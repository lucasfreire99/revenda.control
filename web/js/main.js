// Ponto de entrada: liga store, views e eventos.

import { $, el, toast, openModal, closeModal, initModal } from './dom.js';
import * as store from './store.js';
import {
    CATEGORIES, DEFAULT_CATEGORY, todayISO, formatCurrency, formatDate, formatPercent,
    margin, round2, clampInt, daysSince
} from './utils.js';
import { renderStats, renderProducts, unitDetails, groupDetails } from './views.js';
import { initChart, updateChart, applyChartTheme } from './charts.js';
import { exportExcel } from './exporter.js';
import { exportBackup, getLastBackup, backupIsStale, readBackupFile, setBackupScope } from './backup.js';
import { initPWA } from './pwa.js';
import { checkConfig, PROBLEMS } from './config.js';
import * as auth from './auth.js';
import { createSync } from './sync.js';
import { initAuthUI, showPanel, showSetupProblem, clearAuthForms } from './auth-ui.js';
import { bindAccount, renderAccount, renderSyncStatus } from './account.js';
import { readLegacyProducts, clearLegacyProducts } from './legacy.js';

const SECTIONS = { home: 'Início', launches: 'Lançamentos', data: 'Conta e dados' };

const lsGet = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
const lsSet = (key, value) => { try { localStorage.setItem(key, value); } catch { /* ignora */ } };

const state = {
    filters: { month: '', category: '', status: '', search: '' },
    mode: lsGet('viewMode') === 'items' ? 'items' : 'grouped',
    editingId: null
};

/* ======================= Tema ======================= */

const currentTheme = () => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');

function setTheme(theme, save = true) {
    document.documentElement.dataset.theme = theme;
    if (save) lsSet('theme', theme);
    $('themeIcon').textContent = theme === 'dark' ? '☀️' : '🌙';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#1a1a1a' : '#4a6cf7');
    applyChartTheme();
}

function bindTheme() {
    $('themeToggle').addEventListener('click', () => setTheme(currentTheme() === 'dark' ? 'light' : 'dark'));
    // Acompanha o sistema apenas se a pessoa nunca escolheu um tema manualmente
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
        if (!lsGet('theme')) setTheme(e.matches ? 'dark' : 'light', false);
    });
}

/* ======================= Navegação ======================= */

const sectionFromHash = () => (SECTIONS[location.hash.slice(1)] ? location.hash.slice(1) : 'home');

function showSection(id) {
    document.querySelectorAll('.section').forEach((s) => s.classList.toggle('active', s.id === id));
    document.querySelectorAll('.tabs a').forEach((a) => {
        if (a.dataset.nav === id) a.setAttribute('aria-current', 'page');
        else a.removeAttribute('aria-current');
    });
    document.title = `${SECTIONS[id]} | Revenda+`;
}

function navigate(id) {
    if (location.hash !== `#${id}`) history.pushState(null, '', `#${id}`);
    showSection(id);
}

function bindNavigation() {
    document.querySelectorAll('[data-nav]').forEach((link) => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            navigate(link.dataset.nav);
            window.scrollTo(0, 0);
            $('main').focus({ preventScroll: true });
        });
    });
    const sync = () => showSection(sectionFromHash());
    window.addEventListener('popstate', sync);
    window.addEventListener('hashchange', sync);
}

/* ======================= Desfazer ======================= */

function announce(message) {
    const version = store.getVersion();
    toast(message, {
        actionLabel: 'Desfazer',
        onAction: () => {
            if (store.undo(version)) toast('Alteração desfeita.');
            else toast('Não dá mais para desfazer: houve outra alteração depois.');
        }
    });
}

/* ======================= Renderização ======================= */

const filtered = () => store.filterProducts(store.getProducts(), state.filters);

function renderAll() {
    const list = store.getProducts();
    refreshCategoryFilter();
    renderStats(store.summarize(list));
    updateChart(store.monthlySeries(list));
    renderLaunches();
    renderDataInfo();
}

function renderLaunches() {
    const items = filtered();
    renderProducts({
        mode: state.mode,
        items,
        groups: state.mode === 'grouped' ? store.buildGroups(items) : [],
        onOpenItem: openUnitDetail,
        onOpenGroup: openGroupDetail
    });
    $('modeGrouped').setAttribute('aria-pressed', String(state.mode === 'grouped'));
    $('modeItems').setAttribute('aria-pressed', String(state.mode === 'items'));
}

