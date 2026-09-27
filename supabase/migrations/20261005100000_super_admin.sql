-- ============================================
-- SUPER ADMIN PANEL
-- Platform-wide stats and organization management for super admins, and
-- soft-disabling organizations (no deletes).
--
-- Nobody is a super admin by default. Grant it by hand (SQL editor runs as
-- postgres, which the users privilege guard trusts):
--   update public.users set role = 'super_admin' where email = '…';
-- ============================================

-- --------------------------------------------
-- 1. Soft disable: members of a disabled organization lose all access
--    (super admins excepted). The row and its data stay untouched.
--    Only super admins can update organizations ("Super admins manage orgs"),
--    so nobody else can flip is_active.
-- --------------------------------------------
alter table public.organizations
  add column if not exists is_active boolean not null default true;

-- Every RLS policy goes through user_role() / user_org() / has_client_access(),
-- so returning null from them for disabled organizations locks their members
-- out of everything but their own users row.
create or replace function public.user_role()
returns user_role
language sql
security definer
stable
set search_path = public
as $$
  select u.role
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
  select u.organization_id
    from public.users u
    join public.organizations o on o.id = u.organization_id
   where u.id = auth.uid()
     and (u.role = 'super_admin' or o.is_active)
$$;

-- Client memberships don't go through user_role(), so check it up front
create or replace function public.has_client_access(check_client_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select public.user_role() is not null
     and exists (
       select 1 from public.clients c
        where c.id = check_client_id
          and (
            public.user_role() = 'super_admin'
            or (public.user_role() = 'org_admin' and c.organization_id = public.user_org())
            or exists (
              select 1 from public.client_members cm
               where cm.client_id = c.id and cm.user_id = auth.uid()
            )
          )
     )
$$;

-- Whether the signed-in user is locked out by a disabled organization.
-- The app signs such users out with an explanation.
create or replace function public.org_disabled()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
      from public.users u
      join public.organizations o on o.id = u.organization_id
     where u.id = auth.uid()
       and u.role <> 'super_admin'
       and not o.is_active
  )
$$;

revoke execute on function public.org_disabled() from public, anon;
grant execute on function public.org_disabled() to authenticated;

-- team_members() reads users directly; lock it the same way
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
    select id, role, organization_id from public.users
     where id = auth.uid() and not public.org_disabled()
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
-- 2. Platform stats. Security definer functions count past RLS (fast), and
--    return nothing unless the caller is a super admin.
--    Growth: the last 30 days vs the 30 days before.
-- --------------------------------------------
create or replace function public.is_super_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select coalesce(public.user_role() = 'super_admin', false)
$$;

revoke execute on function public.is_super_admin() from public, anon;
grant execute on function public.is_super_admin() to authenticated;

create or replace function public.get_platform_stats()
returns table (
  organizations bigint,
  active_organizations bigint,
  organizations_last_30 bigint,
  organizations_prev_30 bigint,
  clients bigint,
  clients_last_30 bigint,
  clients_prev_30 bigint,
  users bigint,
  users_last_30 bigint,
  users_prev_30 bigint,
  conversations bigint,
  conversations_last_30 bigint,
  conversations_prev_30 bigint,
  leads bigint,
  leads_last_30 bigint,
  leads_prev_30 bigint
)
language sql
stable
security definer
set search_path = public
as $$
  with bounds as (
    select now() - interval '30 days' as last_start,
           now() - interval '60 days' as prev_start
  )
  select
    (select count(*) from public.organizations),
    (select count(*) from public.organizations where is_active),
    (select count(*) from public.organizations, bounds where created_at >= last_start),
    (select count(*) from public.organizations, bounds where created_at >= prev_start and created_at < last_start),
    (select count(*) from public.clients),
    (select count(*) from public.clients, bounds where created_at >= last_start),
    (select count(*) from public.clients, bounds where created_at >= prev_start and created_at < last_start),
    (select count(*) from public.users),
    (select count(*) from public.users, bounds where created_at >= last_start),
    (select count(*) from public.users, bounds where created_at >= prev_start and created_at < last_start),
    (select count(*) from public.conversations),
    (select count(*) from public.conversations, bounds where created_at >= last_start),
    (select count(*) from public.conversations, bounds where created_at >= prev_start and created_at < last_start),
    (select count(*) from public.leads),
    (select count(*) from public.leads, bounds where created_at >= last_start),
    (select count(*) from public.leads, bounds where created_at >= prev_start and created_at < last_start)
  where public.is_super_admin()
$$;

revoke execute on function public.get_platform_stats() from public, anon;
grant execute on function public.get_platform_stats() to authenticated;

-- The view itself runs as the caller (no RLS bypass through the view);
-- the function behind it does the super admin check
create or replace view public.platform_stats
with (security_invoker = true)
as select * from public.get_platform_stats();

revoke all on public.platform_stats from public, anon;
grant select on public.platform_stats to authenticated;

