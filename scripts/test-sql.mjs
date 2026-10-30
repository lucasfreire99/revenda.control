// Testa as migrações em um Postgres de verdade (PGlite, roda no Node, sem instalar nada).
// Simula o schema "auth" do Supabase e prova que uma usuária não enxerga os dados da outra.
//   npm install && npm run test:sql

import { PGlite } from '@electric-sql/pglite';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = process.env.MIGRATIONS_DIR || path.join(root, 'supabase', 'migrations');
const migrations = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();

const db = new PGlite();

/* ---- Simula o que o Supabase já traz pronto ---- */
await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create schema auth;
    create table auth.users (
        id uuid primary key default gen_random_uuid(),
        email text unique,
        raw_user_meta_data jsonb not null default '{}'::jsonb
    );
    create function auth.uid() returns uuid language sql stable as $$
        select coalesce(
            nullif(current_setting('request.jwt.claim.sub', true), ''),
            (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
        )::uuid
    $$;
    grant usage on schema public to anon, authenticated, service_role;
    grant usage on schema auth to anon, authenticated, service_role;
    grant execute on function auth.uid() to anon, authenticated, service_role;
`);

const applyMigrations = async () => { for (const f of migrations) await db.exec(fs.readFileSync(path.join(migrationsDir, f), 'utf8')); };
await applyMigrations();

/* ---- Helpers ---- */
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1, 'ana@teste.com', '{"nome":"  Ana Paula  "}'), ($2, 'bia@teste.com', '{}')`, [A, B]);

/** Executa fn como "authenticated" com o JWT da usuária (ou como anon, se uid for null). */
async function as(uid, fn) {
    if (uid === 'anon') await db.exec('set role anon');
    else {
        await db.exec('set role authenticated');
        await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify(uid ? { sub: uid, role: 'authenticated' } : {})]);
    }
    try { return await fn(); }
    finally { await db.exec(`reset role; select set_config('request.jwt.claims', '', false)`); }
}
const q = (sql, params) => db.query(sql, params);
async function rejects(promise, pattern, label) {
    let error = null;
    try { await promise; } catch (e) { error = e; }
    assert.ok(error, `deveria falhar: ${label}`);
    assert.match(error.message, pattern, `${label}: mensagem inesperada -> ${error.message}`);
}

let passed = 0;
const t = async (name, fn) => { await fn(); passed++; console.log('ok  -', name); };

const insertProduct = (name = 'Hidratante', extra = '') =>
    q(`insert into public.products (categoria, data_lancamento, nome_produto, valor_compra, valor_venda ${extra ? ', ' + extra.cols : ''})
       values ('Hidratante', '2026-10-01', $1, 20, 45 ${extra ? ', ' + extra.vals : ''}) returning id`, [name]);

/* ---- Testes ---- */
await t('migrações são idempotentes (rodar 2x não quebra)', async () => { await applyMigrations(); });

await t('perfil é criado automaticamente, com nome aparado', async () => {
    const { rows } = await q('select id, nome from public.profiles order by nome desc');
    assert.equal(rows.length, 2);
    assert.equal(rows.find((r) => r.id === A).nome, 'Ana Paula');
    assert.equal(rows.find((r) => r.id === B).nome, '');
});

await t('visitante (anon) não lê, não grava e não chama a exclusão de conta', async () => {
    await as('anon', async () => {
        await rejects(q('select * from public.products'), /permission denied/i, 'select anon');
        await rejects(q('select * from public.profiles'), /permission denied/i, 'select profiles anon');
        await rejects(insertProduct(), /permission denied/i, 'insert anon');
        await rejects(q('select public.delete_my_account()'), /permission denied/i, 'rpc anon');
    });
});

await t('logada sem user_id: o banco preenche user_id com o dela', async () => {
    await as(A, async () => {
        await insertProduct('Perfume A1'); await insertProduct('Perfume A2'); await insertProduct('Perfume A3');
        const { rows } = await q('select user_id from public.products');
        assert.equal(rows.length, 3);
        assert.ok(rows.every((r) => r.user_id === A));
    });
});

await t('ISOLAMENTO: Bia não enxerga nada da Ana', async () => {
    await as(B, async () => {
        assert.equal((await q('select * from public.products')).rows.length, 0);
        assert.equal((await q('select * from public.profiles')).rows.length, 1);
        assert.equal((await q('select id from public.profiles')).rows[0].id, B);
    });
});

await t('Bia não consegue gravar linha em nome da Ana', async () => {
    await as(B, async () => {
        await rejects(q(`insert into public.products (user_id, categoria, data_lancamento, nome_produto, valor_compra, valor_venda)
                         values ($1, 'Perfume', '2026-10-01', 'Invasão', 1, 2)`, [A]), /row-level security/i, 'insert com user_id alheio');
    });
});

await t('Bia não altera nem apaga produtos da Ana (0 linhas afetadas)', async () => {
    await as(B, async () => {
        assert.equal((await q(`update public.products set nome_produto = 'HACK'`)).affectedRows, 0);
        assert.equal((await q(`delete from public.products`)).affectedRows, 0);
    });
    const { rows } = await q(`select count(*)::int as n, count(*) filter (where nome_produto = 'HACK')::int as hack from public.products`);
    assert.equal(rows[0].n, 3);
    assert.equal(rows[0].hack, 0);
});

