-- Lead capture and booking (October 2026).
--
-- A lead is a name and a phone. The row is written from the first thing there
-- is to record (a name, a number, a chosen day) and every later piece updates
-- that same row; it is a lead, visible to the client, once it holds both a name
-- and a phone. Until then only a super admin sees it. The read policy is the
-- enforcement: a page or function that forgets the filter gets a wrong count,
-- never a row it should not see. lead_events follow the lead (their policy
-- reads leads through RLS).
--
-- The booking shape is the business's: 'appointment' (a day and a time),
-- 'day_only' (a day, first come first served) or 'none' (the bot never books).
-- Unset, it follows the opening hours: 'appointment' once hours are entered,
-- 'none' until then. Every client that exists today is set to 'appointment',
-- so nothing changes for a live client.

-- --------------------------------------------
-- 1. Settings: the booking shape and how much of a name is enough
-- --------------------------------------------
alter table public.bot_settings
  add column booking_mode text check (booking_mode in ('appointment', 'day_only', 'none')),
  add column name_strictness text not null default 'single' check (name_strictness in ('single', 'two_parts'));

update public.bot_settings set booking_mode = 'appointment';

-- --------------------------------------------
-- 2. Leads: written as they arrive. The partial booking (day, time, branch)
--    lives on the row, and whether the row is a lead is a stored fact.
-- --------------------------------------------
alter table public.leads
  add column booking_draft jsonb,
  add column is_complete boolean generated always as (
    coalesce(btrim(name), '') <> '' and coalesce(btrim(phone), '') <> ''
  ) stored;

create index leads_client_complete on public.leads (client_id, is_complete, created_at desc);

-- --------------------------------------------
-- 3. Who sees a row. A client sees, changes and deletes leads; a super admin
--    sees every row, partial ones included. Insert is unchanged: what the team
--    adds by hand is theirs to complete.
-- --------------------------------------------
drop policy "Users see leads of their clients" on public.leads;
create policy "Users see leads of their clients"
  on public.leads for select
  using (public.has_client_access(client_id) and (is_complete or public.is_super_admin()));

drop policy "Users update leads of their clients" on public.leads;
create policy "Users update leads of their clients"
  on public.leads for update
  using (public.has_client_access(client_id) and (is_complete or public.is_super_admin()))
  with check (public.has_client_access(client_id));

drop policy "Admins delete leads of their clients" on public.leads;
create policy "Admins delete leads of their clients"
  on public.leads for delete
  using (public.is_client_manager() and public.has_client_access(client_id) and (is_complete or public.is_super_admin()));

-- --------------------------------------------
-- 4. A new client's defaults: booking_mode unset (it follows the opening
--    hours), any name accepted. Copied from 20261018100000 with the two
--    columns appended.
-- --------------------------------------------
create or replace function public.bot_settings_defaults(p_client_id uuid)
returns public.bot_settings
language sql
stable
set search_path = public
as $$
  select
    null::uuid, -- filled by the bot_settings_fill_id trigger on insert
    p_client_id,
    'أنت مساعد ذكي ودود بيتكلم عربي بشكل طبيعي وبسيط. '
      || 'مهمتك تساعد زوار الموقع وترد على أسئلتهم عن النشاط وخدماته بدقة ولطف، '
      || 'وتفهم هم محتاجين إيه بالظبط وتوجّههم للخطوة الجاية.',
    'friendly',
    'ar',
    0.7::float,
    500,
    'أهلاً بيك! 👋 إزاي أقدر أساعدك النهارده؟',
    'للأسف مش عندي المعلومة دي دلوقتي، بس سيب لي اسمك ورقم تليفونك وحد من فريقنا هيتواصل معاك في أقرب وقت.',
    true,
    null::jsonb,
    now(),
    now(),
    true,
    'فيه ضغط على النظام دلوقتي ومش قادر أرد. الفريق هيشوف رسالتك ويرد عليك قريب — ولو مستعجل اتصل بينا.',
    null, -- booking_mode: follows the opening hours until someone chooses
    'single'
$$;

