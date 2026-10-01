-- ============================================
-- Settings page: an organization admin renames their own organization
-- ============================================
-- Organizations are writable by super admins only (RLS), and that stays so:
-- a policy would open every column (slug, is_active, …). This function
-- changes the name, and only of the caller's own organization — it takes no
-- organization id, so there is nothing to point at someone else's.
-- 'forbidden' unless the caller really is an org_admin: client admins, team
-- members and a super admin viewing a customer's account are all refused.
create function public.rename_my_organization(p_name text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_org uuid := public.user_org();
begin
  if auth.uid() is null
     or v_org is null
     or (select u.role from public.users u where u.id = auth.uid()) is distinct from 'org_admin' then
    return 'forbidden';
  end if;
  if char_length(v_name) < 2 or char_length(v_name) > 100 then return 'invalid'; end if;

  update public.organizations set name = v_name where id = v_org;
  return 'ok';
end;
$$;

revoke execute on function public.rename_my_organization(text) from public, anon;
grant execute on function public.rename_my_organization(text) to authenticated;