function renderDataInfo() {
    const count = store.getProducts().length;
    const last = getLastBackup();
    $('dataInfo').textContent = `${count} unidade(s) cadastrada(s). Último backup: ${last ? formatDate(last) : 'nunca'}.`;

    const stale = count > 0 && backupIsStale();
    $('backupBanner').hidden = !stale;
    if (stale) {
        $('backupBannerText').textContent = last
            ? `Seu último backup foi há ${daysSince(last)} dias.`
            : 'Você ainda não fez nenhum backup dos seus dados.';
    }
}

async function renderStorageInfo({ requestPersist = false } = {}) {
    const parts = [];
    try {
        if (navigator.storage?.persisted) {
            let persisted = await navigator.storage.persisted();
            if (!persisted && requestPersist && navigator.storage.persist) persisted = await navigator.storage.persist();
            parts.push(persisted
                ? 'Armazenamento protegido contra limpeza automática: sim.'
                : 'Armazenamento protegido contra limpeza automática: não — por isso o backup é importante.');
        }
        if (navigator.storage?.estimate) {
            const { usage } = await navigator.storage.estimate();
            parts.push(`Espaço usado: ${Math.max(1, Math.round(usage / 1024))} KB.`);
        }
    } catch { /* recurso indisponível */ }
    $('storageInfo').textContent = parts.join(' ');
}

/* ======================= Formulário ======================= */

function populateCategories() {
    $('categoria').replaceChildren(...CATEGORIES.map((c) => new Option(c, c)));
    $('categoria').value = DEFAULT_CATEGORY;
    refreshCategoryFilter();
}

/** Filtro: categorias da lista + eventuais categorias antigas que ainda existam nos dados. */
function refreshCategoryFilter() {
    const select = $('filterCategory');
    const previous = select.value;
    const extras = [...new Set(store.getProducts().map((p) => p.categoria))]
        .filter((c) => !CATEGORIES.includes(c))
        .sort((a, b) => a.localeCompare(b, 'pt-BR'));
    select.replaceChildren(
        new Option('Todas as categorias', ''),
        ...[...CATEGORIES, ...extras].map((c) => new Option(c, c))
    );
    select.value = [...CATEGORIES, ...extras].includes(previous) ? previous : '';
    if (select.value !== previous) state.filters.category = select.value;
}

function updatePriceFeedback() {
    const compra = parseFloat($('valorCompra').value);
    const venda = parseFloat($('valorVenda').value);
    const warning = $('priceWarning');
    if (Number.isFinite(compra) && Number.isFinite(venda)) {
        $('priceHint').textContent = `Lucro por unidade: ${formatCurrency(venda - compra)} (${formatPercent(margin(venda, compra))} de margem).`;
        warning.hidden = venda >= compra;
        if (venda < compra) {
            warning.textContent = `Atenção: o valor de venda é menor que o de compra. Você terá prejuízo de ${formatCurrency(compra - venda)} por unidade.`;
        }
    } else {
        $('priceHint').textContent = '';
        warning.hidden = true;
    }
}

function resetForm({ keepCategory = true } = {}) {
    const category = $('categoria').value;
    state.editingId = null;
    $('productForm').reset();
    [...$('categoria').options].forEach((o) => { if (!CATEGORIES.includes(o.value)) o.remove(); }); // tira a opção "(antiga)"
    $('categoria').value = keepCategory && CATEGORIES.includes(category) ? category : DEFAULT_CATEGORY;
    $('dataLancamento').value = todayISO();
    $('quantidade').disabled = false;
    $('quantidade').value = '1';
    $('formTitle').textContent = 'Cadastrar novo produto';
    $('submitBtn').textContent = 'Adicionar produto';
    $('cancelEdit').hidden = true;
    $('applyGroupWrap').hidden = true;
    $('applyGroup').checked = false;
    updatePriceFeedback();
}