-- --------------------------------------------
-- 5. Counts are of leads: rows with a name and a phone. RLS already hides the
--    rest from clients; these filters make the numbers right for super admins
--    too (their own pages, and a client's pages while impersonating). Each
--    function is its latest definition with the filter added, nothing else.
-- --------------------------------------------
create or replace function public.get_leads_over_time(
  p_client_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_granularity text default 'day'
)
returns table (bucket date, leads bigint)
language sql
stable
security invoker
set search_path = public
as $$
  with counts as (
    select public.analytics_bucket((l.created_at at time zone 'Africa/Cairo')::date, p_granularity) as bucket,
           count(*) as n
      from public.leads l
     where l.is_complete
       and l.created_at >= p_from and l.created_at < p_to
       and (p_client_id is null or l.client_id = p_client_id)
     group by 1
  )
  select b.bucket, coalesce(counts.n, 0)
    from public.analytics_buckets(p_from, p_to, p_granularity) b
    left join counts using (bucket)
   order by b.bucket
$$;

create or replace function public.get_lead_status_breakdown(
  p_client_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
returns table (status lead_status, leads bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select s.status, count(l.id)
    from unnest(enum_range(null::lead_status)) as s(status)
    left join public.leads l
      on l.status = s.status
     and l.is_complete
     and l.created_at >= p_from and l.created_at < p_to
     and (p_client_id is null or l.client_id = p_client_id)
   group by s.status
   order by array_position(enum_range(null::lead_status), s.status)
$$;

create or replace function public.get_client_performance(
  p_from timestamptz,
  p_to timestamptz
)
returns table (
  client_id uuid,
  client_name text,
  conversations bigint,
  leads bigint,
  booked bigint,
  showed_up bigint,
  no_show bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  select c.id, c.name,
         (select count(*) from public.conversations cv
           where cv.client_id = c.id and cv.created_at >= p_from and cv.created_at < p_to),
         count(l.id),
         count(l.id) filter (where l.appointment_at is not null),
         count(l.id) filter (where l.showed_up is true),
         count(l.id) filter (where l.showed_up is false)
    from public.clients c
    left join public.leads l
      on l.client_id = c.id and l.is_complete and l.created_at >= p_from and l.created_at < p_to
   group by c.id, c.name
$$;

create or replace function public.get_journey_stats(
  p_client_id uuid default null,
  p_from timestamptz default now() - interval '30 days',
  p_to timestamptz default now()
)
returns table (
  client_id uuid,
  client_name text,
  leads_count bigint,
  booked_count bigint,
  showed_up_count bigint,
  no_show_count bigint,
  attendance_rate numeric
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    c.id,
    c.name,
    count(l.id),
    count(l.id) filter (where l.appointment_at is not null),
    count(l.id) filter (where l.showed_up is true),
    count(l.id) filter (where l.showed_up is false),
    round(
      100.0 * count(l.id) filter (where l.showed_up is true)
      / nullif(count(l.id) filter (where l.showed_up is not null), 0),
      1
    )
  from public.clients c
  left join public.leads l
    on l.client_id = c.id and l.is_complete and l.created_at >= p_from and l.created_at < p_to
  where p_client_id is null or c.id = p_client_id
  group by c.id, c.name
$$;

create or replace function public.get_upcoming_appointments(
  p_client_id uuid default null,
  p_days_ahead int default 7
)
returns table (
  id uuid,
  client_id uuid,
  client_name text,
  name text,
  phone text,
  service_requested text,
  status lead_status,
  appointment_at timestamptz,
  appointment_confirmed boolean,
  showed_up boolean
)
language sql
stable
security invoker
set search_path = public
as $$
  select l.id, l.client_id, c.name, l.name, l.phone, l.service_requested, l.status,
         l.appointment_at, l.appointment_confirmed, l.showed_up
    from public.leads l
    join public.clients c on c.id = l.client_id
   where l.is_complete
     and l.appointment_at >= now()
     and l.appointment_at < now() + make_interval(days => greatest(p_days_ahead, 0))
     and (p_client_id is null or l.client_id = p_client_id)
   order by l.appointment_at
$$;

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
    (select count(*) from public.leads where is_complete),
    (select count(*) from public.leads, bounds where is_complete and created_at >= last_start),
    (select count(*) from public.leads, bounds where is_complete and created_at >= prev_start and created_at < last_start)
  where public.is_super_admin()
$$;

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
     where l.is_complete
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
           (select count(*) from public.leads l where l.client_id = c.id and l.is_complete) as leads,
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
         where l.is_complete and l.created_at >= now() - interval '30 days'
      ),
      'booked', (
        select count(*) from public.leads l
          join client_rows c on c.id = l.client_id
         where l.is_complete and l.appointment_at is not null
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
