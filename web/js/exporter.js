// Exportação para Excel (.xlsx) com formatação visual, usando ExcelJS (vendor/exceljs.min.js).
// A biblioteca só é carregada quando a pessoa pede o relatório (economiza memória no celular).

import { formatDate, todayISO, margin, isISODate } from './utils.js';
import { STATUS, buildGroups, summarize } from './store.js';
import { downloadBlob } from './backup.js';

/* ---------- Paleta e formatos ---------- */

const C = {
    brand: 'FF4A6CF7',
    brandDark: 'FF3A52D9',
    white: 'FFFFFFFF',
    text: 'FF2B2F36',
    muted: 'FF6B7280',
    zebra: 'FFF5F7FF',
    labelBg: 'FFEEF1FB',
    border: 'FFD9DEEA',
    totalBg: 'FFE3E8FB',
    soldBg: 'FFD4EDDA', soldText: 'FF155724',
    stockBg: 'FFE8EDFF', stockText: 'FF3A52D9',
    goodText: 'FF155724',
    badBg: 'FFFDE2E4', badText: 'FF842029'
};

const FMT = {
    brl: '"R$" #,##0.00;[Red]-"R$" #,##0.00',
    pct: '0.0%;[Red]-0.0%',
    int: '#,##0',
    date: 'dd/mm/yyyy'
};

const thin = { style: 'thin', color: { argb: C.border } };
const BORDER = { top: thin, left: thin, bottom: thin, right: thin };
const fill = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });

/* ---------- Carregamento da biblioteca ---------- */

function loadScript(src) {
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.onload = resolve;
        script.onerror = () => reject(new Error('Falha ao carregar ' + src));
        document.head.append(script);
    });
}

async function ensureExcelJS() {
    if (!window.ExcelJS) await loadScript('vendor/exceljs.min.js');
    if (!window.ExcelJS) throw new Error('Módulo Excel indisponível.');
    return window.ExcelJS;
}

/* ---------- Helpers de estilo ---------- */

/** "2026-10-22" -> Date em UTC (evita o dia mudar por causa do fuso na gravação do Excel). */
function toExcelDate(iso) {
    if (!isISODate(iso)) return null;
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d));
}

function styleHeaderRow(row) {
    row.height = 30;
    row.eachCell((cell) => {
        cell.font = { bold: true, color: { argb: C.white }, size: 11 };
        cell.fill = fill(C.brand);
        cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
        cell.border = { ...BORDER, bottom: { style: 'medium', color: { argb: C.brandDark } } };
    });
}

function styleBodyRow(row, index, { numFmts = {}, centered = [] } = {}) {
    row.height = 20;
    row.eachCell({ includeEmpty: true }, (cell, col) => {
        cell.border = BORDER;
        cell.font = { color: { argb: C.text }, size: 11 };
        cell.alignment = { vertical: 'middle', horizontal: centered.includes(col) ? 'center' : undefined };
        if (index % 2 === 1) cell.fill = fill(C.zebra);
        if (numFmts[col]) cell.numFmt = numFmts[col];
    });
}

function styleTotalRow(row, label, labelCol = 1) {
    row.height = 24;
    row.eachCell({ includeEmpty: true }, (cell) => {
        cell.font = { bold: true, color: { argb: C.text }, size: 11 };
        cell.fill = fill(C.totalBg);
        cell.border = { ...BORDER, top: { style: 'medium', color: { argb: C.brand } } };
        cell.alignment = { vertical: 'middle' };
    });
    row.getCell(labelCol).value = label;
}

/** Fórmula SUBTOTAL(109): soma só as linhas visíveis, então os totais acompanham os filtros do Excel. */
function subtotal(col, first, last, result) {
    return { formula: `SUBTOTAL(109,${col}${first}:${col}${last})`, result };
}

function printSetup(sheet, { landscape = true } = {}) {
    sheet.pageSetup = {
        paperSize: 9, // A4
        orientation: landscape ? 'landscape' : 'portrait',
        fitToPage: true, fitToWidth: 1, fitToHeight: 0,
        margins: { left: 0.4, right: 0.4, top: 0.6, bottom: 0.6, header: 0.3, footer: 0.3 }
    };
    sheet.headerFooter = { oddFooter: '&LRevenda+&CPágina &P de &N&R&D' };
}

function sectionTitle(sheet, rowNumber, text, lastCol) {
    sheet.mergeCells(rowNumber, 1, rowNumber, lastCol);
    const cell = sheet.getCell(rowNumber, 1);
    cell.value = text;
    cell.font = { bold: true, size: 13, color: { argb: C.brandDark } };
    cell.alignment = { vertical: 'middle' };
    for (let c = 1; c <= lastCol; c++) {
        sheet.getCell(rowNumber, c).border = { bottom: { style: 'medium', color: { argb: C.brand } } };
    }
    sheet.getRow(rowNumber).height = 24;
}

