-- ============================================
-- PROCESSED META MESSAGES: when processing finished, so a message the server
-- swallowed can be found
-- ============================================
--
-- Insert-first (20261103) means a crash between the claim and the reply
-- loses that message for good: by the time Meta retries, the id is a
-- duplicate. That is the right trade (a duplicate reply is visible to the
-- customer and looks broken; a dropped one is silent), but silent has to be
-- findable. The claim leaves completed_at null; the end of processing sets
-- it. A row with a null completed_at older than a few minutes is a message
-- we swallowed. No retry, no sweeper: visibility only. The count of those
-- rows is the signal (swallowedMessages in src/lib/meta/processed.ts).
-- ============================================

alter table public.processed_meta_messages add column completed_at timestamptz;

-- Counting what is still open is the column's whole use
create index processed_meta_messages_open_idx
  on public.processed_meta_messages (received_at)
  where completed_at is null;
