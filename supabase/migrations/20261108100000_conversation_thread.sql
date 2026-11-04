-- ============================================
-- CONVERSATIONS HAVE A THREAD: the direct-message one, or a comment thread
-- (.scratch/messenger-instagram-design.md §2, §5)
-- ============================================
--
-- On Facebook a commenter's id is the same id their Messenger messages carry
-- (the PSID; tested live with two people on 2026-11-04, one of them
-- commenting before ever messaging). So one person on one Page can have two
-- conversations with the same (channel_id, contact_identifier): the private
-- one, and the public comment thread. They must stay two. The model writing
-- a public reply must never see the private conversation's history, or a
-- detail a patient wrote in a DM can surface in a public comment; with two
-- rows, the public side cannot read the private one at all.
--
-- 'dm' is every conversation that exists today and every one the
-- direct-message transports open: the website's, WhatsApp's, Messenger's.
-- 'comments' is for the comment threads still to be built. Every Meta
-- transport's lookup of a direct-message conversation filters thread = 'dm'
-- (src/lib/meta/inbound.ts). The website's needs none: a widget conversation
-- is never a comment thread.
--
-- The index serves that lookup: (channel, contact, thread) is how a
-- Meta transport finds the sender's conversation.
-- ============================================

alter table public.conversations
  add column thread text not null default 'dm'
  constraint conversations_thread_check check (thread in ('dm', 'comments'));

create index idx_conversations_channel_contact_thread
  on public.conversations (channel_id, contact_identifier, thread);
