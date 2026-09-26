-- ============================================
-- LEADS: AI detection fields + change timeline
-- ============================================

alter table public.leads
  add column if not exists source_message_id uuid references public.messages(id) on delete set null,
  add column if not exists confidence_score float
    check (confidence_score is null or (confidence_score >= 0 and confidence_score <= 1)),
  add column if not exists ai_extracted_data jsonb,
  add column if not exists last_contacted_at timestamptz,
  add column if not exists follow_up_date timestamptz;

create index if not exists idx_leads_client_status_created
  on public.leads(client_id, status, created_at desc);

-- At most one lead per conversation, so AI detection updates instead of
-- duplicating. NULLs stay distinct, so leads without a conversation are fine.
alter table public.leads
  add constraint leads_conversation_unique unique (conversation_id);

-- --------------------------------------------
-- Timeline: every relevant change is recorded by trigger, whichever code
-- path made it. actor_id is null for changes made server-side by the AI.
-- --------------------------------------------
create table public.lead_events (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads(id) on delete cascade,
  event_type text not null check (event_type in (
    'created', 'status_changed', 'details_updated', 'notes_updated',
    'follow_up_set', 'contacted'
  )),
  from_value text,
  to_value text,
  actor_id uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index idx_lead_events_lead on public.lead_events(lead_id, created_at);

alter table public.lead_events enable row level security;

-- Readable when the lead is (the subquery runs under leads RLS).
-- No write policies: rows are only written by the trigger below.
create policy "Users see events of leads they can see"
  on public.lead_events for select
  using (exists (select 1 from public.leads l where l.id = lead_id));

-- timestamptz::text isn't reliably parseable by browsers; store ISO 8601 UTC
create or replace function public.iso_utc(ts timestamptz)
returns text
language sql
immutable
as $$
  select to_char(ts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
$$;

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
    return new;
  end if;

  if new.status is distinct from old.status then
    insert into public.lead_events (lead_id, event_type, from_value, to_value, actor_id)
    values (new.id, 'status_changed', old.status::text, new.status::text, actor);
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

create trigger leads_record_events after insert or update on public.leads
  for each row execute function public.record_lead_events();
