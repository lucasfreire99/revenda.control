// Sincronização com o Supabase.
//
// Como funciona (local primeiro):
//  - O app sempre trabalha com a cópia local (rápido, funciona sem internet).
//  - Cada alteração entra numa fila de pendências, guardada no aparelho.
//  - Quando há internet, a fila é enviada (upsert/delete). Se a rede cair, a fila espera.
//  - Depois de enviar, o app baixa a versão do servidor (que vale para todos os aparelhos).
// Conflitos: vale a última alteração enviada de cada linha ("last write wins").

import { normalizeProduct } from './store.js';

const TABLE = 'products';
const PAGE_SIZE = 1000;      // limite padrão do Supabase por requisição
const UPSERT_CHUNK = 200;
const DELETE_CHUNK = 100;
const FLUSH_DEBOUNCE_MS = 400;
const PULL_MIN_INTERVAL_MS = 30_000;
const BACKOFF_MS = [4_000, 8_000, 16_000, 32_000, 60_000];

/* ---------- Conversão app <-> banco ---------- */

export const toRow = (p) => ({
    id: p.id,
    categoria: p.categoria,
    data_lancamento: p.dataLancamento,
    nome_produto: p.nomeProduto,
    valor_compra: p.valorCompra,
    valor_venda: p.valorVenda,
    status: p.status,
    data_venda: p.dataVenda ?? null,
    valor_recebido: p.valorRecebido ?? null
    // user_id não é enviado: o banco preenche com auth.uid() e as regras (RLS) conferem.
});

export const fromRow = (r) => normalizeProduct({
    id: r.id,
    categoria: r.categoria,
    dataLancamento: r.data_lancamento,
    nomeProduto: r.nome_produto,
    valorCompra: Number(r.valor_compra),
    valorVenda: Number(r.valor_venda),
    status: r.status,
    dataVenda: r.data_venda,
    valorRecebido: r.valor_recebido == null ? null : Number(r.valor_recebido)
});

/* ---------- Classificação de erros ---------- */

export function classifyError(error, online = true) {
    if (!error) return 'none';
    const msg = String(error.message || '');
    const status = Number(error.status ?? error.statusCode ?? NaN);
    if (!online || status === 0 || /failed to fetch|networkerror|load failed|network request failed|fetch failed|ECONN|ENOTFOUND/i.test(msg)) return 'network';
    if (status === 401 || /^PGRST30[1-3]$/.test(error.code || '') || /jwt (expired|invalid)|invalid jwt|not authenticated/i.test(msg)) return 'auth';
    if (status >= 500 || status === 429 || status === 408) return 'retry';
    return 'fatal';
}

/* ---------- Chaves do armazenamento local (uma por usuária) ---------- */

const keyOf = (uid, name) => `rp2:${uid}:${name}`;

export function purgeLocalData(uid, storage = globalThis.localStorage) {
    try { ['cache', 'pending', 'meta'].forEach((n) => storage.removeItem(keyOf(uid, n))); } catch { /* ignora */ }
}

export function hasLocalData(uid, storage = globalThis.localStorage) {
    try { return storage.getItem(keyOf(uid, 'cache')) !== null; } catch { return false; }
}

/* ---------- Sincronizador ---------- */

/**
 * @param {object} o
 * @param {object} o.client      cliente supabase-js (precisa de .from(), .auth.refreshSession())
 * @param {string} o.userId
 * @param {object} o.store       módulo store.js
 * @param {(s:object)=>void} o.onStatus  recebe { state, pending, message, lastSync, loaded }
 * @param {()=>void} o.onAuthExpired     chamado quando a sessão não pôde ser renovada
 * @param {object} [o.storage]   localStorage (injetável nos testes)
 * @param {object} [o.env]       { isOnline(), on(target, event, fn) -> off } (injetável nos testes)
 */
