// Teste de ponta a ponta: navegador real (Chromium) + servidor local com os cabeçalhos/CSP reais + Supabase falso.
// Uso: NODE_PATH=<onde está o playwright> node tests/e2e/run.cjs   (SHOTS=pasta para salvar capturas de tela)
const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createFake } = require('./fake-supabase.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const FAKE_ORIGIN = 'https://fakeproj.supabase.co';
const SHOTS = process.env.SHOTS || '';
const PORT_OK = 8181, PORT_RAW = 8182;

const fake = createFake(FAKE_ORIGIN);
const results = []; let current = '';
const problems = [];   // erros de console, violações de CSP

function step(name) { current = name; }
function check(cond, msg) { if (!cond) throw new Error(msg); }
async function test(name, fn) {
    try { await fn(); results.push({ name, ok: true }); console.log(`  ✓ ${name}`); }
    catch (e) {
        results.push({ name, ok: false, err: e }); console.log(`  ✗ ${name}\n      ${String(e.message).split('\n')[0]}`);
        if (global.__page) {
            try {
                const info = await global.__page.evaluate(() => ({ auth: document.body.dataset.auth, modal: document.getElementById('modal').classList.contains('active') ? document.getElementById('modal').innerText.slice(0, 200) : null, msg: document.getElementById('authMsg').textContent, sync: document.getElementById('syncBtn').dataset.state }));
                console.log('      estado:', JSON.stringify(info));
                if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await global.__page.screenshot({ path: path.join(SHOTS, `falha-${results.length}.png`) }); }
            } catch { /* ignora */ }
        }
    }
}

/* ---------- servidores ---------- */
function startServer(rootDir, port) {
    const proc = spawn('node', [path.join(ROOT, 'scripts', 'serve.mjs')], { env: { ...process.env, ROOT: rootDir, PORT: String(port) }, stdio: 'pipe' });
    return new Promise((resolve, reject) => {
        proc.stdout.on('data', (d) => { if (String(d).includes('http://')) resolve(proc); });
        proc.on('error', reject);
        setTimeout(() => reject(new Error('servidor não subiu')), 8000);
    });
}

function makeTestSite() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'revenda-site-'));
    fs.cpSync(path.join(ROOT, 'web'), dir, { recursive: true });
    const cfg = fs.readFileSync(path.join(dir, 'js', 'config.js'), 'utf8')
        .replace("'COLE_AQUI_A_URL_DO_PROJETO'", `'${FAKE_ORIGIN}'`)
        .replace("'COLE_AQUI_A_CHAVE_PUBLICA'", `'${fake.anonKey}'`);
    fs.writeFileSync(path.join(dir, 'js', 'config.js'), cfg);
    return dir;
}

/* ---------- ajudantes de tela ---------- */
const BASE = `http://localhost:${PORT_OK}/`;
const panelVisible = (page, name) => page.locator(`[data-panel="${name}"]`).isVisible();
const waitIn = (page) => page.waitForSelector('body[data-auth="in"]', { timeout: 15000 });
const waitPanel = (page, name) => page.waitForSelector(`[data-panel="${name}"]:not([hidden])`, { timeout: 15000 });
const syncState = (page) => page.locator('#syncBtn').getAttribute('data-state');
const waitState = (page, st) => page.waitForFunction((s) => document.getElementById('syncBtn')?.dataset.state === s, st, { timeout: 15000 });
const waitSynced = async (page) => { await waitState(page, 'synced'); };
const goTab = async (page, id) => { await page.locator(`.tabs a[data-nav="${id}"]`).click(); };
const authMsg = (page) => page.locator('#authMsg').innerText();

