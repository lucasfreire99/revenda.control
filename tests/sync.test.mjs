import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../web/js/store.js';
import { createSync, toRow, fromRow, classifyError, purgeLocalData } from '../web/js/sync.js';
import { fakeStorage, fakeTimers, fakeSupabase, serverRow, uuid, settle } from './helpers.mjs';

const product = { categoria: 'Hidratante', dataLancamento: '2026-10-01', nomeProduto: 'Hidratante', valorCompra: 20, valorVenda: 45, quantidade: 1 };

function setup({ rows = [], uid = 'u1', storage = fakeStorage(), online = true } = {}) {
    const server = fakeSupabase({ rows });
    const timers = fakeTimers();
    const target = new EventTarget();
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    const env = { isOnline: () => state.online, target, doc, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout };
    const state = { online };
    server.control.online = online;
    const statuses = [];
    let authExpired = 0;
    const sync = createSync({ client: server.client, userId: uid, store, storage, env, onStatus: (s) => statuses.push(s), onAuthExpired: () => { authExpired++; } });
    return {
        sync, server, timers, storage, target, statuses, state,
        authExpired: () => authExpired,
        goOffline() { state.online = false; server.control.online = false; target.dispatchEvent(new Event('offline')); },
        goOnline() { state.online = true; server.control.online = true; target.dispatchEvent(new Event('online')); },
        last: () => statuses[statuses.length - 1]
    };
}

beforeEach(() => { store.setChangeHandler(null); store.replaceAll([]); });

test('conversão app <-> banco é reversível e nunca envia user_id', () => {
    const p = store.normalizeProduct({ id: uuid(1), categoria: 'Perfume', dataLancamento: '2026-10-01', nomeProduto: 'X', valorCompra: 1.5, valorVenda: 3, status: 'Vendido', dataVenda: '2026-10-05', valorRecebido: 2.5 });
    const row = toRow(p);
    assert.equal('user_id' in row, false);
    assert.deepEqual(fromRow({ ...row, valor_compra: '1.50', valor_venda: '3.00', valor_recebido: '2.50' }), p, 'numeric vindo como texto também funciona');
});

test('primeiro acesso sem cache: baixa do servidor e marca como carregado', async () => {
    const t = setup({ rows: [serverRow(1), serverRow(2)] });
    const { hadCache } = t.sync.start();
    assert.equal(hadCache, false);
    assert.equal(t.sync.status().loaded, false);
    await t.sync.pull();
    assert.equal(store.getProducts().length, 2);
    assert.equal(t.last().state, 'synced');
    assert.equal(t.last().loaded, true);
    assert.ok(t.storage.getItem('rp2:u1:cache'), 'cache salvo no aparelho');
    t.sync.stop();
});

test('alteração local vira upsert no servidor e a fila esvazia', async () => {
    const t = setup();
    t.sync.start(); await t.sync.pull();
    store.addProducts({ ...product, quantidade: 3 });
    assert.equal(t.sync.pendingCount(), 3);
    assert.equal(t.last().state, 'pending');
    await t.sync.flush();
    assert.equal(t.sync.pendingCount(), 0);
    assert.equal(t.server.table.size, 3);
    const row = [...t.server.table.values()][0];
    assert.equal(row.nome_produto, 'Hidratante');
    assert.equal(row.valor_venda, 45);
    assert.equal(t.last().state, 'synced');
    t.sync.stop();
});

test('sem internet: fica na fila (salva no aparelho) e envia quando volta', async () => {
    const t = setup({ online: false });
    t.sync.start();
    store.addProducts({ ...product, quantidade: 2 });
    await t.sync.flush();
    assert.equal(t.last().state, 'offline');
    assert.equal(t.last().pending, 2);
    assert.equal(t.server.table.size, 0);
    assert.equal(Object.keys(JSON.parse(t.storage.getItem('rp2:u1:pending')).u).length, 2, 'fila persistida');

    t.goOnline();
    await settle(); await t.sync.syncNow();
    assert.equal(t.server.table.size, 2);
    assert.equal(t.sync.pendingCount(), 0);
    assert.equal(t.last().state, 'synced');
    t.sync.stop();
});

test('fila sobrevive a fechar o app: nova sessão restaura cache e envia pendências', async () => {
    const storage = fakeStorage();
    const a = setup({ storage, online: false });
    a.sync.start();
    store.addProducts({ ...product, quantidade: 2 });
    a.sync.stop();
    store.replaceAll([]); // "app fechado"

    const b = setup({ storage, online: true });
    const { hadCache } = b.sync.start();
    assert.equal(hadCache, true);
    assert.equal(store.getProducts().length, 2, 'dados voltam do cache instantaneamente');
    await settle(); await b.sync.syncNow();
    assert.equal(b.server.table.size, 2);
    assert.equal(b.sync.pendingCount(), 0);
    b.sync.stop();
});