export function createSync({ client, userId, store, onStatus = () => {}, onAuthExpired = () => {}, storage = globalThis.localStorage, env = {} }) {
    const isOnline = env.isOnline ?? (() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false));
    const listen = env.on ?? ((target, event, fn) => { target.addEventListener(event, fn); return () => target.removeEventListener(event, fn); });
    const setTimer = env.setTimeout ?? setTimeout;
    const clearTimer = env.clearTimeout ?? clearTimeout;

    let pending = { u: {}, d: {} };      // u: { id: revisão }, d: { id: true }
    let state = 'synced';
    let message = '';
    let lastSync = null;
    let loaded = false;
    let flushing = null;                 // promise em andamento
    let flushAgain = false;
    let pulling = null;
    let stopped = false;
    let failures = 0;
    let flushTimer = null;
    let retryTimer = null;
    let lastPullAt = 0;
    const offs = [];

    /* ----- armazenamento local ----- */
    const read = (name) => { try { const v = storage.getItem(keyOf(userId, name)); return v === null ? null : JSON.parse(v); } catch { return null; } };
    const write = (name, value) => { try { storage.setItem(keyOf(userId, name), JSON.stringify(value)); return true; } catch { return false; } };
    const saveCache = () => write('cache', store.getProducts());
    const savePending = () => write('pending', pending);
    const saveMeta = () => write('meta', { lastSync: lastSync ? lastSync.toISOString() : null });

    const pendingCount = () => Object.keys(pending.u).length + Object.keys(pending.d).length;

    function setState(next, msg = '') {
        state = next;
        message = msg;
        onStatus({ state, pending: pendingCount(), message, lastSync, loaded });
    }

    /* ----- registro das alterações feitas pela pessoa ----- */
    function track({ upserts, deletes }) {
        for (const p of upserts) { pending.u[p.id] = (pending.u[p.id] || 0) + 1; delete pending.d[p.id]; }
        for (const id of deletes) { delete pending.u[id]; pending.d[id] = true; }
        const okCache = saveCache();
        const okPending = savePending();
        if (!okCache || !okPending) {
            setState('error', 'Não foi possível salvar neste aparelho (armazenamento cheio ou bloqueado). Baixe um backup.');
            return;
        }
        setState(isOnline() ? 'pending' : 'offline');
        scheduleFlush(FLUSH_DEBOUNCE_MS);
    }

    function scheduleFlush(ms) {
        if (stopped) return;
        clearTimer(flushTimer);
        flushTimer = setTimer(() => { flush(); }, ms);
    }

    function scheduleRetry() {
        if (stopped) return;
        clearTimer(retryTimer);
        const wait = BACKOFF_MS[Math.min(failures - 1, BACKOFF_MS.length - 1)] ?? 60_000;
        retryTimer = setTimer(() => { syncNow(); }, wait);
    }

    /* ----- envio ----- */
    async function pushOnce() {
        const upsEntries = Object.entries(pending.u);
        const delIds = Object.keys(pending.d);
        const byId = new Map(store.getProducts().map((p) => [p.id, p]));

        // Linhas que sumiram localmente sem passar pela fila não existem mais: nada a enviar.
        for (const [id] of upsEntries) if (!byId.has(id)) delete pending.u[id];

        const rows = upsEntries.filter(([id]) => byId.has(id)).map(([id, rev]) => ({ id, rev, row: toRow(byId.get(id)) }));
        for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
            const chunk = rows.slice(i, i + UPSERT_CHUNK);
            const { error, status } = await client.from(TABLE).upsert(chunk.map((c) => c.row), { onConflict: 'id' });
            if (error) throw Object.assign(new Error(error.message), { code: error.code, status: error.status ?? status });
            // só limpa se a linha não foi alterada de novo enquanto enviávamos
            for (const c of chunk) if (pending.u[c.id] === c.rev) delete pending.u[c.id];
            savePending();
        }
        for (let i = 0; i < delIds.length; i += DELETE_CHUNK) {
            const chunk = delIds.slice(i, i + DELETE_CHUNK);
            const { error, status } = await client.from(TABLE).delete().in('id', chunk);
            if (error) throw Object.assign(new Error(error.message), { code: error.code, status: error.status ?? status });
            for (const id of chunk) delete pending.d[id];
            savePending();
        }
    }

    async function handleFailure(err) {
        const kind = classifyError(err, isOnline());
        if (kind === 'auth') {
            const { data, error } = await client.auth.refreshSession();
            if (!error && data?.session) return 'retry-now';
            setState('auth', 'Sua sessão expirou. Entre novamente para sincronizar.');
            onAuthExpired();
            return 'stop';
        }
        failures++;
        if (kind === 'network') { setState('offline', ''); scheduleRetry(); return 'stop'; }
        if (kind === 'retry') { setState('error', 'Servidor indisponível. Vamos tentar de novo.'); scheduleRetry(); return 'stop'; }
        setState('error', `Não foi possível sincronizar: ${err.message || 'erro desconhecido'}`);
        return 'stop'; // erro "fatal": não repete sozinho, a pessoa clica em "Sincronizar"
    }

    /** Garante uma única execução por vez e solta a trava DEPOIS de a promessa ter sido guardada. */
    function single(getRunning, setRunning, run, onBusy) {
        return () => {
            const running = getRunning();
            if (running) { onBusy?.(); return running; }
            const p = run();
            setRunning(p);
            p.finally(() => { if (getRunning() === p) setRunning(null); });
            return p;
        };
    }

    async function doFlush() {
        if (stopped) return false;
        let authRetries = 0;
        do {
            flushAgain = false;
            if (pendingCount() === 0) break;
            if (!isOnline()) { setState('offline'); return false; }
            setState('syncing');
            try {
                await pushOnce();
                failures = 0;
            } catch (err) {
                const next = await handleFailure(err);
                if (next === 'retry-now' && authRetries++ < 1) { flushAgain = true; continue; }
                return false;
            }
        } while (flushAgain || pendingCount() > 0);
        lastSync = new Date();
        saveMeta();
        setState('synced');
        return true;
    }

    const flush = single(() => flushing, (p) => { flushing = p; }, doFlush, () => { flushAgain = true; });

    /* ----- download ----- */
    async function doPull() {
        if (stopped) return false;
        for (let authRetries = 0; authRetries < 2; authRetries++) {
            try {
                if (pendingCount() > 0) {
                    const ok = await flush();
                    if (!ok || pendingCount() > 0) return false;
                }
                if (!isOnline()) { setState('offline'); return false; }
                setState('syncing');

                const all = [];
                for (let from = 0; ; from += PAGE_SIZE) {
                    const { data, error, status } = await client.from(TABLE).select('*')
                        .order('created_at', { ascending: true }).order('id', { ascending: true })
                        .range(from, from + PAGE_SIZE - 1);
                    if (error) throw Object.assign(new Error(error.message), { code: error.code, status: error.status ?? status });
                    all.push(...data);
                    if (data.length < PAGE_SIZE) break;
                }

                // A pessoa alterou algo durante o download: não sobrescreve; envia e baixa de novo.
                if (pendingCount() > 0) { scheduleFlush(0); return false; }

                store.replaceAll(all.map(fromRow).filter(Boolean));
                saveCache();
                lastSync = new Date();
                lastPullAt = Date.now();
                loaded = true;
                failures = 0;
                saveMeta();
                setState('synced');
                return true;
            } catch (err) {
                const next = await handleFailure(err);
                if (next !== 'retry-now') return false;
            }
        }
        return false;
    }

    const pull = single(() => pulling, (p) => { pulling = p; }, doPull);

    /** Envia o que está pendente e baixa a versão do servidor. */
    const syncNow = () => pull();

    /* ----- ciclo de vida ----- */
    function start() {
        stopped = false;
        const cached = read('cache');
        const pend = read('pending');
        const meta = read('meta');
        pending = { u: pend?.u && typeof pend.u === 'object' ? pend.u : {}, d: pend?.d && typeof pend.d === 'object' ? pend.d : {} };
        if (meta?.lastSync) lastSync = new Date(meta.lastSync);
        const hadCache = Array.isArray(cached);
        if (hadCache) { store.replaceAll(cached); loaded = true; } else { store.replaceAll([]); }

        store.setChangeHandler(track);

        if (typeof window !== 'undefined' || env.target) {
            const target = env.target ?? window;
            offs.push(listen(target, 'online', () => { failures = 0; syncNow(); }));
            offs.push(listen(target, 'offline', () => setState('offline')));
        }
        if (typeof document !== 'undefined' || env.doc) {
            const doc = env.doc ?? document;
            offs.push(listen(doc, 'visibilitychange', () => {
                if (doc.visibilityState === 'visible' && Date.now() - lastPullAt > PULL_MIN_INTERVAL_MS) syncNow();
            }));
        }

        setState(pendingCount() ? (isOnline() ? 'pending' : 'offline') : (isOnline() ? 'synced' : 'offline'));
        syncNow();
        return { hadCache };
    }

    function stop() {
        stopped = true;
        clearTimer(flushTimer);
        clearTimer(retryTimer);
        offs.splice(0).forEach((off) => off());
        store.setChangeHandler(null);
    }

    return {
        start, stop, flush, pull, syncNow,
        pendingCount,
        status: () => ({ state, pending: pendingCount(), message, lastSync, loaded }),
        purge: () => purgeLocalData(userId, storage)
    };
}
