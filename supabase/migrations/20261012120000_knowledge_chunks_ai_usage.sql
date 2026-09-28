-- ============================================
-- KNOWLEDGE LIMITS IN CHUNKS + AI USAGE TRACKING
--
-- 1. The knowledge base is limited by chunks (what it actually costs to
--    embed and store), not only by files: deleting a file and uploading a
--    bigger one can no longer get around the limit. Business plans limit
--    each client; agency plans limit the agency's clients together. Plans
--    also cap the size of one uploaded file.
-- 2. Every Gemini call is logged in ai_usage with its tokens and its cost,
--    priced when it's logged (model_pricing, editable by super admins), so
--    later price changes don't rewrite history.
-- ============================================

-- --------------------------------------------
-- 1. Plans: chunk limit and file size cap
-- --------------------------------------------
alter table public.plans
  add column knowledge_chunks_limit int check (knowledge_chunks_limit >= 0),
  add column max_file_size_mb int check (max_file_size_mb between 1 and 100);

update public.plans p set
  knowledge_chunks_limit = v.chunks,
  max_file_size_mb = v.size_mb
  from (values
    ('business_basic', 200, 2),
    ('business_plus', 600, 5),
    ('business_pro', 2000, 10),
    ('agency_starter', 1000, 5),
    ('agency_pro', 3000, 10),
    ('agency_business', 10000, 20)
  ) as v(slug, chunks, size_mb)
 where p.slug = v.slug;

-- The seeded business plan cards listed knowledge files; show the chunk
-- allowance instead (only where the seeded text is still there)
update public.plans p set features = (
  select jsonb_agg(
    case when f->>'en' like '% knowledge base files'
      then jsonb_build_object(
        'ar', format('قاعدة معرفة حتى %s قطعة (ملفات حتى %s ميجا)', p.knowledge_chunks_limit, p.max_file_size_mb),
        'en', format('Knowledge base up to %s chunks (files up to %s MB)', p.knowledge_chunks_limit, p.max_file_size_mb))
      else f end
    order by ord)
    from jsonb_array_elements(p.features) with ordinality as e(f, ord)
)
 where p.plan_type = 'business'
   and p.knowledge_chunks_limit is not null
   and exists (select 1 from jsonb_array_elements(p.features) f where f->>'en' like '% knowledge base files');

-- --------------------------------------------
-- 2. Counters (kept by the triggers below)
-- --------------------------------------------
alter table public.client_subscriptions add column knowledge_chunks_used int not null default 0;
alter table public.subscriptions add column knowledge_chunks_used int not null default 0;

-- Chunks are the knowledge_documents rows with a source document
create index if not exists idx_knowledge_client_chunks on public.knowledge_documents(client_id)
  where source_document_id is not null;

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
    knowledge_chunks_used = (
      select count(*) from public.knowledge_documents k
       where k.client_id = p_client_id and k.source_document_id is not null
    ),
    team_members_used = (select count(*) from public.client_members cm where cm.client_id = p_client_id)
   where cs.client_id = p_client_id
$$;

-- The agency's chunks: all of its clients together
create or replace function public.refresh_subscription_usage(p_org_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.subscriptions s set
    clients_used = (select count(*) from public.clients c where c.organization_id = p_org_id),
    team_members_used = (select count(*) from public.users u where u.organization_id = p_org_id),
    knowledge_chunks_used = (
      select count(*) from public.knowledge_documents k
        join public.clients c on c.id = k.client_id
       where c.organization_id = p_org_id and k.source_document_id is not null
    )
   where s.organization_id = p_org_id
$$;

-- --------------------------------------------
-- 3. Usage rows (limit bars, limit checks, alerts)
-- --------------------------------------------
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
      ('team_members', s.team_members_used, p.team_members_limit, 2),
      ('knowledge_chunks', s.knowledge_chunks_used, p.knowledge_chunks_limit, 3)
    ) as l(limit_type, used, limit_value, ord)
   where s.organization_id = p_org_id
   order by l.ord
$$;

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
      ('knowledge_chunks', cs.knowledge_chunks_used, p.knowledge_chunks_limit, 4),
      ('team_members', cs.team_members_used, p.team_members_limit, 5)
    ) as l(limit_type, used, limit_value, ord)
   where cs.client_id = p_client_id
   order by l.ord
$$;

-- Alerts: knowledge chunks at 80/90/100 %, AI cost past 50 % of the plan's price
alter table public.usage_alerts drop constraint usage_alerts_limit_type_check;
alter table public.usage_alerts add constraint usage_alerts_limit_type_check
  check (limit_type in ('messages', 'clients', 'team_members', 'channels', 'knowledge_docs', 'knowledge_chunks', 'ai_cost'));
