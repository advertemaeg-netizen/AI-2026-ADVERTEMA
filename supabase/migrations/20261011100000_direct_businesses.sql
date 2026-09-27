-- ============================================
-- DIRECT BUSINESSES
--
-- Two kinds of organization sign up:
--   agency — manages many clients. Organization subscription on an agency
--            plan + one business-plan subscription per client (as before).
--   direct — a single business (clinic, restaurant, shop). Exactly one
--            client, created with the organization; only that client's
--            business-plan subscription, no organization subscription.
-- The type is fixed at sign-up; there's no upgrade path.
-- ============================================

-- --------------------------------------------
-- 1. Organization type (every existing organization is an agency)
-- --------------------------------------------
alter table public.organizations
  add column if not exists org_type text not null default 'agency'
    check (org_type in ('agency', 'direct'));

-- Fixed after creation
create or replace function public.guard_org_type()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.org_type is distinct from old.org_type then
    raise exception 'org_type_fixed' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger organizations_guard_org_type before update of org_type on public.organizations
  for each row execute function public.guard_org_type();

-- The type of an organization, for its own members and super admins
create or replace function public.get_org_type(p_org_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select o.org_type
    from public.organizations o
   where o.id = p_org_id
     and (public.is_super_admin() or public.user_org() = p_org_id)
$$;

revoke execute on function public.get_org_type(uuid) from public, anon;
grant execute on function public.get_org_type(uuid) to authenticated;

-- --------------------------------------------
-- 2. A direct business has exactly one client: no second one, and no
--    moving a client into it. (Any path: app, API, SQL.)
-- --------------------------------------------
create or replace function public.enforce_direct_single_client()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' and new.organization_id is not distinct from old.organization_id then
    return new;
  end if;

  if (select o.org_type from public.organizations o where o.id = new.organization_id) = 'direct'
     and exists (
       select 1 from public.clients c
        where c.organization_id = new.organization_id and c.id <> new.id
     ) then
    raise exception 'direct_single_client' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

revoke execute on function public.enforce_direct_single_client() from public, anon, authenticated;

create trigger clients_direct_single_client
  before insert or update of organization_id on public.clients
  for each row execute function public.enforce_direct_single_client();

-- --------------------------------------------
-- 3. No organization subscription for direct businesses: they're billed
--    through their one client's business plan. (Agencies unchanged.)
-- --------------------------------------------
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
    (organization_id, plan_id, status, billing_cycle, trial_ends_at, current_period_start, current_period_end)
  values
    (new.id, v_plan, 'trialing', 'monthly', now() + interval '14 days', now(), now() + interval '14 days')
  on conflict (organization_id) do nothing;
  return new;
end;
$$;

-- --------------------------------------------
-- 4. Sign-up: organization_type in the metadata ('agency' when missing).
--    direct: organization + its one client (same name) + the owner as
--    org_admin and as the client's client_admin member. The client's
--    business_basic trial and bot settings come from the clients triggers.
--    Everything else (invites, agencies, fallback) is unchanged.
-- --------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  new_org_id uuid;
  new_client_id uuid;
  invite_record record;
  meta_org_name text;
  meta_org_type text;
  meta_invite_code text;
  org_slug text;
begin
  meta_org_name := new.raw_user_meta_data->>'organization_name';
  meta_invite_code := new.raw_user_meta_data->>'invite_code';
  meta_org_type := case
    when new.raw_user_meta_data->>'org_type' = 'direct' then 'direct'
    else 'agency'
  end;

  -- Case 1: User is joining via invite
  if meta_invite_code is not null then
    select * into invite_record
    from public.organization_invites
    where invite_code = meta_invite_code
      and accepted_at is null
      and expires_at > now()
      and lower(email) = lower(new.email);

    if invite_record.id is not null then
      insert into public.users (id, email, full_name, role, organization_id)
      values (
        new.id,
        new.email,
        coalesce(nullif(new.raw_user_meta_data->>'full_name', ''), invite_record.invited_name, ''),
        invite_record.role,
        invite_record.organization_id
      );

      if invite_record.client_id is not null then
        insert into public.client_members (client_id, user_id, role)
        values (invite_record.client_id, new.id, invite_record.role)
        on conflict (client_id, user_id) do nothing;
      end if;

      update public.organization_invites
        set accepted_at = now()
        where id = invite_record.id;

      return new;
    end if;
  end if;

  -- Case 2: User creating a new organization (agency or direct business)
  if meta_org_name is not null then
    org_slug := public.unique_organization_slug(meta_org_name);
    for attempt in 1..5 loop
      begin
        insert into public.organizations (name, slug, org_type)
        values (meta_org_name, org_slug, meta_org_type)
        returning id into new_org_id;
        exit;
      exception when unique_violation then
        org_slug := left(coalesce(nullif(public.slugify(meta_org_name), ''), 'org'), 53)
          || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6);
      end;
    end loop;

    if new_org_id is null then
      raise exception 'could not create a unique organization slug';
    end if;

    insert into public.users (id, email, full_name, role, organization_id)
    values (
      new.id,
      new.email,
      coalesce(new.raw_user_meta_data->>'full_name', ''),
      'org_admin',
      new_org_id
    );

    if meta_org_type = 'direct' then
      insert into public.clients (organization_id, name, slug)
      values (
        new_org_id,
        meta_org_name,
        coalesce(nullif(public.slugify(meta_org_name), ''), 'business')
      )
      returning id into new_client_id;

      insert into public.client_members (client_id, user_id, role)
      values (new_client_id, new.id, 'client_admin')
      on conflict (client_id, user_id) do nothing;
    end if;

    return new;
  end if;

  -- Case 3: Fallback
  insert into public.users (id, email, full_name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    'team_member'
  );

  return new;
end;
$$;

-- --------------------------------------------
-- 5. Billing permissions. A client's plan, custom price and invoices are
--    managed by its agency — so for a direct business (which pays the
--    platform) only super admins may change them; otherwise the owner, an
--    org_admin, could change or discount their own plan. The owner can
--    still see the subscription.
-- --------------------------------------------
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
        and exists (
          select 1 from public.clients c
            join public.organizations o on o.id = c.organization_id
           where c.id = p_client_id
             and c.organization_id = public.user_org()
             and o.org_type = 'agency'
        )
      )
$$;

-- Seeing it: those who manage it, plus the client's own admins and the
-- direct business's owner
create or replace function public.can_view_client_billing(p_client_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.can_manage_client_billing(p_client_id)
      or (public.user_role() in ('org_admin', 'client_admin') and public.has_client_access(p_client_id))
$$;
