-- ============================================
-- SUBSCRIPTIONS, PLANS & INVOICES
-- One subscription per organization, on a plan from `plans`. Prices and
-- limits live only in the database and are edited by super admins. There is
-- no payment gateway: invoices are issued and marked paid by hand.
--
-- Limits: messages (per month), clients, team members, channels and
-- knowledge files. null = unlimited. *_used counters are kept by triggers;
-- the monthly message window rolls over lazily (no cron needed).
-- ============================================

-- --------------------------------------------
-- 1. Plans
-- --------------------------------------------
create table public.plans (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+([_-][a-z0-9]+)*$'),
  name text not null,
  name_ar text not null,
  -- agency: manages several clients; business: one business (clinic, restaurant…)
  plan_type text not null check (plan_type in ('agency', 'business')),
  price_monthly numeric(12, 2) not null check (price_monthly >= 0),
  price_yearly numeric(12, 2) not null check (price_yearly >= 0),
  messages_limit int check (messages_limit >= 0),
  clients_limit int check (clients_limit >= 0),
  team_members_limit int check (team_members_limit >= 0),
  channels_limit int check (channels_limit >= 0),
  knowledge_docs_limit int check (knowledge_docs_limit >= 0),
  -- [{"ar": "…", "en": "…"}, …] shown as the plan card's checklist
  features jsonb not null default '[]'::jsonb check (jsonb_typeof(features) = 'array'),
  is_active boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger plans_updated_at before update on public.plans
  for each row execute function update_updated_at();

-- Starting values; super admins edit them from the admin panel.
-- Yearly = 10 months (two months free).
insert into public.plans
  (slug, name, name_ar, plan_type, price_monthly, price_yearly,
   messages_limit, clients_limit, team_members_limit, channels_limit, knowledge_docs_limit,
   sort_order, features)
values
  ('agency_starter', 'Agency Starter', 'وكالة - بداية', 'agency', 3500, 35000,
   5000, 5, 5, 10, 50, 1,
   '[{"ar": "5,000 رسالة/شهر", "en": "5,000 messages/month"},
     {"ar": "حتى 5 عملاء", "en": "Up to 5 clients"},
     {"ar": "5 أعضاء فريق", "en": "5 team members"},
     {"ar": "10 قنوات", "en": "10 channels"},
     {"ar": "50 ملف في قاعدة المعرفة", "en": "50 knowledge base files"},
     {"ar": "ردود ذكاء اصطناعي وتتبع الليدز", "en": "AI replies and lead tracking"}]'),
  ('agency_pro', 'Agency Pro', 'وكالة - احترافي', 'agency', 7500, 75000,
   20000, 15, 15, null, 150, 2,
   '[{"ar": "20,000 رسالة/شهر", "en": "20,000 messages/month"},
     {"ar": "حتى 15 عميل", "en": "Up to 15 clients"},
     {"ar": "15 عضو فريق", "en": "15 team members"},
     {"ar": "قنوات بلا حدود", "en": "Unlimited channels"},
     {"ar": "150 ملف في قاعدة المعرفة", "en": "150 knowledge base files"},
     {"ar": "تحليلات وتقارير متقدمة", "en": "Advanced analytics and reports"}]'),
  ('agency_business', 'Agency Business', 'وكالة - أعمال', 'agency', 15000, 150000,
   60000, null, 40, null, 500, 3,
   '[{"ar": "60,000 رسالة/شهر", "en": "60,000 messages/month"},
     {"ar": "عملاء بلا حدود", "en": "Unlimited clients"},
     {"ar": "40 عضو فريق", "en": "40 team members"},
     {"ar": "قنوات بلا حدود", "en": "Unlimited channels"},
     {"ar": "500 ملف في قاعدة المعرفة", "en": "500 knowledge base files"},
     {"ar": "دعم بأولوية", "en": "Priority support"}]'),
  ('business_basic', 'Business Basic', 'نشاط - أساسي', 'business', 600, 6000,
   1000, 1, 2, 2, 10, 1,
   '[{"ar": "1,000 رسالة/شهر", "en": "1,000 messages/month"},
     {"ar": "نشاط واحد", "en": "One business"},
     {"ar": "2 أعضاء فريق", "en": "2 team members"},
     {"ar": "2 قنوات", "en": "2 channels"},
     {"ar": "10 ملفات في قاعدة المعرفة", "en": "10 knowledge base files"},
     {"ar": "ردود ذكاء اصطناعي وتتبع الليدز", "en": "AI replies and lead tracking"}]'),
  ('business_plus', 'Business Plus', 'نشاط - بلس', 'business', 1200, 12000,
   3000, 1, 5, 4, 30, 2,
   '[{"ar": "3,000 رسالة/شهر", "en": "3,000 messages/month"},
     {"ar": "نشاط واحد", "en": "One business"},
     {"ar": "5 أعضاء فريق", "en": "5 team members"},
     {"ar": "4 قنوات", "en": "4 channels"},
     {"ar": "30 ملف في قاعدة المعرفة", "en": "30 knowledge base files"},
     {"ar": "تتبع المواعيد والحضور", "en": "Appointment and attendance tracking"}]'),
  ('business_pro', 'Business Pro', 'نشاط - احترافي', 'business', 2500, 25000,
   8000, 1, 10, null, 100, 3,
   '[{"ar": "8,000 رسالة/شهر", "en": "8,000 messages/month"},
     {"ar": "نشاط واحد", "en": "One business"},
     {"ar": "10 أعضاء فريق", "en": "10 team members"},
     {"ar": "قنوات بلا حدود", "en": "Unlimited channels"},
     {"ar": "100 ملف في قاعدة المعرفة", "en": "100 knowledge base files"},
     {"ar": "تحليلات وتقارير متقدمة", "en": "Advanced analytics and reports"}]');

-- --------------------------------------------
-- 2. Custom pricing: one per organization.
--    percentage: applies to whichever plan the org is on (plan_id null)
--    fixed_price: for one plan (plan_id), per billing cycle
-- --------------------------------------------
create table public.custom_pricing (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null unique references public.organizations(id) on delete cascade,
  plan_id uuid references public.plans(id) on delete cascade,
  discount_type text not null check (discount_type in ('percentage', 'fixed_price')),
  discount_percentage numeric(5, 2) check (discount_percentage > 0 and discount_percentage <= 100),
  fixed_price_monthly numeric(12, 2) check (fixed_price_monthly >= 0),
  fixed_price_yearly numeric(12, 2) check (fixed_price_yearly >= 0),
  reason text,
  valid_until timestamptz,
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint custom_pricing_shape check (
    (discount_type = 'percentage' and discount_percentage is not null)
    or (
      discount_type = 'fixed_price'
      and plan_id is not null
      and (fixed_price_monthly is not null or fixed_price_yearly is not null)
    )
  )
);

-- --------------------------------------------
-- 3. Subscriptions: per organization instead of per client.
--    Nothing created the old per-client rows; any that exist are folded
--    into their organization's subscription (messages used carried over).
-- --------------------------------------------
drop policy if exists "Users see their subscription" on public.subscriptions;
drop policy if exists "Admins manage subscriptions" on public.subscriptions;

alter table public.subscriptions
  alter column client_id drop not null,
  add column organization_id uuid references public.organizations(id) on delete cascade,
  add column plan_id uuid references public.plans(id),
  add column billing_cycle text not null default 'monthly' check (billing_cycle in ('monthly', 'yearly')),
  add column clients_used int not null default 0,
  add column team_members_used int not null default 0,
  add column channels_used int not null default 0,
  add column knowledge_docs_used int not null default 0,
  -- Start of the current monthly message window (see messages_window_start)
  add column messages_period_start timestamptz not null default now(),
  add column trial_ends_at timestamptz,
  add column notes text;

alter table public.subscriptions drop constraint if exists subscriptions_status_check;
alter table public.subscriptions
  add constraint subscriptions_status_check
  check (status in ('trialing', 'active', 'past_due', 'cancelled'));

-- Existing organizations: a 14-day trial. Agencies (more than one client)
-- start on agency_starter so they aren't blocked at once; super admins
-- then set the right plan.
insert into public.subscriptions
  (organization_id, plan_id, status, billing_cycle, trial_ends_at,
   current_period_start, current_period_end, messages_used)
select o.id,
       (select p.id from public.plans p
         where p.slug = case
           when (select count(*) from public.clients c where c.organization_id = o.id) > 1
             then 'agency_starter' else 'business_basic' end),
       'trialing', 'monthly', now() + interval '14 days',
       now(), now() + interval '14 days',
       coalesce((select sum(s.messages_used)::int
                   from public.subscriptions s
                   join public.clients c on c.id = s.client_id
                  where c.organization_id = o.id), 0)
  from public.organizations o;

delete from public.subscriptions where organization_id is null;

alter table public.subscriptions
  drop column client_id,
  drop column plan,
  drop column messages_limit,
  drop column agents_limit,
  drop column channels_limit,
  alter column organization_id set not null,
  alter column plan_id set not null,
  alter column status set not null,
  alter column status set default 'trialing',
  add constraint subscriptions_organization_id_key unique (organization_id);

drop type if exists plan_tier;

-- --------------------------------------------
-- 4. Invoices, numbered INV-<year>-0001 per calendar year (Cairo)
-- --------------------------------------------
create table public.invoice_counters (
  year int primary key,
  last_number int not null
);

create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  subscription_id uuid references public.subscriptions(id) on delete set null,
  invoice_number text not null unique,
  amount numeric(12, 2) not null check (amount >= 0),
  currency text not null default 'EGP',
  period_start timestamptz not null,
  period_end timestamptz not null,
  status text not null default 'draft'
    check (status in ('draft', 'sent', 'paid', 'overdue', 'cancelled')),
  paid_at timestamptz,
  payment_method text,
  payment_reference text,
  notes text,
  created_at timestamptz not null default now(),
  constraint invoices_period check (period_end > period_start)
);