function startEdit(product, { fromGroup = false } = {}) {
    state.editingId = product.id;
    // Produto com categoria antiga (fora da lista nova): mostra a opção só durante a edição
    if (![...$('categoria').options].some((o) => o.value === product.categoria)) {
        $('categoria').append(new Option(`${product.categoria} (antiga)`, product.categoria));
    }
    $('categoria').value = product.categoria;
    $('dataLancamento').value = product.dataLancamento;
    $('nomeProduto').value = product.nomeProduto;
    $('quantidade').value = '1';
    $('quantidade').disabled = true; // quantidade não se edita: adicione ou exclua unidades
    $('valorCompra').value = product.valorCompra;
    $('valorVenda').value = product.valorVenda;
    $('formTitle').textContent = 'Editar produto';
    $('submitBtn').textContent = 'Salvar alterações';
    $('cancelEdit').hidden = false;

    const key = store.groupKey(product);
    const sameInStock = product.status === store.STATUS.STOCK
        ? store.getProducts().filter((p) => p.status === store.STATUS.STOCK && store.groupKey(p) === key).length
        : 0;
    $('applyGroupWrap').hidden = sameInStock < 2;
    $('applyGroup').checked = fromGroup && sameInStock >= 2;
    $('applyGroupText').textContent = `Aplicar a todas as ${sameInStock} unidades iguais em estoque`;
    updatePriceFeedback();

    navigate('home');
    const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    $('productForm').scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
    $('nomeProduto').focus({ preventScroll: true });
}

function onSubmit(event) {
    event.preventDefault();
    const nome = $('nomeProduto').value.trim();
    if (!nome) {
        toast('Informe o nome do produto.');
        $('nomeProduto').focus();
        return;
    }
    const data = {
        categoria: $('categoria').value,
        dataLancamento: $('dataLancamento').value,
        nomeProduto: nome,
        valorCompra: parseFloat($('valorCompra').value),
        valorVenda: parseFloat($('valorVenda').value)
    };

    if (state.editingId) {
        const applyGroup = $('applyGroup').checked && !$('applyGroupWrap').hidden;
        const changed = store.updateProduct(state.editingId, data, { applyToGroup: applyGroup });
        resetForm({ keepCategory: false });
        announce(changed > 1 ? `${changed} unidades atualizadas.` : 'Produto atualizado.');
    } else {
        const quantity = clampInt($('quantidade').value, 1, 999);
        const added = store.addProducts({ ...data, quantidade: quantity });
        resetForm();
        $('nomeProduto').focus();
        announce(`${added} unidade(s) adicionada(s).`);
        renderStorageInfo({ requestPersist: true }); // pedido feito após um gesto do usuário
    }
}

function bindForm() {
    $('productForm').addEventListener('submit', onSubmit);
    $('cancelEdit').addEventListener('click', () => resetForm({ keepCategory: false }));
    $('valorCompra').addEventListener('input', updatePriceFeedback);
    $('valorVenda').addEventListener('input', updatePriceFeedback);
}

/* ======================= Modais ======================= */

const field = (label, id, input) => el('div', { class: 'form-group' }, el('label', { for: id }, label), input);

function openSaleDialog(items) {
    const first = items[0];
    const multi = items.length > 1;

    const date = el('input', { type: 'date', id: 'saleDate', required: true });
    date.value = todayISO();
    const received = el('input', { type: 'number', id: 'saleValue', step: '0.01', min: '0', inputmode: 'decimal', required: true });
    received.value = String(first.valorVenda);
    const qty = multi
        ? el('input', { type: 'number', id: 'saleQty', min: '1', max: String(items.length), step: '1', inputmode: 'numeric', required: true })
        : null;
    if (qty) qty.value = '1';

    const form = el('form', { class: 'dialog-form' },
        field('Data da venda', 'saleDate', date),
        qty ? field(`Quantidade (disponível: ${items.length})`, 'saleQty', qty) : null,
        field('Valor recebido por unidade (R$)', 'saleValue', received),
        el('p', { class: 'modal-note' }, `Preço de tabela: ${formatCurrency(first.valorVenda)}. Se deu desconto, ajuste o valor recebido.`),
        el('button', { type: 'submit', class: 'btn btn-success' }, 'Confirmar venda')
    );

    form.addEventListener('submit', (e) => {
        e.preventDefault();
        const n = qty ? clampInt(qty.value, 1, items.length) : 1;
        const value = parseFloat(received.value);
        store.sellProducts(items.slice(0, n).map((p) => p.id), { dataVenda: date.value, valorRecebido: value });
        closeModal();
        announce(`${n} venda(s) registrada(s): ${formatCurrency(round2(value * n))}.`);
    });

    openModal({
        title: multi ? `Registrar venda: ${first.nomeProduto}` : 'Registrar venda',
        content: form,
        actions: [{ label: 'Cancelar', className: 'btn-secondary' }]
    });
}

