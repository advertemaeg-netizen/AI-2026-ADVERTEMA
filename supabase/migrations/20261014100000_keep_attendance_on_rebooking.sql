-- ============================================
-- A new appointment must not erase a recorded visit
-- ============================================
-- Booking a new time on a lead that already attended used to reset showed_up
-- and arrival_confirmed_at to null, so the first visit vanished from the
-- attendance rate. A recorded outcome (showed_up is not null) now stays, along
-- with its status and no-show reason; only an explicit status change (or the
-- attendance actions) replaces it.
--
-- This leaves an in-between state: a showed_up / no_show lead holding a future
-- appointment. It is temporary; rebooking a finished lead will open a new lead
-- instead of overwriting the old one.
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
  end if;
  return new;
end;
$$;
