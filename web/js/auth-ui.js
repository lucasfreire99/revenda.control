// Tela de entrada: painéis de login, cadastro, confirmação por código e recuperação de senha.

import { $ } from './dom.js';
import * as auth from './auth.js';

const PANELS = ['login', 'signup', 'confirm', 'forgot', 'reset', 'newpass', 'setup'];
const RESEND_SECONDS = 60;

let handlers = { onSession: () => {} };
let pendingEmail = '';
let resendTimer = null;

const panelEl = (name) => document.querySelector(`[data-panel="${name}"]`);

export function showMessage(text, kind = 'error') {
    const box = $('authMsg');
    box.textContent = text || '';
    box.hidden = !text;
    box.classList.toggle('is-error', kind === 'error');
    box.classList.toggle('is-ok', kind === 'ok');
}

export function showAuthScreen() {
    document.body.dataset.auth = 'out';
    $('authScreen').hidden = false;
}

export function showPanel(name, { email, message, kind } = {}) {
    if (email !== undefined) pendingEmail = email;
    PANELS.forEach((p) => { panelEl(p).hidden = p !== name; });
    document.querySelectorAll('[data-email]').forEach((n) => { n.textContent = pendingEmail; });
    showMessage(message, kind);
    showAuthScreen();
    const first = panelEl(name).querySelector('input');
    if (first) first.focus({ preventScroll: true });
}

export function showSetupProblem(text) {
    $('setupText').textContent = text;
    showPanel('setup');
}

export function clearAuthForms() {
    document.querySelectorAll('#authScreen form').forEach((f) => f.reset());
    pendingEmail = '';
}

/** Desativa o botão enquanto a ação roda e mostra o erro (já em português) se falhar. */
async function guarded(form, action) {
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    showMessage('');
    try {
        await action();
    } catch (err) {
        showMessage(err.message || 'Algo deu errado. Tente novamente.');
        return err;
    } finally {
        button.disabled = false;
    }
    return null;
}

function validPassword(password) {
    if (password.length >= auth.MIN_PASSWORD) return true;
    showMessage(`A senha precisa ter pelo menos ${auth.MIN_PASSWORD} caracteres.`);
    return false;
}

function startResendCooldown() {
    const btn = $('resendBtn');
    clearInterval(resendTimer);
    let left = RESEND_SECONDS;
    btn.disabled = true;
    const tick = () => {
        btn.textContent = left > 0 ? `Reenviar código (${left}s)` : 'Reenviar código';
        btn.disabled = left > 0;
        if (left <= 0) clearInterval(resendTimer);
        left -= 1;
    };
    tick();
    resendTimer = setInterval(tick, 1000);
}

export function initAuthUI({ onSession }) {
    handlers = { onSession };

    document.querySelectorAll('[data-go]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const target = btn.dataset.go;
            const typed = $('loginEmail').value || $('signupEmail').value || $('forgotEmail').value;
            showPanel(target);
            if (target === 'forgot' && typed) $('forgotEmail').value = typed;
        });
    });

    $('loginForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = $('loginEmail').value.trim();
        const password = $('loginPassword').value;
        if (!email || !password) { showMessage('Informe e-mail e senha.'); return; }
        const err = await guarded(e.currentTarget, async () => {
            const session = await auth.signIn(email, password);
            $('loginPassword').value = '';
            handlers.onSession(session);
        });
        if (err?.original && (err.original.code === 'email_not_confirmed' || /not confirmed/i.test(err.original.message || ''))) {
            showPanel('confirm', { email, message: err.message });
            startResendCooldown();
        }
    });

    $('signupForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const nome = $('signupName').value;
        const email = $('signupEmail').value.trim();
        const password = $('signupPassword').value;
        if (!email) { showMessage('Informe o e-mail.'); return; }
        if (!validPassword(password)) return;
        await guarded(e.currentTarget, async () => {
            const result = await auth.signUp({ nome, email, password });
            $('signupPassword').value = '';
            if (result.session) handlers.onSession(result.session);
            else { showPanel('confirm', { email, message: 'Conta criada! Enviamos um código para o seu e-mail.', kind: 'ok' }); startResendCooldown(); }
        });
    });

    $('confirmForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const code = $('confirmCode').value.trim();
        if (!code) { showMessage('Digite o código recebido por e-mail.'); return; }
        await guarded(e.currentTarget, async () => {
            const session = await auth.confirmSignupWithCode(pendingEmail, code);
            $('confirmCode').value = '';
            handlers.onSession(session);
        });
    });

    $('resendBtn').addEventListener('click', async () => {
        $('resendBtn').disabled = true;
        showMessage('');
        try {
            await auth.resendConfirmation(pendingEmail);
            showMessage('Novo código enviado. Confira também a caixa de spam.', 'ok');
            startResendCooldown();
        } catch (err) {
            showMessage(err.message);
            $('resendBtn').disabled = false;
        }
    });

    $('forgotForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = $('forgotEmail').value.trim();
        if (!email) { showMessage('Informe o e-mail.'); return; }
        await guarded(e.currentTarget, async () => {
            await auth.requestPasswordReset(email);
            // Mesma resposta exista ou não a conta (não revela quem tem cadastro)
            showPanel('reset', { email, message: 'Se este e-mail tiver conta, o código já está a caminho.', kind: 'ok' });
        });
    });

    $('resetForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const token = $('resetCode').value.trim();
        const newPassword = $('resetPassword').value;
        if (!token) { showMessage('Digite o código recebido por e-mail.'); return; }
        if (!validPassword(newPassword)) return;
        await guarded(e.currentTarget, async () => {
            await auth.resetPasswordWithCode({ email: pendingEmail, token, newPassword });
            $('resetPassword').value = '';
            $('resetCode').value = '';
            // verifyOtp já deixou a pessoa autenticada: o app abre pelo evento de sessão
            const { session } = await auth.restoreSession();
            if (session) handlers.onSession(session);
        });
    });

    $('newpassForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const newPassword = $('newpassPassword').value;
        if (!validPassword(newPassword)) return;
        await guarded(e.currentTarget, async () => {
            await auth.updatePassword(newPassword);
            $('newpassPassword').value = '';
            const { session } = await auth.restoreSession();
            if (session) handlers.onSession(session, { passwordChanged: true });
        });
    });
}
