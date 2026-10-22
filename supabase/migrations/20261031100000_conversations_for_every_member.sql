-- ============================================
-- Three access rules, decided 22 October 2026 from the access matrix
-- (tests/access/access-matrix.test.ts), before its snapshot was frozen
-- ============================================
--
-- 1. A MEMBER OF A CLIENT SEES THAT CLIENT'S CONVERSATIONS, ALL OF THEM.
--    The product has no "assigned conversations only" role: a team member
--    sees every conversation and every lead of their clients, and is kept
--    out of the knowledge base and the settings (team_member_permissions).
--    The policies of 20260927100000_conversations_inbox.sql made assigned_to
--    an access boundary for anyone but a manager, a concept the product
--    doesn't have; the leads policy never had it. assigned_to stays a field:
--    who is handling a conversation, and an inbox filter. Not who may see it.
--    Messages follow (their policy reads conversations), and so does sending
--    an agent message ("Users send agent messages…" checks the conversation
--    is visible).
--
-- 2. NO CONVERSATION IS CREATED THROUGH THE API BY A USER. Conversations are
--    opened by the webhook (service role); nothing in the product inserts one
--    as a signed-in user. Lead inserts stay: manual booking makes them.
--
-- 3. IMPERSONATION IS READ-ONLY ON EVERY TABLE. The guard of
--    20261013110000_impersonation.sql was installed by a loop over the tables
--    that existed then, with a comment that later tables need it too; three
--    were added after and none got it, so an impersonating super admin could
--    change a client's branch hours and closures. tests/access/table-guards
--    now fails when any table lacks it, which is what that comment could not do.
-- ============================================

drop policy "Users see conversations they handle" on public.conversations;
drop policy "Users update conversations they handle" on public.conversations;

create policy "Members see their clients' conversations"
  on public.conversations for select
  using (public.has_client_access(client_id));

create policy "Members update their clients' conversations"
  on public.conversations for update
  using (public.has_client_access(client_id))
  with check (public.has_client_access(client_id));

drop policy "Users insert conversations" on public.conversations;

create trigger block_impersonated_writes before insert or update or delete on public.branches
  for each statement execute function public.block_impersonated_writes();
create trigger block_impersonated_writes before insert or update or delete on public.branch_closures
  for each statement execute function public.block_impersonated_writes();
create trigger block_impersonated_writes before insert or update or delete on public.legal_versions
  for each statement execute function public.block_impersonated_writes();
