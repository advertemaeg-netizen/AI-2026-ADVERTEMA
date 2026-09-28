-- ============================================
-- MONTHLY BILLING ONLY
--
-- Yearly billing is gone: no billing cycle on subscriptions, no yearly plan
-- price, no yearly custom price. Every price is a monthly price.
--
--   * A subscription that was on the yearly cycle keeps its current period
--     (already paid for) and renews monthly from then on.
--   * A fixed custom price with only a yearly amount becomes a monthly one
--     (yearly / 12) so the discount isn't lost.
-- ============================================

-- --------------------------------------------
-- 1. Functions whose signature or result changes (recreated below)
-- --------------------------------------------
drop function if exists public.get_effective_price(uuid, text, uuid);
drop function if exists public.get_client_effective_price(uuid, text, uuid);
drop function if exists public.change_client_plan(uuid, uuid, text);
drop function if exists public.get_available_plans(text);
drop function if exists public.get_client_available_plans(uuid);
drop function if exists public.get_all_subscriptions();
drop function if exists public.get_all_client_subscriptions();
drop function if exists public.get_agency_clients_billing();

-- --------------------------------------------
-- 2. Custom prices: monthly amounts only
-- --------------------------------------------
update public.custom_pricing
   set fixed_price_monthly = round(fixed_price_yearly / 12, 2)
 where discount_type = 'fixed_price' and fixed_price_monthly is null and fixed_price_yearly is not null;

update public.client_custom_pricing
   set fixed_price_monthly = round(fixed_price_yearly / 12, 2)
 where discount_type = 'fixed_price' and fixed_price_monthly is null and fixed_price_yearly is not null;

alter table public.custom_pricing drop constraint custom_pricing_shape;
alter table public.custom_pricing drop column fixed_price_yearly;
alter table public.custom_pricing
  add constraint custom_pricing_shape check (
    (discount_type = 'percentage' and discount_percentage is not null)
    or (discount_type = 'fixed_price' and plan_id is not null and fixed_price_monthly is not null)
  );

alter table public.client_custom_pricing drop constraint client_custom_pricing_shape;
alter table public.client_custom_pricing drop column fixed_price_yearly;
alter table public.client_custom_pricing
  add constraint client_custom_pricing_shape check (
    (discount_type = 'percentage' and discount_percentage is not null)
    or (discount_type = 'fixed_price' and plan_id is not null and fixed_price_monthly is not null)
  );

-- --------------------------------------------
-- 3. Plans and subscriptions: no yearly price, no cycle
-- --------------------------------------------
alter table public.plans drop column price_yearly;
alter table public.subscriptions drop column billing_cycle;
alter table public.client_subscriptions drop column billing_cycle;

-- --------------------------------------------
-- 4. Prices
-- --------------------------------------------

-- Monthly price for an organization after its custom pricing. p_plan_id
-- prices another plan (upgrade cards); default: the org's current plan.
create function public.get_effective_price(p_org_id uuid, p_plan_id uuid default null)
returns numeric
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_plan public.plans;
  v_custom public.custom_pricing;
begin
  if not public.can_view_billing(p_org_id) then return null; end if;

  select p.* into v_plan
    from public.plans p
   where p.id = coalesce(p_plan_id, (select s.plan_id from public.subscriptions s where s.organization_id = p_org_id));
  if v_plan.id is null then return null; end if;

  select c.* into v_custom
    from public.custom_pricing c
   where c.organization_id = p_org_id
     and (c.valid_until is null or c.valid_until > now())
     and (c.plan_id is null or c.plan_id = v_plan.id);
  if v_custom.id is null then return v_plan.price_monthly; end if;

  if v_custom.discount_type = 'percentage' then
    return round(v_plan.price_monthly * (100 - v_custom.discount_percentage) / 100, 2);
  end if;
  return coalesce(v_custom.fixed_price_monthly, v_plan.price_monthly);
end;
$$;

