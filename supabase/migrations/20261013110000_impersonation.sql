-- ============================================
-- IMPERSONATION: a super admin views a customer's account
--
-- A super admin opens one organization's dashboard to support it. While a
-- session is open (and for at most 8 hours):
--   * user_org() is the target organization and user_role() is org_admin,
--     so every RLS policy and function sees exactly what that
--     organization's admin sees — nothing from other organizations.
--   * is_super_admin() is false: no platform-wide access in the meantime.
--   * Nothing can be written, except a conversation's status or assignee
--     (support tools). A statement trigger on every table refuses the rest,
--     whatever path the write takes (API, RPC).
-- The app keeps the session id in a signed httpOnly cookie; the database
-- row is what counts (an ended session's cookie is ignored). Leaving from the
-- banner or signing out ends the session, and so does any request from the
-- super admin without a valid cookie (another browser, a lost cookie).
-- ============================================

create table public.impersonation_sessions (
  id uuid primary key default gen_random_uuid(),
  super_admin_id uuid not null references public.users(id) on delete cascade,
  target_organization_id uuid not null references public.organizations(id) on delete cascade,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  actions_count int not null default 0 check (actions_count >= 0),
  constraint impersonation_sessions_period check (ended_at is null or ended_at >= started_at)
);

create index idx_impersonation_open on public.impersonation_sessions(super_admin_id) where ended_at is null;
create index idx_impersonation_started on public.impersonation_sessions(started_at desc);

-- --------------------------------------------
-- 1. Who's asking
-- --------------------------------------------

-- The users row says super_admin, impersonating or not
create or replace function public.is_platform_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'super_admin')
$$;

-- The organization the caller is impersonating, or null
create or replace function public.impersonated_org()
returns uuid
language sql
security definer
stable
set search_path = public
as $$
  select s.target_organization_id
    from public.impersonation_sessions s
    join public.users u on u.id = s.super_admin_id and u.role = 'super_admin'
   where s.super_admin_id = auth.uid()
     and s.ended_at is null
     and s.started_at > now() - interval '8 hours'
   order by s.started_at desc
   limit 1
$$;

-- While impersonating, a super admin is the target organization's admin
create or replace function public.user_role()
returns user_role
language sql
security definer
stable
set search_path = public
as $$
  select case
           when u.role = 'super_admin' and public.impersonated_org() is not null then 'org_admin'::user_role
           else u.role
         end
    from public.users u
    left join public.organizations o on o.id = u.organization_id
   where u.id = auth.uid()
     and (u.role = 'super_admin' or o.is_active is not false)
$$;

create or replace function public.user_org()
returns uuid
language sql
security definer
stable
set search_path = public
as $$
  select case
           when u.role = 'super_admin' then coalesce(public.impersonated_org(), u.organization_id)
           else u.organization_id
         end
    from public.users u
    left join public.organizations o on o.id = u.organization_id
   where u.id = auth.uid()
     and (u.role = 'super_admin' or o.is_active)
$$;

-- is_super_admin() is user_role() = 'super_admin', so it's false while
-- impersonating without being redefined.

-- team_members() read the caller's own users row; use the effective role
-- and organization instead
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
    select auth.uid() as id, public.user_role() as role, public.user_org() as organization_id
     where auth.uid() is not null and not public.org_disabled()
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

-- --------------------------------------------
-- 2. Sessions (the only writes an impersonating super admin makes)
-- --------------------------------------------

