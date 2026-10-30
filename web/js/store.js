// Estado em memória e regras de negócio. NÃO sabe onde os dados são guardados:
// a cada alteração ele avisa o que mudou (setChangeHandler) e quem cuida de salvar é o sync.js.

import {
    resolveCategory, isISODate, isUUID, todayISO, newId, round2,
    normalizeText, monthLabel, pad, margin
} from './utils.js';

export const STATUS = { STOCK: 'Em estoque', SOLD: 'Vendido' };

let products = [];
let undoState = null;
let version = 0; // sobe a cada alteração; o "Desfazer" só vale para a alteração mais recente
let changeHandler = null;
const subscribers = new Set();

export const subscribe = (fn) => { subscribers.add(fn); return () => subscribers.delete(fn); };
const emit = () => subscribers.forEach((fn) => fn());
export const getProducts = () => products;
export const getVersion = () => version;

/** Recebe { upserts: Produto[], deletes: id[] } sempre que o usuário altera algo. */
export const setChangeHandler = (fn) => { changeHandler = fn; };

/* ---------- Normalização / validação ---------- */

function toMoney(value, fallback = 0) {
    const n = typeof value === 'number' ? value : parseFloat(value);
    return Number.isFinite(n) && n >= 0 ? round2(n) : fallback;
}

/** Aceita dados antigos (id numérico, sem dataVenda), backups e linhas do servidor; devolve null se inválido. */
export function normalizeProduct(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const nomeProduto = String(raw.nomeProduto ?? '').trim().slice(0, 120);
    if (!nomeProduto) return null;

    const dataLancamento = isISODate(raw.dataLancamento) ? raw.dataLancamento : todayISO();
    const valorCompra = toMoney(raw.valorCompra);
    const valorVenda = toMoney(raw.valorVenda);
    const sold = raw.status === STATUS.SOLD;

    return {
        // O banco exige UUID. Ids antigos (números) ganham um UUID novo.
        id: isUUID(raw.id) ? raw.id.toLowerCase() : newId(),
        categoria: resolveCategory(raw.categoria),
        dataLancamento,
        nomeProduto,
        valorCompra,
        valorVenda,
        status: sold ? STATUS.SOLD : STATUS.STOCK,
        // Vendas antigas não tinham data nem valor recebido: assume lançamento e preço de venda.
        dataVenda: sold ? (isISODate(raw.dataVenda) ? raw.dataVenda : dataLancamento) : null,
        valorRecebido: sold ? toMoney(raw.valorRecebido, valorVenda) : null
    };
}

/* ---------- Detecção de mudanças ---------- */

const sig = (p) => JSON.stringify([p.categoria, p.dataLancamento, p.nomeProduto, p.valorCompra, p.valorVenda, p.status, p.dataVenda, p.valorRecebido]);
const snapshot = () => new Map(products.map((p) => [p.id, sig(p)]));

function diffFrom(before) {
    const upserts = [];
    const seen = new Set();
    for (const p of products) {
        seen.add(p.id);
        if (before.get(p.id) !== sig(p)) upserts.push({ ...p });
    }
    const deletes = [...before.keys()].filter((id) => !seen.has(id));
    return { upserts, deletes };
}

function commit(before) {
    const changes = diffFrom(before);
    if ((changes.upserts.length || changes.deletes.length) && changeHandler) changeHandler(changes);
    emit();
}

function mutate(fn) {
    undoState = JSON.stringify(products);
    version++;
    const before = snapshot();
    fn();
    commit(before);
}

/** Troca TODOS os dados sem contar como alteração do usuário (cache local ou resposta do servidor). */
export function replaceAll(list) {
    products = list.map(normalizeProduct).filter(Boolean);
    const seen = new Set();
    products.forEach((p) => { if (seen.has(p.id)) p.id = newId(); seen.add(p.id); });
    undoState = null;
    version++;
    emit();
}

/** Desfaz a última alteração (um nível). Se expectedVersion for passada, só desfaz se ainda for a mais recente. */
export function undo(expectedVersion) {
    if (undoState === null) return false;
    if (expectedVersion !== undefined && expectedVersion !== version) return false;
    let restored;
    try {
        restored = JSON.parse(undoState).map(normalizeProduct).filter(Boolean);
    } catch { return false; }
    const before = snapshot();
    products = restored;
    undoState = null;
    version++;
    commit(before); // o que o "desfazer" mudou também precisa ir para a nuvem
    return true;
}

/* ---------- Operações ---------- */

export function addProducts(data) {
    const quantity = Math.min(999, Math.max(1, parseInt(data.quantidade, 10) || 1));
    const template = normalizeProduct({ ...data, id: null, status: STATUS.STOCK });
    if (!template) return 0;
    mutate(() => {
        for (let i = 0; i < quantity; i++) products.push({ ...template, id: newId() });
    });
    return quantity;
}