-- Monthly price for a client after its custom pricing. p_plan_id prices
-- another plan (upgrade cards); default: the client's current plan.
create function public.get_client_effective_price(p_client_id uuid, p_plan_id uuid default null)
returns numeric
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_plan public.plans;
  v_custom public.client_custom_pricing;
begin
  if not public.can_view_client_billing(p_client_id) then return null; end if;

  select p.* into v_plan
    from public.plans p
   where p.id = coalesce(p_plan_id, (select cs.plan_id from public.client_subscriptions cs where cs.client_id = p_client_id));
  if v_plan.id is null then return null; end if;

  select c.* into v_custom
    from public.client_custom_pricing c
   where c.client_id = p_client_id
     and (c.valid_until is null or c.valid_until > now())
     and (c.plan_id is null or c.plan_id = v_plan.id);
  if v_custom.id is null then return v_plan.price_monthly; end if;

  if v_custom.discount_type = 'percentage' then
    return round(v_plan.price_monthly * (100 - v_custom.discount_percentage) / 100, 2);
  end if;
  return coalesce(v_custom.fixed_price_monthly, v_plan.price_monthly);
end;
$$;

-- --------------------------------------------
-- 5. Subscription pages
-- --------------------------------------------
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
      'current', public.get_effective_price(s.organization_id),
      'base', p.price_monthly
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
      'current', public.get_client_effective_price(cs.client_id),
      'base', p.price_monthly
    ),
    'usage', public.client_usage_json(cs.client_id)
  )
    from public.client_subscriptions cs
    join public.clients cl on cl.id = cs.client_id
    join public.plans p on p.id = cs.plan_id
   where cs.client_id = p_client_id
     and public.can_view_client_billing(p_client_id)
$$;

