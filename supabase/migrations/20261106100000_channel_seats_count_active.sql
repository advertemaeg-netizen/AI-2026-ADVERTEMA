-- ============================================
-- CHANNEL SEATS COUNT ACTIVE CHANNELS ONLY
-- ============================================
--
-- The plan's channel allowance was counted over every channel of a client,
-- so a deactivated channel (the WhatsApp placeholder of 2026-10-02, paused
-- on 2026-10-26 beside the live one) kept occupying a seat. A paused
-- channel is not a seat in use. The counter is refreshed when is_active
-- changes, not only on insert and delete, and recounted now for every
-- client.
-- ============================================

create or replace function public.refresh_client_usage(p_client_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.client_subscriptions cs set
    channels_used = (select count(*) from public.channels ch where ch.client_id = p_client_id and ch.is_active),
    knowledge_docs_used = (
      select count(*) from public.knowledge_documents k
       where k.client_id = p_client_id and k.source_document_id is null
    ),
    knowledge_chunks_used = (
      select count(*) from public.knowledge_documents k
       where k.client_id = p_client_id and k.source_document_id is not null
    ),
    team_members_used = (select count(*) from public.client_members cm where cm.client_id = p_client_id)
   where cs.client_id = p_client_id
$$;

-- Pausing or resuming a channel moves the count too
drop trigger if exists channels_sync_usage on public.channels;
create trigger channels_sync_usage
  after insert or delete or update of is_active on public.channels
  for each row execute function public.sync_subscription_usage();

-- The counters as they stand, under the new rule
do $$
declare
  r record;
begin
  for r in select client_id from public.client_subscriptions loop
    perform public.refresh_client_usage(r.client_id);
  end loop;
end
$$;
