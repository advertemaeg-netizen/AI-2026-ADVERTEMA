-- ============================================
-- BRANCHES, THEIR HOURS AND CLOSURES
--
-- Phase 2, step 1. A client's opening hours have been one schedule for the
-- whole business (bot_settings.business_hours). The demo clinic has two
-- branches with different hours, and التجمع الخامس is closed on Fridays:
-- with one schedule, a Friday booking there is confirmed by code. Hours
-- belong to a branch; so do the days it is closed and how many visitors a
-- slot takes.
--
-- What this migration does, in order:
--   1. branches and branch_closures, with RLS like every client table
--   2. one branch per client, carrying the hours bot_settings holds today,
--      and one with hours not set for every client created from now on
--   3. leads.branch_id, and a backfill by normalised branch name
-- Nothing reads these yet: the bot still reads bot_settings.business_hours
-- until the booking gate moves to branches, and that column is dropped later
-- in a commit of its own. Safe to apply before any image.
--
-- KNOWN LIMITATION, on purpose: the appointment stays on the lead
-- (leads.appointment_at). One lead holds exactly one appointment, so a
-- follow-up visit, or two appointments for one person, will need an
-- appointments table. Not built now: nothing asks for it yet.
-- ============================================

-- --------------------------------------------
-- Names as people type them: "فرع المعادي", "المعادى", "المعادي " are one
-- branch. Folds case, hamza forms of alef, alef maqsura, taa marbuta,
-- tatweel and harakat, collapses spaces, and drops a leading "فرع".
-- --------------------------------------------
create function public.normalize_branch_name(name text)
returns text
language sql
immutable
set search_path = public
as $$
  select nullif(
    regexp_replace(
      regexp_replace(
        translate(lower(btrim(name)), 'أإآٱىةـًٌٍَُِّْ', 'اااايه'),
        '\s+', ' ', 'g'
      ),
      '^فرع ', ''
    ),
    ''
  )
$$;

-- --------------------------------------------
-- A branch's week: every weekday, each an array of ["HH:MM","HH:MM"] ranges,
-- an empty array when closed that day. A range that closes earlier than it
-- opens runs past midnight (["20:00","01:00"]). Checked here so that no
-- writer can store a shape the booking code would misread; whether ranges
-- overlap is the application's to say.
-- --------------------------------------------
create function public.valid_branch_hours(hours jsonb)
returns boolean
language plpgsql
immutable
set search_path = public
as $$
declare
  day text;
  range jsonb;
  clock constant text := '^([01][0-9]|2[0-3]):[0-5][0-9]$';
begin
  if jsonb_typeof(hours) <> 'object' then
    return false;
  end if;
  if (select array_agg(k order by k) from jsonb_object_keys(hours) k)
     is distinct from array['fri', 'mon', 'sat', 'sun', 'thu', 'tue', 'wed'] then
    return false;
  end if;
  for day in select jsonb_object_keys(hours) loop
    if jsonb_typeof(hours -> day) <> 'array' then
      return false;
    end if;
    for range in select jsonb_array_elements(hours -> day) loop
      if jsonb_typeof(range) <> 'array' or jsonb_array_length(range) <> 2 then
        return false;
      end if;
      if jsonb_typeof(range -> 0) <> 'string' or jsonb_typeof(range -> 1) <> 'string' then
        return false;
      end if;
      if (range ->> 0) !~ clock or (range ->> 1) !~ clock or (range ->> 0) = (range ->> 1) then
        return false;
      end if;
    end loop;
  end loop;
  return true;
end;
$$;

-- --------------------------------------------
-- 1. Tables
-- --------------------------------------------
create table public.branches (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  name text not null check (public.normalize_branch_name(name) is not null and char_length(name) <= 120),
  timezone text not null default 'Africa/Cairo',
  -- How many visitors one slot takes, and how long a slot is
  capacity_per_slot integer not null default 1 check (capacity_per_slot >= 1),
  slot_minutes integer not null default 30 check (slot_minutes in (15, 20, 30, 60)),
  -- Null: hours not set. A time asked for there is a request the team
  -- confirms, never confirmed by the bot.
  business_hours jsonb check (business_hours is null or public.valid_branch_hours(business_hours)),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- The target of the composite keys below: a lead or a closure can only
  -- point at a branch of its own client
  unique (client_id, id)
);

-- Two branches of one client cannot carry what a visitor would read as the same name
create unique index branches_client_name on public.branches (client_id, public.normalize_branch_name(name));

comment on table public.branches is
  'A client''s locations: each has its own hours, closures and slot capacity. The booking decision (code) reads hours and closures from here.';

create trigger branches_updated_at
  before update on public.branches
  for each row execute function update_updated_at();

create table public.branch_closures (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null,
  branch_id uuid not null,
  date date not null,
  reason text check (reason is null or char_length(reason) <= 200),
  created_at timestamptz not null default now(),
  foreign key (client_id, branch_id) references public.branches (client_id, id) on delete cascade,
  unique (branch_id, date)
);

comment on table public.branch_closures is
  'Whole days a branch is closed (a holiday, Eid). Dates are data: the bot is never asked to reason about which day a holiday falls on.';

-- --------------------------------------------
-- RLS: everyone with access to the client sees them; admins manage them,
-- as for channels and the knowledge base
-- --------------------------------------------
alter table public.branches enable row level security;
alter table public.branch_closures enable row level security;

create policy "Users see branches of their clients"
  on public.branches for select
  using (public.has_client_access(client_id));

