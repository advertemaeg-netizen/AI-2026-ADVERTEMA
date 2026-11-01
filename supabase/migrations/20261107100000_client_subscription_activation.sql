-- ============================================
-- A SUPER ADMIN ACTIVATES OR DEACTIVATES A CLIENT'S SUBSCRIPTION, DIRECTLY
-- ============================================
-- Any client: an agency's client or a direct business's one client. Without
-- an invoice: paying (mark_invoice_paid) stays the other way in, untouched.
--
-- What it writes, on client_subscriptions only:
--   activate:   status = 'active'
--               current_period_start = now(), unless it was already active
--                 (active or past_due), when the running period keeps its start
--               current_period_end = the end date given, or when none is given
--                 the later of the period's end and the next message reset
--                 (the monthly message credit's date, messages_period_start
--                 plus whole months), so the card's "renews on" date is never
--                 in the past
--   deactivate: status = 'cancelled' (the one status that isn't usable and
--                 isn't a trial), current_period_end = now() if it ran later,
--                 so the card reads "ended on" today
-- Never plan_id, trial_ends_at, notes, any usage counter, the custom price
-- (client_custom_pricing), or invoices.
--
-- THE END DATE IS NOT A CUT-OFF. Nothing turns an active subscription off at
-- its current_period_end, for a paid invoice's period as for this one: the
-- bot's gate (client_subscription_usable) reads status alone once it is
-- active. Making this end date stop the bot would need a column the gate
-- reads, and a later paid invoice would then have to clear it, which is the
-- invoice path. Until that is decided, the date is the period's end as the
-- cards show it, and deactivating is done by deactivating.
--
-- Triggers the update fires: client_subscriptions_updated_at (updated_at)
-- and block_impersonated_writes (an impersonating super admin is refused
-- before that anyway). Not client_subscriptions_plan_type (plan_id is not
-- in the SET list) and not client_subscriptions_usage_alerts (no counter or
-- plan_id changes).
--
-- Who and when: one row per change in client_subscription_events, written
-- by the same function in the same transaction, from auth.uid() on the
-- server, not from anything the caller sends. Super admins read it; nobody
-- writes it except through the function.
-- ============================================

create table public.client_subscription_events (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  action text not null check (action in ('activate', 'deactivate')),
  from_status text not null,
  to_status text not null,
  period_end timestamptz not null,
  note text check (note is null or length(note) <= 500),
  changed_by uuid references public.users(id) on delete set null,
  changed_at timestamptz not null default now()
);

create index idx_client_subscription_events_client on public.client_subscription_events(client_id, changed_at desc);

alter table public.client_subscription_events enable row level security;

create policy "Super admins read client subscription events"
  on public.client_subscription_events for select
  using (public.is_super_admin());

revoke all on table public.client_subscription_events from public, anon, authenticated;
grant select on table public.client_subscription_events to authenticated;
grant all on table public.client_subscription_events to service_role;

-- Impersonation is read-only on every table (tests/access/table-guards.test.ts)
create trigger block_impersonated_writes before insert or update or delete on public.client_subscription_events
  for each statement execute function public.block_impersonated_writes();

-- 'ok' | 'forbidden' | 'not_found' | 'invalid' | 'invalid_status'
create function public.set_client_subscription_active(
  p_client_id uuid,
  p_active boolean,
  p_period_end timestamptz default null,
  p_note text default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_before public.client_subscriptions;
  v_after public.client_subscriptions;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  -- Super admins only. Not the service role (no auth.uid(): nobody to
  -- record), and not a super admin impersonating a customer (user_role()
  -- reads org_admin then, so is_super_admin() is false).
  if auth.uid() is null or not public.is_super_admin() then return 'forbidden'; end if;

  if p_active is null then return 'invalid'; end if;
  if v_note is not null and length(v_note) > 500 then return 'invalid'; end if;
  -- An end date belongs to an activation, and lies ahead
  if p_period_end is not null and (not p_active or p_period_end <= now()) then return 'invalid'; end if;

  select * into v_before from public.client_subscriptions where client_id = p_client_id for update;
  if not found then return 'not_found'; end if;

  if p_active then
    update public.client_subscriptions cs set
      status = 'active',
      current_period_start = case when cs.status in ('active', 'past_due') then cs.current_period_start else now() end,
      current_period_end = coalesce(
        p_period_end,
        greatest(cs.current_period_end, public.messages_window_start(cs.messages_period_start) + interval '1 month')
      )
     where cs.id = v_before.id
    returning * into v_after;
  else
    if v_before.status = 'cancelled' then return 'invalid_status'; end if;
    update public.client_subscriptions cs set
      status = 'cancelled',
      current_period_end = least(cs.current_period_end, now())
     where cs.id = v_before.id
    returning * into v_after;
  end if;

  insert into public.client_subscription_events
    (client_id, action, from_status, to_status, period_end, note, changed_by)
  values
    (p_client_id, case when p_active then 'activate' else 'deactivate' end,
     v_before.status, v_after.status, v_after.current_period_end, v_note, auth.uid());

  return 'ok';
end;
$$;

revoke execute on function public.set_client_subscription_active(uuid, boolean, timestamptz, text) from public, anon;
grant execute on function public.set_client_subscription_active(uuid, boolean, timestamptz, text) to authenticated, service_role;