async function login(page, email, pw) {
    await waitPanel(page, 'login');
    await page.fill('#loginEmail', email);
    await page.fill('#loginPassword', pw);
    await page.click('#loginForm button[type="submit"]');
}
async function register(page, nome, email, pw) {
    await waitPanel(page, 'login');
    await page.click('[data-panel="login"] [data-go="signup"]');
    await page.fill('#signupName', nome);
    await page.fill('#signupEmail', email);
    await page.fill('#signupPassword', pw);
    await page.click('#signupForm button[type="submit"]');
    await waitPanel(page, 'confirm');
    await page.fill('#confirmCode', fake.OTP);
    await page.click('#confirmForm button[type="submit"]');
    await waitIn(page);
}
async function addProduct(page, nome, qty, compra, venda, categoria = 'Perfume') {
    await goTab(page, 'home');
    await page.selectOption('#categoria', categoria);
    await page.fill('#nomeProduto', nome);
    await page.fill('#quantidade', String(qty));
    await page.fill('#valorCompra', String(compra));
    await page.fill('#valorVenda', String(venda));
    await page.click('#submitBtn');
}
const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name), fullPage: false }); } };

async function newPage(context) {
    const page = await context.newPage();
    page.on('console', (m) => {
        const t = m.text();
        if (/Content Security Policy|Refused to/i.test(t)) problems.push(`CSP: ${t}`);
        else if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(t)) problems.push(`console.error: ${t}`);
    });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    return page;
}