function openUnitDetail(id) {
    const p = store.getProducts().find((x) => x.id === id);
    if (!p) return;
    const sold = p.status === store.STATUS.SOLD;
    const actions = [];

    if (sold) {
        actions.push({
            label: 'Reverter venda', className: 'btn-warning',
            onClick: () => { store.revertSale(p.id); announce('Venda revertida.'); }
        });
    } else {
        actions.push({ label: 'Registrar venda', className: 'btn-success', onClick: () => openSaleDialog([p]) });
    }
    actions.push({ label: 'Editar', className: 'btn-info', onClick: () => startEdit(p) });
    actions.push({
        label: 'Excluir', className: 'btn-danger',
        onClick: () => { store.removeProduct(p.id); announce('Produto excluído.'); }
    });

    openModal({ title: 'Detalhes do produto', content: unitDetails(p), actions });
}

function openGroupDetail(key) {
    const group = store.buildGroups(filtered()).find((g) => g.key === key);
    if (!group) return;
    const actions = [];

    if (group.estoque.length > 0) {
        actions.push({ label: 'Registrar venda', className: 'btn-success', onClick: () => openSaleDialog(group.estoque) });
    }
    actions.push({
        label: 'Editar', className: 'btn-info',
        onClick: () => startEdit(group.estoque[0] ?? group.vendidos[0], { fromGroup: true })
    });
    actions.push({
        label: 'Ver unidades', className: 'btn-secondary',
        onClick: () => {
            state.mode = 'items';
            lsSet('viewMode', 'items');
            state.filters.search = group.sample.nomeProduto;
            $('filterSearch').value = group.sample.nomeProduto;
            renderLaunches();
        }
    });
    if (group.estoque.length > 0) {
        actions.push({
            label: 'Excluir 1 unidade', className: 'btn-danger',
            onClick: () => { store.removeProduct(group.estoque[0].id); announce('1 unidade excluída.'); }
        });
    }

    openModal({ title: 'Detalhes do produto', content: groupDetails(group), actions });
}

/* ======================= Filtros ======================= */

function bindFilters() {
    const sync = () => {
        state.filters = {
            month: $('filterMonth').value,
            category: $('filterCategory').value,
            status: $('filterStatus').value,
            search: $('filterSearch').value
        };
        renderLaunches();
    };
    ['filterMonth', 'filterCategory', 'filterStatus'].forEach((id) => $(id).addEventListener('change', sync));
    $('filterSearch').addEventListener('input', sync);

    $('resetFilters').addEventListener('click', () => {
        $('filterMonth').value = '';
        $('filterSearch').value = '';
        $('filterCategory').value = '';
        $('filterStatus').value = '';
        sync();
    });

    const setMode = (mode) => { state.mode = mode; lsSet('viewMode', mode); renderLaunches(); };
    $('modeGrouped').addEventListener('click', () => setMode('grouped'));
    $('modeItems').addEventListener('click', () => setMode('items'));

    $('exportReports').addEventListener('click', async (e) => {
        const button = e.currentTarget;
        const items = filtered();
        if (items.length === 0) { toast('Não há produtos para exportar com os filtros atuais.'); return; }
        button.disabled = true;
        try {
            await exportExcel(items, state.filters);
            toast('Relatório gerado.');
        } catch (err) {
            console.error(err);
            toast('Não foi possível gerar o Excel. Tente novamente.');
        } finally {
            button.disabled = false;
        }
    });
}

/* ======================= Dados / backup ======================= */

function doBackup() {
    const count = exportBackup();
    renderDataInfo();
    toast(`Backup baixado (${count} unidade(s)).`);
}

