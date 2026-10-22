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

-- Test-only: runs one statement and returns the SQLSTATE it failed with, or
-- null when it succeeded (rolled back either way is NOT promised: a success
-- stays). A refusal the database makes cannot be asserted over REST here: a
-- failed statement drops PostgREST's one connection (pglite#958, see
-- tests/harness/helpers.ts) and the caller sees PGRST001 instead of the
-- code. Caught inside this function, the statement fails in a subtransaction
-- and the connection never sees an error.
create function public.test_sqlstate(statement text)
returns text
language plpgsql
as $$
begin
  execute statement;
  return null;
exception when others then
  return sqlstate;
end;
$$;

revoke execute on function public.test_sqlstate(text) from public, anon, authenticated;
grant execute on function public.test_sqlstate(text) to service_role;

-- Test-only: an auth user created with sign-up metadata, as supabase.auth.signUp
-- leaves one (the profile row is made by the triggers on auth.users)
create function public.test_create_auth_user_with_meta(p_email text, p_meta jsonb)
returns uuid
language sql
security definer
as $$
  insert into auth.users (email, raw_user_meta_data) values (p_email, p_meta) returning id
$$;

revoke execute on function public.test_create_auth_user_with_meta(text, jsonb) from public, anon, authenticated;
grant execute on function public.test_create_auth_user_with_meta(text, jsonb) to service_role;

-- Test-only: every table of the public schema, with what protects it: row
-- level security, and the impersonation read-only guard (a trigger named
-- block_impersonated_writes). Read by tests/access/table-guards.test.ts, so a
-- table added without either fails the suite the day it is added.
create function public.test_table_guards()
returns table (table_name text, has_client_id boolean, rls_enabled boolean, impersonation_guard boolean)
language sql
stable
as $$
  select c.relname::text,
         exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'client_id' and not a.attisdropped),
         c.relrowsecurity,
         exists (select 1 from pg_trigger t where t.tgrelid = c.oid and t.tgname = 'block_impersonated_writes' and not t.tgisinternal)
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'
   order by 1
$$;

revoke execute on function public.test_table_guards() from public, anon, authenticated;
grant execute on function public.test_table_guards() to service_role;
