-- ============================================
-- ARABIC-FRIENDLY, UNIQUE SLUGS
-- ============================================
-- handle_new_user built organization slugs with [^a-zA-Z0-9]+ → '-', so an
-- all-Arabic name became '-' and the second Arabic sign-up failed on
-- organizations_slug_key. Same-named English organizations collided too.

-- --------------------------------------------
-- 1. slugify: keeps ASCII letters/digits and Arabic letters/digits
--    (same idea as the app's slugify for clients). Explicit Unicode ranges
--    rather than [[:alnum:]], whose meaning depends on the database locale.
--    Tashkeel and tatweel are dropped, not turned into hyphens.
-- --------------------------------------------
create or replace function public.slugify(p_value text)
returns text
language sql
immutable
set search_path = public
as $$
  select trim(both '-' from left(
    trim(both '-' from regexp_replace(
      regexp_replace(
        lower(normalize(coalesce(p_value, ''), NFKC)),
        '[ـً-ٰٟ]', '', 'g'
      ),
      '[^a-z0-9ء-غف-ي٠-٩ٱ-ۓ۰-۹]+', '-', 'g'
    )),
    60
  ))
$$;

-- --------------------------------------------
-- 2. A free organization slug: the name's slug, then -2, -3, …
--    ('org' when the name has no letters or digits at all)
-- --------------------------------------------
create or replace function public.unique_organization_slug(p_name text)
returns text
language plpgsql
set search_path = public
as $$
declare
  v_base text := coalesce(nullif(public.slugify(p_name), ''), 'org');
  v_slug text := v_base;
  v_n int := 1;
begin
  while exists (select 1 from public.organizations where slug = v_slug) loop
    v_n := v_n + 1;
    if v_n > 50 then
      return left(v_base, 53) || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6);
    end if;
    v_slug := left(v_base, 55) || '-' || v_n;
  end loop;
  return v_slug;
end;
$$;

revoke execute on function public.unique_organization_slug(text) from public, anon, authenticated;

-- --------------------------------------------
-- 3. handle_new_user: unchanged except the organization slug. Two sign-ups
--    with the same name at the same moment can still pick the same slug, so
--    a unique violation retries with a random suffix.
-- --------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  new_org_id uuid;
  invite_record record;
  meta_org_name text;
  meta_invite_code text;
  org_slug text;
begin
  meta_org_name := new.raw_user_meta_data->>'organization_name';
  meta_invite_code := new.raw_user_meta_data->>'invite_code';

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

  -- Case 2: User creating a new organization
  if meta_org_name is not null then
    org_slug := public.unique_organization_slug(meta_org_name);
    for attempt in 1..5 loop
      begin
        insert into public.organizations (name, slug)
        values (meta_org_name, org_slug)
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
-- 4. Repair slugs the old rule produced: empty, only hyphens, or with a
--    leading / trailing hyphen where Arabic text was stripped ('-7-',
--    'clinic-'). One row at a time so each sees the slugs fixed before it.
--    Slugs are only shown and searched, never part of a URL.
-- --------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select id, name from public.organizations
     where slug !~ '^[^-].*[^-]$' and slug !~ '^[^-]$'
     order by created_at
  loop
    update public.organizations set slug = public.unique_organization_slug(r.name) where id = r.id;
  end loop;
end;
$$;

-- Clients: the app has always generated Arabic-friendly slugs, but rows
-- written outside it (SQL, imports) may have none. Unique per organization.
do $$
declare
  r record;
  v_base text;
  v_slug text;
  v_n int;
begin
  for r in
    select id, organization_id, name from public.clients
     where trim(both '-' from slug) = ''
     order by created_at
  loop
    v_base := coalesce(nullif(public.slugify(r.name), ''), 'client');
    v_slug := v_base;
    v_n := 1;
    while exists (
      select 1 from public.clients c
       where c.organization_id = r.organization_id and c.slug = v_slug and c.id <> r.id
    ) loop
      v_n := v_n + 1;
      v_slug := left(v_base, 55) || '-' || v_n;
    end loop;
    update public.clients set slug = v_slug where id = r.id;
  end loop;
end;
$$;
