// Backup e restauração em JSON.

import { el } from './dom.js';
import { getProducts, normalizeProduct } from './store.js';
import { todayISO, isISODate, daysSince } from './utils.js';

let scope = '';
const lastKey = () => (scope ? `rp2:${scope}:lastBackup` : 'lastBackup');

/** Cada conta guarda a própria data do último backup. */
export function setBackupScope(userId) { scope = userId || ''; }

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

export function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = el('a', { href: url, download: filename });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function exportBackup() {
    const products = getProducts();
    const payload = {
        app: 'revenda-plus',
        version: 1,
        exportedAt: new Date().toISOString(),
        products
    };
    downloadBlob(
        new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }),
        `backup-revenda-${todayISO()}.json`
    );
    try { localStorage.setItem(lastKey(), todayISO()); } catch { /* ignora */ }
    return products.length;
}

export function getLastBackup() {
    try {
        const value = localStorage.getItem(lastKey());
        return isISODate(value) ? value : null;
    } catch { return null; }
}

export function backupIsStale(days = 30) {
    const last = getLastBackup();
    return last === null || daysSince(last) >= days;
}

/** Lê um arquivo de backup (aceita o formato do app ou uma lista simples de produtos). */
export async function readBackupFile(file) {
    if (file.size > MAX_FILE_SIZE) throw new Error('O arquivo é grande demais (limite de 10 MB).');

    let data;
    try {
        data = JSON.parse(await file.text());
    } catch {
        throw new Error('O arquivo não é um JSON válido.');
    }

    const list = Array.isArray(data) ? data : data?.products;
    if (!Array.isArray(list)) throw new Error('Formato de backup não reconhecido.');

    const products = list.map(normalizeProduct).filter(Boolean);
    if (list.length > 0 && products.length === 0) throw new Error('Nenhum produto válido foi encontrado no arquivo.');

    return { products, skipped: list.length - products.length };
}