alter table public.usage_alerts drop constraint usage_alerts_threshold_check;
alter table public.usage_alerts add constraint usage_alerts_threshold_check
  check (threshold in (50, 80, 90, 100));

drop trigger if exists subscriptions_usage_alerts on public.subscriptions;
create trigger subscriptions_usage_alerts
  after update on public.subscriptions
  for each row
  when (
    (old.clients_used, old.team_members_used, old.knowledge_chunks_used, old.plan_id)
    is distinct from
    (new.clients_used, new.team_members_used, new.knowledge_chunks_used, new.plan_id)
  )
  execute function public.subscription_alerts_trigger();

drop trigger if exists client_subscriptions_usage_alerts on public.client_subscriptions;
create trigger client_subscriptions_usage_alerts
  after update on public.client_subscriptions
  for each row
  when (
    (old.messages_used, old.channels_used, old.knowledge_docs_used, old.knowledge_chunks_used,
     old.team_members_used, old.plan_id)
    is distinct from
    (new.messages_used, new.channels_used, new.knowledge_docs_used, new.knowledge_chunks_used,
     new.team_members_used, new.plan_id)
  )
  execute function public.client_subscription_alerts_trigger();

-- --------------------------------------------
-- 4. Chunk counters + the limit, per statement (chunks are inserted in
--    batches). The app checks before processing a file; this refuses any
--    batch that would still go past the client's or the agency's limit.
-- --------------------------------------------
create or replace function public.sync_knowledge_chunks()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client uuid;
  v_org uuid;
begin
  for v_client in
    select distinct r.client_id from changed_rows r where r.source_document_id is not null
  loop
    perform public.refresh_client_usage(v_client);
    select c.organization_id into v_org from public.clients c where c.id = v_client;
    if v_org is not null then
      perform public.refresh_subscription_usage(v_org);
    end if;

    if tg_op = 'INSERT' and (
      exists (
        select 1 from public.client_usage(v_client) u
         where u.limit_type = 'knowledge_chunks' and u.limit_value is not null and u.used > u.limit_value
      )
      or exists (
        select 1 from public.subscription_usage(v_org) u
         where u.limit_type = 'knowledge_chunks' and u.limit_value is not null and u.used > u.limit_value
      )
    ) then
      raise exception 'subscription_limit:knowledge_chunks' using errcode = 'P0001', hint = 'limit_reached';
    end if;
  end loop;
  return null;
end;
$$;

revoke execute on function public.sync_knowledge_chunks() from public, anon, authenticated;

create trigger knowledge_chunks_sync_insert
  after insert on public.knowledge_documents
  referencing new table as changed_rows
  for each statement execute function public.sync_knowledge_chunks();

create trigger knowledge_chunks_sync_delete
  after delete on public.knowledge_documents
  referencing old table as changed_rows
  for each statement execute function public.sync_knowledge_chunks();

