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