create index idx_invoices_org on public.invoices(organization_id, created_at desc);
create index idx_invoices_status on public.invoices(status);

create or replace function public.assign_invoice_number()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_year int := extract(year from now() at time zone 'Africa/Cairo')::int;
  v_number int;
begin
  insert into public.invoice_counters (year, last_number)
  values (v_year, 1)
  on conflict (year) do update set last_number = public.invoice_counters.last_number + 1
  returning last_number into v_number;

  new.invoice_number := format('INV-%s-%s', v_year, lpad(v_number::text, 4, '0'));
  return new;
end;
$$;

create trigger invoices_assign_number before insert on public.invoices
  for each row execute function public.assign_invoice_number();

-- --------------------------------------------
-- 5. Usage alerts at 80 / 90 / 100 %
-- --------------------------------------------
create table public.usage_alerts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  limit_type text not null
    check (limit_type in ('messages', 'clients', 'team_members', 'channels', 'knowledge_docs')),
  threshold int not null check (threshold in (80, 90, 100)),
  created_at timestamptz not null default now(),
  read_at timestamptz
);

create index idx_usage_alerts_org on public.usage_alerts(organization_id, created_at desc);

-- --------------------------------------------
-- 6. Usage helpers (internal)
-- --------------------------------------------

-- The monthly message window containing now(), starting from `start`
create or replace function public.messages_window_start(start timestamptz)
returns timestamptz
language sql
stable
as $$
  select start + make_interval(months => (
    extract(year from age(now(), start)) * 12 + extract(month from age(now(), start))
  )::int)
