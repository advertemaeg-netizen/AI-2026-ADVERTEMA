-- ============================================
-- RLS, PHASE 1: the access check runs once per statement, not once per row
-- (messages, conversations, leads, lead_events)
-- ============================================
--
-- Measured 22 October 2026 (EXPLAIN as a dashboard user):
-- get_response_time_stats took 18,440 ms with RLS, about 0.2 s without.
-- Inside it, a primary-key lookup on conversations cost 3.5 ms: every
-- message row ran the conversations policy, which ran has_client_access()
-- (and is_client_manager()), which ran user_role() up to three times and
-- user_org(), each of which ran impersonated_org(). All security definer
-- SQL, so none of it is inlined and none of it is cached between rows:
-- about a dozen small queries per message row, about 5,000 rows, for six
-- numbers. Linear in messages; the analytics page had already passed the
-- statement timeout.
--
-- has_client_access(client_id) takes the row's own column, so wrapping it
-- in a scalar subquery (the usual Supabase advice) changes nothing. It is
-- inverted instead: accessible_client_ids() returns the set of clients the
-- caller may see, Postgres evaluates `client_id in (select …)` once as a
-- hashed subplan, and each row is a hash lookup. Row-independent calls
-- (is_client_manager(), is_super_admin(), auth.uid()) are wrapped in
-- `(select …)` for the same reason. The messages and lead_events policies
-- keep reading their parent table's own policy, once per statement
-- (`… in (select id from parent)`), so who may see a conversation or a lead
-- is still decided in exactly one place.
--
-- WHO MAY READ OR WRITE WHAT DOES NOT CHANGE. The proof is
-- tests/access/access-matrix.test.ts, whose snapshot was frozen before this
-- migration (commit e3fbdba) and must stay byte for byte the same, and its
-- equivalence check: for every identity and every client in the test
-- database, has_client_access(c) = c in accessible_client_ids().
-- ============================================

-- has_client_access(), as a set. The same three ways in, behind the same
-- gate: no role (a disabled organization's users, anyone signed out) sees
-- nothing. user_role() and user_org() are read once (the `me` row), not per
-- client.
create function public.accessible_client_ids()
returns setof uuid
language sql
security definer
stable
set search_path = public
as $$
  with me as (select public.user_role() as role, public.user_org() as org)
  select c.id
    from public.clients c, me
   where me.role is not null
     and (
       me.role = 'super_admin'
       or (me.role = 'org_admin' and c.organization_id = me.org)
       or exists (
         select 1 from public.client_members cm
          where cm.client_id = c.id and cm.user_id = auth.uid()
       )
     )
$$;

-- Executable by anon, as has_client_access() is: the policies below run it
-- for whoever reads, and for anon it returns nothing (no role). Revoked, a
-- signed-out read of conversations fails where it returned no rows; the
-- access matrix caught exactly that on the first run of this migration.
grant execute on function public.accessible_client_ids() to anon, authenticated, service_role;

-- --------------------------------------------
-- conversations
-- --------------------------------------------
drop policy "Members see their clients' conversations" on public.conversations;
drop policy "Members update their clients' conversations" on public.conversations;

create policy "Members see their clients' conversations"
  on public.conversations for select
  using (client_id in (select public.accessible_client_ids()));

create policy "Members update their clients' conversations"
  on public.conversations for update
  using (client_id in (select public.accessible_client_ids()))
  with check (client_id in (select public.accessible_client_ids()));

-- --------------------------------------------
-- messages: visible with their conversation (the conversations policy, once)
-- --------------------------------------------
drop policy "Users see messages of accessible conversations" on public.messages;
drop policy "Users send agent messages in conversations they handle" on public.messages;

create policy "Users see messages of accessible conversations"
  on public.messages for select
  using (conversation_id in (select c.id from public.conversations c));

create policy "Users send agent messages in conversations they handle"
  on public.messages for insert
  with check (
    role = 'agent'
    and sender_id = (select auth.uid())
    and conversation_id in (select c.id from public.conversations c)
  );

-- --------------------------------------------
-- leads
-- --------------------------------------------
drop policy "Users see leads of their clients" on public.leads;
drop policy "Users update leads of their clients" on public.leads;
drop policy "Admins delete leads of their clients" on public.leads;
drop policy "Users add leads to their clients" on public.leads;

create policy "Users see leads of their clients"
  on public.leads for select
  using (client_id in (select public.accessible_client_ids()) and (is_complete or (select public.is_super_admin())));

create policy "Users update leads of their clients"
  on public.leads for update
  using (client_id in (select public.accessible_client_ids()) and (is_complete or (select public.is_super_admin())))
  with check (client_id in (select public.accessible_client_ids()));

create policy "Admins delete leads of their clients"
  on public.leads for delete
  using (
    (select public.is_client_manager())
    and client_id in (select public.accessible_client_ids())
    and (is_complete or (select public.is_super_admin()))
  );

create policy "Users add leads to their clients"
  on public.leads for insert
  with check (client_id in (select public.accessible_client_ids()));

-- --------------------------------------------
-- lead_events: visible with their lead (the leads policy, once)
-- --------------------------------------------
drop policy "Users see events of leads they can see" on public.lead_events;

create policy "Users see events of leads they can see"
  on public.lead_events for select
  using (lead_id in (select l.id from public.leads l));