(async () => {
    const siteDir = makeTestSite();
    const servers = [await startServer(siteDir, PORT_OK), await startServer(path.join(ROOT, 'web'), PORT_RAW)];
    const browser = await chromium.launch();
    const A = { nome: 'Ana Revendedora', email: 'ana@example.com', pw: 'senha-da-ana-1' };
    const B = { nome: 'Bia', email: 'bia@example.com', pw: 'senha-da-bia-1' };

    try {
        /* ===== 0. sem configuração ===== */
        await test('sem configurar o Supabase: mostra o aviso e não abre o app', async () => {
            const ctx = await browser.newContext(); const page = await newPage(ctx);
            await page.goto(`http://localhost:${PORT_RAW}/`);
            await waitPanel(page, 'setup');
            check((await page.locator('#setupText').innerText()).includes('config.js'), 'mensagem não cita config.js');
            check(!(await page.locator('main').isVisible()), 'app visível sem login');
            await ctx.close();
        });

        const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'allow' });
        await ctx.route(`${FAKE_ORIGIN}/**`, (r) => fake.handle(r));
        let page = await newPage(ctx);
        global.__page = page;

        await test('abre na tela de entrada; o app fica escondido', async () => {
            await page.goto(BASE);
            await waitPanel(page, 'login');
            check(!(await page.locator('main').isVisible()), 'main visível sem login');
            check(!(await page.locator('.app-header').isVisible()), 'cabeçalho visível sem login');
            await shot(page, 'auth-desktop.png');
        });

        await test('senha errada mostra mensagem em português', async () => {
            await login(page, A.email, 'qualquer-senha');
            await page.waitForFunction(() => !document.getElementById('authMsg').hidden);
            check((await authMsg(page)).includes('incorretos'), `msg: ${await authMsg(page)}`);
        });

        await test('criar conta: código errado falha, código certo entra', async () => {
            await page.click('[data-go="signup"]');
            await page.fill('#signupName', A.nome); await page.fill('#signupEmail', A.email); await page.fill('#signupPassword', 'curta');
            await page.click('#signupForm button[type="submit"]');
            check((await authMsg(page)).includes('8 caracteres'), 'não validou senha curta');
            await page.fill('#signupPassword', A.pw);
            await page.click('#signupForm button[type="submit"]');
            await waitPanel(page, 'confirm');
            check((await page.locator('[data-panel="confirm"] [data-email]').innerText()) === A.email, 'e-mail não aparece');
            await page.fill('#confirmCode', '000000');
            await page.click('#confirmForm button[type="submit"]');
            await page.waitForFunction(() => document.getElementById('authMsg').textContent.includes('inválido'));
            await page.fill('#confirmCode', fake.OTP);
            await page.click('#confirmForm button[type="submit"]');
            await waitIn(page);
            await goTab(page, 'data');
            check((await page.locator('#accountName').innerText()) === A.nome, 'nome da conta');
            check((await page.locator('#accountEmail').innerText()) === A.email, 'e-mail da conta');
        });

        await test('produtos viram linhas da nuvem, só da dona, e o botão passa a "Sincronizado"', async () => {
            await addProduct(page, 'Perfume Floral', 2, 30, 70);
            await waitSynced(page);
            const mine = fake.rowsOf(A.email);
            check(mine.length === 2, `esperava 2 linhas, veio ${mine.length}`);
            check(mine.every((r) => r.nome_produto === 'Perfume Floral' && r.categoria === 'Perfume' && Number(r.valor_venda) === 70), 'campos errados');
            check(mine.every((r) => /^[0-9a-f-]{36}$/.test(r.id)), 'id não é UUID');
        });

        await test('vender e excluir também sincronizam', async () => {
            await goTab(page, 'launches');
            await page.locator('#productsContainer .product-card, #productsContainer [data-id], #productsContainer button').first().click();
            await page.getByRole('button', { name: 'Registrar venda' }).click();
            await page.fill('#saleValue', '65');
            await page.getByRole('button', { name: 'Confirmar venda' }).click();
            await waitSynced(page);
            const sold = fake.rowsOf(A.email).filter((r) => r.status === 'Vendido');
            check(sold.length === 1 && Number(sold[0].valor_recebido) === 65 && sold[0].data_venda, 'venda não chegou ao servidor');
        });

        await test('recarregar a página mantém a sessão e mostra os dados', async () => {
            await page.reload();
            await waitIn(page);
            await goTab(page, 'launches');
            await page.waitForFunction(() => document.getElementById('productsContainer').textContent.includes('Perfume Floral'));
            await waitSynced(page);
        });

        await test('sem internet: cadastra, fica "pendente", sobrevive a recarregar e envia quando volta', async () => {
            await page.evaluate(() => navigator.serviceWorker.ready);
            await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 10000 }).catch(async () => { await page.reload(); await waitIn(page); });
            await ctx.setOffline(true);
            await addProduct(page, 'Hidratante Offline', 1, 10, 25, 'Hidratante');
            await page.waitForFunction(() => /pendente|Sem internet/.test(document.getElementById('syncLabel').textContent));
            check(fake.rowsOf(A.email).length === 2, 'não deveria ter ido ao servidor offline');
            await page.reload();
            await waitIn(page);
            await goTab(page, 'launches');
            await page.waitForFunction(() => document.getElementById('productsContainer').textContent.includes('Hidratante Offline'));
            await ctx.setOffline(false);
            await waitSynced(page);
            check(fake.rowsOf(A.email).length === 3, `depois de voltar: ${fake.rowsOf(A.email).length} linhas`);
        });

        await test('token expirado: renova a sessão sozinho e envia', async () => {
            fake.expireAllTokens();
            const before = fake.log.filter((l) => l.includes('grant_type=refresh_token')).length;
            await addProduct(page, 'Depois de expirar', 1, 5, 12, 'Sabonete');
            await waitSynced(page);
            check(fake.log.filter((l) => l.includes('grant_type=refresh_token')).length > before, 'não renovou o token');
            check(fake.rowsOf(A.email).length === 4, 'não enviou depois de renovar');
        });

        await test('Excel exportado com CSP ativa', async () => {
            await goTab(page, 'launches');
            const [download] = await Promise.all([page.waitForEvent('download'), page.click('#exportReports')]);
            const file = path.join(os.tmpdir(), 'rel-e2e.xlsx');
            await download.saveAs(file);
            check(fs.statSync(file).size > 3000, 'xlsx vazio');
        });

        await test('visual: app logado no desktop e no celular', async () => {
            await goTab(page, 'home');
            await page.waitForTimeout(600);
            await shot(page, 'app-desktop.png');
            await page.setViewportSize({ width: 390, height: 844 });
            await page.waitForTimeout(400);
            await shot(page, 'app-mobile.png');
            await goTab(page, 'data');
            await shot(page, 'conta-mobile.png');
            await page.setViewportSize({ width: 1280, height: 800 });
        });

        await test('sair: pede nada quando está tudo enviado, volta ao login e limpa o aparelho', async () => {
            const uid = fake.users.get(A.email).id;
            await goTab(page, 'data');
            await page.click('#signOutBtn');
            await waitPanel(page, 'login');
            const keys = await page.evaluate(() => Object.keys(localStorage));
            check(!keys.some((k) => k.startsWith(`rp2:${uid}:cache`) || k.startsWith(`rp2:${uid}:pending`)), `sobrou cache: ${keys}`);
            check(!(await page.content()).includes('Perfume Floral'), 'dados da conta A ainda no HTML');
            await shot(page, 'auth-pos-saida.png');
        });

        await test('isolamento: outra conta não vê nada da primeira (no aparelho nem na nuvem)', async () => {
            await register(page, B.nome, B.email, B.pw);
            await goTab(page, 'launches');
            check((await page.locator('#productsContainer').innerText()).includes('Perfume Floral') === false, 'B vê produto da A');
            await addProduct(page, 'Produto da Bia', 1, 8, 20, 'Booster');
            await waitSynced(page);
            check(fake.rowsOf(B.email).length === 1 && fake.rowsOf(A.email).length === 4, 'linhas misturadas');
            await goTab(page, 'data'); await page.click('#signOutBtn'); await waitPanel(page, 'login');
            await login(page, A.email, A.pw);
            await waitIn(page);
            await goTab(page, 'launches');
            await page.waitForFunction(() => document.getElementById('productsContainer').textContent.includes('Perfume Floral'));
            check(!(await page.locator('#productsContainer').innerText()).includes('Produto da Bia'), 'A vê produto da B');
        });

        await test('sessão que não renova: volta ao login sem perder o que estava pendente', async () => {
            fake.ctl.refreshBroken = true; fake.expireAllTokens();
            await addProduct(page, 'Pendente de sessão', 1, 9, 19, 'Esfoliante');
            await waitPanel(page, 'login');
            check((await authMsg(page)).includes('sessão expirou'), `msg: ${await authMsg(page)}`);
            fake.ctl.refreshBroken = false;
            await login(page, A.email, A.pw);
            await waitIn(page);
            await goTab(page, 'launches');
            await page.waitForFunction(() => document.getElementById('productsContainer').textContent.includes('Pendente de sessão'));
            await waitSynced(page);
            check(fake.rowsOf(A.email).some((r) => r.nome_produto === 'Pendente de sessão'), 'pendente não foi enviado depois do novo login');
        });

        await test('abrir offline com token vencido usa os dados do aparelho', async () => {
            await page.evaluate(() => {
                const k = 'revenda-plus-auth'; const s = JSON.parse(localStorage.getItem(k));
                s.expires_at = Math.floor(Date.now() / 1000) - 100; localStorage.setItem(k, JSON.stringify(s));
            });
            await ctx.setOffline(true);
            await page.reload();
            await waitIn(page);
            await goTab(page, 'launches');
            await page.waitForFunction(() => document.getElementById('productsContainer').textContent.includes('Perfume Floral'));
            await ctx.setOffline(false);
        });

        await test('recuperar senha por código e entrar com a nova', async () => {
            await goTab(page, 'data');
            await page.click('#signOutBtn');
            await waitPanel(page, 'login');
            await page.fill('#loginEmail', A.email);
            await page.click('[data-panel="login"] [data-go="forgot"]');
            check((await page.inputValue('#forgotEmail')) === A.email, 'não repetiu o e-mail');
            await page.click('#forgotForm button[type="submit"]');
            await waitPanel(page, 'reset');
            await page.fill('#resetCode', fake.OTP);
            await page.fill('#resetPassword', 'NOVA-senha-2');
            await page.click('#resetForm button[type="submit"]');
            await waitIn(page);
            check(fake.users.get(A.email).password === 'NOVA-senha-2', 'senha não mudou no servidor');
            A.pw = 'NOVA-senha-2';
        });

        await test('trocar senha dentro da conta', async () => {
            await goTab(page, 'data');
            await page.click('#changePasswordBtn');
            await page.fill('#cpNew', 'outra-senha-3'); await page.fill('#cpAgain', 'diferente');
            await page.getByRole('button', { name: 'Salvar nova senha' }).click();
            check((await page.locator('.modal .warning-text').innerText()).includes('não são iguais'), 'não comparou');
            await page.fill('#cpAgain', 'outra-senha-3');
            await page.getByRole('button', { name: 'Salvar nova senha' }).click();
            await page.waitForFunction(() => !document.getElementById('modal').classList.contains('active'));
            check(fake.users.get(A.email).password === 'outra-senha-3', 'senha não mudou');
            A.pw = 'outra-senha-3';
        });

        await test('importa dados da versão antiga (ids numéricos e categoria antiga)', async () => {
            await page.click('#signOutBtn'); await waitPanel(page, 'login');
            const C = { nome: 'Carla', email: 'carla@example.com', pw: 'senha-da-carla-1' };
            await page.evaluate(() => localStorage.setItem('products', JSON.stringify([
                { id: 1700000000001, categoria: 'Hidrante', dataLancamento: '2026-05-01', nomeProduto: 'Velho 1', valorCompra: 10, valorVenda: 25, status: 'Em estoque' },
                { id: 1700000000002, categoria: 'Perfume', dataLancamento: '2026-05-02', nomeProduto: 'Velho 2', valorCompra: 20, valorVenda: 50, status: 'Vendido' }
            ])));
            await register(page, C.nome, C.email, C.pw);
            await page.getByRole('button', { name: 'Importar agora' }).click();
            await waitSynced(page);
            const rows = fake.rowsOf(C.email);
            check(rows.length === 2, `importou ${rows.length}`);
            check(rows.some((r) => r.nome_produto === 'Velho 1' && r.categoria === 'Hidratante'), 'categoria antiga não convertida');
            check(rows.every((r) => /^[0-9a-f-]{36}$/.test(r.id)), 'ids não viraram UUID');
            check(await page.evaluate(() => localStorage.getItem('products')) === null, 'cópia antiga não foi removida');
        });

        await test('excluir a conta: apaga tudo na nuvem e volta ao login', async () => {
            await goTab(page, 'data');
            await page.click('#deleteAccountBtn');
            const confirmBtn = page.getByRole('button', { name: 'Excluir para sempre' });
            check(await confirmBtn.isDisabled(), 'botão liberado sem digitar');
            await page.fill('#delConfirm', 'EXCLUIR');
            await confirmBtn.click();
            await waitPanel(page, 'login');
            check(!fake.users.has('carla@example.com') && fake.rowsOf('carla@example.com').length === 0, 'conta/linhas ainda existem');
            await login(page, 'carla@example.com', 'senha-da-carla-1');
            await page.waitForFunction(() => document.getElementById('authMsg').textContent.includes('incorretos'));
        });

        await test('nenhuma violação de CSP nem erro de console durante todo o fluxo', async () => {
            check(problems.length === 0, problems.slice(0, 5).join(' | '));
        });

        /* ===== celular: tela de entrada ===== */
        const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
        const mpage = await mctx.newPage();
        await mpage.goto(`http://localhost:${PORT_RAW}/`);
        await waitPanel(mpage, 'setup');
        await shot(mpage, 'setup-mobile.png');
        await mctx.close();
        const mctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'dark' });
        await mctx2.route(`${FAKE_ORIGIN}/**`, (r) => fake.handle(r));
        const m2 = await mctx2.newPage();
        await m2.goto(BASE); await waitPanel(m2, 'login'); await shot(m2, 'auth-mobile-dark.png');
        await mctx2.close();
    } finally {
        await browser.close();
        servers.forEach((s) => s.kill());
        fs.rmSync(siteDir, { recursive: true, force: true });
    }

    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} passaram`);
    if (failed.length) { failed.forEach((f) => console.log(`\n✗ ${f.name}\n${f.err.stack.split('\n').slice(0, 4).join('\n')}`)); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