function confirmImport(list, skipped) {
    const current = store.getProducts().length;
    const skippedText = skipped ? ` ${skipped} registro(s) inválido(s) foram ignorados.` : '';
    openModal({
        title: 'Restaurar backup',
        content: [
            el('p', { class: 'modal-note' }, `O arquivo tem ${list.length} unidade(s). Hoje há ${current} na sua conta.${skippedText}`),
            el('p', { class: 'modal-note' }, 'Mesclar adiciona só o que ainda não existe. Substituir apaga o que está aqui e usa o conteúdo do arquivo.')
        ],
        actions: [
            {
                label: 'Mesclar', className: 'btn-primary',
                onClick: () => announce(`${store.importProducts(list, 'merge')} unidade(s) adicionada(s).`)
            },
            {
                label: 'Substituir tudo', className: 'btn-danger',
                onClick: () => { store.importProducts(list, 'replace'); announce(`Backup restaurado: ${list.length} unidade(s).`); }
            },
            { label: 'Cancelar', className: 'btn-secondary' }
        ]
    });
}

function bindData() {
    $('exportBackup').addEventListener('click', doBackup);
    $('backupBannerBtn').addEventListener('click', doBackup);

    $('importFile').addEventListener('change', async (e) => {
        const file = e.target.files[0];
        e.target.value = '';
        if (!file) return;
        try {
            const { products, skipped } = await readBackupFile(file);
            confirmImport(products, skipped);
        } catch (err) {
            toast(err.message, { duration: 8000 });
        }
    });

    $('clearAll').addEventListener('click', () => {
        const count = store.getProducts().length;
        if (count === 0) { toast('Não há produtos para apagar.'); return; }
        openModal({
            title: 'Apagar todos os dados?',
            content: el('p', { class: 'modal-note' }, `Isso remove as ${count} unidade(s) da sua conta (nuvem e este aparelho). Considere baixar um backup antes.`),
            actions: [
                { label: 'Baixar backup antes', className: 'btn-primary', onClick: doBackup },
                { label: 'Apagar tudo', className: 'btn-danger', onClick: () => { store.clearAll(); announce('Todos os dados foram apagados.'); } },
                { label: 'Cancelar', className: 'btn-secondary' }
            ]
        });
    });
}

/* ======================= Sessão (login + sincronização) ======================= */

const session = { user: null, sync: null, recovering: false };

function onSyncStatus(status) {
    renderSyncStatus(status);
    renderLoading(status);
}

/** Faixa no topo enquanto os dados da nuvem ainda não chegaram (primeiro acesso neste aparelho). */
function renderLoading(status) {
    const banner = $('loadingBanner');
    const waiting = !status.loaded;
    banner.hidden = !waiting;
    if (!waiting) return;
    const failed = status.state === 'offline' || status.state === 'error';
    $('loadingBannerText').textContent = failed
        ? `Não foi possível carregar seus dados ainda. ${status.state === 'offline' ? 'Sem internet.' : (status.message || '')}`.trim()
        : 'Carregando seus dados…';
    $('loadingRetry').hidden = !failed;
}

function resetViewState() {
    state.filters = { month: '', category: '', status: '', search: '' };
    ['filterMonth', 'filterSearch', 'filterCategory', 'filterStatus'].forEach((id) => { $(id).value = ''; });
    resetForm({ keepCategory: false });
    $('toasts').replaceChildren();
}

function enterApp(user) {
    if (session.user?.id === user.id) return;   // o Supabase repete SIGNED_IN ao voltar para a aba
    if (session.user) leaveApp();
    session.user = user;
    session.recovering = false;

    setBackupScope(user.id);
    clearAuthForms();
    resetViewState();
    document.body.dataset.auth = 'in';
    $('authScreen').hidden = true;

    session.sync = createSync({
        client: auth.getClient(),
        userId: user.id,
        store,
        onStatus: onSyncStatus,
        onAuthExpired: () => leaveApp({ message: 'Sua sessão expirou. Entre novamente para continuar sincronizando.' })
    });
    renderAccount(user);
    const { hadCache } = session.sync.start();
    onSyncStatus(session.sync.status());
    if (!hadCache) renderLoading(session.sync.status());

    showSection(sectionFromHash());
    renderAll();
    renderStorageInfo();
    offerLegacyImport();
}

