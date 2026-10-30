// =====================================================================
// CONFIGURAÇÃO DO SUPABASE — é o ÚNICO arquivo que você precisa editar.
//
// Onde achar: Supabase > seu projeto > Project Settings > API
//   - Project URL ........................ cole em SUPABASE_URL
//   - Chave pública (anon / publishable) .. cole em SUPABASE_ANON_KEY
//
// A chave pública PODE ficar no site: quem protege os dados são as regras de
// segurança (RLS) criadas pelo SQL. NUNCA cole aqui a chave "service_role" ou
// "secret": ela dá acesso total ao banco. O app se recusa a iniciar se detectar isso.
// =====================================================================

export const SUPABASE_URL = 'https://scufpeszmtvuiaecyixy.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_7F_wtTUPd18AOvToHosq2g_iAhTl6rT';

/* ---------- Validação (não precisa mexer daqui para baixo) ---------- */

function decodeJwtPayload(token) {
    try {
        const part = token.split('.')[1];
        if (!part) return null;
        const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
        const json = typeof atob === 'function'
            ? decodeURIComponent(atob(b64).split('').map((c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join(''))
            : Buffer.from(b64, 'base64').toString('utf8');
        return JSON.parse(json);
    } catch { return null; }
}

/** Retorna { ok: true } ou { ok: false, problem: 'placeholder' | 'url' | 'key' | 'secret' }. */
export function checkConfig(url = SUPABASE_URL, key = SUPABASE_ANON_KEY) {
    if (!url || !key || /COLE_AQUI/i.test(url) || /COLE_AQUI/i.test(key)) return { ok: false, problem: 'placeholder' };

    let parsed;
    try { parsed = new URL(url); } catch { return { ok: false, problem: 'url' }; }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
    if (!(parsed.protocol === 'https:' || (parsed.protocol === 'http:' && local))) return { ok: false, problem: 'url' };
    if (parsed.pathname.replace(/\/+$/, '') !== '') return { ok: false, problem: 'url' }; // sem /rest/v1 no final

    if (/^sb_secret_/i.test(key)) return { ok: false, problem: 'secret' };
    if (key.split('.').length === 3) {
        const payload = decodeJwtPayload(key);
        if (!payload) return { ok: false, problem: 'key' };
        if (payload.role === 'service_role') return { ok: false, problem: 'secret' };
    } else if (!/^sb_publishable_/i.test(key)) {
        return { ok: false, problem: 'key' };
    }
    return { ok: true };
}

export const PROBLEMS = {
    placeholder: 'Falta configurar o Supabase. Abra o arquivo web/js/config.js e cole a URL do projeto e a chave pública.',
    url: 'A URL do Supabase em config.js está inválida. Use só o endereço, por exemplo https://abcdefgh.supabase.co (sem /rest/v1 no final).',
    key: 'A chave pública em config.js está inválida. Copie de novo em Project Settings > API (chave "anon" ou "publishable").',
    secret: 'ATENÇÃO: você colou uma chave SECRETA (service_role) em config.js. Ela dá acesso total ao banco e NUNCA pode ficar no site. Troque pela chave pública (anon/publishable) e gere uma nova chave secreta no Supabase.'
};
