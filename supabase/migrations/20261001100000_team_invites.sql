-- ============================================
-- TEAM & INVITES
-- ============================================

-- --------------------------------------------
-- 0. Security fix: users could change their own role / organization.
--    "Users update themselves" has no column restriction, and org admins
--    could promote anyone (themselves included) to super_admin.
--    Role/org changes are now only allowed:
--      * from trusted server code (security definer functions, service role)
--      * by super admins
--      * by org admins, within their org, and never to super_admin
-- --------------------------------------------
create or replace function public.guard_user_privileges()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- Security definer functions run as their owner; the API service role is trusted
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.role = 'super_admin' and public.user_role() is distinct from 'super_admin' then
      raise exception 'not allowed to create a super admin' using errcode = '42501';
    end if;
    return new;
  end if;

  if new.role is not distinct from old.role
     and new.organization_id is not distinct from old.organization_id then
    return new;
  end if;

  if public.user_role() = 'super_admin' then
    return new;
  end if;

  if public.user_role() = 'org_admin'
     and new.id <> auth.uid()
     and old.organization_id = public.user_org()
     and new.organization_id is not distinct from old.organization_id
     and new.role <> 'super_admin' then
    return new;
  end if;

  raise exception 'not allowed to change role or organization' using errcode = '42501';
end;
$$;

create trigger users_guard_privileges before insert or update on public.users
  for each row execute function public.guard_user_privileges();

-- Admins could add any user (even from another organization) to a client
drop policy if exists "Admins manage client members" on public.client_members;

create policy "Admins manage client members"
  on public.client_members for all
  using (
    public.user_role() in ('super_admin', 'org_admin', 'client_admin')
    and public.has_client_access(client_id)
  )
  with check (
    public.user_role() in ('super_admin', 'org_admin', 'client_admin')
    and public.has_client_access(client_id)
    and exists (
      select 1 from public.users u
        join public.clients c on c.id = client_members.client_id
       where u.id = client_members.user_id and u.organization_id = c.organization_id
    )
  );

-- --------------------------------------------
-- 1. Invites: optional client + name
-- --------------------------------------------
alter table public.organization_invites
  add column if not exists client_id uuid references public.clients(id) on delete cascade,
  add column if not exists invited_name text;

-- Client roles need a client; nobody can be invited as super admin
alter table public.organization_invites
  add constraint organization_invites_role_client check (
    role <> 'super_admin'
    and (role = 'org_admin' or client_id is not null)
  ) not valid;

create index if not exists idx_invites_client on public.organization_invites(client_id);

drop policy if exists "Org admins see their invites" on public.organization_invites;
drop policy if exists "Org admins create invites" on public.organization_invites;

-- Org admins: every invite of their org. Client admins: invites to their clients.
create policy "Admins see invites they manage"
  on public.organization_invites for select
  using (
    (public.user_role() = 'super_admin')
    or (public.user_role() = 'org_admin' and organization_id = public.user_org())
    or (
      public.user_role() = 'client_admin'
      and organization_id = public.user_org()
      and client_id is not null
      and public.has_client_access(client_id)
    )
  );

create policy "Admins invite to clients they manage"
  on public.organization_invites for insert
  with check (
    organization_id = public.user_org()
    and invited_by = auth.uid()
    and role in ('client_admin', 'team_member')
    and client_id is not null
    -- Qualified: inside the subquery a bare organization_id would mean c's
    and exists (
      select 1 from public.clients c
       where c.id = organization_invites.client_id
         and c.organization_id = organization_invites.organization_id
    )
    and (
      public.user_role() in ('super_admin', 'org_admin')
      or (public.user_role() = 'client_admin' and public.has_client_access(client_id))
    )
  );

create policy "Admins cancel pending invites they manage"
  on public.organization_invites for delete
  using (
    accepted_at is null
    and (
      (public.user_role() = 'super_admin')
      or (public.user_role() = 'org_admin' and organization_id = public.user_org())
      or (
        public.user_role() = 'client_admin'
        and organization_id = public.user_org()
        and client_id is not null
        and public.has_client_access(client_id)
      )
    )
  );

