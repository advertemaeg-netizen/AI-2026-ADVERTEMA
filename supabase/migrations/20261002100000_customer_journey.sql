-- ============================================
-- CUSTOMER JOURNEY: appointments + attendance
-- (leads.appointment_at and leads.showed_up already exist)
-- ============================================

alter table public.leads
  add column if not exists appointment_confirmed boolean not null default false,
  add column if not exists appointment_reminder_sent_at timestamptz,
  add column if not exists arrival_confirmed_at timestamptz,
  add column if not exists no_show_reason text;

create index if not exists idx_leads_appointment
  on public.leads(client_id, appointment_at)
  where appointment_at is not null;

-- --------------------------------------------
-- Keep attendance consistent however the status is changed (lead page
-- select, bulk update, or the appointment actions)
-- --------------------------------------------
create or replace function public.sync_lead_attendance()
returns trigger
language plpgsql
as $$
begin
  if new.status is distinct from old.status then
    if new.status = 'showed_up' then
      new.showed_up := true;
      new.arrival_confirmed_at := coalesce(new.arrival_confirmed_at, now());
      new.no_show_reason := null;
    elsif new.status = 'no_show' then
      new.showed_up := false;
      new.arrival_confirmed_at := null;
    end if;
  end if;

  -- A new appointment time starts a fresh attempt
  if new.appointment_at is distinct from old.appointment_at then
    -- unconfirmed again, unless this same update confirms it
    if new.appointment_confirmed is not distinct from old.appointment_confirmed then
      new.appointment_confirmed := false;
    end if;
    new.appointment_reminder_sent_at := null;
    if new.status is not distinct from old.status and old.status in ('showed_up', 'no_show') then
      new.status := 'appointment_booked';
      new.showed_up := null;
      new.arrival_confirmed_at := null;
      new.no_show_reason := null;
    end if;
  end if;
  return new;
end;
$$;

create trigger leads_sync_attendance before update on public.leads
  for each row execute function public.sync_lead_attendance();

-- --------------------------------------------
-- Timeline: appointment changes and confirmations
-- --------------------------------------------
alter table public.lead_events drop constraint if exists lead_events_event_type_check;
alter table public.lead_events add constraint lead_events_event_type_check check (event_type in (
  'created', 'status_changed', 'details_updated', 'notes_updated',
  'follow_up_set', 'contacted', 'appointment_set', 'appointment_confirmed'
));

create or replace function public.record_lead_events()
returns trigger
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  changed text[] := '{}';
begin
  if tg_op = 'INSERT' then
    insert into public.lead_events (lead_id, event_type, to_value, actor_id)
    values (new.id, 'created', new.status::text, actor);
    if new.appointment_at is not null then
      insert into public.lead_events (lead_id, event_type, to_value, actor_id)
      values (new.id, 'appointment_set', public.iso_utc(new.appointment_at), actor);
    end if;
    return new;
  end if;

  if new.status is distinct from old.status then
    insert into public.lead_events (lead_id, event_type, from_value, to_value, actor_id)
    values (new.id, 'status_changed', old.status::text, new.status::text, actor);
  end if;

  if new.appointment_at is distinct from old.appointment_at then
    insert into public.lead_events (lead_id, event_type, from_value, to_value, actor_id)
    values (new.id, 'appointment_set', public.iso_utc(old.appointment_at), public.iso_utc(new.appointment_at), actor);
  end if;

  if new.appointment_confirmed and not old.appointment_confirmed then
    insert into public.lead_events (lead_id, event_type, actor_id)
    values (new.id, 'appointment_confirmed', actor);
  end if;

  if new.follow_up_date is distinct from old.follow_up_date then
    insert into public.lead_events (lead_id, event_type, from_value, to_value, actor_id)
    values (new.id, 'follow_up_set', public.iso_utc(old.follow_up_date), public.iso_utc(new.follow_up_date), actor);
  end if;

  if new.last_contacted_at is distinct from old.last_contacted_at and new.last_contacted_at is not null then
    insert into public.lead_events (lead_id, event_type, to_value, actor_id)
    values (new.id, 'contacted', public.iso_utc(new.last_contacted_at), actor);
  end if;

  if new.notes is distinct from old.notes then
    insert into public.lead_events (lead_id, event_type, actor_id)
    values (new.id, 'notes_updated', actor);
  end if;

  if new.name is distinct from old.name then changed := changed || 'name'; end if;
  if new.phone is distinct from old.phone then changed := changed || 'phone'; end if;
  if new.service_requested is distinct from old.service_requested then changed := changed || 'service_requested'; end if;
  if new.budget is distinct from old.budget then changed := changed || 'budget'; end if;
  if new.branch is distinct from old.branch then changed := changed || 'branch'; end if;

  if array_length(changed, 1) > 0 then
    insert into public.lead_events (lead_id, event_type, to_value, actor_id)
    values (new.id, 'details_updated', array_to_string(changed, ','), actor);
  end if;

  return new;
end;
$$ language plpgsql;

-- --------------------------------------------
-- Journey stats per client for a period (security invoker: RLS applies).
-- Cohort = leads created in the period, so each funnel step is a subset of
-- the previous one:
--   leads → booked (got an appointment) → showed_up / no_show
-- attendance_rate = showed_up / (showed_up + no_show), null if none resolved.
-- --------------------------------------------
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
    on l.client_id = c.id and l.created_at >= p_from and l.created_at < p_to
  where p_client_id is null or c.id = p_client_id
  group by c.id, c.name
$$;

revoke execute on function public.get_journey_stats(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.get_journey_stats(uuid, timestamptz, timestamptz) to authenticated, service_role;

-- Last 30 days per client; security_invoker so RLS limits it to the caller's clients
create or replace view public.client_journey_stats
with (security_invoker = true) as
  select * from public.get_journey_stats();

revoke all on public.client_journey_stats from anon;

-- --------------------------------------------
-- Upcoming appointments (security invoker: RLS applies)
-- --------------------------------------------
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
   where l.appointment_at >= now()
     and l.appointment_at < now() + make_interval(days => greatest(p_days_ahead, 0))
     and (p_client_id is null or l.client_id = p_client_id)
   order by l.appointment_at
$$;

revoke execute on function public.get_upcoming_appointments(uuid, int) from public, anon;
grant execute on function public.get_upcoming_appointments(uuid, int) to authenticated, service_role;
