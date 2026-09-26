-- ============================================
-- TEAM MEMBER PERMISSIONS
-- Team members work conversations, leads, appointments and the overview.
-- Configuring a client (channels, knowledge base, bot settings, invites) is
-- for client admins and up.
--
-- Writes were already limited to super/org/client admins on channels,
-- knowledge_documents, bot_settings, organization_invites and knowledge
-- files. What changes here is reading.
-- ============================================

-- Knowledge base: documents, chunks and embeddings are configuration, not
-- day-to-day work. "Client admins manage knowledge" (FOR ALL) keeps
-- read access for admins.
drop policy if exists "Users see knowledge of their clients" on public.knowledge_documents;

-- Bot settings: same; "Admins manage bot settings of their clients" (FOR ALL)
-- keeps read access for admins. The widget/webhook read them server-side.
drop policy if exists "Users see bot settings of their clients" on public.bot_settings;

-- Knowledge files in storage
drop policy if exists "Users read knowledge files of their clients" on storage.objects;

create policy "Admins read knowledge files of their clients"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'knowledge-base'
    and public.is_client_manager()
    and public.has_client_access(public.storage_client_id(name))
  );

-- Channels: team members keep read access (conversations show which
-- channel they came from); only admins could ever write them:
--   "Client admins manage channels" — super/org/client admins.
-- Invites: already admins only for select / insert / delete.
