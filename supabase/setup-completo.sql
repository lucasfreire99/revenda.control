-- =====================================================================
-- Revenda+ | SETUP COMPLETO (gerado por "npm run sql:bundle" — não edite aqui)
-- Cole TUDO no Supabase: SQL Editor > New query > Run.
-- É seguro rodar mais de uma vez.
-- =====================================================================

-- >>>>> 20261029120000_tabelas.sql
-- =====================================================================
-- Revenda+ | 1/3 — Tabelas, índices e gatilhos
-- Rode os 3 arquivos em ordem (ou use o arquivo setup-completo.sql).
-- É seguro rodar de novo: tudo usa "if not exists" / "or replace".
-- =====================================================================

-- ---------------------------------------------------------------------
-- Perfil da usuária (1 linha por conta; criada automaticamente no cadastro)
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
    id          uuid primary key references auth.users (id) on delete cascade,
    nome        text not null default '' check (char_length(nome) <= 120),
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);

comment on table public.profiles is 'Perfil de cada usuária do Revenda+ (uma linha por conta).';

-- ---------------------------------------------------------------------
-- Produtos: UMA LINHA POR UNIDADE (igual ao app). Cada linha pertence a
-- uma usuária (user_id) e só ela consegue ver/alterar (ver RLS no arquivo 2).
-- O id é gerado pelo app (UUID), o que permite cadastrar offline.
-- ---------------------------------------------------------------------
create table if not exists public.products (
    id              uuid primary key default gen_random_uuid(),
    user_id         uuid not null default auth.uid() references auth.users (id) on delete cascade,
    categoria       text not null check (char_length(btrim(categoria)) between 1 and 60),
    data_lancamento date not null,
    nome_produto    text not null check (char_length(btrim(nome_produto)) between 1 and 120),
    valor_compra    numeric(12, 2) not null check (valor_compra >= 0),
    valor_venda     numeric(12, 2) not null check (valor_venda >= 0),
    status          text not null default 'Em estoque' check (status in ('Em estoque', 'Vendido')),
    data_venda      date,
    valor_recebido  numeric(12, 2) check (valor_recebido is null or valor_recebido >= 0),
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),

    -- Vendido => precisa de data e valor recebido; Em estoque => não pode ter nenhum dos dois.
    constraint products_venda_coerente check (
        (status = 'Vendido'    and data_venda is not null and valor_recebido is not null)
        or
        (status = 'Em estoque' and data_venda is null     and valor_recebido is null)
    )
);

comment on table  public.products is 'Uma linha por unidade de produto da revendedora.';
comment on column public.products.valor_recebido is 'Quanto foi realmente recebido na venda (pode ter desconto).';

-- Listagem paginada da usuária (select ... order by created_at, id)
create index if not exists products_user_created_idx on public.products (user_id, created_at, id);
-- Consultas por mês/status
create index if not exists products_user_lancamento_idx on public.products (user_id, data_lancamento);

-- ---------------------------------------------------------------------
-- Gatilhos
-- ---------------------------------------------------------------------

-- Atualiza updated_at a cada alteração.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    new.updated_at := now();
    return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
    before update on public.profiles
    for each row execute function public.set_updated_at();

-- Impede trocar o dono de um produto e preserva created_at.
create or replace function public.protect_products_columns()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    if new.user_id is distinct from old.user_id then
        raise exception 'user_id não pode ser alterado' using errcode = '42501';
    end if;
    new.created_at := old.created_at;
    new.updated_at := now();
    return new;
end;
$$;

drop trigger if exists products_protect_columns on public.products;
create trigger products_protect_columns
    before update on public.products
    for each row execute function public.protect_products_columns();

-- Cria o perfil automaticamente quando uma conta é criada no Supabase Auth.
-- O nome vem do cadastro (options.data.nome no signUp).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    insert into public.profiles (id, nome)
    values (new.id, left(btrim(coalesce(new.raw_user_meta_data ->> 'nome', '')), 120))
    on conflict (id) do nothing;
    return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
    after insert on auth.users
    for each row execute function public.handle_new_user();

-- Contas que já existiam antes deste script também ganham perfil.
insert into public.profiles (id)
select u.id from auth.users u
on conflict (id) do nothing;

-- >>>>> 20261029120100_seguranca_rls.sql
-- =====================================================================
-- Revenda+ | 2/3 — Segurança (Row Level Security)
-- Regra de ouro: cada usuária só enxerga e altera as PRÓPRIAS linhas.
-- Sem estas políticas, qualquer pessoa com a chave pública (anon) leria tudo.
-- =====================================================================

alter table public.profiles enable row level security;
alter table public.products enable row level security;

-- Nada para visitantes não logados; permissões mínimas para quem está logada.
revoke all on public.profiles from anon, public;
revoke all on public.products from anon, public;

grant select, update on public.profiles to authenticated;                 -- criação e exclusão: só por gatilho/cascata
grant select, insert, update, delete on public.products to authenticated;

-- ---------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------
drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
    for select to authenticated
    using (id = (select auth.uid()));

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
    for update to authenticated
    using (id = (select auth.uid()))
    with check (id = (select auth.uid()));

-- ---------------------------------------------------------------------
-- products
-- ---------------------------------------------------------------------
drop policy if exists products_select_own on public.products;
create policy products_select_own on public.products
    for select to authenticated
    using (user_id = (select auth.uid()));

drop policy if exists products_insert_own on public.products;
create policy products_insert_own on public.products
    for insert to authenticated
    with check (user_id = (select auth.uid()));

drop policy if exists products_update_own on public.products;
create policy products_update_own on public.products
    for update to authenticated
    using (user_id = (select auth.uid()))
    with check (user_id = (select auth.uid()));

drop policy if exists products_delete_own on public.products;
create policy products_delete_own on public.products
    for delete to authenticated
    using (user_id = (select auth.uid()));

-- >>>>> 20261029120200_funcoes.sql
-- =====================================================================
-- Revenda+ | 3/3 — Funções chamáveis pelo app (RPC)
-- =====================================================================

-- Exclui a conta de quem está logada (e, por cascata, perfil e produtos).
-- O app pede confirmação antes de chamar: supabase.rpc('delete_my_account').
create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    uid uuid := (select auth.uid());
begin
    if uid is null then
        raise exception 'Não autenticado' using errcode = '28000';
    end if;
    delete from auth.users where id = uid;
end;
$$;

-- Só usuárias logadas podem chamar; visitantes não.
revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

-- Funções internas dos gatilhos nunca devem ser chamadas pela API.
revoke all on function public.handle_new_user()          from public, anon, authenticated;
revoke all on function public.set_updated_at()           from public, anon, authenticated;
revoke all on function public.protect_products_columns() from public, anon, authenticated;