create policy "Client admins manage branches"
  on public.branches for all
  using (
    public.user_role() in ('super_admin', 'org_admin', 'client_admin')
    and public.has_client_access(client_id)
  );

create policy "Users see branch closures of their clients"
  on public.branch_closures for select
  using (public.has_client_access(client_id));

create policy "Client admins manage branch closures"
  on public.branch_closures for all
  using (
    public.user_role() in ('super_admin', 'org_admin', 'client_admin')
    and public.has_client_access(client_id)
  );

-- --------------------------------------------
-- 2. One branch per client, with the hours it has today.
--
-- bot_settings.business_hours is {"enabled", "timezone", "days": {"sat":
-- {"open", "from", "to"}, …}}. Turned off, missing, or a shape the new check
-- refuses (a day that opens and closes at the same minute), it becomes "not
-- set": the branch then takes requests the team confirms. A function of its
-- own so the conversion can be tested on old-format input; dropped with
-- bot_settings.business_hours.
-- --------------------------------------------
create function public.branch_hours_from_settings(old jsonb)
returns jsonb
language sql
immutable
set search_path = public
as $$
  with converted as (
    select jsonb_object_agg(
             d,
             case
               when coalesce((old -> 'days' -> d ->> 'open')::boolean, false)
                 then jsonb_build_array(jsonb_build_array(old -> 'days' -> d ->> 'from', old -> 'days' -> d ->> 'to'))
               else '[]'::jsonb
             end) as hours
      from unnest(array['sat', 'sun', 'mon', 'tue', 'wed', 'thu', 'fri']) d
     where jsonb_typeof(old) = 'object'
       and coalesce((old ->> 'enabled')::boolean, false)
  )
  select case when public.valid_branch_hours(hours) then hours end from converted
$$;

do $$
declare
  refused integer;
begin
  select count(*) into refused
    from public.bot_settings s
   where coalesce((s.business_hours ->> 'enabled')::boolean, false)
     and public.branch_hours_from_settings(s.business_hours) is null;
  if refused > 0 then
    raise notice 'branches: % client(s) had opening hours the new format refuses; their branch starts with hours not set', refused;
  end if;

  insert into public.branches (client_id, name, timezone, business_hours)
  select c.id,
         case when s.language = 'en' then 'Main branch' else 'الفرع الرئيسي' end,
         coalesce(nullif(s.business_hours ->> 'timezone', ''), 'Africa/Cairo'),
         public.branch_hours_from_settings(s.business_hours)
    from public.clients c
    left join public.bot_settings s on s.client_id = c.id
   where not exists (select 1 from public.branches b where b.client_id = c.id);
end;
$$;

-- Every client made from here on gets one branch too, with hours NOT set.
-- It books exactly like having none (requests only, nothing confirmed), but
-- it is there on the الفروع page asking to be filled in, instead of a
-- client nobody noticed has no branch (the user's decision, 2026-10-14).
create function public.create_default_branch()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.branches (client_id, name)
  select new.id, 'الفرع الرئيسي'
   where not exists (select 1 from public.branches b where b.client_id = new.id);
  return new;
end;
$$;

revoke execute on function public.create_default_branch() from public, anon, authenticated;

create trigger clients_default_branch
  after insert on public.clients
  for each row execute function public.create_default_branch();

-- --------------------------------------------
-- 3. Which branch a lead is for. Nullable: a lead with no branch is a lead
-- the team still has to place. NO ACTION on delete (the default, not
-- cascade): a branch that has leads is deactivated, not deleted.
-- --------------------------------------------
alter table public.leads add column branch_id uuid;
alter table public.leads
  add constraint leads_branch_fkey foreign key (client_id, branch_id) references public.branches (client_id, id);

-- Counting a slot's appointments (book_appointment, a later step)
create index leads_branch_appointment on public.leads (branch_id, appointment_at)
  where branch_id is not null and appointment_at is not null;

comment on column public.leads.branch_id is
  'The branch the appointment is at. leads.branch stays as the text the visitor or the team wrote.';

-- Links a branch's unplaced leads by name: the leads whose free-text branch
-- reads as this branch's name. Run here for the seeded branches, and by the
-- app when a branch is created or renamed. Never moves a lead that already
-- has a branch. Returns how many it linked.
create function public.link_leads_to_branch(p_branch_id uuid)
returns integer
language sql
set search_path = public
as $$
  with linked as (
    update public.leads l
       set branch_id = b.id
      from public.branches b
     where b.id = p_branch_id
       and l.client_id = b.client_id
       and l.branch_id is null
       and public.normalize_branch_name(l.branch) = public.normalize_branch_name(b.name)
    returning l.id
  )
  select count(*)::integer from linked
$$;

revoke execute on function public.link_leads_to_branch(uuid) from public, anon;
grant execute on function public.link_leads_to_branch(uuid) to authenticated, service_role;

-- The backfill, and what it leaves for the team: a seeded branch is named
-- "الفرع الرئيسي", so on today's data most leads with an appointment stay
-- unplaced until the client names its real branches
do $$
declare
  linked integer := 0;
  b record;
  unplaced integer;
begin
  for b in select id from public.branches loop
    linked := linked + public.link_leads_to_branch(b.id);
  end loop;
  select count(*) into unplaced from public.leads where appointment_at is not null and branch_id is null;
  raise notice 'branches: % lead(s) linked by name; % lead(s) with an appointment have no branch yet', linked, unplaced;
end;
$$;
