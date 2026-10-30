// Login com o Supabase Auth (e-mail + senha, código por e-mail para confirmar/recuperar).
// Só este arquivo conhece o supabase-js; o resto do app usa as funções daqui.

import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const LAST_USER_KEY = 'rp2:lastUser';
export const MIN_PASSWORD = 8;

let client = null;

export function getClient() {
    if (client) return client;
    if (!window.supabase?.createClient) throw new Error('Biblioteca do Supabase não carregou.');
    client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: {
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: true,   // troca o ?code= do link do e-mail por uma sessão
            flowType: 'pkce',
            storageKey: 'revenda-plus-auth'
        }
    });
    return client;
}

/* ---------- Mensagens de erro em português ---------- */

export function friendlyError(error) {
    if (!error) return 'Algo deu errado. Tente novamente.';
    const code = String(error.code || error.error_code || '').toLowerCase();
    const msg = String(error.message || error.msg || '').toLowerCase();
    const status = Number(error.status ?? NaN);

    if (status === 0 || /failed to fetch|networkerror|load failed|fetch failed/.test(msg) || error.name === 'AuthRetryableFetchError') {
        return 'Sem conexão com a internet. Verifique a rede e tente de novo.';
    }
    if (code === 'invalid_credentials' || /invalid login credentials/.test(msg)) return 'E-mail ou senha incorretos.';
    if (code === 'email_not_confirmed' || /email not confirmed/.test(msg)) return 'Seu e-mail ainda não foi confirmado. Use o código que enviamos ou peça um novo.';
    if (code === 'user_already_exists' || code === 'email_exists' || /already registered/.test(msg)) return 'Este e-mail já tem uma conta. Entre ou recupere a senha.';
    if (code === 'weak_password' || /password should be|weak password/.test(msg)) return `Senha fraca. Use pelo menos ${MIN_PASSWORD} caracteres, misturando letras e números.`;
    if (code === 'same_password' || /different from the old password/.test(msg)) return 'A nova senha precisa ser diferente da atual.';
    if (code === 'otp_expired' || code === 'otp_disabled' || /token has expired|invalid.*(token|otp)|otp/.test(msg)) return 'Código inválido ou expirado. Peça um novo.';
    if (code.includes('rate_limit') || status === 429 || /rate limit|too many/.test(msg)) return 'Muitas tentativas. Aguarde alguns minutos e tente de novo.';
    if (code === 'signup_disabled') return 'Novos cadastros estão desativados.';
    if (code === 'validation_failed' || /unable to validate email|invalid format/.test(msg)) return 'Confira o e-mail digitado.';
    if (code === 'session_not_found' || code === 'refresh_token_not_found' || /refresh token|session.*(missing|not found)/.test(msg)) return 'Sua sessão expirou. Entre novamente.';
    return 'Não foi possível concluir. Tente novamente em instantes.';
}

const clean = (email) => String(email || '').trim().toLowerCase();

async function run(promise) {
    const { data, error } = await promise;
    if (error) throw Object.assign(new Error(friendlyError(error)), { original: error });
    return data;
}

/* ---------- Sessão ---------- */

function rememberUser(user) {
    try {
        localStorage.setItem(LAST_USER_KEY, JSON.stringify({ id: user.id, email: user.email, nome: user.user_metadata?.nome || '' }));
    } catch { /* ignora */ }
}

export function lastKnownUser() {
    try { return JSON.parse(localStorage.getItem(LAST_USER_KEY) || 'null'); } catch { return null; }
}

export function forgetLastUser() {
    try { localStorage.removeItem(LAST_USER_KEY); } catch { /* ignora */ }
}

/**
 * Recupera a sessão salva. Se não houver rede e a sessão não puder ser renovada,
 * devolve { offlineUser } com a última usuária conhecida para o app abrir com os dados do aparelho.
 */
