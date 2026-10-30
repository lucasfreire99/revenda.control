// Ferramentas de teste: armazenamento falso, servidor Supabase falso e relógio controlável.

export function fakeStorage() {
    const m = new Map();
    return {
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => { m.set(k, String(v)); },
        removeItem: (k) => { m.delete(k); },
        keys: () => [...m.keys()],
        dump: () => Object.fromEntries(m)
    };
}

/** Timers que só disparam quando o teste manda. */
export function fakeTimers() {
    let id = 0;
    const pending = new Map();
    return {
        setTimeout: (fn, ms) => { pending.set(++id, { fn, ms }); return id; },
        clearTimeout: (i) => pending.delete(i),
        count: () => pending.size,
        delays: () => [...pending.values()].map((t) => t.ms),
        async runAll() { const list = [...pending.entries()]; pending.clear(); for (const [, t] of list) await t.fn(); }
    };
}

/** Imita o trecho do supabase-js que o sync.js usa (from/upsert/delete/select + auth.refreshSession). */
export function fakeSupabase({ rows = [] } = {}) {
    const table = new Map(rows.map((r) => [r.id, { created_at: '2026-01-01T00:00:00Z', ...r }]));
    const calls = { upsert: [], delete: [], select: [], refresh: 0 };
    const control = {
        online: true,
        failWith: null,          // { status, message, code } para a próxima chamada
        refreshOk: true,
        gate: null               // Promise que segura a próxima leitura (simula download lento)
    };
    let tick = 0;

    const guard = () => {
        if (!control.online) return { data: null, error: { message: 'TypeError: Failed to fetch', code: '' }, status: 0 };
        if (control.failWith) { const f = control.failWith; control.failWith = null; return { data: null, error: { message: f.message || 'erro', code: f.code || '' }, status: f.status }; }
        return null;
    };

    const client = {
        from() {
            return {
                async upsert(rs) {
                    const g = guard(); if (g) return g;
                    calls.upsert.push(rs.map((r) => r.id));
                    for (const r of rs) table.set(r.id, { created_at: `2026-01-01T00:00:${String(++tick).padStart(2, '0')}Z`, ...table.get(r.id), ...r });
                    return { error: null, status: 201 };
                },
                delete() {
                    return {
                        async in(_col, ids) {
                            const g = guard(); if (g) return g;
                            calls.delete.push(ids);
                            ids.forEach((id) => table.delete(id));
                            return { error: null, status: 204 };
                        }
                    };
                },
                select() {
                    const q = {
                        order: () => q,
                        async range(a, b) {
                            const gate = control.gate; control.gate = null;
                            if (gate) await gate;
                            const g = guard(); if (g) return g;
                            calls.select.push([a, b]);
                            const sorted = [...table.values()].sort((x, y) => (x.created_at + x.id).localeCompare(y.created_at + y.id));
                            return { data: sorted.slice(a, b + 1), error: null, status: 200 };
                        }
                    };
                    return q;
                }
            };
        },
        auth: {
            async refreshSession() {
                calls.refresh++;
                return control.refreshOk ? { data: { session: { access_token: 'novo' } }, error: null } : { data: { session: null }, error: { message: 'Invalid Refresh Token' } };
            }
        }
    };
    return { client, table, calls, control };
}

export const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const serverRow = (n, over = {}) => ({
    id: uuid(n), user_id: 'u1', categoria: 'Hidratante', data_lancamento: '2026-10-01', nome_produto: `Produto ${n}`,
    valor_compra: 10, valor_venda: 20, status: 'Em estoque', data_venda: null, valor_recebido: null, ...over
});

/** Espera microtarefas e timers curtos. */
export const settle = () => new Promise((r) => setTimeout(r, 5));