function leaveApp({ message, kind = 'error' } = {}) {
    if (session.sync) { session.sync.stop(); session.sync = null; }
    const had = session.user !== null;
    session.user = null;
    store.setChangeHandler(null);
    store.replaceAll([]);          // nada da conta anterior fica na tela
    setBackupScope('');
    closeModal();
    if (had || message) {
        showPanel('login', { message, kind });
        $('loginEmail').value = '';
    }
}

/* ----- dados da versão antiga ----- */

function legacyAskedKey() { return `rp2:${session.user?.id}:legacyAsked`; }

function renderLegacyCard() {
    const list = readLegacyProducts();
    $('legacyCard').hidden = list.length === 0;
    $('legacyCount').textContent = String(list.length);
    return list;
}

function importLegacy(list) {
    const added = store.importProducts(list, 'merge');
    clearLegacyProducts();
    renderLegacyCard();
    announce(`${added} unidade(s) da versão antiga importada(s).`);
}

function offerLegacyImport() {
    const list = renderLegacyCard();
    if (list.length === 0) return;
    let asked = false;
    try { asked = localStorage.getItem(legacyAskedKey()) === '1'; } catch { /* ignora */ }
    if (asked) return;
    try { localStorage.setItem(legacyAskedKey(), '1'); } catch { /* ignora */ }
    openModal({
        title: 'Importar dados antigos?',
        content: el('p', { class: 'modal-note' }, `Encontramos ${list.length} unidade(s) salvas neste aparelho pela versão antiga do app. Quer importar para a conta ${session.user.email ?? ''}? Depois da importação, a cópia antiga é removida daqui.`),
        actions: [
            { label: 'Importar agora', className: 'btn-primary', onClick: () => importLegacy(list) },
            { label: 'Agora não', className: 'btn-secondary' }
        ]
    });
}

function bindSession() {
    $('legacyImportBtn').addEventListener('click', () => importLegacy(readLegacyProducts()));
    $('loadingRetry').addEventListener('click', () => session.sync?.syncNow());

    bindAccount({ getSync: () => session.sync, leave: (opts) => leaveApp(opts) });

    // Ao esconder a página (trocar de aba/app), tenta enviar o que estiver pendente.
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden' && session.sync?.pendingCount()) session.sync.flush();
    });
    window.addEventListener('pagehide', () => { session.sync?.flush(); });
}

function handleAuthEvent(event, authSession) {
    // Não chame o Supabase dentro deste callback: adie para fora dele.
    if (event === 'PASSWORD_RECOVERY') {
        session.recovering = true;
        showPanel('newpass', { message: 'Escolha uma nova senha para continuar.', kind: 'ok' });
        return;
    }
    if (event === 'SIGNED_OUT') {
        setTimeout(() => { if (session.user) leaveApp(); }, 0);
        return;
    }
    if (event === 'SIGNED_IN' && authSession?.user && !session.recovering) {
        setTimeout(() => enterApp(authSession.user), 0);
    }
}

async function startSession() {
    const config = checkConfig();
    if (!config.ok) { showSetupProblem(PROBLEMS[config.problem]); return; }
    if (!window.supabase?.createClient) {
        showSetupProblem('A biblioteca de login não carregou. Confira se o arquivo vendor/supabase.js está publicado e recarregue a página.');
        return;
    }

    initAuthUI({
        onSession: (s) => { session.recovering = false; enterApp(s.user); }
    });
    auth.onAuthChange(handleAuthEvent);

    const restored = await auth.restoreSession();
    const urlMessage = auth.consumeUrlParams();

    if (session.recovering) return;                       // abriu pelo link de recuperar senha
    if (restored.session) enterApp(restored.session.user);
    else if (restored.offlineUser) enterApp(restored.offlineUser);
    else showPanel('login', { message: urlMessage });
}

/* ======================= Inicialização ======================= */

async function init() {
    initModal();
    populateCategories();
    setTheme(currentTheme(), false);
    bindTheme();
    bindNavigation();
    bindForm();
    bindFilters();
    bindData();
    bindSession();

    $('dataLancamento').value = todayISO();

    initChart($('monthlyChart'));
    store.subscribe(renderAll);
    initPWA();

    try {
        await startSession();
    } catch (err) {
        console.error(err);
        showSetupProblem('Não foi possível iniciar o login. Recarregue a página. Se continuar, confira a configuração em js/config.js.');
    }
}

init();
