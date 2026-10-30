// Dados da versão antiga (só neste aparelho): ficavam em localStorage na chave "products".

import { normalizeProduct } from './store.js';

const KEY = 'products';

export function readLegacyProducts() {
    try {
        const raw = localStorage.getItem(KEY);
        if (!raw) return [];
        const list = JSON.parse(raw);
        return Array.isArray(list) ? list.map(normalizeProduct).filter(Boolean) : [];
    } catch { return []; }
}

export function clearLegacyProducts() {
    try { localStorage.removeItem(KEY); } catch { /* ignora */ }
}