$$;

-- A trial that ran out, or a cancelled subscription, can't be used
create or replace function public.subscription_usable(s public.subscriptions)
returns boolean
language sql
stable
as $$
  select s.status in ('active', 'past_due')
      or (s.status = 'trialing' and (s.trial_ends_at is null or s.trial_ends_at > now()))
$$;

-- Used vs limit per limit type (messages: in the current monthly window)
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
      ('messages', case when public.messages_window_start(s.messages_period_start) > s.messages_period_start
                        then 0 else s.messages_used end, p.messages_limit, 1),
      ('clients', s.clients_used, p.clients_limit, 2),
      ('team_members', s.team_members_used, p.team_members_limit, 3),
      ('channels', s.channels_used, p.channels_limit, 4),
      ('knowledge_docs', s.knowledge_docs_used, p.knowledge_docs_limit, 5)
    ) as l(limit_type, used, limit_value, ord)
   where s.organization_id = p_org_id
   order by l.ord
$$;

-- {allowed, used, limit, percentage, reason}; null if the org has no subscription.
-- reason: ok | limit_reached | inactive
create or replace function public.subscription_limit_status(p_org_id uuid, p_limit_type text)
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
    from public.subscription_usage(p_org_id) u
   where u.limit_type = p_limit_type
$$;