test('exclusão chega ao servidor; desfazer antes de sincronizar não deixa lixo', async () => {
    const t = setup({ rows: [serverRow(1), serverRow(2)] });
    t.sync.start(); await t.sync.pull();
    store.removeProduct(uuid(1));
    await t.sync.flush();
    assert.deepEqual(t.server.calls.delete, [[uuid(1)]]);
    assert.equal(t.server.table.size, 1);

    store.addProducts({ ...product });
    const v = store.getVersion();
    assert.equal(store.undo(v), true, 'desfaz o cadastro');
    await t.sync.flush();
    assert.equal(store.getProducts().length, 1);
    assert.equal(t.server.table.size, 1, 'o item cadastrado e desfeito não ficou no servidor');
    t.sync.stop();
});

test('desfazer uma exclusão já sincronizada recria a linha no servidor', async () => {
    const t = setup({ rows: [serverRow(1)] });
    t.sync.start(); await t.sync.pull();
    store.removeProduct(uuid(1));
    await t.sync.flush();
    assert.equal(t.server.table.size, 0);
    store.undo(store.getVersion());
    await t.sync.flush();
    assert.equal(t.server.table.size, 1);
    assert.equal(t.server.table.get(uuid(1)).nome_produto, 'Produto 1');
    t.sync.stop();
});

test('paginação: baixa mais de 1000 linhas (limite do Supabase) em várias páginas', async () => {
    const rows = Array.from({ length: 2500 }, (_, i) => serverRow(i + 1));
    const t = setup({ rows });
    t.sync.start(); await t.sync.pull();
    assert.equal(store.getProducts().length, 2500);
    assert.deepEqual(t.server.calls.select, [[0, 999], [1000, 1999], [2000, 2999]]);
    t.sync.stop();
});

test('envio em lotes: 450 linhas = 3 requisições de upsert', async () => {
    const t = setup();
    t.sync.start(); await t.sync.pull();
    store.addProducts({ ...product, quantidade: 450 > 999 ? 999 : 450 });
    await t.sync.flush();
    assert.equal(t.server.table.size, 450);
    assert.deepEqual(t.server.calls.upsert.map((c) => c.length), [200, 200, 50]);
    t.sync.stop();
});

test('download não sobrescreve alteração feita durante ele', async () => {
    const t = setup({ rows: [serverRow(1)] });
    let release; t.server.control.gate = new Promise((r) => { release = r; });
    t.sync.start();                       // o download inicial fica preso na "trava"
    await settle();
    assert.equal(store.getProducts().length, 0, 'download ainda não terminou');
    store.addProducts({ ...product, nomeProduto: 'Feito durante o download' });
    release();
    await t.sync.pull();                  // devolve o download em andamento
    assert.ok(store.getProducts().some((p) => p.nomeProduto === 'Feito durante o download'), 'alteração local preservada');
    assert.equal(t.server.table.size, 1, 'ainda não enviada (o timer de envio é manual neste teste)');
    await t.sync.syncNow();
    assert.equal(t.server.table.size, 2, 'e depois foi enviada ao servidor');
    assert.equal(store.getProducts().length, 2, 'e o servidor e o app concordam');
    t.sync.stop();
});

test('segunda alteração durante o envio da primeira não se perde', async () => {
    const t = setup();
    t.sync.start(); await t.sync.pull();
    store.addProducts({ ...product, nomeProduto: 'A' });
    const id = store.getProducts()[0].id;
    // enquanto o upsert está "no ar", altera de novo
    const original = t.server.client.from;
    let injected = false;
    t.server.client.from = () => {
        const b = original();
        const up = b.upsert;
        b.upsert = async (rs) => {
            if (!injected) { injected = true; store.updateProduct(id, { ...product, nomeProduto: 'A editado', valorVenda: 99 }); }
            return up(rs);
        };
        return b;
    };
    await t.sync.flush();
    assert.equal(t.server.table.get(id).nome_produto, 'A editado');
    assert.equal(t.server.table.get(id).valor_venda, 99);
    assert.equal(t.sync.pendingCount(), 0);
    t.sync.stop();
});

