-- ============================================
-- CLIENT SUBSCRIPTIONS: billing on two levels
--
--   organization (agency) → an agency plan, paid to the platform.
--                           Limits: clients, team members (the whole org).
--   client (business)     → a business plan, paid to the agency.
--                           Limits: messages / month, channels, knowledge
--                           files, team members of that client.
--
-- Plan prices are set by super admins only. An agency can't change them, but
-- can give one of its clients a custom price (discount or fixed price).
-- Invoices are either platform → agency (billed_to = 'platform') or
-- agency → its client (billed_to = 'agency', client_id set); one number
-- sequence for both.
-- ============================================

-- --------------------------------------------
-- 1. Plans: each level has its own plan type
-- --------------------------------------------

-- Seed plans: drop the limits that no longer apply to their level
update public.plans
   set messages_limit = null, channels_limit = null, knowledge_docs_limit = null
 where plan_type = 'agency';

update public.plans set clients_limit = null where plan_type = 'business';

update public.plans set features = case slug
  when 'agency_starter' then
    '[{"ar": "حتى 5 عملاء", "en": "Up to 5 clients"},
      {"ar": "5 أعضاء فريق", "en": "5 team members"},
      {"ar": "لوحة موحدة لكل العملاء", "en": "One dashboard for every client"},
      {"ar": "فوترة عملائك من المنصة", "en": "Bill your clients from the platform"}]'::jsonb
  when 'agency_pro' then
    '[{"ar": "حتى 15 عميل", "en": "Up to 15 clients"},
      {"ar": "15 عضو فريق", "en": "15 team members"},
      {"ar": "تحليلات وتقارير متقدمة", "en": "Advanced analytics and reports"},
      {"ar": "فوترة عملائك من المنصة", "en": "Bill your clients from the platform"}]'::jsonb
  when 'agency_business' then
    '[{"ar": "عملاء بلا حدود", "en": "Unlimited clients"},
      {"ar": "40 عضو فريق", "en": "40 team members"},
      {"ar": "تحليلات وتقارير متقدمة", "en": "Advanced analytics and reports"},
      {"ar": "دعم بأولوية", "en": "Priority support"}]'::jsonb
end
 where slug in ('agency_starter', 'agency_pro', 'agency_business');

-- A plan in use can't switch type (its subscribers are on the other level)
create or replace function public.guard_plan_type()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.plan_type is distinct from old.plan_type and (
    exists (select 1 from public.subscriptions where plan_id = old.id)
    or exists (select 1 from public.client_subscriptions where plan_id = old.id)
    or exists (select 1 from public.client_custom_pricing where plan_id = old.id)
  ) then
    raise exception 'plan_type_in_use' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

-- Subscriptions only take plans of their level
create or replace function public.enforce_plan_type()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_expected text := tg_argv[0];
begin
  if new.plan_id is not null
     and (select p.plan_type from public.plans p where p.id = new.plan_id) is distinct from v_expected then
    raise exception 'plan_type_mismatch: expected %', v_expected using errcode = '23514';
  end if;
  return new;
end;
$$;

-- --------------------------------------------
-- 2. Organization subscriptions: agency plans, org-level limits only
-- --------------------------------------------

-- Organizations put on a business plan by the previous migration move to the
-- first agency plan; everything else about their subscription stays.
update public.subscriptions s
   set plan_id = (
     select p.id from public.plans p
      where p.plan_type = 'agency'
      order by (p.slug = 'agency_starter') desc, p.is_active desc, p.sort_order
      limit 1
   )
 where (select p.plan_type from public.plans p where p.id = s.plan_id) <> 'agency'
   and exists (select 1 from public.plans p where p.plan_type = 'agency');

-- Custom prices tied to a business plan no longer match any org plan
delete from public.custom_pricing c
 where c.plan_id is not null
   and (select p.plan_type from public.plans p where p.id = c.plan_id) <> 'agency';

-- The alerts trigger watches columns that move to the client level
drop trigger if exists subscriptions_usage_alerts on public.subscriptions;

alter table public.subscriptions
  drop column messages_used,
  drop column channels_used,
  drop column knowledge_docs_used,
  drop column messages_period_start;

-- Org alerts that belong to clients now
delete from public.usage_alerts where limit_type in ('messages', 'channels', 'knowledge_docs');

create trigger subscriptions_plan_type
  before insert or update of plan_id on public.subscriptions
  for each row execute function public.enforce_plan_type('agency');

create trigger custom_pricing_plan_type
  before insert or update of plan_id on public.custom_pricing
  for each row execute function public.enforce_plan_type('agency');

-- New organizations: the first agency plan with a 14-day trial
create or replace function public.create_default_subscription()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plan uuid;
begin
  select id into v_plan
    from public.plans
   where plan_type = 'agency'
   order by (slug = 'agency_starter') desc, is_active desc, sort_order
   limit 1;
  if v_plan is null then return new; end if;

  insert into public.subscriptions
    (organization_id, plan_id, status, billing_cycle, trial_ends_at, current_period_start, current_period_end)
  values
    (new.id, v_plan, 'trialing', 'monthly', now() + interval '14 days', now(), now() + interval '14 days')
  on conflict (organization_id) do nothing;
  return new;
