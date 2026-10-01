-- ============================================
-- Lead capture past the message limit: its own counter
-- ============================================
-- Past the plan's monthly messages the bot stops replying, but visitor
-- messages are still analysed for leads, for as many messages again as the
-- plan allows (so analysis stops at twice the limit). Those messages are
-- counted here, not in messages_used: that one stays "AI replies this month",
-- never passes the plan limit, and keeps meaning the same for usage alerts,
-- the admin tables and a plan change (an upgrade doesn't inherit messages the
-- bot never answered).
alter table public.client_subscriptions
  add column lead_capture_used int not null default 0;

-- Counts one message analysed past the limit. false once the allowance (one
-- more plan's worth) is spent. Checked and counted in one statement, so
-- concurrent messages can't overshoot. Called only while the limit is reached,
-- with the service role.
create function public.claim_lead_capture(p_client_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  with claimed as (
    update public.client_subscriptions cs
       set lead_capture_used = cs.lead_capture_used + 1
      from public.plans p
     where cs.client_id = p_client_id
       and p.id = cs.plan_id
       and cs.lead_capture_used < p.messages_limit
    returning 1
  )
  select exists (select 1 from claimed)
$$;

revoke execute on function public.claim_lead_capture(uuid) from public, anon, authenticated;
grant execute on function public.claim_lead_capture(uuid) to service_role;

-- One AI reply used (the bot, with the service role). A new monthly window
-- starts both counters over.
create or replace function public.consume_client_message(p_client_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.client_subscriptions cs set
    messages_used = case
      when public.messages_window_start(cs.messages_period_start) > cs.messages_period_start then 1
      else cs.messages_used + 1
    end,
    lead_capture_used = case
      when public.messages_window_start(cs.messages_period_start) > cs.messages_period_start then 0
      else cs.lead_capture_used
    end,
    messages_period_start = public.messages_window_start(cs.messages_period_start)
   where cs.client_id = p_client_id
$$;
