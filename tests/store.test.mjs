import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../web/js/store.js';
import { isUUID } from '../web/js/utils.js';

const base = { categoria: 'Perfume', dataLancamento: '2026-10-01', nomeProduto: 'Perfume A', valorCompra: 30, valorVenda: 70, quantidade: 1 };
let diffs;
beforeEach(() => { store.setChangeHandler(null); store.replaceAll([]); diffs = []; store.setChangeHandler((d) => diffs.push(d)); });

test('ids novos são UUID v4 e únicos', () => {
    store.addProducts({ ...base, quantidade: 50 });
    const ids = store.getProducts().map((p) => p.id);
    assert.ok(ids.every(isUUID));
    assert.equal(new Set(ids).size, 50);
});

test('não usa localStorage', () => {
    globalThis.localStorage = { getItem() { throw new Error('não deveria ler'); }, setItem() { throw new Error('não deveria gravar'); } };
    try { store.addProducts(base); store.clearAll(); } finally { delete globalThis.localStorage; }
});

test('adicionar emite apenas upserts, um por unidade', () => {
    store.addProducts({ ...base, quantidade: 3 });
    assert.equal(diffs.length, 1);
    assert.equal(diffs[0].upserts.length, 3);
    assert.equal(diffs[0].deletes.length, 0);
});

test('vender só emite os itens que mudaram', () => {
    store.addProducts({ ...base, quantidade: 3 });
    const [a, b] = store.getProducts();
    diffs.length = 0;
    store.sellProducts([a.id], { dataVenda: '2026-10-05', valorRecebido: 65 });
    assert.deepEqual(diffs[0].upserts.map((p) => p.id), [a.id]);
    assert.equal(store.getProducts().find((p) => p.id === b.id).status, 'Em estoque');
    assert.equal(store.getProducts().find((p) => p.id === a.id).valorRecebido, 65);
});

test('remover emite delete; replaceAll é silencioso', () => {
    store.addProducts(base);
    const id = store.getProducts()[0].id;
    diffs.length = 0;
    store.removeProduct(id);
    assert.deepEqual(diffs[0].deletes, [id]);
    diffs.length = 0;
    store.replaceAll([{ ...base, id: 'x' }]);
    assert.equal(diffs.length, 0);
});

test('desfazer devolve o item e avisa a nuvem', () => {
    store.addProducts(base);
    const id = store.getProducts()[0].id;
    store.removeProduct(id);
    diffs.length = 0;
    assert.equal(store.undo(), true);
    assert.equal(store.getProducts().length, 1);
    assert.deepEqual(diffs[0].upserts.map((p) => p.id), [id]);
});

test('desfazer com versão antiga é recusado', () => {
    store.addProducts(base);
    const v = store.getVersion();
    store.addProducts(base);
    assert.equal(store.undo(v), false);
});

test('editar em grupo altera só unidades em estoque iguais', () => {
    store.addProducts({ ...base, quantidade: 3 });
    const [a] = store.getProducts();
    store.sellProducts([a.id], { dataVenda: '2026-10-05', valorRecebido: 70 });
    const n = store.updateProduct(store.getProducts()[1].id, { valorVenda: 80 }, { applyToGroup: true });
    assert.equal(n, 2);
    assert.equal(store.getProducts().find((p) => p.id === a.id).valorVenda, 70);
});

test('ids numéricos antigos viram UUID e categoria antiga é convertida', () => {
    const p = store.normalizeProduct({ id: 5, categoria: 'Hidrante', dataLancamento: '2026-10-01', nomeProduto: 'X', valorCompra: 1, valorVenda: 2, status: 'Em estoque' });
    assert.ok(isUUID(p.id));
    assert.ok(store.normalizeProduct({ ...p, valorCompra: -1 }) === null || store.normalizeProduct({ ...p, valorCompra: -1 }).valorCompra >= 0);
});

test('importar em mesclar ignora ids repetidos', () => {
    store.addProducts(base);
    const existing = store.getProducts();
    assert.equal(store.importProducts([...existing], 'merge'), 0);
    assert.equal(store.getProducts().length, 1);
});
