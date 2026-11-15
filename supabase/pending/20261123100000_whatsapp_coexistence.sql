-- ============================================
-- WHATSAPP COEXISTENCE: THE SCHEMA (2026-11-15, branch coexistence)
--
-- WAITING FOR: nothing in production reads or writes any of it; the code
-- that does is on branch coexistence, behind META_WHATSAPP_COEXISTENCE (off).
-- Additive only: deployed code is unaffected by every statement below. It
-- may be applied before that code ships, and must be (the code selects the
-- new columns). The four webhook fields stay unsubscribed until Meta's App
-- Review is through (the owner, 2026-11-15).
--
-- Meta's spec: developers.facebook.com/documentation/business-messaging/
-- whatsapp/embedded-signup/onboarding-business-app-users/
-- The design: .scratch/coexistence-design.md, Task 3.
--
-- 1. channels: a coexistence channel is told apart, and carries the state of
--    its two one-shot imports (history, contacts), read by its card.
-- 2. messages: where an outbound message came from (sent_from), set by a
--    trigger so no existing writer changes; imported history marked
--    (imported, sent_at) and kept out of everything live: the bot's history,
--    insert_bot_reply's check, the 24-hour window, the hand-off triggers.
-- 3. whatsapp_history_chunks, whatsapp_contacts: the raw import and the
--    business's contacts. Service role only.
-- ============================================

-- --------------------------------------------
-- 1. The channel
-- --------------------------------------------
alter table public.channels
  -- 'cloud_api': a number on the Cloud API alone (every channel until now).
  -- 'coexistence': a number still on the WhatsApp Business app too; the
  -- business may answer from its phone, and Meta sends us what it sent
  add column whatsapp_mode text not null default 'cloud_api'
    check (whatsapp_mode in ('cloud_api', 'coexistence')),
  add column coexistence_onboarded_at timestamptz,
  -- History and contacts can each be requested ONCE, within 24 hours of
  -- onboarding (Meta). The states, in order:
  --   not_requested   onboarded, not asked yet
  --   requested       Meta accepted the request (not the same as shared)
  --   request_failed  the request did not go through; may be retried in the window
  --   receiving       chunks are arriving (history only)
  --   complete        progress reached 100 (history) / the request was accepted (contacts)
  --   declined        the business chose not to share history (error 2593109)
  --   window_missed   24 hours passed without an accepted request
  add column history_sync text
    check (history_sync in ('not_requested', 'requested', 'request_failed', 'receiving', 'complete', 'declined', 'window_missed')),
  add column history_sync_progress smallint check (history_sync_progress between 0 and 100),
  add column history_imported integer not null default 0,
  add column contacts_sync text
    check (contacts_sync in ('not_requested', 'requested', 'request_failed', 'complete', 'window_missed')),
  -- Meta's ACCOUNT_OFFBOARDED (a device change or re-registration): sends
  -- paused until ACCOUNT_RECONNECTED. Never set by us for any other reason
  add column coexistence_offboarded_at timestamptz;

alter table public.channels
  add constraint channels_coexistence_is_whatsapp
    check (whatsapp_mode = 'cloud_api' or type = 'whatsapp'),
  add constraint channels_sync_only_coexistence
    check (whatsapp_mode = 'coexistence' or (history_sync is null and contacts_sync is null));

-- The column grant on channels names its columns (20261008100000): the card reads these
grant select (whatsapp_mode, coexistence_onboarded_at, history_sync, history_sync_progress, history_imported, contacts_sync, coexistence_offboarded_at)
  on public.channels to authenticated;

-- --------------------------------------------
-- 2. The message
-- --------------------------------------------
alter table public.messages
  -- Who sent an outbound row (role 'assistant' or 'agent'); NULL otherwise:
  --   bot          the assistant (role 'assistant')
  --   inbox        a person at the business, from our dashboard (role 'agent', sender_id)
  --   meta_inbox   a person at the business, from Meta's Page inbox (a Messenger/Instagram echo)
  --   phone        the business's own WhatsApp Business app (smb_message_echoes, or history)
  add column sent_from text check (sent_from in ('bot', 'inbox', 'meta_inbox', 'phone')),
  -- Brought in by the one-shot history sync: a record of before onboarding,
  -- never live. sent_at is Meta's timestamp for it (created_at is the import)
  add column imported boolean not null default false,
  add column sent_at timestamptz;

-- A Page-inbox echo is marked as one (inbound.ts); every other agent row was
-- written from our dashboard, its sender since deleted or not
update public.messages set sent_from = case
  when role = 'assistant' then 'bot'
  when metadata ->> 'echo' = 'true' then 'meta_inbox'
  else 'inbox'
