-- ============================================
-- CLIENTS CRUD: description column + client_admin write access
-- ============================================

alter table public.clients add column if not exists description text;

-- Client admins can create clients inside their own organization
create policy "Client admins create clients in their org"
  on public.clients for insert
  with check (
    public.user_role() = 'client_admin'
    and organization_id = public.user_org()
  );

-- Client admins can update clients they are assigned to
create policy "Client admins update their clients"
  on public.clients for update
  using (
    public.user_role() = 'client_admin'
    and organization_id = public.user_org()
    and public.has_client_access(id)
  )
  with check (
    public.user_role() = 'client_admin'
    and organization_id = public.user_org()
  );

-- Client admins can delete clients they are assigned to
create policy "Client admins delete their clients"
  on public.clients for delete
  using (
    public.user_role() = 'client_admin'
    and organization_id = public.user_org()
    and public.has_client_access(id)
  );

-- When a client admin creates a client, assign them to it so they keep
-- access (select on clients goes through client_members for them)
create or replace function public.add_creator_as_client_member()
returns trigger
security definer
set search_path = public
as $$
begin
  if public.user_role() = 'client_admin' then
    insert into public.client_members (client_id, user_id, role)
    values (new.id, auth.uid(), 'client_admin')
    on conflict (client_id, user_id) do nothing;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger clients_add_creator_member after insert on public.clients
  for each row execute function public.add_creator_as_client_member();
