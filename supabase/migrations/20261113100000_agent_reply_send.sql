-- ============================================
-- A DASHBOARD REPLY IS SENT, AND ONE THAT DID NOT REACH THE PATIENT LOOKS IT
-- (.scratch/agent-reply-decisions.md §2; .scratch/agent-reply-decisions-2.md)
-- ============================================
--
-- Until now a reply typed in the inbox was a row and nothing more: on
-- WhatsApp, Messenger and Instagram it never left. It now goes out through
-- the channel's transport (sendAgentMessage), and its row records the send
-- the way the bot's replies already do: metadata.send.state is 'sending'
-- when the row is written, then 'sent' with Meta's message id, or 'failed'
-- with a reason.
--
-- Three things in the database assumed "an agent row exists" means "the
-- patient has it". Two change here; one stays on purpose.
--
-- 1. THE NEEDS-A-PERSON MARK WAS CLEARED ON INSERT. A failed reply would
--    have made the banner's count drop while the patient got nothing. Now an
--    agent row that carries a send clears the mark only once its send is
--    'sent'. A row with no send (the website, where the visitor's browser
--    fetches the reply; a person at the clinic answering in the Page inbox,
--    which Meta's echo proves delivered) still clears it on insert.
--
-- 2. A FAILED SEND MARKS THE CONVERSATION, with its own reason,
--    'send_failed'. It is the same banner, inbox flag and counts as the
--    other reasons, with its own wording: the bot could not answer and
--    "go and answer" is one job; your answer did not send and "send it
--    again" is another. The reason replaces whatever cause was there (the
--    newest thing a person has to do), and the mark is set in this trigger,
--    in the same statement as the state, because the mark is what makes
--    sure a person sees the failure: it must not depend on a second call
--    that could fail on its own.
--
-- 3. AUTO-REPLY STILL TURNS OFF ON INSERT (sync_conversation_last_message,
--    unchanged), whether the send then works or not (decided 2026-11-08,
--    Decision 5): in almost every failure the bot cannot send either
--    (window, paused, disconnected), and the employee who just failed is
--    looking at the failed message.
--
-- THE STATUSES THAT ARRIVE BEFORE THEIR SEND IS RECORDED. WhatsApp can
-- accept a message and report its failure later, in a status webhook keyed
-- by the message id. That status can arrive before the send's own answer
-- has written the id onto our row (the race Messenger's echoes have).
-- meta_pending_statuses holds such a status by message id until the send
-- records the id; both sides write first and look second, so whichever comes
-- last finds the other. Meta's ids and our channel only: no person id, no
-- text. Service role only, like processed_meta_messages.
-- ============================================

-- --------------------------------------------
-- 1. The reason
-- --------------------------------------------
alter table public.conversations drop constraint if exists conversations_needs_human_reason_check;
alter table public.conversations
  add constraint conversations_needs_human_reason_check
  check (needs_human_reason in ('service_down', 'limit_reached', 'inactive', 'no_answer', 'send_failed'));

-- --------------------------------------------
-- 2. Insert: only a reply with no send to wait for settles the mark
-- --------------------------------------------
create or replace function public.clear_needs_human()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.role = 'agent' and (new.metadata is null or new.metadata -> 'send' is null) then
    update public.conversations
       set needs_human_since = null,
           needs_human_reason = null
     where id = new.conversation_id
       and needs_human_since is not null;
  end if;
  return new;
end;
$$;

-- --------------------------------------------
-- 3. Update: an agent reply's send settles the mark, or sets it
-- --------------------------------------------
create function public.agent_send_outcome()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  was text := old.metadata -> 'send' ->> 'state';
  now_state text := new.metadata -> 'send' ->> 'state';
begin
  if new.role <> 'agent' or now_state is not distinct from was then
    return new;
  end if;
  if now_state = 'sent' then
    update public.conversations
       set needs_human_since = null,
           needs_human_reason = null
     where id = new.conversation_id
       and needs_human_since is not null;
  elsif now_state = 'failed' then
    update public.conversations
       set needs_human_since = coalesce(needs_human_since, now()),
           needs_human_reason = 'send_failed'
     where id = new.conversation_id;
  end if;
  return new;
end;
$$;

revoke execute on function public.agent_send_outcome() from public, anon, authenticated;

create trigger messages_agent_send_outcome after update of metadata on public.messages
  for each row execute function public.agent_send_outcome();

-- --------------------------------------------
-- 4. A status that arrived before its send was recorded
-- --------------------------------------------
create table public.meta_pending_statuses (
  -- The outbound message id the status is about (a wamid), exactly as sent
  message_id text primary key,
  channel_id uuid not null references public.channels(id) on delete cascade,
  -- Meta's status: only 'failed' is held today
  status text not null,
  -- The status's error codes, never their text (which can quote the message)
  error_codes integer[] not null default '{}',
  received_at timestamptz not null default now()
);

create index idx_meta_pending_statuses_received on public.meta_pending_statuses (received_at);

alter table public.meta_pending_statuses enable row level security;
-- No policy, on purpose: see the header.

revoke all on table public.meta_pending_statuses from public, anon, authenticated;
grant all on table public.meta_pending_statuses to service_role;

-- Impersonation is read-only on every table (tests/access/table-guards.test.ts)
create trigger block_impersonated_writes before insert or update or delete on public.meta_pending_statuses
  for each statement execute function public.block_impersonated_writes();
