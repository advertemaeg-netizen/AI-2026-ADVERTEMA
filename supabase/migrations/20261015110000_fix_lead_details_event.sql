-- ============================================
-- Lead timeline: changing a lead's details failed
-- ============================================
-- record_lead_events built its list of changed fields with
--   changed := changed || 'name'
-- Postgres reads the untyped literal as an array (text[] || text[]) and raises
-- "malformed array literal", so every UPDATE that changed name, phone,
-- service_requested, budget or branch was rejected: the team could not edit a
-- lead's details, and the AI could not add a phone or name to an existing
-- lead. array_append takes the element as text. Nothing else changes.
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

  if new.name is distinct from old.name then changed := array_append(changed, 'name'); end if;
  if new.phone is distinct from old.phone then changed := array_append(changed, 'phone'); end if;
  if new.service_requested is distinct from old.service_requested then changed := array_append(changed, 'service_requested'); end if;
  if new.budget is distinct from old.budget then changed := array_append(changed, 'budget'); end if;
  if new.branch is distinct from old.branch then changed := array_append(changed, 'branch'); end if;

  if array_length(changed, 1) > 0 then
    insert into public.lead_events (lead_id, event_type, to_value, actor_id)
    values (new.id, 'details_updated', array_to_string(changed, ','), actor);
  end if;

  return new;
end;
$$ language plpgsql;