-- --------------------------------------------
-- 3. Every organization with its totals. Last activity: the latest
--    message, lead change or member sign-in.
-- --------------------------------------------
create or replace function public.get_organizations_overview()
returns table (
  id uuid,
  name text,
  slug text,
  is_active boolean,
  created_at timestamptz,
  clients bigint,
  users bigint,
  conversations bigint,
  leads bigint,
  last_activity_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  with cl as (
    select organization_id, count(*) as n
      from public.clients
     group by organization_id
  ),
  us as (
    select u.organization_id, count(*) as n, max(au.last_sign_in_at) as last_at
      from public.users u
      left join auth.users au on au.id = u.id
     where u.organization_id is not null
     group by u.organization_id
  ),
  cv as (
    select c.organization_id, count(*) as n, max(v.last_message_at) as last_at
      from public.conversations v
      join public.clients c on c.id = v.client_id
     group by c.organization_id
  ),
  ld as (
    select c.organization_id, count(*) as n, max(l.updated_at) as last_at
      from public.leads l
      join public.clients c on c.id = l.client_id
     group by c.organization_id
  )
  select o.id, o.name, o.slug, o.is_active, o.created_at,
         coalesce(cl.n, 0), coalesce(us.n, 0), coalesce(cv.n, 0), coalesce(ld.n, 0),
         greatest(us.last_at, cv.last_at, ld.last_at)
    from public.organizations o
    left join cl on cl.organization_id = o.id
    left join us on us.organization_id = o.id
    left join cv on cv.organization_id = o.id
    left join ld on ld.organization_id = o.id
   where public.is_super_admin()
   order by o.created_at desc
$$;

revoke execute on function public.get_organizations_overview() from public, anon;
grant execute on function public.get_organizations_overview() to authenticated;

-- --------------------------------------------
-- 4. One organization in full: details, stats, clients, members.
--    null when the caller isn't a super admin or the org doesn't exist.
-- --------------------------------------------
create or replace function public.get_organization_details(p_org_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with org as (
    select o.* from public.organizations o
     where o.id = p_org_id and public.is_super_admin()
  ),
  client_rows as (
    select c.id, c.name, c.slug, c.industry, c.status, c.created_at,
           (select count(*) from public.channels ch where ch.client_id = c.id) as channels,
           (select count(*) from public.conversations cv where cv.client_id = c.id) as conversations,
           (select count(*) from public.leads l where l.client_id = c.id) as leads,
           greatest(
             (select max(cv.last_message_at) from public.conversations cv where cv.client_id = c.id),
             (select max(l.updated_at) from public.leads l where l.client_id = c.id)
           ) as last_activity_at
      from public.clients c
      join org on org.id = c.organization_id
  ),
  user_rows as (
    select u.id, u.email, u.full_name, u.role, u.created_at, au.last_sign_in_at,
           coalesce(
             (select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'role', cm.role) order by c.name)
                from public.client_members cm
                join public.clients c on c.id = cm.client_id and c.organization_id = u.organization_id
               where cm.user_id = u.id),
             '[]'::jsonb
           ) as clients
      from public.users u
      join org on org.id = u.organization_id
      left join auth.users au on au.id = u.id
  )
  select jsonb_build_object(
    'organization', jsonb_build_object(
      'id', org.id,
      'name', org.name,
      'slug', org.slug,
      'logo_url', org.logo_url,
      'is_active', org.is_active,
      'created_at', public.iso_utc(org.created_at),
      'updated_at', public.iso_utc(org.updated_at)
    ),
    'stats', jsonb_build_object(
      'clients', (select count(*) from client_rows),
      'active_clients', (select count(*) from client_rows where status = 'active'),
      'users', (select count(*) from user_rows),
      'channels', (select coalesce(sum(channels), 0) from client_rows),
      'conversations', (select coalesce(sum(conversations), 0) from client_rows),
      'conversations_last_30', (
        select count(*) from public.conversations cv
          join client_rows c on c.id = cv.client_id
         where cv.created_at >= now() - interval '30 days'
      ),
      'leads', (select coalesce(sum(leads), 0) from client_rows),
      'leads_last_30', (
        select count(*) from public.leads l
          join client_rows c on c.id = l.client_id
         where l.created_at >= now() - interval '30 days'
      ),
      'booked', (
        select count(*) from public.leads l
          join client_rows c on c.id = l.client_id
         where l.appointment_at is not null
      ),
      'last_activity_at', public.iso_utc(greatest(
        (select max(last_activity_at) from client_rows),
        (select max(last_sign_in_at) from user_rows)
      ))
    ),
    'clients', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', id, 'name', name, 'slug', slug, 'industry', industry, 'status', status,
        'created_at', public.iso_utc(created_at),
        'channels', channels, 'conversations', conversations, 'leads', leads,
        'last_activity_at', public.iso_utc(last_activity_at)
      ) order by name)
      from client_rows
    ), '[]'::jsonb),
    'users', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', id, 'email', email, 'full_name', full_name, 'role', role,
        'created_at', public.iso_utc(created_at),
        'last_sign_in_at', public.iso_utc(last_sign_in_at),
        'clients', clients
      ) order by array_position(enum_range(null::user_role), role), full_name nulls last, email)
      from user_rows
    ), '[]'::jsonb)
  )
  from org
$$;

revoke execute on function public.get_organization_details(uuid) from public, anon;
grant execute on function public.get_organization_details(uuid) to authenticated;
