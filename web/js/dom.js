// Utilitários de DOM: criação segura de elementos, modal acessível e avisos (toasts).
// Todo texto entra via textContent/createTextNode, então nome de produto nunca vira HTML (sem XSS).

export const $ = (id) => document.getElementById(id);

export function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
        if (value === undefined || value === null || value === false) continue;
        if (key === 'class') node.className = value;
        else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
        else if (value === true) node.setAttribute(key, '');
        else node.setAttribute(key, value);
    }
    const append = (child) => {
        if (child === undefined || child === null || child === false) return;
        if (Array.isArray(child)) child.forEach(append);
        else node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    };
    children.forEach(append);
    return node;
}

/* ---------- Toasts ---------- */

export function toast(message, { actionLabel, onAction, duration = 6000 } = {}) {
    const box = $('toasts');
    while (box.children.length >= 3) box.firstElementChild.remove();

    let timer;
    const remove = () => { clearTimeout(timer); item.remove(); };
    const item = el('div', { class: 'toast' }, el('span', {}, message));
    if (actionLabel) {
        item.append(el('button', {
            type: 'button',
            class: 'toast-action',
            onclick: () => { remove(); onAction?.(); }
        }, actionLabel));
    }
    box.append(item);
    timer = setTimeout(remove, duration);
}

/* ---------- Modal ---------- */

let lastFocused = null;
let onCloseCallback = null;

const modalRoot = () => $('modal');
const isOpen = () => modalRoot().classList.contains('active');

export function openModal({ title, content, actions = [], onClose = null }) {
    $('modalTitle').textContent = title;
    $('modalBody').replaceChildren(...[].concat(content ?? []));

    const footer = $('modalActions');
    footer.replaceChildren(...actions.map((a) =>
        el('button', {
            type: 'button',
            class: `btn ${a.className || 'btn-secondary'}`,
            onclick: () => { closeModal(); a.onClick?.(); } // fecha ANTES, para a ação poder abrir outro modal
        }, a.label)
    ));
    footer.hidden = actions.length === 0;

    lastFocused = document.activeElement;
    onCloseCallback = onClose;
    modalRoot().classList.add('active');
    modalRoot().setAttribute('aria-hidden', 'false');
    document.body.classList.add('modal-open');

    // Foco síncrono: o overlay fica visível na hora (ver CSS), então não há risco de focar depois de fechar.
    const target = $('modalBody').querySelector('input, select, textarea')
        || footer.querySelector('button')
        || $('closeModal');
    target.focus();
}

export function closeModal() {
    if (!isOpen()) return;
    modalRoot().classList.remove('active');
    modalRoot().setAttribute('aria-hidden', 'true');
    document.body.classList.remove('modal-open');
    const cb = onCloseCallback;
    onCloseCallback = null;
    if (lastFocused && document.contains(lastFocused) && typeof lastFocused.focus === 'function') {
        lastFocused.focus();
    }
    lastFocused = null;
    cb?.();
}

export function initModal() {
    $('closeModal').addEventListener('click', closeModal);
    modalRoot().addEventListener('click', (e) => { if (e.target === modalRoot()) closeModal(); });

    document.addEventListener('keydown', (e) => {
        if (!isOpen()) return;
        if (e.key === 'Escape') {
            e.preventDefault();
            closeModal();
            return;
        }
        if (e.key !== 'Tab') return;
        // Mantém o foco dentro do modal
        const focusable = [...modalRoot().querySelectorAll('button, input, select, textarea, a[href]')]
            .filter((n) => !n.disabled && !n.hidden && n.offsetParent !== null);
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        else if (!modalRoot().contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    });
}
