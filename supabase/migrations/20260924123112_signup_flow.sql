-- Add invitation system for later
create extension if not exists pgcrypto with schema extensions;
create table organization_invites (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  email text not null,
  role user_role not null default 'team_member',
invite_code text unique not null default encode(extensions.gen_random_bytes(16), 'hex'),
  invited_by uuid references users(id) on delete set null,
  accepted_at timestamptz,
  expires_at timestamptz not null default (now() + interval '7 days'),
  created_at timestamptz default now()
);

create index idx_invites_email on organization_invites(email);
create index idx_invites_code on organization_invites(invite_code);

-- Replace the old handle_new_user function
-- Now it checks metadata for org creation or invite acceptance
create or replace function public.handle_new_user()
returns trigger as $$
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
    from organization_invites
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

      update organization_invites
        set accepted_at = now()
        where id = invite_record.id;

      return new;
    end if;
  end if;

  -- Case 2: User creating a new organization
  if meta_org_name is not null then
    insert into organizations (name, slug)
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

  -- Case 3: No org info - basic user (fallback)
  insert into public.users (id, email, full_name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    'team_member'
  );

  return new;
end;
$$ language plpgsql security definer;

-- RLS for invites
alter table organization_invites enable row level security;

create policy "Org admins see their invites"
  on organization_invites for select
  using (
    public.user_role() in ('super_admin', 'org_admin')
    and organization_id = public.user_org()
  );

create policy "Org admins create invites"
  on organization_invites for insert
  with check (
    public.user_role() in ('super_admin', 'org_admin')
    and organization_id = public.user_org()
  );