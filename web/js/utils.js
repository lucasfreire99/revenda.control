// Funções auxiliares sem dependência de DOM (podem ser testadas em Node).

export const CATEGORIES = [
    'Hidratante',
    'Perfume',
    'Bodysplash',
    'Booster',
    'Proteína',
    'Esfoliante',
    'Desodorante',
    'Sabonete',
    'Shampoo + Condicionador'
];
export const DEFAULT_CATEGORY = CATEGORIES[0];

/** Categorias da versão anterior -> equivalente na lista nova. O que não estiver aqui é mantido como está. */
export const LEGACY_CATEGORIES = {
    'Perfumaria': 'Perfume',
    'Body Splash': 'Bodysplash',
    'Body Care / Corpo': 'Hidratante',
    'Hidrante': 'Hidratante',
    'Hair / Cabelos': 'Shampoo + Condicionador',
    'Desodorantes': 'Desodorante',
    'Bath & Body': 'Sabonete'
};

/** Converte qualquer categoria (nova, antiga ou desconhecida) em um texto válido. */
export function resolveCategory(value) {
    const text = String(value ?? '').trim().slice(0, 60);
    if (!text) return DEFAULT_CATEGORY;
    if (CATEGORIES.includes(text)) return text;
    return LEGACY_CATEGORIES[text] ?? text;
}

export const pad = (n) => String(n).padStart(2, '0');

/** Data de hoje no fuso LOCAL (toISOString usaria UTC e viraria o dia após as 21h no Brasil). */
export function todayISO(date = new Date()) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function isISODate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [y, m, d] = value.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
}

/** "2026-10-22" -> "22/10/2026", sem passar por Date (sem problema de fuso). */
export function formatDate(iso) {
    if (!isISODate(iso)) return '—';
    const [y, m, d] = iso.split('-');
    return `${d}/${m}/${y}`;
}

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
export const formatCurrency = (value) => brl.format(Number.isFinite(value) ? value : 0);

export function formatPercent(value) {
    const v = Number.isFinite(value) ? value : 0;
    return `${v.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;
}

/** Evita erros de ponto flutuante (0.1 + 0.2) nas somas de dinheiro. */
export const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Margem sobre o preço de venda, em %. */
export const margin = (venda, compra) => (venda > 0 ? ((venda - compra) / venda) * 100 : 0);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isUUID = (value) => typeof value === 'string' && UUID_RE.test(value);

/** UUID v4. O banco (Supabase) exige UUID; gerar no app permite cadastrar sem internet. */
export function newId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    // Fallback para contextos não seguros (HTTP em rede local): getRandomValues existe em todos
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Minúsculas e sem acento, para buscas. */
export const normalizeText = (s) =>
    String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

export function monthLabel(date) {
    const month = date.toLocaleString('pt-BR', { month: 'short' }).replace('.', '');
    return `${month}/${String(date.getFullYear()).slice(2)}`;
}

export function daysSince(iso, now = new Date()) {
    if (!isISODate(iso)) return Infinity;
    const [y, m, d] = iso.split('-').map(Number);
    const then = new Date(y, m - 1, d);
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.round((today - then) / 86400000);
}

export const clampInt = (value, min, max, fallback = min) => {
    const n = parseInt(value, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
};
