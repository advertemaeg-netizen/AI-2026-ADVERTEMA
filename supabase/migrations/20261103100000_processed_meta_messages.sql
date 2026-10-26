-- ============================================
-- PROCESSED META MESSAGES: one row per delivery Meta has made, so a retry
-- does nothing (.scratch/whatsapp-send-design.md §2)
-- ============================================
--
-- Meta retries on a timeout, on a non-200, and sometimes on a 200 it did
-- not read in time, and a retry carries the same message id (the wamid on
-- WhatsApp). Without a record of what was already acted on, the first retry
-- costs a duplicate reply to a real customer and a duplicate model call.
--
-- The webhook inserts the id here BEFORE anything acts on the delivery:
-- before the conversation is touched, before the model is called, before a
-- message is sent. `insert … on conflict do nothing`, then whether a row was
-- inserted decides: none means a repeat, logged as a duplicate and dropped.
--
-- A table with a primary key, not a cache, not a TTL, not an in-memory set:
-- the container restarts and Meta retries across restarts. Service role only,
-- like channel_secrets: no policy, no grant to anon or authenticated. It
-- holds no message text and no phone number, only Meta's id and ours.
-- ============================================

create table public.processed_meta_messages (
  -- Meta's id for the event, exactly as sent (wamid… on WhatsApp)
  message_id text primary key,
  channel_id uuid not null references public.channels(id) on delete cascade,
  received_at timestamptz not null default now()
);

alter table public.processed_meta_messages enable row level security;
-- No policy, on purpose: see the header.

revoke all on table public.processed_meta_messages from public, anon, authenticated;
grant all on table public.processed_meta_messages to service_role;

-- Impersonation is read-only on every table (tests/access/table-guards.test.ts)
create trigger block_impersonated_writes before insert or update or delete on public.processed_meta_messages
  for each statement execute function public.block_impersonated_writes();