end
where sent_from is null and role in ('assistant', 'agent');

alter table public.messages
  add constraint messages_sent_from_role
    check ((role in ('assistant', 'agent')) = (sent_from is not null)),
  add constraint messages_imported_sent_at
    check (not imported or sent_at is not null);

-- An imported message once per conversation, however often Meta resends its chunk
create unique index messages_imported_once on public.messages (conversation_id, (metadata ->> 'wamid')) where imported;

-- sent_from for every writer that does not name it, so none of them changes
create or replace function public.messages_default_sent_from()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.sent_from is null and new.role in ('assistant', 'agent') then
    new.sent_from := case
      when new.role = 'assistant' then 'bot'
      when new.metadata ->> 'echo' = 'true' then 'meta_inbox'
      else 'inbox'
    end;
  end if;
  return new;
end;
$$;

revoke execute on function public.messages_default_sent_from() from public, anon, authenticated;

drop trigger if exists messages_default_sent_from on public.messages;
create trigger messages_default_sent_from before insert on public.messages
  for each row execute function public.messages_default_sent_from();

-- An imported row is history, not a turn: it does not move the inbox's
-- "last message", hand the conversation to people, clear the needs-a-person
-- mark, or reach the website widget. Each trigger returns early for it.
create or replace function public.sync_conversation_last_message()
returns trigger
security definer
set search_path = public
as $$
begin
  if new.imported then
    -- Only fills an empty inbox line: a past message never overwrites a live one
    update public.conversations
       set last_message_at = new.sent_at,
           last_message_preview = left(new.content, 200),
           last_message_role = new.role
     where id = new.conversation_id
       and (last_message_at is null or last_message_at < new.sent_at);
    return new;
  end if;
  update public.conversations
     set last_message_at = new.created_at,
         last_message_preview = left(new.content, 200),
         last_message_role = new.role,
         auto_reply_enabled = case when new.role = 'agent' then false else auto_reply_enabled end
   where id = new.conversation_id;
  return new;
end;
$$ language plpgsql;

create or replace function public.clear_needs_human()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.imported then
    return new;
  end if;
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

create or replace function public.broadcast_agent_message()
returns trigger
security definer
set search_path = public
as $$
declare
  conv record;
begin
  if new.role <> 'agent' or new.imported then
    return new;
  end if;

  select c.id, c.contact_identifier, ch.type
    into conv
    from public.conversations c
    join public.channels ch on ch.id = c.channel_id
   where c.id = new.conversation_id;

  if conv.id is null or conv.type <> 'website' or conv.contact_identifier is null then
    return new;
  end if;

  perform realtime.send(
    jsonb_build_object('id', new.id, 'content', new.content, 'created_at', new.created_at),
    'agent_message',
    'widget:' || conv.id || ':' || conv.contact_identifier,
    false
  );

  return new;
exception when others then
  -- Never lose the agent's message because the broadcast failed; the widget
  -- also catches up over HTTP when it (re)connects
  raise warning 'broadcast_agent_message failed: %', sqlerrm;
  return new;
end;
$$ language plpgsql;

-- insert_bot_reply (20261121100000), with imported history left out of the
-- check, and the business's own phone named: a reply from the phone is a
-- person's reply (role 'agent', sent_from 'phone') and withholds the bot's.
create or replace function public.insert_bot_reply(
  p_conversation_id uuid,
  p_answers uuid,
  p_content text,
  p_metadata jsonb
)
returns table (id uuid, withheld text)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  answered_seq bigint;
  newer text;
  new_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('messages:' || p_conversation_id::text, 0));

  select m.seq into answered_seq from public.messages m where m.id = p_answers and m.conversation_id = p_conversation_id;
  if answered_seq is null then
    return query select null::uuid, 'not_found'::text;
    return;
  end if;

  select case when m.role = 'agent' then 'person' else 'visitor' end into newer
    from public.messages m
   where m.conversation_id = p_conversation_id
     and m.seq > answered_seq
     and not m.imported
     and (
       m.role = 'agent'  -- the dashboard, a Page inbox, or the business's phone
       or (
         m.role = 'user'
         and coalesce(m.metadata ->> 'whatsapp_type', m.metadata ->> 'messenger_type', m.metadata ->> 'instagram_type', '') <> 'reaction'
         and coalesce((m.metadata ->> 'placeholder')::boolean, false) = false
       )
     )
   order by (m.role = 'agent') desc, m.seq
   limit 1;
  if newer is not null then
    return query select null::uuid, newer;
    return;
  end if;

  insert into public.messages (conversation_id, role, content, metadata)
  values (p_conversation_id, 'assistant', p_content, coalesce(p_metadata, '{}'::jsonb))
  returning messages.id into new_id;
  return query select new_id, null::text;
