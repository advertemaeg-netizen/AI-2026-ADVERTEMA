-- ============================================
-- COMMENT REPLIES: the per-client switch, and one claim per comment
-- (.scratch/messenger-instagram-design.md §2; .scratch/comments-decisions-and-arabic.md)
-- ============================================
--
-- THE SWITCH. clients.comment_replies_enabled, false for every client that
-- exists and every one created: replying to comments in a clinic's name is
-- not a thing nine clinics get by a deploy. While it is off, a comment is
-- not stored, not claimed and not answered: the webhook logs its shape and
-- nothing else happens.
--
-- THE CLAIM. One row per comment id, inserted before anything acts on the
-- comment (`insert … on conflict do nothing`, as processed_meta_messages):
-- a webhook retry, a duplicate notification for a boosted post, or the same
-- comment delivered twice finds the row and does nothing. A duplicate PUBLIC
-- reply is the failure the whole page can read; this primary key is what
-- makes it impossible.
--
-- The row then records what was done, each step's intent written before
-- the step (the same rule as an outbound message's 'sending'):
--   decision        reply, or why not (own_reply, own_account, reply_in_thread…)
--   private_state   sending → sent | failed:<kind>; skipped
--   public_state    posting → posted | failed; and which string (public_variant)
--   public_comment_id  the id Meta gave OUR public reply. Recorded ids are
--                   how our own comments are recognised when Instagram
--                   delivers them back: never a field of the payload.
--
-- No comment text and no person id here: Meta's ids and ours only, like
-- processed_meta_messages. Service role only, for the same reason.
-- ============================================

alter table public.clients
  add column comment_replies_enabled boolean not null default false;

create table public.meta_comment_replies (
  -- Meta's id for the comment, exactly as sent
  comment_id text primary key,
  channel_id uuid not null references public.channels(id) on delete cascade,
  received_at timestamptz not null default now(),
  decision text,
  private_state text,
  private_message_id text,
  -- The DM conversation the private reply opened (thread 'dm')
  dm_conversation_id uuid references public.conversations(id) on delete set null,
  public_variant text,
  public_state text,
  public_comment_id text unique,
  completed_at timestamptz
);

create index idx_meta_comment_replies_channel on public.meta_comment_replies (channel_id);

alter table public.meta_comment_replies enable row level security;
-- No policy, on purpose: see the header.

revoke all on table public.meta_comment_replies from public, anon, authenticated;
grant all on table public.meta_comment_replies to service_role;

-- Impersonation is read-only on every table (tests/access/table-guards.test.ts)
create trigger block_impersonated_writes before insert or update or delete on public.meta_comment_replies
  for each statement execute function public.block_impersonated_writes();