export async function restoreSession() {
    const supa = getClient();
    let result;
    try {
        result = await supa.auth.getSession();
    } catch (err) {
        result = { data: { session: null }, error: err };
    }
    const session = result.data?.session ?? null;
    if (session?.user) { rememberUser(session.user); return { session }; }

    const offlineLike = navigator.onLine === false || result.error?.name === 'AuthRetryableFetchError' || result.error?.status === 0;
    const known = lastKnownUser();
    if (offlineLike && known?.id) return { session: null, offlineUser: known };
    return { session: null };
}

export function onAuthChange(callback) {
    const { data } = getClient().auth.onAuthStateChange((event, session) => {
        if (session?.user) rememberUser(session.user);
        callback(event, session);
    });
    return () => data.subscription.unsubscribe();
}

/* ---------- Ações ---------- */

export async function signIn(email, password) {
    const data = await run(getClient().auth.signInWithPassword({ email: clean(email), password }));
    return data.session;
}

/** Retorna { session } se já entrou, ou { needsConfirmation: true } se precisa confirmar o e-mail. */
export async function signUp({ nome, email, password }) {
    const data = await run(getClient().auth.signUp({
        email: clean(email),
        password,
        options: { data: { nome: String(nome || '').trim().slice(0, 120) }, emailRedirectTo: appUrl() }
    }));
    return data.session ? { session: data.session } : { needsConfirmation: true };
}

export async function resendConfirmation(email) {
    await run(getClient().auth.resend({ type: 'signup', email: clean(email), options: { emailRedirectTo: appUrl() } }));
}

export async function confirmSignupWithCode(email, token) {
    const data = await run(getClient().auth.verifyOtp({ email: clean(email), token: String(token).replace(/\s+/g, ''), type: 'signup' }));
    return data.session;
}

export async function requestPasswordReset(email) {
    await run(getClient().auth.resetPasswordForEmail(clean(email), { redirectTo: appUrl() }));
}

/** Confirma o código recebido por e-mail e já define a nova senha. */
export async function resetPasswordWithCode({ email, token, newPassword }) {
    await run(getClient().auth.verifyOtp({ email: clean(email), token: String(token).replace(/\s+/g, ''), type: 'recovery' }));
    await run(getClient().auth.updateUser({ password: newPassword }));
}

export async function updatePassword(newPassword) {
    await run(getClient().auth.updateUser({ password: newPassword }));
}

export async function signOut() {
    const supa = getClient();
    let { error } = await supa.auth.signOut();
    if (error) ({ error } = await supa.auth.signOut({ scope: 'local' })); // sem internet: sai só deste aparelho
    forgetLastUser();
}

/** Apaga a conta (e todos os dados, por cascata no banco) via função SQL delete_my_account. */
export async function deleteAccount() {
    await run(getClient().rpc('delete_my_account'));
    try { await getClient().auth.signOut({ scope: 'local' }); } catch { /* a conta já não existe */ }
    forgetLastUser();
}

/** Endereço do app, usado nos links dos e-mails (sem hash nem parâmetros). */
export function appUrl() {
    return `${location.origin}${location.pathname}`;
}

/** Lê erros que o Supabase devolve na URL (link expirado, por exemplo) e limpa a barra de endereço. */
export function consumeUrlParams() {
    const params = new URLSearchParams(location.search);
    const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
    const description = params.get('error_description') || hash.get('error_description');
    const errorCode = params.get('error_code') || hash.get('error_code');
    const hadAuthParams = ['code', 'error', 'error_code', 'error_description'].some((k) => params.has(k)) || hash.has('error_description');
    if (hadAuthParams) {
        ['code', 'error', 'error_code', 'error_description'].forEach((k) => params.delete(k));
        const qs = params.toString();
        const cleanHash = hash.has('error_description') ? '' : location.hash;
        history.replaceState(null, '', location.pathname + (qs ? `?${qs}` : '') + cleanHash);
    }
    if (!description && !errorCode) return null;
    if (errorCode === 'otp_expired') return 'O link do e-mail expirou ou já foi usado. Entre com sua senha ou peça um novo código.';
    return 'Não foi possível validar o link do e-mail. Entre com sua senha ou peça um novo código.';
}