/* ---------- Planilha: Resumo ---------- */

function buildSummary(workbook, list, filters, s) {
    const sheet = workbook.addWorksheet('Resumo', { properties: { tabColor: { argb: C.brand } }, views: [{ showGridLines: false }] });
    sheet.columns = [{ width: 32 }, { width: 16 }, { width: 14 }, { width: 14 }, { width: 18 }, { width: 18 }, { width: 18 }];
    const LAST = 7;

    // Título
    sheet.mergeCells(1, 1, 1, LAST);
    const title = sheet.getCell(1, 1);
    title.value = 'Revenda+ | Relatório financeiro';
    title.font = { bold: true, size: 18, color: { argb: C.white } };
    title.alignment = { vertical: 'middle', indent: 1 };
    for (let c = 1; c <= LAST; c++) sheet.getCell(1, c).fill = fill(C.brand);
    sheet.getRow(1).height = 40;

    const now = new Date();
    sheet.mergeCells(2, 1, 2, LAST);
    const sub = sheet.getCell(2, 1);
    sub.value = `Gerado em ${formatDate(todayISO())} às ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    sub.font = { italic: true, color: { argb: C.muted } };
    sub.alignment = { indent: 1 };

    // Filtros aplicados
    sectionTitle(sheet, 4, 'Filtros aplicados', LAST);
    const filterRows = [
        ['Mês', filters.month ? `${filters.month.slice(5)}/${filters.month.slice(0, 4)}` : 'Todos'],
        ['Categoria', filters.category || 'Todas'],
        ['Busca por nome', filters.search || '—'],
        ['Status', { estoque: 'Em estoque', vendido: 'Vendidos' }[filters.status] || 'Todos']
    ];
    filterRows.forEach(([label, value], i) => {
        const r = 5 + i;
        sheet.mergeCells(r, 2, r, 3);
        const a = sheet.getCell(r, 1), b = sheet.getCell(r, 2);
        a.value = label; b.value = value;
        a.font = { bold: true, color: { argb: C.text } };
        a.fill = fill(C.labelBg);
        [a, sheet.getCell(r, 3), b].forEach((c) => { c.border = BORDER; });
        b.alignment = { horizontal: 'left', indent: 1 };
        sheet.getRow(r).height = 20;
    });

    // Indicadores
    let r = 10;
    sectionTitle(sheet, r, 'Indicadores', LAST);
    r++;
    sheet.mergeCells(r, 2, r, 3);
    sheet.getCell(r, 1).value = 'Indicador';
    sheet.getCell(r, 2).value = 'Valor';
    styleHeaderRow(sheet.getRow(r));
    sheet.getCell(r, 3).fill = fill(C.brand);
    sheet.getCell(r, 3).border = sheet.getCell(r, 2).border;

    const kpis = [
        ['Unidades no relatório', list.length, FMT.int],
        ['Unidades em estoque', s.unidadesEstoque, FMT.int],
        ['Unidades vendidas', s.unidadesVendidas, FMT.int],
        ['Total investido', s.investido, FMT.brl],
        ['Total vendido (recebido)', s.vendido, FMT.brl],
        ['Lucro líquido', s.lucro, FMT.brl, true],
        ['Lucro potencial do estoque', s.potencial, FMT.brl],
        ['Margem sobre vendas', s.margem / 100, FMT.pct]
    ];
    kpis.forEach(([label, value, numFmt, highlight], i) => {
        const row = r + 1 + i;
        sheet.mergeCells(row, 2, row, 3);
        const a = sheet.getCell(row, 1), b = sheet.getCell(row, 2);
        a.value = label; b.value = value; b.numFmt = numFmt;
        [a, b, sheet.getCell(row, 3)].forEach((c) => {
            c.border = BORDER;
            c.font = { color: { argb: C.text }, size: 11 };
            if (i % 2 === 1) c.fill = fill(C.zebra);
        });
        b.alignment = { horizontal: 'right', indent: 1 };
        if (highlight) {
            const good = value >= 0;
            [a, b, sheet.getCell(row, 3)].forEach((c) => { c.fill = fill(good ? C.soldBg : C.badBg); });
            a.font = { bold: true, color: { argb: good ? C.soldText : C.badText } };
            b.font = { bold: true, size: 12, color: { argb: good ? C.soldText : C.badText } };
        }
        sheet.getRow(row).height = 22;
    });
    r += kpis.length + 3;

    // Por categoria
    sectionTitle(sheet, r, 'Resumo por categoria', LAST);
    r++;
    const header = sheet.getRow(r);
    ['Categoria', 'Unidades', 'Em estoque', 'Vendidas', 'Investido', 'Vendido (recebido)', 'Lucro líquido'].forEach((h, i) => { header.getCell(i + 1).value = h; });
    styleHeaderRow(header);

    const byCategory = new Map();
    list.forEach((p) => {
        const g = byCategory.get(p.categoria) ?? { n: 0, estoque: 0, vendidas: 0, investido: 0, vendido: 0, custoVendidas: 0 };
        g.n++; g.investido += p.valorCompra;
        if (p.status === STATUS.SOLD) { g.vendidas++; g.vendido += p.valorRecebido; g.custoVendidas += p.valorCompra; } else g.estoque++;
        byCategory.set(p.categoria, g);
    });
    const rows = [...byCategory.entries()].sort((a, b) => b[1].investido - a[1].investido);
    const first = r + 1;
    rows.forEach(([name, g], i) => {
        const row = sheet.getRow(first + i);
        const lucro = g.vendido - g.custoVendidas;
        [name, g.n, g.estoque, g.vendidas, g.investido, g.vendido, lucro].forEach((v, c) => { row.getCell(c + 1).value = typeof v === 'number' ? Math.round(v * 100) / 100 : v; });
        styleBodyRow(row, i, { numFmts: { 2: FMT.int, 3: FMT.int, 4: FMT.int, 5: FMT.brl, 6: FMT.brl, 7: FMT.brl }, centered: [2, 3, 4] });
    });
    const last = first + rows.length - 1;
    const total = sheet.getRow(last + 1);
    total.getCell(2).value = subtotal('B', first, last, list.length);
    total.getCell(3).value = subtotal('C', first, last, s.unidadesEstoque);
    total.getCell(4).value = subtotal('D', first, last, s.unidadesVendidas);
    total.getCell(5).value = subtotal('E', first, last, s.investido);
    total.getCell(6).value = subtotal('F', first, last, s.vendido);
    total.getCell(7).value = subtotal('G', first, last, s.lucro);
    styleTotalRow(total, 'Total');
    [2, 3, 4].forEach((c) => { total.getCell(c).numFmt = FMT.int; total.getCell(c).alignment = { horizontal: 'center', vertical: 'middle' }; });
    [5, 6, 7].forEach((c) => { total.getCell(c).numFmt = FMT.brl; });

    printSetup(sheet, { landscape: false });
}

/* ---------- Planilha: Produtos ---------- */

function buildProducts(workbook, list) {
    const sheet = workbook.addWorksheet('Produtos', {
        properties: { tabColor: { argb: 'FF28A745' } },
        views: [{ state: 'frozen', xSplit: 3, ySplit: 1, showGridLines: false }]
    });
    sheet.columns = [
        { header: 'Lançamento', width: 13 },
        { header: 'Categoria', width: 26 },
        { header: 'Produto', width: 36 },
        { header: 'Valor de compra', width: 16 },
        { header: 'Valor de venda (tabela)', width: 18 },
        { header: 'Status', width: 13 },
        { header: 'Data da venda', width: 14 },
        { header: 'Valor recebido', width: 16 },
        { header: 'Lucro realizado', width: 16 },
        { header: 'Lucro previsto (estoque)', width: 18 },
        { header: 'Margem', width: 11 }
    ];
    styleHeaderRow(sheet.getRow(1));

    const sorted = [...list].sort((a, b) => b.dataLancamento.localeCompare(a.dataLancamento) || a.nomeProduto.localeCompare(b.nomeProduto, 'pt-BR'));
    sorted.forEach((p, i) => {
        const sold = p.status === STATUS.SOLD;
        const receita = sold ? p.valorRecebido : p.valorVenda;
        const row = sheet.addRow([
            toExcelDate(p.dataLancamento), p.categoria, p.nomeProduto, p.valorCompra, p.valorVenda, p.status,
            sold ? toExcelDate(p.dataVenda) : null,
            sold ? p.valorRecebido : null,
            sold ? Math.round((p.valorRecebido - p.valorCompra) * 100) / 100 : null,
            sold ? null : Math.round((p.valorVenda - p.valorCompra) * 100) / 100,
            receita > 0 ? margin(receita, p.valorCompra) / 100 : 0
        ]);
        styleBodyRow(row, i, {
            numFmts: { 1: FMT.date, 4: FMT.brl, 5: FMT.brl, 7: FMT.date, 8: FMT.brl, 9: FMT.brl, 10: FMT.brl, 11: FMT.pct },
            centered: [1, 6, 7]
        });
        const status = row.getCell(6);
        status.font = { bold: true, color: { argb: sold ? C.soldText : C.stockText } };
        status.fill = fill(sold ? C.soldBg : C.stockBg);
        const realizado = row.getCell(9);
        if (sold) realizado.font = { bold: true, color: { argb: p.valorRecebido - p.valorCompra >= 0 ? C.goodText : C.badText } };
        row.getCell(10).font = { italic: true, color: { argb: C.muted } };
    });

    const first = 2, last = 1 + sorted.length;
    const s = summarize(list);
    const total = sheet.addRow([]);
    total.getCell(4).value = subtotal('D', first, last, s.investido);
    total.getCell(8).value = subtotal('H', first, last, s.vendido);
    total.getCell(9).value = subtotal('I', first, last, s.lucro);
    total.getCell(10).value = subtotal('J', first, last, s.potencial);
    styleTotalRow(total, 'Total (acompanha os filtros do Excel)', 1);
    [4, 8, 9, 10].forEach((c) => { total.getCell(c).numFmt = FMT.brl; });
    for (let c = 1; c <= 11; c++) total.getCell(c).border = { ...BORDER, top: { style: 'medium', color: { argb: C.brand } } };

    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: last, column: 11 } };
    printSetup(sheet);
    sheet.pageSetup.printTitlesRow = '1:1';
}

/* ---------- Planilha: Estoque agrupado ---------- */

function buildStock(workbook, list) {
    const sheet = workbook.addWorksheet('Estoque agrupado', {
        properties: { tabColor: { argb: 'FFF59E0B' } },
        views: [{ state: 'frozen', xSplit: 1, ySplit: 1, showGridLines: false }]
    });
    sheet.columns = [
        { header: 'Produto', width: 36 },
        { header: 'Categoria', width: 26 },
        { header: 'Em estoque', width: 13 },
        { header: 'Vendidas', width: 12 },
        { header: 'Valor de compra', width: 16 },
        { header: 'Valor de venda', width: 16 },
        { header: 'Lucro unitário', width: 15 },
        { header: 'Lucro potencial', width: 17 }
    ];
    styleHeaderRow(sheet.getRow(1));

    const groups = buildGroups(list);
    groups.forEach((g, i) => {
        const p = g.sample;
        const lucroUnit = Math.round((p.valorVenda - p.valorCompra) * 100) / 100;
        const row = sheet.addRow([p.nomeProduto, p.categoria, g.estoque.length, g.vendidos.length, p.valorCompra, p.valorVenda, lucroUnit, Math.round(lucroUnit * g.estoque.length * 100) / 100]);
        styleBodyRow(row, i, { numFmts: { 3: FMT.int, 4: FMT.int, 5: FMT.brl, 6: FMT.brl, 7: FMT.brl, 8: FMT.brl }, centered: [3, 4] });
        if (g.estoque.length === 0) { // esgotado: destaque
            const cell = row.getCell(3);
            cell.fill = fill(C.badBg);
            cell.font = { bold: true, color: { argb: C.badText } };
        }
        if (lucroUnit < 0) row.getCell(7).font = { bold: true, color: { argb: C.badText } };
    });

    const first = 2, last = 1 + groups.length;
    const s = summarize(list);
    const total = sheet.addRow([]);
    total.getCell(3).value = subtotal('C', first, last, s.unidadesEstoque);
    total.getCell(4).value = subtotal('D', first, last, s.unidadesVendidas);
    total.getCell(8).value = subtotal('H', first, last, s.potencial);
    styleTotalRow(total, 'Total');
    [3, 4].forEach((c) => { total.getCell(c).numFmt = FMT.int; total.getCell(c).alignment = { horizontal: 'center', vertical: 'middle' }; });
    total.getCell(8).numFmt = FMT.brl;

    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: last, column: 8 } };
    printSetup(sheet);
    sheet.pageSetup.printTitlesRow = '1:1';
}

/* ---------- API ---------- */

export async function exportExcel(list, filters = {}) {
    const ExcelJS = await ensureExcelJS();
    const s = summarize(list);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Revenda+';
    workbook.created = new Date();
    workbook.title = 'Relatório Revenda+';

    buildSummary(workbook, list, filters, s);
    buildProducts(workbook, list);
    buildStock(workbook, list);

    const buffer = await workbook.xlsx.writeBuffer();
    downloadBlob(
        new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
        `relatorio-revenda-${todayISO()}.xlsx`
    );
    return { rows: list.length };
}