test('erro de rede no meio: status offline, tenta de novo sozinho com espera crescente', async () => {
    const t = setup();
    t.sync.start(); await t.sync.pull();
    store.addProducts({ ...product });
    t.server.control.online = false; // cai a rede sem o navegador avisar
    await t.sync.flush();
    assert.equal(t.last().state, 'offline');
    assert.equal(t.sync.pendingCount(), 1);
    assert.ok(t.timers.delays().includes(4000), 'agendou nova tentativa em 4s');
    t.server.control.online = true;
    await t.timers.runAll(); await settle();
    assert.equal(t.sync.pendingCount(), 0);
    assert.equal(t.server.table.size, 1);
    t.sync.stop();
});

test('sessão expirada: renova e reenvia; se não conseguir, avisa para entrar de novo sem perder dados', async () => {
    const t = setup();
    t.sync.start(); await t.sync.pull();
    store.addProducts({ ...product });
    t.server.control.failWith = { status: 401, message: 'JWT expired', code: 'PGRST301' };
    await t.sync.flush();
    assert.equal(t.server.calls.refresh, 1);
    assert.equal(t.server.table.size, 1, 'reenviou após renovar a sessão');

    store.addProducts({ ...product, nomeProduto: 'B' });
    t.server.control.failWith = { status: 401, message: 'JWT expired', code: 'PGRST301' };
    t.server.control.refreshOk = false;
    await t.sync.flush();
    assert.equal(t.last().state, 'auth');
    assert.equal(t.authExpired(), 1);
    assert.equal(t.sync.pendingCount(), 1, 'pendência preservada para depois do login');
    t.sync.stop();
});

test('erro de validação (400): mostra o erro e NÃO fica repetindo', async () => {
    const t = setup();
    t.sync.start(); await t.sync.pull();
    store.addProducts({ ...product });
    t.server.control.failWith = { status: 400, message: 'violates check constraint', code: '23514' };
    await t.sync.flush();
    assert.equal(t.last().state, 'error');
    assert.match(t.last().message, /violates check constraint/);
    assert.equal(t.timers.delays().filter((d) => d >= 4000).length, 0, 'sem retry automático');
    assert.equal(t.sync.pendingCount(), 1);
    await t.sync.syncNow(); // a pessoa clica em "Sincronizar"
    assert.equal(t.sync.pendingCount(), 0);
    t.sync.stop();
});

test('erro 5xx tenta de novo sozinho', async () => {
    const t = setup();
    t.sync.start(); await t.sync.pull();
    store.addProducts({ ...product });
    t.server.control.failWith = { status: 503, message: 'Service Unavailable' };
    await t.sync.flush();
    assert.equal(t.last().state, 'error');
    assert.ok(t.timers.delays().includes(4000));
    await t.timers.runAll(); await settle();
    assert.equal(t.sync.pendingCount(), 0);
    t.sync.stop();
});

test('cache e fila são separados por usuária; purge apaga só a dela', async () => {
    const storage = fakeStorage();
    const a = setup({ storage, uid: 'ana', online: false });
    a.sync.start(); store.addProducts({ ...product, nomeProduto: 'Da Ana' }); a.sync.stop();

    const b = setup({ storage, uid: 'bia', online: false });
    const { hadCache } = b.sync.start();
    assert.equal(hadCache, false, 'Bia não herda o cache da Ana');
    assert.equal(store.getProducts().length, 0);
    store.addProducts({ ...product, nomeProduto: 'Da Bia' });
    b.sync.stop();

    purgeLocalData('ana', storage);
    assert.deepEqual(storage.keys().filter((k) => k.includes(':ana:')), []);
    assert.ok(storage.keys().some((k) => k.includes(':bia:')));
});

test('classifyError', () => {
    assert.equal(classifyError({ message: 'TypeError: Failed to fetch', status: 0 }), 'network');
    assert.equal(classifyError({ message: 'x', status: 400 }, false), 'network', 'offline vence');
    assert.equal(classifyError({ message: 'JWT expired', code: 'PGRST301' }), 'auth');
    assert.equal(classifyError({ message: 'x', status: 401 }), 'auth');
    assert.equal(classifyError({ message: 'x', status: 503 }), 'retry');
    assert.equal(classifyError({ message: 'x', status: 429 }), 'retry');
    assert.equal(classifyError({ message: 'new row violates row-level security policy', status: 403 }), 'fatal');
    assert.equal(classifyError(null), 'none');
});

test('stop(): sem timers pendentes e sem ouvir eventos', async () => {
    const t = setup();
    t.sync.start(); await t.sync.pull();
    store.addProducts({ ...product });
    t.sync.stop();
    assert.equal(t.timers.count(), 0);
    t.target.dispatchEvent(new Event('online'));
    await settle();
    assert.equal(t.server.table.size, 0, 'não envia depois de parado');
});
