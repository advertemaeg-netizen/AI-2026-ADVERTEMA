-- The parts of a Supabase project the migrations rely on, for a bare Postgres
-- (PGlite): roles, the auth / storage / realtime schemas and default grants.

create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;

create schema extensions;
create schema auth;
create schema storage;
create schema realtime;

-- Preinstalled on Supabase
create extension pgcrypto with schema extensions;

grant usage on schema public, extensions, auth, storage to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  raw_user_meta_data jsonb not null default '{}',
  last_sign_in_at timestamptz,
  created_at timestamptz not null default now()
);

-- PostgREST puts the verified JWT in request.jwt.claims
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
$$;

create function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;

create function auth.role() returns text language sql stable as $$
  select auth.jwt() ->> 'role'
$$;

grant execute on all functions in schema auth to anon, authenticated, service_role;

create table storage.buckets (
  id text primary key,
  name text not null unique,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[],
  created_at timestamptz not null default now()
);

create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text,
  owner uuid,
  metadata jsonb,
  created_at timestamptz not null default now()
);

alter table storage.objects enable row level security;

-- Broadcasts go nowhere in tests
create function realtime.send(payload jsonb, event text, topic text, private boolean default true)
returns void language sql as $$ select $$;

create publication supabase_realtime;

-- Test-only stand-in for Supabase Auth's sign-up: the auth.users row, which the
-- app's own trigger turns into a profile. auth isn't exposed over REST.
create function public.test_create_auth_user(p_email text)
returns uuid
language sql
security definer
as $$
  insert into auth.users (email) values (p_email) returning id
$$;

revoke execute on function public.test_create_auth_user(text) from public, anon, authenticated;
grant execute on function public.test_create_auth_user(text) to service_role;