-- --------------------------------------------
-- 2. Role helpers. users.role is global, so when someone joins another
--    client we keep the higher of their current role and the invited one.
-- --------------------------------------------
create or replace function public.role_rank(r user_role)
returns int
language sql
immutable
as $$
  select case r
    when 'super_admin' then 4
    when 'org_admin' then 3
    when 'client_admin' then 2
    else 1
  end
$$;

-- --------------------------------------------
-- 3. Invite lookup for the (possibly signed-out) invite page. The code is
--    the secret; only display fields are returned.
-- --------------------------------------------
create or replace function public.get_invite(code text)
returns table (
  email text,
  invited_name text,
  role user_role,
  organization_name text,
  client_id uuid,
  client_name text,
  expires_at timestamptz,
  accepted boolean,
  expired boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select i.email, i.invited_name, i.role, o.name, c.id, c.name, i.expires_at,
         i.accepted_at is not null, i.expires_at <= now()
    from public.organization_invites i
    join public.organizations o on o.id = i.organization_id
    left join public.clients c on c.id = i.client_id
   where i.invite_code = code
$$;

revoke execute on function public.get_invite(text) from public;
grant execute on function public.get_invite(text) to anon, authenticated;

-- --------------------------------------------
-- 4. Accept an invite as the signed-in user.
--    Returns: 'ok' | 'not_found' | 'expired' | 'already_accepted' |
--             'email_mismatch' | 'other_organization'
-- --------------------------------------------
create or replace function public.accept_invite(code text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  inv record;
  me record;
  auth_email text;
begin
  if auth.uid() is null then
    return 'not_found';
  end if;

  select * into inv from public.organization_invites where invite_code = code for update;
  if not found then return 'not_found'; end if;
  if inv.accepted_at is not null then return 'already_accepted'; end if;
  if inv.expires_at <= now() then return 'expired'; end if;

  select email into auth_email from auth.users where id = auth.uid();
  if lower(auth_email) <> lower(inv.email) then return 'email_mismatch'; end if;

  select * into me from public.users where id = auth.uid();
  if me.id is null then
    insert into public.users (id, email, full_name, role, organization_id)
    values (auth.uid(), auth_email, coalesce(inv.invited_name, ''), inv.role, inv.organization_id);
  elsif me.organization_id is not null and me.organization_id <> inv.organization_id then
    return 'other_organization';
  else
    update public.users
       set organization_id = inv.organization_id,
           role = case when public.role_rank(inv.role) > public.role_rank(me.role) then inv.role else me.role end,
           full_name = coalesce(nullif(full_name, ''), inv.invited_name, '')
     where id = auth.uid();
  end if;

  if inv.client_id is not null then
    insert into public.client_members (client_id, user_id, role)
    values (inv.client_id, auth.uid(), inv.role)
    on conflict (client_id, user_id) do update set role = excluded.role;
  end if;

  update public.organization_invites set accepted_at = now() where id = inv.id;
  return 'ok';
end;
$$;

revoke execute on function public.accept_invite(text) from public, anon;
grant execute on function public.accept_invite(text) to authenticated;

-- --------------------------------------------
-- 5. Team listing. users RLS hides colleagues from client admins, so this
--    returns exactly what the caller may see: org/super admins get their
--    whole organization, client admins the members of their clients.
--    One row per (user, client) membership; admins without one get a row
--    with a null client.
-- --------------------------------------------
create or replace function public.team_members()
returns table (
  user_id uuid,
  full_name text,
  email text,
  user_role user_role,
  client_id uuid,
  client_name text,
  member_role user_role,
  joined_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  with me as (
    select id, role, organization_id from public.users where id = auth.uid()
  )
  select u.id, u.full_name, u.email, u.role, c.id, c.name, cm.role, coalesce(cm.created_at, u.created_at)
    from me
    join public.users u on u.organization_id = me.organization_id
    left join public.client_members cm on cm.user_id = u.id
    left join public.clients c on c.id = cm.client_id and c.organization_id = me.organization_id
   where me.role in ('super_admin', 'org_admin')
     and (cm.id is null or c.id is not null)
  union all
  select u.id, u.full_name, u.email, u.role, c.id, c.name, cm.role, cm.created_at
    from me
    join public.client_members mine on mine.user_id = me.id
    join public.clients c on c.id = mine.client_id
    join public.client_members cm on cm.client_id = c.id
    join public.users u on u.id = cm.user_id
   where me.role = 'client_admin'
  order by 6 nulls first, 2
$$;

revoke execute on function public.team_members() from public, anon;
grant execute on function public.team_members() to authenticated;

-- --------------------------------------------
-- 6. Remove someone from the organization (org/super admins only):
--    drops their client memberships and detaches them from the org.
--    The auth account itself is kept.
--    Returns: 'ok' | 'forbidden' | 'not_found' | 'self'
-- --------------------------------------------
create or replace function public.remove_org_member(member_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  target record;
begin
  if public.user_role() not in ('super_admin', 'org_admin') then return 'forbidden'; end if;
  if member_id = auth.uid() then return 'self'; end if;

  select * into target from public.users where id = member_id;
  if target.id is null or target.organization_id is distinct from public.user_org() then
    return 'not_found';
  end if;
  if target.role = 'super_admin' then return 'forbidden'; end if;

  delete from public.client_members cm
   using public.clients c
   where cm.client_id = c.id and c.organization_id = target.organization_id and cm.user_id = member_id;

  update public.conversations set assigned_to = null
   where assigned_to = member_id
     and client_id in (select id from public.clients where organization_id = target.organization_id);

  update public.users set organization_id = null, role = 'team_member' where id = member_id;
  return 'ok';
end;
$$;

revoke execute on function public.remove_org_member(uuid) from public, anon;
grant execute on function public.remove_org_member(uuid) to authenticated;

-- --------------------------------------------
-- 7. Signing up through an invite also joins the invited client
-- --------------------------------------------
create or replace function public.handle_new_user()
returns trigger
security definer
set search_path = public, extensions
as $$
declare
  new_org_id uuid;
  invite_record record;
  meta_org_name text;
  meta_invite_code text;
begin
  meta_org_name := new.raw_user_meta_data->>'organization_name';
  meta_invite_code := new.raw_user_meta_data->>'invite_code';

  -- Case 1: User is joining via invite
  if meta_invite_code is not null then
    select * into invite_record
    from public.organization_invites
    where invite_code = meta_invite_code
      and accepted_at is null
      and expires_at > now()
      and lower(email) = lower(new.email);

    if invite_record.id is not null then
      insert into public.users (id, email, full_name, role, organization_id)
      values (
        new.id,
        new.email,
        coalesce(nullif(new.raw_user_meta_data->>'full_name', ''), invite_record.invited_name, ''),
        invite_record.role,
        invite_record.organization_id
      );

      if invite_record.client_id is not null then
        insert into public.client_members (client_id, user_id, role)
        values (invite_record.client_id, new.id, invite_record.role)
        on conflict (client_id, user_id) do nothing;
      end if;

      update public.organization_invites
        set accepted_at = now()
        where id = invite_record.id;

      return new;
    end if;
  end if;

  -- Case 2: User creating a new organization
  if meta_org_name is not null then
    insert into public.organizations (name, slug)
    values (
      meta_org_name,
      lower(regexp_replace(meta_org_name, '[^a-zA-Z0-9]+', '-', 'g'))
    )
    returning id into new_org_id;

    insert into public.users (id, email, full_name, role, organization_id)
    values (
      new.id,
      new.email,
      coalesce(new.raw_user_meta_data->>'full_name', ''),
      'org_admin',
      new_org_id
    );

    return new;
  end if;

  -- Case 3: Fallback
  insert into public.users (id, email, full_name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    'team_member'
  );

  return new;
end;
$$ language plpgsql;