end;
$$;

-- --------------------------------------------
-- 3. Client subscriptions: one per client, on a business plan
-- --------------------------------------------
create table public.client_subscriptions (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null unique references public.clients(id) on delete cascade,
  plan_id uuid not null references public.plans(id),
  billing_cycle text not null default 'monthly' check (billing_cycle in ('monthly', 'yearly')),
  -- Same states as organization subscriptions
  status text not null default 'trialing' check (status in ('trialing', 'active', 'past_due', 'cancelled')),
  messages_used int not null default 0,
  channels_used int not null default 0,
  knowledge_docs_used int not null default 0,
  team_members_used int not null default 0,
  -- Start of the current monthly message window (see messages_window_start)
  messages_period_start timestamptz not null default now(),
  trial_ends_at timestamptz,
  current_period_start timestamptz not null default now(),
  current_period_end timestamptz not null default (now() + interval '14 days'),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_client_subscriptions_plan on public.client_subscriptions(plan_id);

create trigger client_subscriptions_updated_at before update on public.client_subscriptions
  for each row execute function update_updated_at();

create trigger client_subscriptions_plan_type
  before insert or update of plan_id on public.client_subscriptions
  for each row execute function public.enforce_plan_type('business');

-- --------------------------------------------
-- 4. Client custom pricing: set by the agency (or a super admin).
--    percentage: whichever plan the client is on (plan_id null)
--    fixed_price: for one plan (plan_id), per billing cycle
-- --------------------------------------------
create table public.client_custom_pricing (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null unique references public.clients(id) on delete cascade,
  plan_id uuid references public.plans(id) on delete cascade,
  discount_type text not null check (discount_type in ('percentage', 'fixed_price')),
  discount_percentage numeric(5, 2) check (discount_percentage > 0 and discount_percentage <= 100),
  fixed_price_monthly numeric(12, 2) check (fixed_price_monthly >= 0),
  fixed_price_yearly numeric(12, 2) check (fixed_price_yearly >= 0),
  reason text,
  valid_until timestamptz,
  created_by uuid default auth.uid() references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint client_custom_pricing_shape check (
    (discount_type = 'percentage' and discount_percentage is not null)
    or (
      discount_type = 'fixed_price'
      and plan_id is not null
      and (fixed_price_monthly is not null or fixed_price_yearly is not null)
    )
  )
);

create trigger client_custom_pricing_plan_type
  before insert or update of plan_id on public.client_custom_pricing
  for each row execute function public.enforce_plan_type('business');

create trigger plans_guard_type
  before update of plan_type on public.plans
  for each row execute function public.guard_plan_type();

-- --------------------------------------------
-- 5. Invoices: platform → agency, or agency → client
-- --------------------------------------------
alter table public.invoices
  add column client_id uuid references public.clients(id) on delete cascade,
  add column billed_to text not null default 'platform' check (billed_to in ('platform', 'agency'));

alter table public.invoices
  add constraint invoices_billed_to_client check (
    (billed_to = 'platform' and client_id is null)
    or (billed_to = 'agency' and client_id is not null)
  );

create index idx_invoices_client on public.invoices(client_id, created_at desc) where client_id is not null;
create index idx_invoices_billed_to on public.invoices(billed_to, created_at desc);

-- A client's invoice belongs to the client's agency. Numbers, parties and
-- the paid state are only set by the database / mark_invoice_paid().
-- Not security definer: current_user tells API calls from trusted functions.
create or replace function public.guard_invoice()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.client_id is not null then
      select c.organization_id into new.organization_id from public.clients c where c.id = new.client_id;
      new.billed_to := 'agency';
      new.subscription_id := null;
    end if;
    if current_user in ('authenticated', 'anon') and new.status = 'paid' then
      raise exception 'invoices are marked paid with mark_invoice_paid()' using errcode = '42501';
    end if;
    return new;
  end if;

  if new.invoice_number is distinct from old.invoice_number
     or new.organization_id is distinct from old.organization_id
     or new.client_id is distinct from old.client_id
     or new.billed_to is distinct from old.billed_to then
    raise exception 'invoice parties and number can''t change' using errcode = '42501';
  end if;
  if current_user in ('authenticated', 'anon') and new.status = 'paid' and old.status <> 'paid' then
    raise exception 'invoices are marked paid with mark_invoice_paid()' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger invoices_guard before insert or update on public.invoices
  for each row execute function public.guard_invoice();

-- --------------------------------------------
-- 6. Usage alerts: organization-level (client_id null) or per client
-- --------------------------------------------
alter table public.usage_alerts
  add column client_id uuid references public.clients(id) on delete cascade;

create index idx_usage_alerts_client on public.usage_alerts(client_id, created_at desc) where client_id is not null;

-- --------------------------------------------
-- 7. Usage helpers (internal)
-- --------------------------------------------

-- Organization: clients and team members only
create or replace function public.subscription_usage(p_org_id uuid)
returns table (limit_type text, used int, limit_value int, usable boolean)
language sql
stable
security definer
set search_path = public
as $$
  select l.limit_type, l.used, l.limit_value, public.subscription_usable(s)
    from public.subscriptions s
    join public.plans p on p.id = s.plan_id
    cross join lateral (values
      ('clients', s.clients_used, p.clients_limit, 1),
      ('team_members', s.team_members_used, p.team_members_limit, 2)
    ) as l(limit_type, used, limit_value, ord)
   where s.organization_id = p_org_id
   order by l.ord
$$;

create or replace function public.refresh_subscription_usage(p_org_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.subscriptions s set
    clients_used = (select count(*) from public.clients c where c.organization_id = p_org_id),
    team_members_used = (select count(*) from public.users u where u.organization_id = p_org_id)
   where s.organization_id = p_org_id
$$;

create or replace function public.record_usage_alerts(p_org_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.usage_alerts (organization_id, limit_type, threshold)
  select p_org_id, u.limit_type, t.threshold
    from public.subscription_usage(p_org_id) u
    cross join (values (80), (90), (100)) as t(threshold)
    join public.subscriptions s on s.organization_id = p_org_id
   where u.limit_value > 0
     and u.used * 100 >= t.threshold * u.limit_value
     and not exists (
       select 1 from public.usage_alerts a
        where a.organization_id = p_org_id
          and a.client_id is null
          and a.limit_type = u.limit_type
          and a.threshold = t.threshold
          and a.created_at >= s.current_period_start
     )
$$;

create or replace function public.client_subscription_usable(s public.client_subscriptions)
returns boolean
language sql
stable
as $$
  select s.status in ('active', 'past_due')
      or (s.status = 'trialing' and (s.trial_ends_at is null or s.trial_ends_at > now()))
$$;

-- A client works while its own subscription and its agency's are usable
create or replace function public.client_usage(p_client_id uuid)
returns table (limit_type text, used int, limit_value int, usable boolean)
language sql
stable
security definer
set search_path = public
as $$
  select l.limit_type, l.used, l.limit_value,
         public.client_subscription_usable(cs)
           and coalesce((select public.subscription_usable(s) from public.subscriptions s
                          where s.organization_id = c.organization_id), true)
    from public.client_subscriptions cs
    join public.clients c on c.id = cs.client_id
    join public.plans p on p.id = cs.plan_id
    cross join lateral (values
      ('messages', case when public.messages_window_start(cs.messages_period_start) > cs.messages_period_start
                        then 0 else cs.messages_used end, p.messages_limit, 1),
      ('channels', cs.channels_used, p.channels_limit, 2),
      ('knowledge_docs', cs.knowledge_docs_used, p.knowledge_docs_limit, 3),
      ('team_members', cs.team_members_used, p.team_members_limit, 4)
    ) as l(limit_type, used, limit_value, ord)
   where cs.client_id = p_client_id
   order by l.ord
$$;

-- {allowed, used, limit, percentage, reason}; null if the client has no subscription
create or replace function public.client_limit_status(p_client_id uuid, p_limit_type text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'allowed', u.usable and (u.limit_value is null or u.used < u.limit_value),
    'used', u.used,
    'limit', u.limit_value,
    'percentage', case
      when u.limit_value is null then null
      when u.limit_value = 0 then 100
      else round(u.used * 100.0 / u.limit_value, 1)
    end,
    'reason', case
      when not u.usable then 'inactive'
      when u.limit_value is not null and u.used >= u.limit_value then 'limit_reached'
      else 'ok'
    end
  )
    from public.client_usage(p_client_id) u
   where u.limit_type = p_limit_type
$$;

-- usage jsonb array ({limit_type, used, limit, percentage}) for pages and tables
create or replace function public.client_usage_json(p_client_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'limit_type', u.limit_type,
    'used', u.used,
    'limit', u.limit_value,
    'percentage', case
      when u.limit_value is null then null
      when u.limit_value = 0 then 100
      else round(u.used * 100.0 / u.limit_value, 1)
    end
  )), '[]'::jsonb)
    from public.client_usage(p_client_id) u
$$;

create or replace function public.refresh_client_usage(p_client_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.client_subscriptions cs set
    channels_used = (select count(*) from public.channels ch where ch.client_id = p_client_id),
    knowledge_docs_used = (
      select count(*) from public.knowledge_documents k
       where k.client_id = p_client_id and k.source_document_id is null
    ),
    team_members_used = (select count(*) from public.client_members cm where cm.client_id = p_client_id)
   where cs.client_id = p_client_id
$$;

-- One alert per (client, limit, threshold) per window: the monthly message
-- window, or the billing period for everything else
create or replace function public.record_client_usage_alerts(p_client_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.usage_alerts (organization_id, client_id, limit_type, threshold)
  select c.organization_id, p_client_id, u.limit_type, t.threshold
    from public.client_usage(p_client_id) u
    cross join (values (80), (90), (100)) as t(threshold)
    join public.client_subscriptions cs on cs.client_id = p_client_id
    join public.clients c on c.id = p_client_id
   where u.limit_value > 0
     and u.used * 100 >= t.threshold * u.limit_value
     and not exists (
       select 1 from public.usage_alerts a
        where a.client_id = p_client_id
          and a.limit_type = u.limit_type
          and a.threshold = t.threshold
          and a.created_at >= case
            when u.limit_type = 'messages' then public.messages_window_start(cs.messages_period_start)
            else cs.current_period_start
          end
     )
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'client_usage(uuid)',
    'client_limit_status(uuid, text)',
    'client_usage_json(uuid)',
    'refresh_client_usage(uuid)',
    'record_client_usage_alerts(uuid)'
  ] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', fn);
  end loop;
end $$;

-- --------------------------------------------
-- 8. Triggers: counters, alerts, limits, new clients
-- --------------------------------------------
create or replace function public.sync_subscription_usage()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
  v_old_org uuid;
  v_client uuid;
begin
  if tg_table_name in ('clients', 'users') then
    if tg_op <> 'DELETE' then v_org := new.organization_id; end if;
    if tg_op <> 'INSERT' then v_old_org := old.organization_id; end if;
    if v_org is not null then
      perform public.refresh_subscription_usage(v_org);
    end if;
    if v_old_org is not null and v_old_org is distinct from v_org then
      perform public.refresh_subscription_usage(v_old_org);
    end if;
  else
    -- channels / knowledge_documents / client_members. While a client is
    -- being deleted its subscription may already be gone (nothing to update).
    if tg_op = 'DELETE' then v_client := old.client_id; else v_client := new.client_id; end if;
    perform public.refresh_client_usage(v_client);
  end if;
  return null;
end;
$$;

create trigger client_members_sync_usage
  after insert or delete on public.client_members
  for each row execute function public.sync_subscription_usage();

create trigger subscriptions_usage_alerts
  after update on public.subscriptions
  for each row
  when (
    (old.clients_used, old.team_members_used, old.plan_id)
    is distinct from
    (new.clients_used, new.team_members_used, new.plan_id)
  )
  execute function public.subscription_alerts_trigger();

create or replace function public.client_subscription_alerts_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.record_client_usage_alerts(new.client_id);
  return null;
end;
$$;

create trigger client_subscriptions_usage_alerts
  after update on public.client_subscriptions
  for each row
  when (
    (old.messages_used, old.channels_used, old.knowledge_docs_used, old.team_members_used, old.plan_id)
    is distinct from
    (new.messages_used, new.channels_used, new.knowledge_docs_used, new.team_members_used, new.plan_id)
  )
  execute function public.client_subscription_alerts_trigger();

-- Backstop for the app-side checks (and races): clients count against the
-- organization, channels and knowledge files against the client.
-- The app maps "subscription_limit:<type>" to a friendly message.
create or replace function public.enforce_subscription_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_type text := tg_argv[0];
  v_status jsonb;
begin
  if tg_table_name = 'clients' then
    v_status := public.subscription_limit_status(new.organization_id, v_type);
  else
    v_status := public.client_limit_status(new.client_id, v_type);
  end if;

  if v_status is not null and not (v_status->>'allowed')::boolean then
    raise exception 'subscription_limit:%', v_type
      using errcode = 'P0001', hint = v_status->>'reason';
  end if;
  return new;
end;
$$;

-- New clients: business_basic (or the first business plan) with a 14-day trial
create or replace function public.create_default_client_subscription()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plan uuid;
begin
  select id into v_plan
    from public.plans
   where plan_type = 'business'
   order by (slug = 'business_basic') desc, is_active desc, sort_order
   limit 1;
  if v_plan is null then return new; end if;

  insert into public.client_subscriptions
    (client_id, plan_id, status, billing_cycle, trial_ends_at, current_period_start, current_period_end)
  values
    (new.id, v_plan, 'trialing', 'monthly', now() + interval '14 days', now(), now() + interval '14 days')
  on conflict (client_id) do nothing;
  -- The creator may already have been added as a member (earlier trigger)
  perform public.refresh_client_usage(new.id);
  return new;
end;
$$;

create trigger clients_default_subscription
  after insert on public.clients
  for each row execute function public.create_default_client_subscription();

-- Existing clients: business_basic with a 14-day trial
insert into public.client_subscriptions
  (client_id, plan_id, status, billing_cycle, trial_ends_at, current_period_start, current_period_end)
select c.id,
       (select p.id from public.plans p
         where p.plan_type = 'business'
         order by (p.slug = 'business_basic') desc, p.is_active desc, p.sort_order
         limit 1),
       'trialing', 'monthly', now() + interval '14 days', now(), now() + interval '14 days'
  from public.clients c
 where exists (select 1 from public.plans p where p.plan_type = 'business')
on conflict (client_id) do nothing;

do $$
declare
  v_id uuid;
begin
  for v_id in select id from public.clients loop
    perform public.refresh_client_usage(v_id);
  end loop;
  for v_id in select id from public.organizations loop
    perform public.refresh_subscription_usage(v_id);
  end loop;
end $$;

-- --------------------------------------------
-- 9. Access checks
-- --------------------------------------------

-- Changing a client's plan, custom price or invoices: its agency's admins
-- and super admins. No auth.uid() = service role / trusted server code.
create or replace function public.can_manage_client_billing(p_client_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is null
      or public.is_super_admin()
      or (
        public.user_role() = 'org_admin'
        and exists (select 1 from public.clients c where c.id = p_client_id and c.organization_id = public.user_org())
      )
$$;

-- Seeing them: also the client's own admins
create or replace function public.can_view_client_billing(p_client_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.can_manage_client_billing(p_client_id)
      or (public.user_role() = 'client_admin' and public.has_client_access(p_client_id))
$$;

-- Used by RLS policies, so signed-in users need them
revoke execute on function public.can_manage_client_billing(uuid) from public, anon;
revoke execute on function public.can_view_client_billing(uuid) from public, anon;
grant execute on function public.can_manage_client_billing(uuid) to authenticated, service_role;
grant execute on function public.can_view_client_billing(uuid) to authenticated, service_role;

-- --------------------------------------------
-- 10. Public functions
-- --------------------------------------------

-- Organization limits (clients, team_members)
create or replace function public.check_org_limit(p_org_id uuid, p_limit_type text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select public.subscription_limit_status(p_org_id, p_limit_type)
   where public.can_view_limits(p_org_id)
$$;

-- Client limits (messages, channels, knowledge_docs, team_members); anyone
-- who can see the client
create or replace function public.check_client_limit(p_client_id uuid, p_limit_type text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select public.client_limit_status(p_client_id, p_limit_type)
   where auth.uid() is null or public.has_client_access(p_client_id)
$$;

drop function if exists public.check_subscription_limit(uuid, text);
drop function if exists public.consume_subscription_message(uuid);

-- One AI reply used (the bot, with the service role)
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
    messages_period_start = public.messages_window_start(cs.messages_period_start)
   where cs.client_id = p_client_id
$$;

-- Final price for a client after its custom pricing. p_plan_id prices another
-- plan (upgrade cards); default: the client's current plan.
create or replace function public.get_client_effective_price(
  p_client_id uuid,
  p_billing_cycle text,
  p_plan_id uuid default null
)
returns numeric
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_plan public.plans;
  v_custom public.client_custom_pricing;
  v_base numeric;
  v_fixed numeric;
begin
  if not public.can_view_client_billing(p_client_id) then return null; end if;
  if p_billing_cycle not in ('monthly', 'yearly') then
    raise exception 'invalid billing cycle: %', p_billing_cycle using errcode = '22023';
  end if;

  select p.* into v_plan
    from public.plans p
   where p.id = coalesce(p_plan_id, (select cs.plan_id from public.client_subscriptions cs where cs.client_id = p_client_id));
  if v_plan.id is null then return null; end if;

  v_base := case when p_billing_cycle = 'yearly' then v_plan.price_yearly else v_plan.price_monthly end;

  select c.* into v_custom
    from public.client_custom_pricing c
   where c.client_id = p_client_id
     and (c.valid_until is null or c.valid_until > now())
     and (c.plan_id is null or c.plan_id = v_plan.id);
  if v_custom.id is null then return v_base; end if;

  if v_custom.discount_type = 'percentage' then
    return round(v_base * (100 - v_custom.discount_percentage) / 100, 2);
  end if;

  v_fixed := case when p_billing_cycle = 'yearly' then v_custom.fixed_price_yearly else v_custom.fixed_price_monthly end;
  return coalesce(v_fixed, v_base);
end;
$$;

-- Everything the organization subscription page needs (org-level limits)
create or replace function public.get_subscription_details(p_org_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'subscription', jsonb_build_object(
      'id', s.id,
      'organization_id', s.organization_id,
      'status', s.status,
      'usable', public.subscription_usable(s),
      'billing_cycle', s.billing_cycle,
      'current_period_start', public.iso_utc(s.current_period_start),
      'current_period_end', public.iso_utc(s.current_period_end),
      'trial_ends_at', public.iso_utc(s.trial_ends_at),
      'messages_period_start', null,
      'notes', s.notes
    ),
    'plan', to_jsonb(p) - 'created_at' - 'updated_at',
    'custom_pricing', (
      select jsonb_build_object(
        'discount_type', c.discount_type,
        'discount_percentage', c.discount_percentage,
        'fixed_price_monthly', c.fixed_price_monthly,
        'fixed_price_yearly', c.fixed_price_yearly,
        'plan_id', c.plan_id,
        'reason', c.reason,
        'valid_until', public.iso_utc(c.valid_until),
        'created_at', public.iso_utc(c.created_at),
        'applies', (c.valid_until is null or c.valid_until > now()) and (c.plan_id is null or c.plan_id = s.plan_id)
      )
        from public.custom_pricing c
       where c.organization_id = s.organization_id
    ),
    'price', jsonb_build_object(
      'monthly', public.get_effective_price(s.organization_id, 'monthly'),
      'yearly', public.get_effective_price(s.organization_id, 'yearly'),
      'current', public.get_effective_price(s.organization_id, s.billing_cycle),
      'base_current', case when s.billing_cycle = 'yearly' then p.price_yearly else p.price_monthly end
    ),
    'usage', (
      select jsonb_agg(jsonb_build_object(
        'limit_type', u.limit_type,
        'used', u.used,
        'limit', u.limit_value,
        'percentage', case
          when u.limit_value is null then null
          when u.limit_value = 0 then 100
          else round(u.used * 100.0 / u.limit_value, 1)
        end
      ))
        from public.subscription_usage(s.organization_id) u
    )
  )
    from public.subscriptions s
    join public.plans p on p.id = s.plan_id
   where s.organization_id = p_org_id
     and public.can_view_billing(p_org_id)
$$;

-- Everything the client subscription page needs
create or replace function public.get_client_subscription_details(p_client_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'subscription', jsonb_build_object(
      'id', cs.id,
      'client_id', cs.client_id,
      'organization_id', cl.organization_id,
      'status', cs.status,
      'usable', public.client_subscription_usable(cs),
      'agency_usable', coalesce((select public.subscription_usable(s) from public.subscriptions s
                                  where s.organization_id = cl.organization_id), true),
      'billing_cycle', cs.billing_cycle,
      'current_period_start', public.iso_utc(cs.current_period_start),
      'current_period_end', public.iso_utc(cs.current_period_end),
      'trial_ends_at', public.iso_utc(cs.trial_ends_at),
      'messages_period_start', public.iso_utc(public.messages_window_start(cs.messages_period_start)),
      'notes', cs.notes
    ),
    'client', jsonb_build_object('id', cl.id, 'name', cl.name),
    'plan', to_jsonb(p) - 'created_at' - 'updated_at',
    'custom_pricing', (
      select jsonb_build_object(
        'discount_type', c.discount_type,
        'discount_percentage', c.discount_percentage,
        'fixed_price_monthly', c.fixed_price_monthly,
        'fixed_price_yearly', c.fixed_price_yearly,
        'plan_id', c.plan_id,
        'reason', c.reason,
        'valid_until', public.iso_utc(c.valid_until),
        'created_at', public.iso_utc(c.created_at),
        'applies', (c.valid_until is null or c.valid_until > now()) and (c.plan_id is null or c.plan_id = cs.plan_id)
      )
        from public.client_custom_pricing c
       where c.client_id = cs.client_id
    ),
    'price', jsonb_build_object(
      'monthly', public.get_client_effective_price(cs.client_id, 'monthly'),
      'yearly', public.get_client_effective_price(cs.client_id, 'yearly'),
      'current', public.get_client_effective_price(cs.client_id, cs.billing_cycle),
      'base_current', case when cs.billing_cycle = 'yearly' then p.price_yearly else p.price_monthly end
    ),
    'usage', public.client_usage_json(cs.client_id)
  )
    from public.client_subscriptions cs
    join public.clients cl on cl.id = cs.client_id
    join public.plans p on p.id = cs.plan_id
   where cs.client_id = p_client_id
     and public.can_view_client_billing(p_client_id)
$$;

-- Business plans with this client's prices
create or replace function public.get_client_available_plans(p_client_id uuid)
returns table (
  id uuid,
  slug text,
  name text,
  name_ar text,
  plan_type text,
  price_monthly numeric,
  price_yearly numeric,
  effective_monthly numeric,
  effective_yearly numeric,
  messages_limit int,
  clients_limit int,
  team_members_limit int,
  channels_limit int,
  knowledge_docs_limit int,
  features jsonb,
  is_active boolean,
  sort_order int
)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.slug, p.name, p.name_ar, p.plan_type, p.price_monthly, p.price_yearly,
         coalesce(public.get_client_effective_price(p_client_id, 'monthly', p.id), p.price_monthly),
         coalesce(public.get_client_effective_price(p_client_id, 'yearly', p.id), p.price_yearly),
         p.messages_limit, p.clients_limit, p.team_members_limit, p.channels_limit, p.knowledge_docs_limit,
         p.features, p.is_active, p.sort_order
    from public.plans p
   where p.plan_type = 'business'
     and public.can_view_client_billing(p_client_id)
     -- Inactive plans are hidden, except the one the client is on
     and (p.is_active or p.id = (select cs.plan_id from public.client_subscriptions cs where cs.client_id = p_client_id))
   order by p.sort_order, p.price_monthly
$$;

-- The agency moves one of its clients to another business plan / cycle
create or replace function public.change_client_plan(p_client_id uuid, p_plan_id uuid, p_billing_cycle text)
returns text
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.can_manage_client_billing(p_client_id) or auth.uid() is null then return 'forbidden'; end if;
  if p_billing_cycle not in ('monthly', 'yearly') then return 'invalid'; end if;
  if not exists (
    select 1 from public.plans p
     where p.id = p_plan_id
       and p.plan_type = 'business'
       and (p.is_active or p.id = (select cs.plan_id from public.client_subscriptions cs where cs.client_id = p_client_id))
  ) then
    return 'invalid';
  end if;

  update public.client_subscriptions
     set plan_id = p_plan_id, billing_cycle = p_billing_cycle
   where client_id = p_client_id;
  if not found then return 'not_found'; end if;
  return 'ok';
end;
$$;

-- Every client of the caller's agency with its plan, price and usage
create or replace function public.get_agency_clients_billing()
returns table (
  client_id uuid,
  client_name text,
  client_status text,
  subscription_id uuid,
  status text,
  usable boolean,
  billing_cycle text,
  plan_id uuid,
  plan_slug text,
  plan_name text,
  plan_name_ar text,
  base_price numeric,
  effective_price numeric,
  -- effective price per month (yearly / 12), for the expected revenue
  monthly_value numeric,
  has_custom_pricing boolean,
  current_period_start timestamptz,
  current_period_end timestamptz,
  trial_ends_at timestamptz,
  usage jsonb,
  open_invoices int,
  open_amount numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select c.id, c.name, c.status, cs.id, cs.status, public.client_subscription_usable(cs), cs.billing_cycle,
         p.id, p.slug, p.name, p.name_ar,
         case when cs.billing_cycle = 'yearly' then p.price_yearly else p.price_monthly end,
         public.get_client_effective_price(c.id, cs.billing_cycle),
         case when cs.billing_cycle = 'yearly'
              then round(public.get_client_effective_price(c.id, 'yearly') / 12, 2)
              else public.get_client_effective_price(c.id, 'monthly') end,
         cp.id is not null
           and (cp.valid_until is null or cp.valid_until > now())
           and (cp.plan_id is null or cp.plan_id = cs.plan_id),
         cs.current_period_start, cs.current_period_end, cs.trial_ends_at,
         public.client_usage_json(c.id),
         (select count(*)::int from public.invoices i where i.client_id = c.id and i.status in ('draft', 'sent', 'overdue')),
         (select coalesce(sum(i.amount), 0) from public.invoices i where i.client_id = c.id and i.status in ('sent', 'overdue'))
    from public.clients c
    join public.client_subscriptions cs on cs.client_id = c.id
    join public.plans p on p.id = cs.plan_id
    left join public.client_custom_pricing cp on cp.client_id = c.id
   where c.organization_id = public.user_org()
     and public.can_view_billing(c.organization_id)
   order by c.name
$$;

-- Every client subscription on the platform, for the admin panel
create or replace function public.get_all_client_subscriptions()
returns table (
  client_id uuid,
  client_name text,
  organization_id uuid,
  organization_name text,
  organization_active boolean,
  subscription_id uuid,
  status text,
  usable boolean,
  billing_cycle text,
  plan_id uuid,
  plan_slug text,
  plan_name text,
  plan_name_ar text,
  base_price numeric,
  effective_price numeric,
  has_custom_pricing boolean,
  custom_pricing_reason text,
  current_period_end timestamptz,
  trial_ends_at timestamptz,
  usage jsonb
)
language sql
stable
security definer
set search_path = public
as $$
  select c.id, c.name, o.id, o.name, o.is_active, cs.id, cs.status, public.client_subscription_usable(cs), cs.billing_cycle,
         p.id, p.slug, p.name, p.name_ar,
         case when cs.billing_cycle = 'yearly' then p.price_yearly else p.price_monthly end,
         public.get_client_effective_price(c.id, cs.billing_cycle),
         cp.id is not null
           and (cp.valid_until is null or cp.valid_until > now())
           and (cp.plan_id is null or cp.plan_id = cs.plan_id),
         cp.reason,
         cs.current_period_end, cs.trial_ends_at,
         public.client_usage_json(c.id)
    from public.client_subscriptions cs
    join public.clients c on c.id = cs.client_id
    join public.organizations o on o.id = c.organization_id
    join public.plans p on p.id = cs.plan_id
    left join public.client_custom_pricing cp on cp.client_id = c.id
   where public.is_super_admin()
   order by o.name, c.name
$$;

-- Unread alerts that still hold, the highest threshold per (client, limit):
-- the organization's own and its clients' (org admins' dashboard banner)
drop function if exists public.get_active_usage_alerts();

create function public.get_active_usage_alerts()
returns table (limit_type text, threshold int, used int, limit_value int, client_id uuid, client_name text)
language sql
stable
security definer
set search_path = public
as $$
  select * from (
    select distinct on (a.limit_type) a.limit_type, a.threshold, u.used, u.limit_value,
           null::uuid as client_id, null::text as client_name
      from public.usage_alerts a
      join public.subscription_usage(public.user_org()) u on u.limit_type = a.limit_type
     where a.organization_id = public.user_org()
       and a.client_id is null
       and a.read_at is null
       and public.can_view_billing(a.organization_id)
       and u.limit_value > 0
       and u.used * 100 >= a.threshold * u.limit_value
     order by a.limit_type, a.threshold desc
  ) org_alerts
  union all
  select * from (
    select distinct on (a.client_id, a.limit_type) a.limit_type, a.threshold, u.used, u.limit_value,
           c.id as client_id, c.name as client_name
      from public.usage_alerts a
      join public.clients c on c.id = a.client_id
      cross join lateral public.client_usage(a.client_id) u
     where u.limit_type = a.limit_type
       and a.organization_id = public.user_org()
       and c.organization_id = public.user_org()
       and a.read_at is null
       and public.can_view_billing(a.organization_id)
       and u.limit_value > 0
       and u.used * 100 >= a.threshold * u.limit_value
     order by a.client_id, a.limit_type, a.threshold desc
  ) client_alerts
$$;

-- Super admin: recount the organization's clients and members, clear alerts
create or replace function public.reset_subscription_usage(p_org_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_super_admin() then return false; end if;
  if not exists (select 1 from public.subscriptions where organization_id = p_org_id) then return false; end if;
  perform public.refresh_subscription_usage(p_org_id);
  update public.usage_alerts set read_at = now()
   where organization_id = p_org_id and client_id is null and read_at is null;
  return true;
end;
$$;

-- Records a payment. Super admins: any invoice. Org admins: the invoices
-- their agency issued to its clients. The paid subscription (the
-- organization's or the client's) becomes active and, when the invoice
-- covers a later period, moves on to it.
create or replace function public.mark_invoice_paid(
  p_invoice_id uuid,
  p_payment_method text,
  p_payment_reference text,
  p_paid_at timestamptz default now()
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice public.invoices;
begin
  select * into v_invoice from public.invoices where id = p_invoice_id for update;
  if v_invoice.id is null then
    return case when public.is_super_admin() or public.user_role() = 'org_admin' then 'not_found' else 'forbidden' end;
  end if;

  if not (
    public.is_super_admin()
    or (
      v_invoice.billed_to = 'agency'
      and public.user_role() = 'org_admin'
      and v_invoice.organization_id = public.user_org()
    )
  ) then
    return 'forbidden';
  end if;
  if v_invoice.status in ('paid', 'cancelled') then return 'invalid_status'; end if;

  update public.invoices
     set status = 'paid',
         paid_at = coalesce(p_paid_at, now()),
         payment_method = nullif(trim(p_payment_method), ''),
         payment_reference = nullif(trim(p_payment_reference), '')
   where id = p_invoice_id;

  if v_invoice.client_id is null then
    update public.subscriptions s
       set status = 'active',
           current_period_start = case when v_invoice.period_end > s.current_period_end
                                       then v_invoice.period_start else s.current_period_start end,
           current_period_end = greatest(s.current_period_end, v_invoice.period_end)
     where s.organization_id = v_invoice.organization_id;
  else
    update public.client_subscriptions cs
       set status = 'active',
           current_period_start = case when v_invoice.period_end > cs.current_period_end
                                       then v_invoice.period_start else cs.current_period_start end,
           current_period_end = greatest(cs.current_period_end, v_invoice.period_end)
     where cs.client_id = v_invoice.client_id;
  end if;

  return 'ok';
end;
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'check_org_limit(uuid, text)',
    'check_client_limit(uuid, text)',
    'get_client_effective_price(uuid, text, uuid)',
    'get_client_subscription_details(uuid)',
    'get_client_available_plans(uuid)',
    'change_client_plan(uuid, uuid, text)',
    'get_agency_clients_billing()',
    'get_all_client_subscriptions()',
    'get_active_usage_alerts()'
  ] loop
    execute format('revoke execute on function public.%s from public, anon', fn);
    execute format('grant execute on function public.%s to authenticated, service_role', fn);
  end loop;
end $$;

revoke execute on function public.consume_client_message(uuid) from public, anon, authenticated;
grant execute on function public.consume_client_message(uuid) to service_role;

-- --------------------------------------------
-- 11. RLS
-- --------------------------------------------
alter table public.client_subscriptions enable row level security;
alter table public.client_custom_pricing enable row level security;

-- Plan and cycle changes go through change_client_plan(); counters and
-- periods are only written by the database and super admins.
create policy "Client billing viewers see client subscriptions"
  on public.client_subscriptions for select
  using (public.can_view_client_billing(client_id) and auth.uid() is not null);

create policy "Super admins manage client subscriptions"
  on public.client_subscriptions for all
  using (public.is_super_admin())
  with check (public.is_super_admin());

create policy "Client billing viewers see client custom pricing"
  on public.client_custom_pricing for select
  using (public.can_view_client_billing(client_id) and auth.uid() is not null);

create policy "Agencies manage their clients' custom pricing"
  on public.client_custom_pricing for all
  using (public.can_manage_client_billing(client_id) and auth.uid() is not null)
  with check (public.can_manage_client_billing(client_id) and auth.uid() is not null);

-- Org admins: the platform's invoices to them and theirs to their clients.
-- They issue and update the latter; paying goes through mark_invoice_paid().
drop policy if exists "Org admins see their invoices" on public.invoices;

create policy "Org admins see their invoices"
  on public.invoices for select
  using (public.user_role() = 'org_admin' and organization_id = public.user_org());

create policy "Org admins issue invoices to their clients"
  on public.invoices for insert
  with check (
    public.user_role() = 'org_admin'
    and billed_to = 'agency'
    and organization_id = public.user_org()
    and public.can_manage_client_billing(client_id)
  );

create policy "Org admins update invoices to their clients"
  on public.invoices for update
  using (public.user_role() = 'org_admin' and billed_to = 'agency' and organization_id = public.user_org())
  with check (public.user_role() = 'org_admin' and billed_to = 'agency' and organization_id = public.user_org());

create policy "Client admins see their client's invoices"
  on public.invoices for select
  using (
    billed_to = 'agency'
    and public.user_role() = 'client_admin'
    and public.has_client_access(client_id)
  );
