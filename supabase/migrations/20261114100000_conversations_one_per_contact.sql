-- ============================================
-- ONE CONVERSATION PER PERSON, PER CHANNEL, PER THREAD
-- (.scratch/agent-reply-decisions.md §3.3; decided 2026-11-08)
-- ============================================
--
-- Every transport finds the sender's conversation by (channel_id,
-- contact_identifier, thread) and opens one when there is none: Meta's
-- direct messages (conversationFor), Instagram comment threads
-- (commentThreadFor), and the website widget's first message. Each is a
-- read and then an insert, and until now only an ordinary index stood
-- behind them (20261108100000). Two messages from one person arriving
-- together could both read "none" and both insert:
--   - on WhatsApp, Messenger and Instagram, every later lookup for that
--     person expects one row and fails, so the person's thread is broken
--     for good by nothing worse than two fast messages;
--   - on the website, a visitor's two first messages, sent before the first
--     answer brought back the conversation id, land in two conversations.
-- Same race, same shape, on every transport: the index covers them all.
--
-- The creators now meet this index on a race and read back the row that won
-- (src/lib/meta/inbound.ts, src/lib/meta/comments.ts, the website route).
--
-- A conversation with no contact_identifier is not constrained (NULLs are
-- distinct): there is no person to have two of.
--
-- EXISTING DUPLICATES ARE NOT MERGED. Merging moves messages, leads and
-- appointments from one conversation to another, and which survives is a
-- person's decision. If any exist the migration stops and says how to list
-- them. (Production was checked before this was written: none, 2026-11-08.)
-- ============================================

do $$
declare
  groups int;
begin
  select count(*) into groups
    from (
      select 1
        from public.conversations
       where contact_identifier is not null
       group by channel_id, contact_identifier, thread
      having count(*) > 1
    ) duplicated;
  if groups > 0 then
    raise exception 'conversations_one_per_contact: % (channel, contact, thread) groups have more than one conversation; resolve them by hand first', groups
      using hint = 'select channel_id, contact_identifier, thread, array_agg(id order by created_at) from public.conversations where contact_identifier is not null group by 1, 2, 3 having count(*) > 1';
  end if;
end;
$$;

-- The unique index serves the same lookup the ordinary one did
drop index if exists public.idx_conversations_channel_contact_thread;

create unique index conversations_one_per_contact
  on public.conversations (channel_id, contact_identifier, thread);