-- Room left for one client's knowledge base, before a file is processed:
-- {used, limit, org_used, org_limit, available, max_file_size_mb, usable}.
-- limit/org_limit/available/max_file_size_mb null = no limit.
create or replace function public.knowledge_quota(p_client_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_used int;
  v_limit int;
  v_usable boolean := true;
  v_org_used int;
  v_org_limit int;
  v_client_size int;
  v_org_size int;
begin
  select c.organization_id into v_org_id from public.clients c where c.id = p_client_id;
  if v_org_id is null then return null; end if;

  select u.used, u.limit_value, u.usable into v_used, v_limit, v_usable
    from public.client_usage(p_client_id) u where u.limit_type = 'knowledge_chunks';
  select u.used, u.limit_value into v_org_used, v_org_limit
    from public.subscription_usage(v_org_id) u where u.limit_type = 'knowledge_chunks';

  select p.max_file_size_mb into v_client_size
    from public.client_subscriptions cs join public.plans p on p.id = cs.plan_id
   where cs.client_id = p_client_id;
  select p.max_file_size_mb into v_org_size
    from public.subscriptions s join public.plans p on p.id = s.plan_id
   where s.organization_id = v_org_id;

  return jsonb_build_object(
    'used', coalesce(v_used, 0),
    'limit', v_limit,
    'org_used', v_org_used,
    'org_limit', v_org_limit,
    -- least() skips nulls: whichever level is tighter
    'available', case
      when v_limit is null and v_org_limit is null then null
      else greatest(0, least(v_limit - coalesce(v_used, 0), v_org_limit - coalesce(v_org_used, 0)))
    end,
    'max_file_size_mb', least(v_client_size, v_org_size),
    'usable', coalesce(v_usable, true)
  );
end;
$$;

revoke execute on function public.knowledge_quota(uuid) from public, anon, authenticated;

-- Anyone who can see the client (the upload route checks managers)
create or replace function public.check_knowledge_quota(p_client_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select public.knowledge_quota(p_client_id)
   where auth.uid() is null or public.has_client_access(p_client_id)
$$;

revoke execute on function public.check_knowledge_quota(uuid) from public, anon;
grant execute on function public.check_knowledge_quota(uuid) to authenticated, service_role;

-- Uploads up to the biggest plan's cap; each plan's own cap is checked by the app
update storage.buckets set file_size_limit = 20971520 where id = 'knowledge-base'; -- 20 MB

-- --------------------------------------------
-- 5. Plan cards with the new limits
-- --------------------------------------------
drop function if exists public.get_available_plans(text);
drop function if exists public.get_client_available_plans(uuid);

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
  knowledge_chunks_limit int,
  max_file_size_mb int,
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
         p.knowledge_chunks_limit, p.max_file_size_mb,
         p.features, p.is_active, p.sort_order
    from public.plans p
   where p.plan_type = p_plan_type
     and (p.is_active or p.id = (select s.plan_id from public.subscriptions s where s.organization_id = public.user_org()))
   order by p.sort_order, p.price_monthly
$$;

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
  knowledge_chunks_limit int,
  max_file_size_mb int,
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
         p.knowledge_chunks_limit, p.max_file_size_mb,
         p.features, p.is_active, p.sort_order
    from public.plans p
   where p.plan_type = 'business'
     and public.can_view_client_billing(p_client_id)
     and (p.is_active or p.id = (select cs.plan_id from public.client_subscriptions cs where cs.client_id = p_client_id))
   order by p.sort_order, p.price_monthly
$$;

revoke execute on function public.get_available_plans(text) from public, anon;
grant execute on function public.get_available_plans(text) to authenticated, service_role;
revoke execute on function public.get_client_available_plans(uuid) from public, anon;
grant execute on function public.get_client_available_plans(uuid) to authenticated, service_role;

-- Counters for existing knowledge bases
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
-- 6. AI pricing and platform settings (super admins)
-- --------------------------------------------
create table public.model_pricing (
  model text primary key check (model ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$'),
  input_price_per_million numeric(12, 6) not null check (input_price_per_million >= 0),
  output_price_per_million numeric(12, 6) not null check (output_price_per_million >= 0),
  updated_at timestamptz not null default now()
);

create trigger model_pricing_updated_at before update on public.model_pricing
  for each row execute function update_updated_at();

-- USD per 1M tokens (Gemini API list prices, standard tier)
insert into public.model_pricing (model, input_price_per_million, output_price_per_million) values
  ('gemini-3-flash-preview', 0.50, 3.00),
  ('gemini-embedding-001', 0.15, 0);

-- One row: platform-wide settings
create table public.platform_settings (
  id boolean primary key default true check (id),
  usd_to_egp numeric(12, 4) not null default 50 check (usd_to_egp > 0),
  updated_at timestamptz not null default now()
);

insert into public.platform_settings (id) values (true);

create trigger platform_settings_updated_at before update on public.platform_settings
  for each row execute function update_updated_at();

-- --------------------------------------------
-- 7. AI usage log (written by the server with the service role)
-- --------------------------------------------
create table public.ai_usage (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- Kept (without the client) if the client is deleted: the cost was real
  client_id uuid references public.clients(id) on delete set null,
  operation text not null
    check (operation in ('chat_reply', 'lead_analysis', 'embedding', 'playground', 'bot_preview')),
  model text not null,
  prompt_tokens int not null default 0 check (prompt_tokens >= 0),
  completion_tokens int not null default 0 check (completion_tokens >= 0),
  total_tokens int not null default 0 check (total_tokens >= 0),
  -- Priced when logged; null while the model has no price (filled in once
  -- a super admin adds it)
  estimated_cost_usd numeric(10, 6),
  conversation_id uuid references public.conversations(id) on delete set null,
  created_at timestamptz not null default now()
);

create index idx_ai_usage_org on public.ai_usage(organization_id, created_at);
create index idx_ai_usage_client on public.ai_usage(client_id, created_at);
create index idx_ai_usage_created on public.ai_usage(created_at);

-- Organization from the client, total and cost from the current prices
create or replace function public.prepare_ai_usage()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_price public.model_pricing;
begin
  if new.client_id is not null then
    select c.organization_id into new.organization_id from public.clients c where c.id = new.client_id;
  end if;
  if new.total_tokens = 0 then
    new.total_tokens := new.prompt_tokens + new.completion_tokens;
  end if;
  if new.estimated_cost_usd is null then
    select * into v_price from public.model_pricing where model = new.model;
    if v_price.model is not null then
      new.estimated_cost_usd := round(
        (new.prompt_tokens * v_price.input_price_per_million
          + new.completion_tokens * v_price.output_price_per_million) / 1000000.0,
        6);
    end if;
  end if;
  return new;
end;
$$;

create trigger ai_usage_prepare before insert on public.ai_usage
  for each row execute function public.prepare_ai_usage();

-- One alert per client per monthly window once its AI cost passes half of
-- what its subscription brings in
create or replace function public.check_ai_cost_alert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_start timestamptz;
  v_price numeric;
  v_rate numeric;
  v_cost numeric;
begin
  if new.client_id is null or new.estimated_cost_usd is null or new.estimated_cost_usd = 0 then
    return null;
  end if;

  select public.messages_window_start(cs.messages_period_start) into v_start
    from public.client_subscriptions cs where cs.client_id = new.client_id;
  if v_start is null then return null; end if;

  if exists (
    select 1 from public.usage_alerts a
     where a.client_id = new.client_id and a.limit_type = 'ai_cost' and a.created_at >= v_start
  ) then
    return null;
  end if;

  v_price := public.get_client_effective_price(new.client_id);
  if v_price is null or v_price <= 0 then return null; end if;

  select usd_to_egp into v_rate from public.platform_settings;
  select coalesce(sum(u.estimated_cost_usd), 0) into v_cost
    from public.ai_usage u
   where u.client_id = new.client_id and u.created_at >= v_start;

  if v_cost * coalesce(v_rate, 50) > v_price * 0.5 then
    insert into public.usage_alerts (organization_id, client_id, limit_type, threshold)
    values (new.organization_id, new.client_id, 'ai_cost', 50);
  end if;
  return null;
end;
$$;

create trigger ai_usage_cost_alert after insert on public.ai_usage
  for each row execute function public.check_ai_cost_alert();

revoke execute on function public.prepare_ai_usage() from public, anon, authenticated;
revoke execute on function public.check_ai_cost_alert() from public, anon, authenticated;

-- --------------------------------------------
-- 8. Reports
-- --------------------------------------------

-- Every client with its AI usage in [p_from, p_to) and its monthly price
-- (super admins). p_org_id: one organization's clients.
create or replace function public.get_ai_usage_report(p_from timestamptz, p_to timestamptz, p_org_id uuid default null)
returns table (
  client_id uuid,
  client_name text,
  organization_id uuid,
  organization_name text,
  org_type text,
  plan_id uuid,
  plan_slug text,
  plan_name text,
  plan_name_ar text,
  subscription_status text,
  monthly_price numeric,
  requests int,
  prompt_tokens bigint,
  completion_tokens bigint,
  total_tokens bigint,
  cost_usd numeric,
  unpriced_requests int,
  cost_alert boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select c.id, c.name, o.id, o.name, o.org_type,
         p.id, p.slug, p.name, p.name_ar, cs.status,
         case when cs.id is null then null else public.get_client_effective_price(c.id) end,
         coalesce(u.requests, 0), coalesce(u.prompt_tokens, 0), coalesce(u.completion_tokens, 0),
         coalesce(u.total_tokens, 0), coalesce(u.cost_usd, 0), coalesce(u.unpriced, 0),
         exists (
           select 1 from public.usage_alerts a
            where a.client_id = c.id and a.limit_type = 'ai_cost'
              and a.created_at >= public.messages_window_start(cs.messages_period_start)
         )
    from public.clients c
    join public.organizations o on o.id = c.organization_id
    left join public.client_subscriptions cs on cs.client_id = c.id
    left join public.plans p on p.id = cs.plan_id
    left join lateral (
      select count(*)::int as requests,
             sum(a.prompt_tokens)::bigint as prompt_tokens,
             sum(a.completion_tokens)::bigint as completion_tokens,
             sum(a.total_tokens)::bigint as total_tokens,
             sum(a.estimated_cost_usd) as cost_usd,
             count(*) filter (where a.estimated_cost_usd is null)::int as unpriced
        from public.ai_usage a
       where a.client_id = c.id and a.created_at >= p_from and a.created_at < p_to
    ) u on true
   where public.is_super_admin()
     and (p_org_id is null or c.organization_id = p_org_id)
   order by coalesce(u.cost_usd, 0) desc, c.name
$$;

-- Usage in [p_from, p_to) by operation, all organizations (super admins)
create or replace function public.get_ai_usage_by_operation(p_from timestamptz, p_to timestamptz)
returns table (
  operation text,
  requests int,
  prompt_tokens bigint,
  completion_tokens bigint,
  total_tokens bigint,
  cost_usd numeric,
  unpriced_requests int
)
language sql
stable
security definer
set search_path = public
as $$
  select a.operation, count(*)::int, sum(a.prompt_tokens)::bigint, sum(a.completion_tokens)::bigint,
         sum(a.total_tokens)::bigint, coalesce(sum(a.estimated_cost_usd), 0),
         count(*) filter (where a.estimated_cost_usd is null)::int
    from public.ai_usage a
   where public.is_super_admin() and a.created_at >= p_from and a.created_at < p_to
   group by a.operation
   order by 6 desc
$$;

-- Models in use that have no price yet (super admins)
create or replace function public.get_unpriced_ai_models()
returns table (model text, requests int, last_used_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select a.model, count(*)::int, max(a.created_at)
    from public.ai_usage a
   where public.is_super_admin()
     and a.estimated_cost_usd is null
     and not exists (select 1 from public.model_pricing m where m.model = a.model)
   group by a.model
   order by 2 desc
$$;

-- Adds or updates a model's price. Past calls keep their cost; calls logged
-- while the model had no price are priced now.
create or replace function public.upsert_model_pricing(p_model text, p_input numeric, p_output numeric)
returns text
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_super_admin() then return 'forbidden'; end if;

  insert into public.model_pricing (model, input_price_per_million, output_price_per_million)
  values (trim(p_model), p_input, p_output)
  on conflict (model) do update
    set input_price_per_million = excluded.input_price_per_million,
        output_price_per_million = excluded.output_price_per_million;

  update public.ai_usage a
     set estimated_cost_usd = round((a.prompt_tokens * p_input + a.completion_tokens * p_output) / 1000000.0, 6)
   where a.model = trim(p_model) and a.estimated_cost_usd is null;
  return 'ok';
end;
$$;

-- One client's AI usage over the last p_days: the agency's admins and
-- super admins (it's the platform's cost, not the client's)
create or replace function public.get_client_ai_usage(p_client_id uuid, p_days int default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or not public.can_manage_client_billing(p_client_id) or p_days not between 1 and 366 then
    return null;
  end if;

  return (
  select jsonb_build_object(
    'days', p_days,
    'requests', count(a.id),
    'total_tokens', coalesce(sum(a.total_tokens), 0),
    'cost_usd', coalesce(sum(a.estimated_cost_usd), 0),
    'cost_egp', round(coalesce(sum(a.estimated_cost_usd), 0) * (select s.usd_to_egp from public.platform_settings s), 2),
    'by_operation', coalesce((
      select jsonb_agg(jsonb_build_object('operation', b.operation, 'total_tokens', b.total_tokens, 'cost_usd', b.cost_usd)
                       order by b.cost_usd desc)
        from (
          select x.operation, sum(x.total_tokens) as total_tokens, coalesce(sum(x.estimated_cost_usd), 0) as cost_usd
            from public.ai_usage x
           where x.client_id = p_client_id and x.created_at >= now() - make_interval(days => p_days)
           group by x.operation
        ) b
    ), '[]'::jsonb)
  )
    from public.ai_usage a
   where a.client_id = p_client_id and a.created_at >= now() - make_interval(days => p_days)
  );
end;
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'get_ai_usage_report(timestamptz, timestamptz, uuid)',
    'get_ai_usage_by_operation(timestamptz, timestamptz)',
    'get_unpriced_ai_models()',
    'upsert_model_pricing(text, numeric, numeric)',
    'get_client_ai_usage(uuid, int)'
  ] loop
    execute format('revoke execute on function public.%s from public, anon', fn);
    execute format('grant execute on function public.%s to authenticated, service_role', fn);
  end loop;
end $$;

-- --------------------------------------------
-- 9. RLS
-- --------------------------------------------
alter table public.model_pricing enable row level security;
alter table public.platform_settings enable row level security;
alter table public.ai_usage enable row level security;

create policy "Super admins manage model pricing"
  on public.model_pricing for all
  using (public.is_super_admin())
  with check (public.is_super_admin());

create policy "Super admins manage platform settings"
  on public.platform_settings for all
  using (public.is_super_admin())
  with check (public.is_super_admin());

-- Read-only for users; rows are written by the server (service role)
create policy "AI usage: super admins, org admins, client admins"
  on public.ai_usage for select
  using (
    public.is_super_admin()
    or (public.user_role() = 'org_admin' and organization_id = public.user_org())
    or (public.user_role() = 'client_admin' and public.has_client_access(client_id))
  );
