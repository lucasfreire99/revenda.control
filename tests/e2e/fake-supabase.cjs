// Supabase de mentira (GoTrue + PostgREST) para os testes de ponta a ponta.
// Imita só o que o app usa. A segurança real (RLS) é testada no SQL; aqui o servidor falso
// apenas separa os dados por usuária a partir do token, como o banco faria.
const crypto = require('node:crypto');

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (payload) => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.fake-signature`;
const OTP = '123456';

function createFake(origin) {
    const users = new Map();      // email -> { id, email, password, nome, confirmed }
    const tokens = new Map();     // access_token -> userId
    const refresh = new Map();    // refresh_token -> userId
    const rows = new Map();       // id -> row (com user_id)
    const log = [];
    const ctl = { expired: new Set(), refreshBroken: false, down: false, tick: 0 };

    const json = (status, body, extra = {}) => ({ status, contentType: 'application/json', body: body === undefined ? '' : JSON.stringify(body), headers: extra });
    const authErr = (status, error_code, msg) => json(status, { code: status, error_code, msg });

    const userObj = (u) => ({
        id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email,
        email_confirmed_at: u.confirmed ? '2026-01-01T00:00:00Z' : null,
        app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: { nome: u.nome || '' },
        identities: [], created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z'
    });

    function issueSession(u) {
        const now = Math.floor(Date.now() / 1000);
        const access = jwt({ sub: u.id, email: u.email, role: 'authenticated', aud: 'authenticated', exp: now + 3600, iat: now, n: ++ctl.tick });
        const rt = crypto.randomUUID();
        tokens.set(access, u.id); refresh.set(rt, u.id);
        return { access_token: access, token_type: 'bearer', expires_in: 3600, expires_at: now + 3600, refresh_token: rt, user: userObj(u) };
    }

    function whoami(headers) {
        const t = (headers.authorization || '').replace(/^Bearer\s+/i, '');
        if (!tokens.has(t)) return { err: json(401, { code: 'PGRST301', message: 'JWT invalid' }) };
        if (ctl.expired.has(t)) return { err: json(401, { code: 'PGRST303', message: 'JWT expired' }) };
        return { uid: tokens.get(t), token: t };
    }

    function auth(method, path, query, body, headers) {
        if (path === '/token' && query.get('grant_type') === 'password') {
            const u = users.get(String(body.email).toLowerCase());
            if (!u || u.password !== body.password) return authErr(400, 'invalid_credentials', 'Invalid login credentials');
            if (!u.confirmed) return authErr(400, 'email_not_confirmed', 'Email not confirmed');
            return json(200, issueSession(u));
        }
        if (path === '/token' && query.get('grant_type') === 'refresh_token') {
            const uid = refresh.get(body.refresh_token);
            if (ctl.refreshBroken || !uid) return authErr(400, 'refresh_token_not_found', 'Invalid Refresh Token: Refresh Token Not Found');
            const u = [...users.values()].find((x) => x.id === uid);
            if (!u) return authErr(400, 'refresh_token_not_found', 'Invalid Refresh Token');
            return json(200, issueSession(u));
        }
        if (path === '/signup') {
            const email = String(body.email).toLowerCase();
            if (users.has(email)) return json(200, { ...userObj(users.get(email)), identities: [] }); // não revela que existe
            const u = { id: crypto.randomUUID(), email, password: body.password, nome: body.data?.nome || '', confirmed: false };
            users.set(email, u);
            return json(200, { ...userObj(u), confirmation_sent_at: '2026-01-01T00:00:00Z' });
        }
        if (path === '/verify' || (path === '/verify' && method === 'POST')) {
            const u = users.get(String(body.email).toLowerCase());
            if (!u || String(body.token) !== OTP) return authErr(403, 'otp_expired', 'Token has expired or is invalid');
            if (body.type === 'signup') u.confirmed = true;
            return json(200, issueSession(u));
        }
        if (path === '/resend' || path === '/recover') return json(200, {});
        if (path === '/user' && method === 'PUT') {
            const w = whoami(headers); if (w.err) return authErr(401, 'bad_jwt', 'invalid JWT');
            const u = [...users.values()].find((x) => x.id === w.uid);
            if (body.password) {
                if (body.password === u.password) return authErr(422, 'same_password', 'New password should be different from the old password.');
                u.password = body.password;
            }
            return json(200, userObj(u));
        }
        if (path === '/user' && method === 'GET') {
            const w = whoami(headers); if (w.err) return authErr(401, 'bad_jwt', 'invalid JWT');
            return json(200, userObj([...users.values()].find((x) => x.id === w.uid)));
        }
        if (path === '/logout') { const t = (headers.authorization || '').replace(/^Bearer\s+/i, ''); tokens.delete(t); return { status: 204, body: '' }; }
        return json(404, { msg: `rota de auth não simulada: ${method} ${path}` });
    }

    function rest(method, path, query, body, headers) {
        const w = whoami(headers); if (w.err) return w.err;
        if (path === '/rpc/delete_my_account') {
            for (const [id, r] of rows) if (r.user_id === w.uid) rows.delete(id);
            for (const [email, u] of users) if (u.id === w.uid) users.delete(email);
            for (const [t, uid] of tokens) if (uid === w.uid) tokens.delete(t);
            return json(200, null);
        }
        if (path !== '/products') return json(404, { message: 'tabela não simulada' });
        if (method === 'GET') {
            const mine = [...rows.values()].filter((r) => r.user_id === w.uid)
                .sort((a, b) => (a.created_at + a.id).localeCompare(b.created_at + b.id));
            const offset = Number(query.get('offset') || 0);
            const limit = query.get('limit') ? Number(query.get('limit')) : mine.length;
            return json(200, mine.slice(offset, offset + limit));
        }
        if (method === 'POST') {
            for (const r of [].concat(body)) {
                const old = rows.get(r.id);
                if (old && old.user_id !== w.uid) return json(403, { code: '42501', message: 'new row violates row-level security policy for table "products"' });
                rows.set(r.id, { created_at: old?.created_at || new Date(Date.now() + (++ctl.tick)).toISOString(), ...old, ...r, user_id: w.uid });
            }
            return { status: 201, body: '' };
        }
        if (method === 'DELETE') {
            const ids = (query.get('id') || '').replace(/^in\.\(|\)$/g, '').split(',').map((s) => s.replace(/"/g, '')).filter(Boolean);
            for (const id of ids) if (rows.get(id)?.user_id === w.uid) rows.delete(id);
            return { status: 204, body: '' };
        }
        return json(405, { message: 'método não simulado' });
    }

    /** Handler para page.route(`${origin}/**`). */
    async function handle(route) {
        const req = route.request();
        const url = new URL(req.url());
        const cors = {
            'access-control-allow-origin': req.headers().origin || '*',
            'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
            'access-control-allow-headers': req.headers()['access-control-request-headers'] || '*',
            'access-control-expose-headers': 'content-range',
            vary: 'Origin'
        };
        if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
        if (ctl.down) return route.abort('connectionrefused');

        let body = {};
        try { body = req.postData() ? JSON.parse(req.postData()) : {}; } catch { /* sem corpo */ }
        const headers = req.headers();
        const m = url.pathname.match(/^\/(auth|rest)\/v1(\/.*)?$/);
        let res;
        if (!m) res = json(404, { message: 'rota desconhecida' });
        else if (m[1] === 'auth') res = auth(req.method(), m[2] || '', url.searchParams, body, headers);
        else res = rest(req.method(), m[2] || '', url.searchParams, body, headers);
        log.push(`${req.method()} ${url.pathname}${url.search} -> ${res.status}`);
        return route.fulfill({ status: res.status, contentType: res.contentType, body: res.body, headers: { ...cors, ...(res.headers || {}) } });
    }

    return {
        origin, handle, users, rows, log, ctl, OTP,
        rowsOf: (email) => { const u = users.get(email); return [...rows.values()].filter((r) => u && r.user_id === u.id); },
        expireAllTokens() { for (const t of tokens.keys()) ctl.expired.add(t); },
        anonKey: jwt({ role: 'anon', iss: 'supabase', ref: 'fakeproj', exp: 4102444800 })
    };
}

module.exports = { createFake };