-- Recount the *_used counters of one organization
create or replace function public.refresh_subscription_usage(p_org_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.subscriptions s set
    clients_used = (select count(*) from public.clients c where c.organization_id = p_org_id),
    team_members_used = (select count(*) from public.users u where u.organization_id = p_org_id),
    channels_used = (
      select count(*) from public.channels ch
        join public.clients c on c.id = ch.client_id
       where c.organization_id = p_org_id
    ),
    knowledge_docs_used = (
      select count(*) from public.knowledge_documents k
        join public.clients c on c.id = k.client_id
       where c.organization_id = p_org_id and k.source_document_id is null
    )
   where s.organization_id = p_org_id
$$;

-- One alert per (limit, threshold) per window: the monthly message window,
-- or the billing period for everything else
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
          and a.limit_type = u.limit_type
          and a.threshold = t.threshold
          and a.created_at >= case
            when u.limit_type = 'messages' then public.messages_window_start(s.messages_period_start)
            else s.current_period_start
          end
     )
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'subscription_usage(uuid)',
    'subscription_limit_status(uuid, text)',
    'refresh_subscription_usage(uuid)',
    'record_usage_alerts(uuid)'
  ] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', fn);
  end loop;
end $$;

-- --------------------------------------------
-- 7. Triggers: counters, alerts, limits, new organizations
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
  else
    -- channels / knowledge_documents. While a client is being deleted its
    -- rows may already be gone; the clients trigger recounts then.
    if tg_op = 'DELETE' then v_client := old.client_id; else v_client := new.client_id; end if;
    select c.organization_id into v_org from public.clients c where c.id = v_client;
  end if;

  if v_org is not null then
    perform public.refresh_subscription_usage(v_org);
  end if;
  if v_old_org is not null and v_old_org is distinct from v_org then
    perform public.refresh_subscription_usage(v_old_org);
  end if;
  return null;
end;
$$;

create trigger clients_sync_usage
  after insert or delete or update of organization_id on public.clients
  for each row execute function public.sync_subscription_usage();

create trigger users_sync_usage
  after insert or delete or update of organization_id on public.users
  for each row execute function public.sync_subscription_usage();

create trigger channels_sync_usage
  after insert or delete on public.channels
  for each row execute function public.sync_subscription_usage();

-- Chunks are rows too; only source documents count
create trigger knowledge_documents_sync_usage_insert
  after insert on public.knowledge_documents
  for each row when (new.source_document_id is null)
  execute function public.sync_subscription_usage();

create trigger knowledge_documents_sync_usage_delete
  after delete on public.knowledge_documents
  for each row when (old.source_document_id is null)
  execute function public.sync_subscription_usage();

-- Alerts whenever usage or the plan (its limits) changes
create or replace function public.subscription_alerts_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.record_usage_alerts(new.organization_id);
  return null;
end;
$$;

create trigger subscriptions_usage_alerts
  after update on public.subscriptions
  for each row
  when (
    (old.messages_used, old.clients_used, old.team_members_used, old.channels_used,
     old.knowledge_docs_used, old.plan_id)
    is distinct from
    (new.messages_used, new.clients_used, new.team_members_used, new.channels_used,
     new.knowledge_docs_used, new.plan_id)
  )
  execute function public.subscription_alerts_trigger();

-- Backstop for the app-side checks (and races): refuse inserts past a limit.
-- The app maps "subscription_limit:<type>" to a friendly message.
create or replace function public.enforce_subscription_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_type text := tg_argv[0];
  v_org uuid;
  v_status jsonb;
begin
  if tg_table_name = 'clients' then
    v_org := new.organization_id;
  else
    select c.organization_id into v_org from public.clients c where c.id = new.client_id;
  end if;
  if v_org is null then return new; end if;

  v_status := public.subscription_limit_status(v_org, v_type);
  if v_status is not null and not (v_status->>'allowed')::boolean then
    raise exception 'subscription_limit:%', v_type
      using errcode = 'P0001', hint = v_status->>'reason';
  end if;
  return new;
end;
$$;

create trigger clients_enforce_limit before insert on public.clients
  for each row execute function public.enforce_subscription_limit('clients');

create trigger channels_enforce_limit before insert on public.channels
  for each row execute function public.enforce_subscription_limit('channels');

create trigger knowledge_documents_enforce_limit before insert on public.knowledge_documents
  for each row when (new.source_document_id is null)
  execute function public.enforce_subscription_limit('knowledge_docs');

-- New organizations: business_basic (or the first active business plan)
-- with a 14-day trial
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
   order by (slug = 'business_basic') desc, (plan_type = 'business' and is_active) desc, sort_order
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

create trigger organizations_default_subscription
  after insert on public.organizations
  for each row execute function public.create_default_subscription();

-- Counters for existing data
do $$
declare
  org uuid;
