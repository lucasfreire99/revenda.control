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
