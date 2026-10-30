// Renderização (cards, indicadores, detalhes). Só recebe dados e callbacks; não conhece o store.

import { $, el } from './dom.js';
import { formatCurrency, formatDate, formatPercent, margin } from './utils.js';
import { STATUS } from './store.js';

const setText = (id, text) => { const n = $(id); if (n) n.textContent = text; };

export function renderStats(s) {
    setText('totalInvestido', formatCurrency(s.investido));
    setText('totalVendido', formatCurrency(s.vendido));
    setText('lucroLiquido', formatCurrency(s.lucro));
    setText('lucroPotencial', formatCurrency(s.potencial));
    setText('margemGeral', formatPercent(s.margem));
    setText('unidadesEstoque', String(s.unidadesEstoque));
    $('lucroLiquido').classList.toggle('negative', s.lucro < 0);
}

const row = (label, value, cls = '') =>
    el('span', { class: 'price-row' }, el('span', {}, label), el('span', { class: cls }, value));

function signedClass(n) { return n < 0 ? 'negative' : ''; }

function card(className, label, children, onOpen) {
    return el('button', {
        type: 'button',
        class: `product-card${className}`,
        'aria-label': label,
        onclick: onOpen
    }, children);
}

function unitCard(p, onOpen) {
    const sold = p.status === STATUS.SOLD;
    const receita = sold ? p.valorRecebido : p.valorVenda;
    const lucro = receita - p.valorCompra;
    return card(sold ? ' sold' : '', `${p.nomeProduto}, ${p.status}. Abrir detalhes`, [
        el('span', { class: 'pc-name', title: p.nomeProduto }, p.nomeProduto),
        el('span', { class: 'pc-category' }, p.categoria),
        row('Compra:', formatCurrency(p.valorCompra)),
        row(sold ? 'Recebido:' : 'Venda:', formatCurrency(receita)),
        row('Lucro:', formatCurrency(lucro), signedClass(lucro)),
        row('Margem:', formatPercent(margin(receita, p.valorCompra)), signedClass(lucro)),
        el('span', { class: 'pc-status' }, sold ? `✅ Vendido em ${formatDate(p.dataVenda)}` : '📦 Em estoque')
    ], () => onOpen(p.id));
}

function groupCard(g, onOpen) {
    const p = g.sample;
    const lucroUnit = p.valorVenda - p.valorCompra;
    const allSold = g.estoque.length === 0;
    const status = allSold ? '✅ Tudo vendido' : `📦 ${g.estoque.length} em estoque`;
    return card(allSold ? ' sold' : '', `${p.nomeProduto}, ${g.estoque.length} em estoque, ${g.vendidos.length} vendidas. Abrir detalhes`, [
        el('span', { class: 'pc-name', title: p.nomeProduto }, p.nomeProduto),
        el('span', { class: 'pc-category' }, p.categoria),
        row('Em estoque:', `${g.estoque.length} un.`),
        row('Vendidas:', `${g.vendidos.length} un.`),
        row('Compra:', formatCurrency(p.valorCompra)),
        row('Venda:', formatCurrency(p.valorVenda)),
        row('Lucro unit.:', `${formatCurrency(lucroUnit)} (${formatPercent(margin(p.valorVenda, p.valorCompra))})`, signedClass(lucroUnit)),
        el('span', { class: 'pc-status' }, status)
    ], () => onOpen(g.key));
}

/** mode: 'grouped' | 'items'. */
export function renderProducts({ mode, items, groups, onOpenItem, onOpenGroup }) {
    const box = $('productsContainer');
    const total = mode === 'grouped' ? groups.length : items.length;

    if (total === 0) {
        box.replaceChildren(el('div', { class: 'empty' }, 'Nenhum produto encontrado.'));
        $('resultCount').textContent = '';
        return;
    }

    box.replaceChildren(...(mode === 'grouped'
        ? groups.map((g) => groupCard(g, onOpenGroup))
        : items.map((p) => unitCard(p, onOpenItem))));

    $('resultCount').textContent = mode === 'grouped'
        ? `${groups.length} produto(s) agrupado(s), ${items.length} unidade(s) no total.`
        : `${items.length} unidade(s).`;
}

export function detailList(pairs) {
    return el('dl', { class: 'details' }, pairs.map(([label, value, cls]) =>
        el('div', {}, el('dt', {}, label), el('dd', { class: cls || '' }, value))
    ));
}

export function unitDetails(p) {
    const sold = p.status === STATUS.SOLD;
    const receita = sold ? p.valorRecebido : p.valorVenda;
    const lucro = receita - p.valorCompra;
    const pairs = [
        ['Produto', p.nomeProduto],
        ['Categoria', p.categoria],
        ['Data de lançamento', formatDate(p.dataLancamento)],
        ['Valor de compra', formatCurrency(p.valorCompra)],
        ['Valor de venda (tabela)', formatCurrency(p.valorVenda)]
    ];
    if (sold) {
        pairs.push(['Data da venda', formatDate(p.dataVenda)]);
        pairs.push(['Valor recebido', formatCurrency(p.valorRecebido)]);
    }
    pairs.push([sold ? 'Lucro realizado' : 'Lucro unitário', formatCurrency(lucro), signedClass(lucro)]);
    pairs.push(['Margem', formatPercent(margin(receita, p.valorCompra)), signedClass(lucro)]);
    pairs.push(['Status', sold ? '✅ Vendido' : '📦 Em estoque']);
    return detailList(pairs);
}

export function groupDetails(g) {
    const p = g.sample;
    const lucroUnit = p.valorVenda - p.valorCompra;
    return detailList([
        ['Produto', p.nomeProduto],
        ['Categoria', p.categoria],
        ['Em estoque', `${g.estoque.length} un.`],
        ['Vendidas', `${g.vendidos.length} un.`],
        ['Valor de compra (un.)', formatCurrency(p.valorCompra)],
        ['Valor de venda (un.)', formatCurrency(p.valorVenda)],
        ['Lucro unitário', formatCurrency(lucroUnit), signedClass(lucroUnit)],
        ['Margem', formatPercent(margin(p.valorVenda, p.valorCompra)), signedClass(lucroUnit)],
        ['Lucro potencial do estoque', formatCurrency(lucroUnit * g.estoque.length), signedClass(lucroUnit)]
    ]);
}