begin
  for org in select id from public.organizations loop
    perform public.refresh_subscription_usage(org);
  end loop;
end $$;

-- --------------------------------------------
-- 8. Access checks
-- --------------------------------------------

-- Billing (prices, invoices): the org's admins and super admins.
-- No auth.uid() = service role / trusted server code.
create or replace function public.can_view_billing(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is null
      or public.is_super_admin()
      or (public.user_role() = 'org_admin' and public.user_org() = p_org_id)
$$;

-- Limits: anyone in the organization (client admins add channels, files…)
create or replace function public.can_view_limits(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is null
      or public.is_super_admin()
      or public.user_org() = p_org_id
$$;

revoke execute on function public.can_view_billing(uuid) from public, anon;
revoke execute on function public.can_view_limits(uuid) from public, anon;

-- --------------------------------------------
-- 9. Public functions
-- --------------------------------------------

-- Final price for an organization after custom pricing. p_plan_id prices
-- another plan (upgrade cards); default: the org's current plan.
create or replace function public.get_effective_price(
  p_org_id uuid,
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
  v_custom public.custom_pricing;
  v_base numeric;
  v_fixed numeric;
begin
  if not public.can_view_billing(p_org_id) then return null; end if;
  if p_billing_cycle not in ('monthly', 'yearly') then
    raise exception 'invalid billing cycle: %', p_billing_cycle using errcode = '22023';
  end if;

  select p.* into v_plan
    from public.plans p
   where p.id = coalesce(p_plan_id, (select s.plan_id from public.subscriptions s where s.organization_id = p_org_id));
  if v_plan.id is null then return null; end if;

  v_base := case when p_billing_cycle = 'yearly' then v_plan.price_yearly else v_plan.price_monthly end;

  select c.* into v_custom
    from public.custom_pricing c
   where c.organization_id = p_org_id
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

-- {allowed, used, limit, percentage, reason}; null when the caller may not
-- see this organization or it has no subscription
create or replace function public.check_subscription_limit(p_org_id uuid, p_limit_type text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select public.subscription_limit_status(p_org_id, p_limit_type)
   where public.can_view_limits(p_org_id)
$$;

-- One AI reply used (the bot, with the service role). Starts a new monthly
-- window when the old one is over.
create or replace function public.consume_subscription_message(p_org_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.subscriptions s set
    messages_used = case
      when public.messages_window_start(s.messages_period_start) > s.messages_period_start then 1
      else s.messages_used + 1
    end,
    messages_period_start = public.messages_window_start(s.messages_period_start)
   where s.organization_id = p_org_id
$$;

-- Everything the subscription page needs, for one organization
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
      'messages_period_start', public.iso_utc(public.messages_window_start(s.messages_period_start)),
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

-- Plans of one type with this organization's prices (the caller's org)
create or replace function public.get_available_plans(p_plan_type text)
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
         coalesce(public.get_effective_price(public.user_org(), 'monthly', p.id), p.price_monthly),
         coalesce(public.get_effective_price(public.user_org(), 'yearly', p.id), p.price_yearly),
         p.messages_limit, p.clients_limit, p.team_members_limit, p.channels_limit, p.knowledge_docs_limit,
         p.features, p.is_active, p.sort_order
    from public.plans p
   where p.plan_type = p_plan_type
     -- Inactive plans are hidden, except the one the org is on
     and (p.is_active or p.id = (select s.plan_id from public.subscriptions s where s.organization_id = public.user_org()))
   order by p.sort_order, p.price_monthly
$$;

-- Every subscription, for the admin panel
create or replace function public.get_all_subscriptions()
returns table (
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
  select o.id, o.name, o.is_active, s.id, s.status, public.subscription_usable(s), s.billing_cycle,
         p.id, p.slug, p.name, p.name_ar, p.plan_type,
         case when s.billing_cycle = 'yearly' then p.price_yearly else p.price_monthly end,
         public.get_effective_price(o.id, s.billing_cycle),
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

-- Unread alerts that still hold (usage is still past the threshold), the
-- highest threshold per limit — for the dashboard banner (org admins)
create or replace function public.get_active_usage_alerts()
returns table (limit_type text, threshold int, used int, limit_value int)
language sql
stable
security definer
set search_path = public
as $$
  select distinct on (a.limit_type) a.limit_type, a.threshold, u.used, u.limit_value
    from public.usage_alerts a
    join public.subscription_usage(public.user_org()) u on u.limit_type = a.limit_type
   where a.organization_id = public.user_org()
     and a.read_at is null
     and public.can_view_billing(a.organization_id)
     and u.limit_value > 0
     and u.used * 100 >= a.threshold * u.limit_value
   order by a.limit_type, a.threshold desc
$$;

create or replace function public.dismiss_usage_alerts()
returns void
language sql
security definer
set search_path = public
as $$
  update public.usage_alerts set read_at = now()
   where organization_id = public.user_org()
     and read_at is null
     and public.can_view_billing(organization_id)
$$;

-- Super admin: start the message window over and recount everything else
create or replace function public.reset_subscription_usage(p_org_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_super_admin() then return false; end if;
  update public.subscriptions
     set messages_used = 0, messages_period_start = now()
   where organization_id = p_org_id;
  if not found then return false; end if;
  perform public.refresh_subscription_usage(p_org_id);
  update public.usage_alerts set read_at = now()
   where organization_id = p_org_id and read_at is null;
  return true;
end;
$$;

-- Super admin: record a payment. The subscription becomes active and, when
-- the invoice covers a later period, moves on to it.
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
  if not public.is_super_admin() then return 'forbidden'; end if;

  select * into v_invoice from public.invoices where id = p_invoice_id for update;
  if v_invoice.id is null then return 'not_found'; end if;
  if v_invoice.status in ('paid', 'cancelled') then return 'invalid_status'; end if;

  update public.invoices
     set status = 'paid',
         paid_at = coalesce(p_paid_at, now()),
         payment_method = nullif(trim(p_payment_method), ''),
         payment_reference = nullif(trim(p_payment_reference), '')
   where id = p_invoice_id;

  update public.subscriptions s
     set status = 'active',
         current_period_start = case when v_invoice.period_end > s.current_period_end
                                     then v_invoice.period_start else s.current_period_start end,
         current_period_end = greatest(s.current_period_end, v_invoice.period_end)
   where s.organization_id = v_invoice.organization_id;

  return 'ok';
end;
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'get_effective_price(uuid, text, uuid)',
    'check_subscription_limit(uuid, text)',
    'get_subscription_details(uuid)',
    'get_available_plans(text)',
    'get_all_subscriptions()',
    'get_active_usage_alerts()',
    'dismiss_usage_alerts()',
    'reset_subscription_usage(uuid)',
    'mark_invoice_paid(uuid, text, text, timestamptz)'
  ] loop
    execute format('revoke execute on function public.%s from public, anon', fn);
    execute format('grant execute on function public.%s to authenticated, service_role', fn);
  end loop;
end $$;

revoke execute on function public.consume_subscription_message(uuid) from public, anon, authenticated;
grant execute on function public.consume_subscription_message(uuid) to service_role;

-- --------------------------------------------
-- 10. RLS
-- --------------------------------------------
alter table public.plans enable row level security;
alter table public.custom_pricing enable row level security;
alter table public.invoices enable row level security;
alter table public.invoice_counters enable row level security;
alter table public.usage_alerts enable row level security;
-- subscriptions already has RLS enabled

create policy "Anyone reads plans"
  on public.plans for select
  using (true);

create policy "Super admins manage plans"
  on public.plans for all
  using (public.is_super_admin())
  with check (public.is_super_admin());

create policy "Org admins see their subscription"
  on public.subscriptions for select
  using (public.user_role() = 'org_admin' and organization_id = public.user_org());

create policy "Super admins manage subscriptions"
  on public.subscriptions for all
  using (public.is_super_admin())
  with check (public.is_super_admin());

create policy "Org admins see their custom pricing"
  on public.custom_pricing for select
  using (public.user_role() = 'org_admin' and organization_id = public.user_org());

create policy "Super admins manage custom pricing"
  on public.custom_pricing for all
  using (public.is_super_admin())
  with check (public.is_super_admin());

create policy "Org admins see their invoices"
  on public.invoices for select
  using (public.user_role() = 'org_admin' and organization_id = public.user_org());

create policy "Super admins manage invoices"
  on public.invoices for all
  using (public.is_super_admin())
  with check (public.is_super_admin());

create policy "Org admins see their usage alerts"
  on public.usage_alerts for select
  using (public.user_role() = 'org_admin' and organization_id = public.user_org());

create policy "Super admins manage usage alerts"
  on public.usage_alerts for all
  using (public.is_super_admin())
  with check (public.is_super_admin());

-- invoice_counters: no policies; only the numbering trigger touches it
