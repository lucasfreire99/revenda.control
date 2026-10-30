// Conta da pessoa logada: status de sincronização, trocar senha, sair e excluir a conta.

import { $, el, toast, openModal, closeModal } from './dom.js';
import * as auth from './auth.js';
import { exportBackup } from './backup.js';

const SYNC_VIEW = {
    synced: ['✓', 'Sincronizado'],
    syncing: ['↻', 'Sincronizando…'],
    offline: ['⚠', 'Sem internet'],
    pending: ['●', 'Pendente'],
    error: ['!', 'Erro'],
    auth: ['🔒', 'Entre de novo']
};

const formatDateTime = (d) => (d instanceof Date && !Number.isNaN(d.getTime())
    ? d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
    : null);

/** Atualiza o botão do cabeçalho e o texto do cartão "Minha conta". */
export function renderSyncStatus(status) {
    const [icon, label] = SYNC_VIEW[status.state] ?? SYNC_VIEW.synced;
    const text = status.state === 'pending' || (status.state === 'offline' && status.pending > 0)
        ? `${status.pending} pendente(s)${status.state === 'offline' ? ' · sem internet' : ''}`
        : label;
    const btn = $('syncBtn');
    btn.dataset.state = status.state;
    $('syncIcon').textContent = icon;
    $('syncLabel').textContent = text;
    const last = formatDateTime(status.lastSync);
    btn.setAttribute('aria-label', `Sincronização: ${text}. Toque para sincronizar agora.`);
    btn.title = [status.message, last ? `Última sincronização: ${last}` : null].filter(Boolean).join('\n') || 'Sincronização com a nuvem';

    const lines = [];
    if (last) lines.push(`Última sincronização: ${last}.`);
    if (status.pending > 0) lines.push(`${status.pending} alteração(ões) aguardando envio.`);
    if (status.message) lines.push(status.message);
    $('syncInfo').textContent = lines.join(' ') || 'Ainda não sincronizado.';
}

export function renderAccount(user) {
    const name = user.user_metadata?.nome || user.nome || '';
    $('accountName').textContent = name || user.email || 'Minha conta';
    $('accountEmail').textContent = name ? (user.email || '') : '';
}

/**
 * @param {object} ctx
 * @param {()=>object|null} ctx.getSync   sincronizador atual
 * @param {(opts?:object)=>void} ctx.leave volta para a tela de entrada
 */
export function bindAccount(ctx) {
    const field = (label, id, input) => el('div', { class: 'form-group' }, el('label', { for: id }, label), input);

    /* ----- sincronizar ----- */
    async function syncNow() {
        const sync = ctx.getSync();
        if (!sync) return;
        const status = sync.status();
        if (status.state === 'auth') { ctx.leave({ message: 'Entre novamente para continuar sincronizando.' }); return; }
        const ok = await sync.syncNow();
        const after = sync.status();
        if (ok) toast('Tudo sincronizado.');
        else toast(after.state === 'offline' ? 'Sem internet. As alterações ficam guardadas e serão enviadas depois.' : (after.message || 'Não foi possível sincronizar agora.'));
    }
    $('syncBtn').addEventListener('click', syncNow);
    $('syncNowBtn').addEventListener('click', syncNow);

    /* ----- trocar senha ----- */
    $('changePasswordBtn').addEventListener('click', () => {
        const pass = el('input', { type: 'password', id: 'cpNew', autocomplete: 'new-password', minlength: String(auth.MIN_PASSWORD), required: true });
        const again = el('input', { type: 'password', id: 'cpAgain', autocomplete: 'new-password', required: true });
        const error = el('p', { class: 'warning-text', role: 'alert', hidden: true });
        const submit = el('button', { type: 'submit', class: 'btn btn-primary' }, 'Salvar nova senha');
        const form = el('form', { class: 'dialog-form' },
            field(`Nova senha (mínimo ${auth.MIN_PASSWORD} caracteres)`, 'cpNew', pass),
            field('Repita a nova senha', 'cpAgain', again),
            error, submit);
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const fail = (msg) => { error.textContent = msg; error.hidden = false; };
            if (pass.value.length < auth.MIN_PASSWORD) return fail(`A senha precisa ter pelo menos ${auth.MIN_PASSWORD} caracteres.`);
            if (pass.value !== again.value) return fail('As senhas não são iguais.');
            submit.disabled = true; error.hidden = true;
            try {
                await auth.updatePassword(pass.value);
                closeModal();
                toast('Senha alterada.');
            } catch (err) { fail(err.message); submit.disabled = false; }
        });
        openModal({ title: 'Trocar senha', content: form, actions: [{ label: 'Cancelar', className: 'btn-secondary' }] });
    });

    /* ----- sair ----- */
    async function finishSignOut() {
        const sync = ctx.getSync();
        sync?.stop();
        sync?.purge();               // tira os dados desta pessoa do aparelho
        await auth.signOut();
        ctx.leave({ message: 'Você saiu da conta.', kind: 'ok' });
    }

    $('signOutBtn').addEventListener('click', async () => {
        const sync = ctx.getSync();
        if (sync && sync.pendingCount() > 0) {
            toast('Enviando suas alterações antes de sair…');
            await sync.flush();
        }
        const left = sync?.pendingCount() ?? 0;
        if (left === 0) { await finishSignOut(); return; }
        openModal({
            title: 'Alterações não enviadas',
            content: el('p', { class: 'modal-note' }, `${left} alteração(ões) ainda não chegaram à nuvem (talvez sem internet). Se sair agora, elas serão perdidas. Baixe um backup ou volte quando houver conexão.`),
            actions: [
                { label: 'Baixar backup', className: 'btn-primary', onClick: () => { exportBackup(); toast('Backup baixado.'); } },
                { label: 'Sair e perder', className: 'btn-danger', onClick: finishSignOut },
                { label: 'Cancelar', className: 'btn-secondary' }
            ]
        });
    });

    /* ----- excluir conta ----- */
    $('deleteAccountBtn').addEventListener('click', () => {
        const CONFIRM_WORD = 'EXCLUIR';
        const input = el('input', { type: 'text', id: 'delConfirm', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false' });
        const error = el('p', { class: 'warning-text', role: 'alert', hidden: true });
        const submit = el('button', { type: 'submit', class: 'btn btn-danger', disabled: true }, 'Excluir para sempre');
        const form = el('form', { class: 'dialog-form' },
            el('p', { class: 'modal-note' }, 'Isso apaga sua conta e TODOS os seus produtos, na nuvem e neste aparelho. Não dá para recuperar. Baixe um backup antes, se quiser guardar.'),
            field(`Para confirmar, digite ${CONFIRM_WORD}`, 'delConfirm', input),
            error, submit);
        input.addEventListener('input', () => { submit.disabled = input.value.trim().toUpperCase() !== CONFIRM_WORD; });
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (input.value.trim().toUpperCase() !== CONFIRM_WORD) return;
            submit.disabled = true; error.hidden = true;
            try {
                await auth.deleteAccount();
                const sync = ctx.getSync();
                sync?.stop();
                sync?.purge();
                closeModal();
                ctx.leave({ message: 'Sua conta foi excluída.', kind: 'ok' });
            } catch (err) {
                error.textContent = err.message; error.hidden = false; submit.disabled = false;
            }
        });
        openModal({
            title: 'Excluir minha conta',
            content: form,
            actions: [
                { label: 'Baixar backup antes', className: 'btn-primary', onClick: () => { exportBackup(); toast('Backup baixado.'); } },
                { label: 'Cancelar', className: 'btn-secondary' }
            ]
        });
    });
}