end;
$$;

revoke execute on function public.insert_bot_reply(uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.insert_bot_reply(uuid, uuid, text, jsonb) to service_role;

-- --------------------------------------------
-- 3. The imports
-- --------------------------------------------

-- Each `history` webhook as Meta sent it, stored before anything reads it:
-- one can describe thousands of messages (Meta), so it is captured first
-- and imported from here, as often as needed. Deleted once imported.
create table public.whatsapp_history_chunks (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references public.channels(id) on delete cascade,
  phase smallint,
  chunk_order integer,
  progress smallint,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  imported_at timestamptz
);

create index idx_whatsapp_history_chunks_pending on public.whatsapp_history_chunks (channel_id) where imported_at is null;

alter table public.whatsapp_history_chunks enable row level security;
-- No policy, on purpose: message content, the server's alone
revoke all on table public.whatsapp_history_chunks from public, anon, authenticated;
grant all on table public.whatsapp_history_chunks to service_role;
create trigger block_impersonated_writes before insert or update or delete on public.whatsapp_history_chunks
  for each statement execute function public.block_impersonated_writes();

-- The business's WhatsApp contacts (smb_app_state_sync): names for its
-- conversations, nothing else. Never shown to the bot, never sent anywhere
create table public.whatsapp_contacts (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references public.channels(id) on delete cascade,
  -- Meta's: the number, and the user id that replaces it for username users
  phone_number text,
  user_id text,
  full_name text,
  first_name text,
  updated_at timestamptz not null default now(),
  check (phone_number is not null or user_id is not null)
);

create unique index whatsapp_contacts_by_phone on public.whatsapp_contacts (channel_id, phone_number) where phone_number is not null;
create unique index whatsapp_contacts_by_user on public.whatsapp_contacts (channel_id, user_id) where phone_number is null;

alter table public.whatsapp_contacts enable row level security;
revoke all on table public.whatsapp_contacts from public, anon, authenticated;
grant all on table public.whatsapp_contacts to service_role;
create trigger block_impersonated_writes before insert or update or delete on public.whatsapp_contacts
  for each statement execute function public.block_impersonated_writes();

-- --------------------------------------------
-- 4. Analytics: imported history is not a response time or a busy hour.
--    Its created_at is the import's moment, which would put 180 days of a
--    business's past into one afternoon. The two functions as
--    20261117100000 left them, with imported rows left out.
-- --------------------------------------------
create or replace function public.get_response_time_stats(
  p_client_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
returns table (
  conversations bigint,
  responded bigint,
  avg_seconds numeric,
  median_seconds numeric,
  agent_responded bigint,
  agent_avg_seconds numeric
)
language sql
stable
security invoker
set search_path = public
as $$
  with conv as (
    select c.id
      from public.conversations c
     where c.created_at >= p_from and c.created_at < p_to
       and (p_client_id is null or c.client_id = p_client_id)
       and c.thread <> 'comments'
  ),
  firsts as (
    select conv.id,
           fu.first_user,
           (select min(m.created_at) from public.messages m
             where m.conversation_id = conv.id and not m.imported and m.role in ('assistant', 'agent')
               and m.created_at >= fu.first_user) as first_reply,
           (select min(m.created_at) from public.messages m
             where m.conversation_id = conv.id and not m.imported and m.role = 'agent'
               and m.created_at >= fu.first_user) as first_agent
      from conv
      cross join lateral (
        select min(m.created_at) as first_user
          from public.messages m
         where m.conversation_id = conv.id and not m.imported and m.role = 'user'
      ) fu
     where fu.first_user is not null
  )
  select
    count(*),
    count(first_reply),
    round(avg(extract(epoch from first_reply - first_user))::numeric, 1),
    round((percentile_cont(0.5) within group (order by extract(epoch from first_reply - first_user)))::numeric, 1),
    count(first_agent),
    round(avg(extract(epoch from first_agent - first_user))::numeric, 1)
  from firsts
$$;

create or replace function public.get_peak_hours(
  p_client_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
returns table (hour int, messages bigint)
language sql
stable
security invoker
set search_path = public
as $$
  with counts as (
    select extract(hour from m.created_at at time zone 'Africa/Cairo')::int as hour, count(*) as n
      from public.messages m
      join public.conversations c on c.id = m.conversation_id
     where m.role = 'user'
       and not m.imported
       and m.created_at >= p_from and m.created_at < p_to
       and (p_client_id is null or c.client_id = p_client_id)
       and c.thread <> 'comments'
     group by 1
  )
  select h.hour, coalesce(counts.n, 0)
    from generate_series(0, 23) as h(hour)
    left join counts using (hour)
   order by h.hour
$$;