await t('upsert da Bia em cima do id da Ana é bloqueado e não altera a linha', async () => {
    const { rows: [target] } = await q(`select id from public.products where nome_produto = 'Perfume A1'`);
    await as(B, async () => {
        await rejects(q(`insert into public.products (id, categoria, data_lancamento, nome_produto, valor_compra, valor_venda)
                         values ($1, 'Perfume', '2026-10-01', 'SEQUESTRADO', 1, 2)
                         on conflict (id) do update set nome_produto = excluded.nome_produto`, [target.id]), /row-level security/i, 'upsert alheio');
    });
    assert.equal((await q('select nome_produto from public.products where id = $1', [target.id])).rows[0].nome_produto, 'Perfume A1');
});

await t('ninguém troca o dono de um produto (user_id imutável)', async () => {
    await as(A, async () => {
        await rejects(q(`update public.products set user_id = $1`, [B]), /row-level security|user_id não pode/i, 'trocar dono');
    });
    assert.equal((await q(`select count(*)::int as n from public.products where user_id = $1`, [A])).rows[0].n, 3);
});

await t('a dona edita, vende e apaga os próprios produtos', async () => {
    await as(A, async () => {
        const { rows: [p] } = await q(`select id from public.products where nome_produto = 'Perfume A1'`);
        await q(`update public.products set status = 'Vendido', data_venda = '2026-10-20', valor_recebido = 40 where id = $1`, [p.id]);
        const { rows: [r] } = await q('select status, valor_recebido::float as v from public.products where id = $1', [p.id]);
        assert.deepEqual(r, { status: 'Vendido', v: 40 });
        assert.equal((await q('delete from public.products where id = $1', [p.id])).affectedRows, 1);
    });
});

await t('constraints: venda incoerente, preço negativo, nome vazio, status inválido', async () => {
    await as(A, async () => {
        await rejects(insertProduct('X', { cols: 'status', vals: `'Vendido'` }), /products_venda_coerente/, 'vendido sem data');
        await rejects(insertProduct('X', { cols: 'data_venda, valor_recebido', vals: `'2026-10-01', 10` }), /products_venda_coerente/, 'estoque com data');
        await rejects(insertProduct('X', { cols: 'status', vals: `'Perdido'` }), /check constraint/i, 'status inválido');
        await rejects(q(`insert into public.products (categoria, data_lancamento, nome_produto, valor_compra, valor_venda) values ('K','2026-10-01','Neg',-1,2)`), /check constraint/i, 'preço negativo');
        await rejects(insertProduct('   '), /check constraint/i, 'nome só com espaços');
        await rejects(insertProduct('x'.repeat(121)), /check constraint/i, 'nome longo');
    });
});

await t('updated_at muda ao editar e created_at não pode ser forjado', async () => {
    await as(A, async () => {
        const { rows: [p] } = await q(`select id, created_at, updated_at from public.products limit 1`);
        await q(`select pg_sleep(0.05)`);
        await q(`update public.products set nome_produto = 'Editado', created_at = '2000-01-01' where id = $1`, [p.id]);
        const { rows: [n] } = await q(`select created_at, updated_at from public.products where id = $1`, [p.id]);
        assert.equal(new Date(n.created_at).getTime(), new Date(p.created_at).getTime(), 'created_at preservado');
        assert.ok(new Date(n.updated_at) > new Date(p.updated_at), 'updated_at avançou');
    });
});

await t('perfil: cada uma edita só o seu', async () => {
    await as(A, async () => {
        await q(`update public.profiles set nome = 'Ana P.'`);
        assert.equal((await q('select nome from public.profiles')).rows[0].nome, 'Ana P.');
        await rejects(q(`update public.profiles set nome = repeat('a', 121)`), /check constraint/i, 'nome longo');
    });
    await as(B, async () => {
        assert.equal((await q(`update public.profiles set nome = 'Bia'`)).affectedRows, 1);
    });
    assert.equal((await q(`select nome from public.profiles where id = $1`, [A])).rows[0].nome, 'Ana P.');
});

await t('funções internas dos gatilhos não são chamáveis pela API', async () => {
    await as(A, async () => {
        await rejects(q('select public.handle_new_user()'), /permission denied/i, 'handle_new_user');
        await rejects(q('select public.set_updated_at()'), /permission denied/i, 'set_updated_at');
    });
});

await t('delete_my_account sem login falha', async () => {
    await as(null, async () => { await rejects(q('select public.delete_my_account()'), /Não autenticado/, 'sem uid'); });
});

await t('delete_my_account apaga conta, perfil e produtos só de quem chamou', async () => {
    await as(B, async () => { await insertProduct('Produto da Bia'); });
    await as(A, async () => { await q('select public.delete_my_account()'); });
    assert.equal((await q(`select count(*)::int as n from auth.users where id = $1`, [A])).rows[0].n, 0);
    assert.equal((await q(`select count(*)::int as n from public.profiles where id = $1`, [A])).rows[0].n, 0);
    assert.equal((await q(`select count(*)::int as n from public.products where user_id = $1`, [A])).rows[0].n, 0);
    assert.equal((await q(`select count(*)::int as n from public.products where user_id = $1`, [B])).rows[0].n, 1, 'Bia intacta');
    assert.equal((await q(`select count(*)::int as n from auth.users where id = $1`, [B])).rows[0].n, 1);
});

await t('RLS está ligada nas duas tabelas', async () => {
    const { rows } = await q(`select relname, relrowsecurity from pg_class where relname in ('products','profiles') and relnamespace = 'public'::regnamespace order by relname`);
    assert.deepEqual(rows.map((r) => [r.relname, r.relrowsecurity]), [['products', true], ['profiles', true]]);
    const pol = await q(`select count(*)::int as n from pg_policies where schemaname = 'public'`);
    assert.equal(pol.rows[0].n, 6);
});

console.log(`\n${passed} testes de SQL passaram`);
await db.close();