-- Plans of one type with the caller's organization's prices
create function public.get_available_plans(p_plan_type text)
returns table (
  id uuid,
  slug text,
  name text,
  name_ar text,
  plan_type text,
  price_monthly numeric,
  effective_monthly numeric,
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
  select p.id, p.slug, p.name, p.name_ar, p.plan_type, p.price_monthly,
         coalesce(public.get_effective_price(public.user_org(), p.id), p.price_monthly),
         p.messages_limit, p.clients_limit, p.team_members_limit, p.channels_limit, p.knowledge_docs_limit,
         p.features, p.is_active, p.sort_order
    from public.plans p
   where p.plan_type = p_plan_type
     -- Inactive plans are hidden, except the one the org is on
     and (p.is_active or p.id = (select s.plan_id from public.subscriptions s where s.organization_id = public.user_org()))
   order by p.sort_order, p.price_monthly
$$;

-- Business plans with this client's prices
create function public.get_client_available_plans(p_client_id uuid)
returns table (
  id uuid,
  slug text,
  name text,
  name_ar text,
  plan_type text,
  price_monthly numeric,
  effective_monthly numeric,
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
  select p.id, p.slug, p.name, p.name_ar, p.plan_type, p.price_monthly,
         coalesce(public.get_client_effective_price(p_client_id, p.id), p.price_monthly),
         p.messages_limit, p.clients_limit, p.team_members_limit, p.channels_limit, p.knowledge_docs_limit,
         p.features, p.is_active, p.sort_order
    from public.plans p
   where p.plan_type = 'business'
     and public.can_view_client_billing(p_client_id)
     -- Inactive plans are hidden, except the one the client is on
     and (p.is_active or p.id = (select cs.plan_id from public.client_subscriptions cs where cs.client_id = p_client_id))
   order by p.sort_order, p.price_monthly
$$;

-- The agency (or a super admin) moves a client to another business plan
create function public.change_client_plan(p_client_id uuid, p_plan_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
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

  update public.client_subscriptions set plan_id = p_plan_id where client_id = p_client_id;
  if not found then return 'not_found'; end if;
  return 'ok';
end;
$$;

-- --------------------------------------------
-- 6. Billing tables
-- --------------------------------------------

-- Every client of the caller's agency with its plan, price and usage
create function public.get_agency_clients_billing()
returns table (
  client_id uuid,
  client_name text,
  client_status text,
  subscription_id uuid,
  status text,
  usable boolean,
  plan_id uuid,
  plan_slug text,
  plan_name text,
  plan_name_ar text,
  base_price numeric,
  effective_price numeric,
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
  select c.id, c.name, c.status, cs.id, cs.status, public.client_subscription_usable(cs),
         p.id, p.slug, p.name, p.name_ar,
         p.price_monthly,
         public.get_client_effective_price(c.id),
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

-- Every organization subscription, for the admin panel
create function public.get_all_subscriptions()
returns table (
  organization_id uuid,
  organization_name text,
  organization_active boolean,
  subscription_id uuid,
  status text,
  usable boolean,
  plan_id uuid,
  plan_slug text,
  plan_name text,
  plan_name_ar text,
  plan_type text,
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
  select o.id, o.name, o.is_active, s.id, s.status, public.subscription_usable(s),
         p.id, p.slug, p.name, p.name_ar, p.plan_type,
         p.price_monthly,
         public.get_effective_price(o.id),
         c.id is not null
           and (c.valid_until is null or c.valid_until > now())
           and (c.plan_id is null or c.plan_id = s.plan_id),
         c.reason,
         s.current_period_end, s.trial_ends_at,
         (select jsonb_agg(jsonb_build_object('limit_type', u.limit_type, 'used', u.used, 'limit', u.limit_value))
            from public.subscription_usage(o.id) u)
    from public.subscriptions s
    join public.organizations o on o.id = s.organization_id
    join public.plans p on p.id = s.plan_id
    left join public.custom_pricing c on c.organization_id = o.id
   where public.is_super_admin()
   order by o.name
$$;

-- Every client subscription on the platform, for the admin panel
create function public.get_all_client_subscriptions()
returns table (
  client_id uuid,
  client_name text,
  organization_id uuid,
  organization_name text,
  organization_active boolean,
  subscription_id uuid,
  status text,
  usable boolean,
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
  select c.id, c.name, o.id, o.name, o.is_active, cs.id, cs.status, public.client_subscription_usable(cs),
         p.id, p.slug, p.name, p.name_ar,
         p.price_monthly,
         public.get_client_effective_price(c.id),
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

-- --------------------------------------------
-- 7. New subscriptions (no cycle column any more)
-- --------------------------------------------

-- Agencies: the first agency plan with a 14-day trial. Direct businesses
-- have no organization subscription (see direct_businesses).
create or replace function public.create_default_subscription()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plan uuid;
begin
  if new.org_type = 'direct' then
    return new;
  end if;

  select id into v_plan
    from public.plans
   where plan_type = 'agency'
   order by (slug = 'agency_starter') desc, is_active desc, sort_order
   limit 1;
  if v_plan is null then return new; end if;

  insert into public.subscriptions
    (organization_id, plan_id, status, trial_ends_at, current_period_start, current_period_end)
  values
    (new.id, v_plan, 'trialing', now() + interval '14 days', now(), now() + interval '14 days')
  on conflict (organization_id) do nothing;
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
    (client_id, plan_id, status, trial_ends_at, current_period_start, current_period_end)
  values
    (new.id, v_plan, 'trialing', now() + interval '14 days', now(), now() + interval '14 days')
  on conflict (client_id) do nothing;
  -- The creator may already have been added as a member (earlier trigger)
  perform public.refresh_client_usage(new.id);
  return new;
end;
$$;

-- --------------------------------------------
-- 8. Grants for the recreated functions
-- --------------------------------------------
do $$
declare
  fn text;
begin
  foreach fn in array array[
    'get_effective_price(uuid, uuid)',
    'get_client_effective_price(uuid, uuid)',
    'get_available_plans(text)',
    'get_client_available_plans(uuid)',
    'change_client_plan(uuid, uuid)',
    'get_agency_clients_billing()',
    'get_all_subscriptions()',
    'get_all_client_subscriptions()'
  ] loop
    execute format('revoke execute on function public.%s from public, anon', fn);
    execute format('grant execute on function public.%s to authenticated, service_role', fn);
  end loop;
end $$;
