# Revenda+ | Controle Financeiro — versão online (SaaS)

App para revendedoras controlarem estoque, vendas e lucro, agora **online, com login e banco de dados no Supabase (Postgres/SQL)**.
Cada pessoa cria a própria conta e **só enxerga os próprios dados**. Continua instalável (PWA) e **funciona sem internet**: o que for feito offline é enviado quando a conexão voltar.

```
revenda-saas/
├─ supabase/
│  ├─ setup-completo.sql        ← cole este arquivo no SQL Editor do Supabase (tudo em um só)
│  └─ migrations/               ← os mesmos scripts separados (para a CLI do Supabase)
├─ web/                         ← o site (é esta pasta que vai para a hospedagem)
│  ├─ index.html, css/, js/, vendor/, icons/, sw.js, manifest.webmanifest
│  ├─ js/config.js              ← ÚNICO arquivo que você edita (URL e chave pública)
│  └─ _headers                  ← cabeçalhos de segurança (CSP etc.)
├─ tests/ e scripts/            ← testes automatizados e utilitários
├─ netlify.toml / vercel.json   ← configuração das hospedagens
└─ README.md
```

## Como funciona (resumo)

| Parte | O que faz |
|---|---|
| **Supabase Auth** | Cadastro e login por e-mail e senha. Confirmação de e-mail e recuperação de senha por **código** (funciona também no app instalado). |
| **Tabelas SQL** | `profiles` (nome) e `products` (os produtos), criadas pelo `setup-completo.sql`. |
| **RLS (segurança por linha)** | O próprio banco só deixa cada conta ler/gravar as **suas** linhas. Mesmo que alguém abra o site e mexa no código, não alcança dados de outra pessoa. |
| **Sincronização** | O app guarda uma cópia no aparelho e envia as alterações em segundo plano (com tentativas automáticas). O botão no topo mostra *Sincronizado / Sincronizando / Sem internet / N pendentes*. |

---

## Passo a passo para colocar no ar

### 1. Criar o projeto no Supabase
1. Crie uma conta em <https://supabase.com> e clique em **New project**. Guarde a senha do banco.
2. Escolha a região mais próxima (ex.: *South America (São Paulo)*).

### 2. Criar as tabelas (SQL)
1. No painel: **SQL Editor → New query**.
2. Abra o arquivo **`supabase/setup-completo.sql`**, copie tudo, cole e clique em **Run**. Deve aparecer *Success*.
3. Pode rodar de novo sem problema (o script é idempotente).
4. Conferência: em **Table Editor** devem existir `profiles` e `products`, ambas com o cadeado de **RLS ativado**.

> Prefere a CLI? `supabase link --project-ref SEU_REF` e depois `supabase db push` aplica a pasta `supabase/migrations/`.

### 3. Configurar o login (Authentication)
1. **Authentication → URL Configuration**
   - **Site URL**: o endereço final do app (ex.: `https://seuapp.netlify.app`).
   - **Redirect URLs**: adicione o mesmo endereço e, para testar, `http://localhost:8080/**`.
2. **Authentication → Sign In / Providers → Email**: deixe **Confirm email** ligado e defina o **tamanho mínimo da senha em 8** (o app também exige 8).
3. **Authentication → Email Templates** — troque os modelos **Confirm signup** e **Reset password** para mostrarem o código. Exemplo:
   ```html
   <h2>Seu código do Revenda+</h2>
   <p>Digite este código no app: <strong>{{ .Token }}</strong></p>
   ```
   (O app pede o código digitado; o link do e-mail também funciona, mas o código é o que funciona no app instalado.)
4. **E-mail de produção**: o envio padrão do Supabase é só para testes (poucos e-mails por hora). Para valer, configure um SMTP próprio em **Project Settings → Authentication → SMTP Settings** (Resend, Brevo, Amazon SES, etc.).
5. Opcional: ative **CAPTCHA** em *Authentication → Attack Protection* contra criação automática de contas.

