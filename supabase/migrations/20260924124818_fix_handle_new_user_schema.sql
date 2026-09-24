create or replace function public.handle_new_user()
returns trigger
security definer
set search_path = public, extensions
as $$
declare
  new_org_id uuid;
  invite_record record;
  meta_org_name text;
  meta_invite_code text;
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
        coalesce(new.raw_user_meta_data->>'full_name', ''),
        invite_record.role,
        invite_record.organization_id
      );

      update public.organization_invites
        set accepted_at = now()
        where id = invite_record.id;

      return new;
    end if;
  end if;

  -- Case 2: User creating a new organization
  if meta_org_name is not null then
    insert into public.organizations (name, slug)
    values (
      meta_org_name,
      lower(regexp_replace(meta_org_name, '[^a-zA-Z0-9]+', '-', 'g'))
    )
    returning id into new_org_id;

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
$$ language plpgsql;