/** Edita uma unidade — ou todas as unidades iguais em estoque, se applyToGroup. */
export function updateProduct(id, fields, { applyToGroup = false } = {}) {
    const target = products.find((p) => p.id === String(id));
    if (!target) return 0;
    const key = groupKey(target);
    const ids = new Set([target.id]);
    if (applyToGroup && target.status === STATUS.STOCK) {
        products.forEach((p) => { if (p.status === STATUS.STOCK && groupKey(p) === key) ids.add(p.id); });
    }
    mutate(() => {
        products = products.map((p) => {
            if (!ids.has(p.id)) return p;
            return normalizeProduct({ ...p, ...fields, id: p.id, status: p.status, dataVenda: p.dataVenda, valorRecebido: p.valorRecebido }) ?? p;
        });
    });
    return ids.size;
}

export function removeProduct(id) {
    mutate(() => { products = products.filter((p) => p.id !== String(id)); });
}

export function sellProducts(ids, { dataVenda, valorRecebido }) {
    const set = new Set(ids.map(String));
    mutate(() => {
        products.forEach((p) => {
            if (set.has(p.id) && p.status === STATUS.STOCK) {
                p.status = STATUS.SOLD;
                p.dataVenda = isISODate(dataVenda) ? dataVenda : todayISO();
                p.valorRecebido = toMoney(valorRecebido, p.valorVenda);
            }
        });
    });
}

export function revertSale(id) {
    mutate(() => {
        const p = products.find((x) => x.id === String(id));
        if (p) { p.status = STATUS.STOCK; p.dataVenda = null; p.valorRecebido = null; }
    });
}

/** mode: 'replace' | 'merge'. Retorna quantos registros entraram. */
export function importProducts(list, mode) {
    let added = 0;
    mutate(() => {
        if (mode === 'replace') {
            products = [...list];
            added = list.length;
        } else {
            const existing = new Set(products.map((p) => p.id));
            list.forEach((p) => { if (!existing.has(p.id)) { products.push(p); added++; } });
        }
    });
    return added;
}

export function clearAll() {
    mutate(() => { products = []; });
}

/* ---------- Consultas ---------- */

export const groupKey = (p) =>
    [p.categoria, normalizeText(p.nomeProduto), p.valorCompra, p.valorVenda].join('|');

export function filterProducts(list, { month = '', category = '', status = '', search = '' } = {}) {
    const q = normalizeText(search.trim());
    return list.filter((p) => {
        if (month && !(p.dataLancamento.startsWith(month) || (p.dataVenda && p.dataVenda.startsWith(month)))) return false;
        if (category && p.categoria !== category) return false;
        if (status === 'estoque' && p.status !== STATUS.STOCK) return false;
        if (status === 'vendido' && p.status !== STATUS.SOLD) return false;
        if (q && !normalizeText(p.nomeProduto).includes(q)) return false;
        return true;
    });
}

/** Agrupa unidades idênticas (nome + categoria + preços). Em estoque: mais antigas primeiro. */
export function buildGroups(list) {
    const map = new Map();
    list.forEach((p) => {
        const key = groupKey(p);
        if (!map.has(key)) map.set(key, { key, sample: p, estoque: [], vendidos: [] });
        const g = map.get(key);
        (p.status === STATUS.SOLD ? g.vendidos : g.estoque).push(p);
    });
    const groups = [...map.values()];
    groups.forEach((g) => g.estoque.sort((a, b) => a.dataLancamento.localeCompare(b.dataLancamento)));
    return groups.sort((a, b) => a.sample.nomeProduto.localeCompare(b.sample.nomeProduto, 'pt-BR'));
}

export function summarize(list) {
    let investido = 0, vendido = 0, custoVendidos = 0, potencial = 0;
    let unidadesEstoque = 0, unidadesVendidas = 0;
    list.forEach((p) => {
        investido += p.valorCompra;
        if (p.status === STATUS.SOLD) {
            vendido += p.valorRecebido;
            custoVendidos += p.valorCompra;
            unidadesVendidas++;
        } else {
            potencial += p.valorVenda - p.valorCompra;
            unidadesEstoque++;
        }
    });
    const lucro = vendido - custoVendidos;
    return {
        investido: round2(investido),
        vendido: round2(vendido),
        lucro: round2(lucro),
        potencial: round2(potencial),
        margem: margin(vendido, custoVendidos),
        unidadesEstoque,
        unidadesVendidas
    };
}

/** Últimos N meses. Compras pela data de lançamento; vendas e lucro pela data da venda. */
export function monthlySeries(list, months = 6, ref = new Date()) {
    const labels = [], compras = [], vendas = [], lucro = [];
    for (let i = months - 1; i >= 0; i--) {
        const d = new Date(ref.getFullYear(), ref.getMonth() - i, 1);
        const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
        let c = 0, v = 0, l = 0;
        list.forEach((p) => {
            if (p.dataLancamento.startsWith(key)) c += p.valorCompra;
            if (p.status === STATUS.SOLD && p.dataVenda && p.dataVenda.startsWith(key)) {
                v += p.valorRecebido;
                l += p.valorRecebido - p.valorCompra;
            }
        });
        labels.push(monthLabel(d));
        compras.push(round2(c));
        vendas.push(round2(v));
        lucro.push(round2(l));
    }
    return { labels, compras, vendas, lucro };
}
