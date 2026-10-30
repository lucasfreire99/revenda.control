// Gráfico mensal (Chart.js carregado localmente em vendor/chart.umd.js).

import { el } from './dom.js';
import { formatCurrency } from './utils.js';

let chart = null;
let canvasRef = null;

const compact = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', notation: 'compact', maximumFractionDigits: 1 });
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function initChart(canvas) {
    canvasRef = canvas;
    if (typeof window.Chart === 'undefined') {
        canvas.replaceWith(el('p', { class: 'empty' }, 'Não foi possível carregar o gráfico.'));
        return;
    }
    chart = new window.Chart(canvas.getContext('2d'), {
        type: 'bar',
        data: {
            labels: [],
            datasets: [
                { label: 'Compras', data: [], backgroundColor: '#4a6cf7', borderRadius: 6 },
                { label: 'Vendas', data: [], backgroundColor: '#28a745', borderRadius: 6 },
                {
                    type: 'line', label: 'Lucro', data: [],
                    borderColor: '#f59e0b', backgroundColor: '#f59e0b',
                    tension: 0.3, pointRadius: 4, pointHoverRadius: 6
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { labels: { usePointStyle: true } },
                tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${formatCurrency(ctx.parsed.y)}` } }
            },
            scales: {
                x: { grid: { display: false }, ticks: {} },
                y: { beginAtZero: true, grid: {}, ticks: { callback: (v) => compact.format(v) } }
            }
        }
    });
    applyChartTheme();
}

/** Reaplica as cores do texto/grade conforme o tema atual. */
export function applyChartTheme() {
    if (!chart) return;
    const text = cssVar('--text');
    chart.options.color = text;
    chart.options.scales.x.ticks.color = text;
    chart.options.scales.y.ticks.color = text;
    chart.options.scales.y.grid.color = cssVar('--border');
    chart.update('none');
}

export function updateChart({ labels, compras, vendas, lucro }) {
    if (!chart) return;
    chart.data.labels = labels;
    chart.data.datasets[0].data = compras;
    chart.data.datasets[1].data = vendas;
    chart.data.datasets[2].data = lucro;
    chart.update();

    // Alternativa em texto para leitores de tela
    const resumo = labels.map((l, i) =>
        `${l}: compras ${formatCurrency(compras[i])}, vendas ${formatCurrency(vendas[i])}, lucro ${formatCurrency(lucro[i])}`
    ).join('; ');
    canvasRef.setAttribute('aria-label', `Compras, vendas e lucro dos últimos ${labels.length} meses. ${resumo}`);
}