### 4. Conectar o site ao Supabase
1. **Project Settings → API Keys**: copie a **Project URL** e a chave **publishable** (ou a antiga *anon*).
2. Abra **`web/js/config.js`** e cole:
   ```js
   export const SUPABASE_URL = 'https://xxxxxxxx.supabase.co';
   export const SUPABASE_ANON_KEY = 'sb_publishable_...';
   ```
3. ⚠️ **Nunca** cole a chave `secret` / `service_role`. O app recusa iniciar se detectar isso. A chave pública pode ficar no site: quem protege os dados é o RLS.

### 5. Testar no seu computador
```bash
npm install        # só para os testes; o site em si não precisa de build
npm run dev        # abre http://localhost:8080 com os mesmos cabeçalhos de segurança da produção
```
Crie uma conta, cadastre produtos e veja as linhas aparecerem em **Table Editor → products**.

### 6. Publicar (escolha uma)
O site é estático: publique **a pasta `web/`**. Precisa de **HTTPS** (todas abaixo já dão).

- **Netlify** — arraste a pasta `web/` em <https://app.netlify.com/drop>, ou conecte o repositório (o `netlify.toml` já aponta para `web`). Os cabeçalhos vêm de `web/_headers`.
- **Vercel** — importe o repositório; o `vercel.json` já define `web` como saída e os cabeçalhos.
- **Cloudflare Pages** — diretório de saída `web`, sem comando de build. Usa o `_headers`.
- GitHub Pages também serve, mas **não aplica** o `_headers` (fica sem CSP). Prefira uma das três acima.

Depois de publicar, volte ao passo 3 e confirme a **Site URL** com o endereço definitivo.

### 7. Atualizações futuras
Sempre que mudar qualquer arquivo de `web/`, **aumente o `VERSION` em `web/sw.js`** (ex.: `v2.0.1`). Quem usa o app verá o aviso “Há uma nova versão” e atualiza com um toque.

---

## Segurança — checklist
- [x] RLS ligado nas duas tabelas; `anon` (sem login) não acessa nada.
- [x] `user_id` é preenchido pelo banco (`auth.uid()`), não pelo app, e não pode ser alterado.
- [x] Conta excluída apaga todos os dados (função SQL `delete_my_account`, em cascata).
- [x] CSP restritiva (`script-src 'self'`): sem scripts de terceiros; só fala com o próprio site e `*.supabase.co`.
- [x] Nome de produto nunca vira HTML (sem XSS).
- [x] Ao sair da conta, os dados dela são removidos do aparelho.
- [ ] **Você**: SMTP próprio, CAPTCHA (opcional) e **nunca** publicar a chave `service_role`.
- Domínio próprio no Supabase? Ajuste `connect-src` em `web/_headers` e `vercel.json`.

## Testes
```bash
npm test          # 42 testes de unidade (sincronização, store, configuração)
npm run test:sql  # 17 testes do SQL + RLS num Postgres de verdade (PGlite), incluindo isolamento entre contas
npm run test:e2e  # 20 testes no navegador (Chromium) com um Supabase simulado e a CSP real
```
(`test:e2e` precisa do Playwright instalado: `npm i -D playwright && npx playwright install chromium`.)

## Limitações conhecidas
- **Uma conta = uma pessoa.** Não há equipes/compartilhamento (dá para evoluir com uma tabela de membros e novas políticas RLS).
- **Conflitos: vale a última alteração.** Se a mesma conta editar o mesmo produto em dois aparelhos ao mesmo tempo, a gravação mais recente vence.
- Se a sessão expirar offline por muito tempo, é preciso entrar de novo; o que ficou pendente no aparelho é enviado depois do login.
- Relatório Excel e backup JSON continuam funcionando como antes (backup agora é uma segurança extra).
- Dados da versão antiga (salvos só no aparelho) são oferecidos para importação no primeiro login.
