-- ============================================
-- Changing a client's plan starts its usage alerts over, and an upgrade
-- starts its lead-capture allowance over
-- ============================================
-- 1. Usage alerts are recorded once per limit and threshold per window.
--    Thresholds already marked on the old plan (say 100 % of 200 messages)
--    kept the same ones from being raised on the new plan (100 % of 600) for
--    the rest of the month. The client's limit alerts are now cleared when
--    its plan changes; the update itself re-records whatever the new plan's
--    thresholds already are (client_subscriptions_usage_alerts trigger).
--    The AI-cost alert goes too: it compares the month's cost to the plan's
--    price, so a new price makes the recorded one meaningless. The next AI
--    call re-checks it against the new price (check_ai_cost_alert).
-- 2. lead_capture_used (messages analysed for leads past the limit) goes back
--    to 0 when the new plan allows more messages than the old one (an
--    unlimited plan counts as more). A downgrade, or a plan with the same
--    limit, keeps it.
create or replace function public.change_client_plan(p_client_id uuid, p_plan_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old_plan uuid;
  v_old_limit int;
  v_new_limit int;
begin
  if not public.can_manage_client_billing(p_client_id) or auth.uid() is null then return 'forbidden'; end if;
  if not exists (
    select 1 from public.plans p
     where p.id = p_plan_id
       and p.plan_type = 'business'
       and (p.is_active or p.id = (select cs.plan_id from public.client_subscriptions cs where cs.client_id = p_client_id))
  ) then
    return 'invalid';
  end if;

  select cs.plan_id, p.messages_limit into v_old_plan, v_old_limit
    from public.client_subscriptions cs
    join public.plans p on p.id = cs.plan_id
   where cs.client_id = p_client_id
     for update of cs;
  if not found then return 'not_found'; end if;
  if v_old_plan = p_plan_id then return 'ok'; end if;

  select p.messages_limit into v_new_limit from public.plans p where p.id = p_plan_id;

  delete from public.usage_alerts a where a.client_id = p_client_id;

  update public.client_subscriptions cs set
    plan_id = p_plan_id,
    lead_capture_used = case
      -- null: unlimited
      when v_old_limit is not null and (v_new_limit is null or v_new_limit > v_old_limit) then 0
      else cs.lead_capture_used
    end
   where cs.client_id = p_client_id;
  return 'ok';
end;
$$;
