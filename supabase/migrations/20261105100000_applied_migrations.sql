-- ============================================
-- APPLIED MIGRATIONS, READABLE BY THE DEPLOY: the schema says what it has
-- ============================================
--
-- Three deploys have shipped code ahead of its schema: the image started,
-- the new code ran against tables and columns that were not there yet, and
-- nothing stopped it (the third time, 26 October 2026, for about fifteen
-- minutes). The migrations were a step someone remembered. deploy/update.sh
-- now asks the database which migration versions it has applied and refuses
-- to build when the repository holds one it has not. It never applies
-- anything itself: a deploy that changed the schema on its own would turn
-- an irreversible action into a side effect of pushing code.
--
-- The CLI records applied versions in supabase_migrations.schema_migrations,
-- which PostgREST does not expose. This function exposes the version list,
-- and only that, to the service role alone: the deploy already holds that
-- key. SECURITY DEFINER over a system schema is exactly the kind of thing
-- that turns out quietly callable by a role nobody checked, so the revokes
-- are explicit, and tests/access/access-matrix.test.ts records it refused
-- for every identity.
--
-- Bootstrap: this migration is pushed by hand first; the deploy that carries
-- the script change is the first one checked, and every deploy after it.
-- ============================================

create function public.applied_migrations()
returns setof text
language sql
security definer
stable
set search_path = public
as $$
  select version from supabase_migrations.schema_migrations order by version
$$;

revoke execute on function public.applied_migrations() from public, anon, authenticated;
grant execute on function public.applied_migrations() to service_role;