-- Opens a session on an organization (ending any open one); its id
create or replace function public.start_impersonation(p_org_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if not public.is_platform_admin() then return null; end if;
  if not exists (select 1 from public.organizations where id = p_org_id) then return null; end if;

  update public.impersonation_sessions set ended_at = now()
   where super_admin_id = auth.uid() and ended_at is null;

  insert into public.impersonation_sessions (super_admin_id, target_organization_id)
  values (auth.uid(), p_org_id)
  returning id into v_id;
  return v_id;
end;
$$;

-- Ends the caller's open sessions (no-op when there are none)
create or replace function public.end_impersonation()
returns void
language sql
security definer
set search_path = public
as $$
  update public.impersonation_sessions set ended_at = now()
   where super_admin_id = auth.uid() and ended_at is null
$$;

-- The caller's session with this id, if it's still open
create or replace function public.get_active_impersonation(p_session_id uuid)
returns table (id uuid, target_organization_id uuid, organization_name text, org_type text, started_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select s.id, s.target_organization_id, o.name, o.org_type, s.started_at
    from public.impersonation_sessions s
    join public.organizations o on o.id = s.target_organization_id
   where s.id = p_session_id
     and s.super_admin_id = auth.uid()
     and s.ended_at is null
     and s.started_at > now() - interval '8 hours'
     and public.is_platform_admin()
$$;

-- One support action (conversation status / assignment) done in the session
create or replace function public.record_impersonation_action(p_session_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.impersonation_sessions set actions_count = actions_count + 1
   where id = p_session_id and super_admin_id = auth.uid() and ended_at is null
$$;

-- Latest sessions, for the admin panel
create or replace function public.get_impersonation_log(p_limit int default 20)
returns table (
  id uuid,
  admin_name text,
  admin_email text,
  organization_id uuid,
  organization_name text,
  org_type text,
  started_at timestamptz,
  ended_at timestamptz,
  actions_count int
)
language sql
stable
security definer
set search_path = public
as $$
  select s.id, u.full_name, u.email, o.id, o.name, o.org_type, s.started_at,
         -- Sessions nobody ended expire after 8 hours
         coalesce(s.ended_at, case when s.started_at <= now() - interval '8 hours' then s.started_at + interval '8 hours' end),
         s.actions_count
    from public.impersonation_sessions s
    join public.users u on u.id = s.super_admin_id
    join public.organizations o on o.id = s.target_organization_id
   where public.is_super_admin()
   order by s.started_at desc
   limit least(greatest(p_limit, 1), 100)
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'is_platform_admin()',
    'impersonated_org()',
    'start_impersonation(uuid)',
    'end_impersonation()',
    'get_active_impersonation(uuid)',
    'record_impersonation_action(uuid)',
    'get_impersonation_log(int)'
  ] loop
    execute format('revoke execute on function public.%s from public, anon', fn);
    execute format('grant execute on function public.%s to authenticated, service_role', fn);
  end loop;
end $$;

alter table public.impersonation_sessions enable row level security;

-- Read-only through the API; written by the functions above
create policy "Platform admins see impersonation sessions"
  on public.impersonation_sessions for select
  using (public.is_platform_admin());

-- --------------------------------------------
-- 3. Read-only while impersonating
-- --------------------------------------------

-- Refuses any write by an impersonating super admin, whatever the path.
-- Writes made by other triggers (pg_trigger_depth() > 1) follow from a
-- write that was already allowed. The service role (no auth.uid()) is
-- never impersonating.
create or replace function public.block_impersonated_writes()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if pg_trigger_depth() > 1 or public.impersonated_org() is null then
    return null;
  end if;
  -- Support tools: a conversation's status and assignee (checked per row below)
  if tg_table_name = 'conversations' and tg_op = 'UPDATE' then
    return null;
  end if;
  raise exception 'impersonation_read_only' using errcode = '42501', hint = 'impersonating';
end;
$$;

create or replace function public.guard_impersonated_conversation_update()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if pg_trigger_depth() > 1 or public.impersonated_org() is null then
    return new;
  end if;
  if (to_jsonb(new) - 'status' - 'assigned_to' - 'updated_at')
     is distinct from (to_jsonb(old) - 'status' - 'assigned_to' - 'updated_at') then
    raise exception 'impersonation_read_only' using errcode = '42501', hint = 'impersonating';
  end if;
  return new;
end;
$$;

-- Every table but the sessions themselves. (Tables added later need the
-- same trigger.)
do $$
declare
  t text;
begin
  for t in
    select tablename from pg_tables
     where schemaname = 'public' and tablename <> 'impersonation_sessions'
  loop
    execute format(
      'create trigger block_impersonated_writes before insert or update or delete on public.%I
         for each statement execute function public.block_impersonated_writes()',
      t
    );
  end loop;
end $$;

-- Runs after the other before-update triggers (alphabetical), so it sees
-- updated_at already set
create trigger zz_guard_impersonated_update before update on public.conversations
  for each row execute function public.guard_impersonated_conversation_update();
