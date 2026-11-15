-- ============================================
-- MESSAGES IN THE ORDER THEY WERE WRITTEN (2026-11-15)
--
-- APPLY BEFORE DEPLOYING THE CODE THAT READS IT (moved into migrations/
-- 2026-11-15, on branch ordering-seq, so the tree checked is the tree
-- deployed). Deployed code (c91606b) ignores the new column, so this applies
-- first, safely; the code after it calls insert_bot_reply() and orders by
-- seq, and fails without it. update.sh refuses to build until it is applied.
--
-- THE DEFECT (.scratch/coexistence-design.md, Task 2; AGENTS.md): the bot
-- answered whichever row sorted last by created_at, not the message it was
-- called for. created_at is now(): the time the writing transaction began,
-- not the order rows were committed in. And two runs on one conversation
-- (two messages a second apart; soon, a reply from the business's own
-- phone) could each answer, the older one on top of the newer.
--
-- 1. messages.seq: one number per row, taken under a per-conversation lock
--    (pg_advisory_xact_lock, held to commit), so within a conversation seq
--    is the order rows were committed in. No ties, no clock. Set by the
--    trigger alone: a value sent with an insert is overwritten, and an
--    update cannot change it.
-- 2. insert_bot_reply(): the bot's reply is written only if nothing newer
--    has arrived since the message it answers: a visitor's message that will
--    get its own answer, or a person's reply. Check and insert under the same
--    lock, so nothing can land between them. Answers the new row's id, or
--    null with the reason. Never raises for a superseded reply: in the test
--    harness a refused statement drops the connection (pglite#958).
-- ============================================

-- 1. The column, numbered for every existing row in the order the app read them
create sequence if not exists public.messages_seq_seq as bigint;

alter table public.messages add column if not exists seq bigint;

with numbered as (
  select id, row_number() over (order by created_at, id) as n from public.messages
)
update public.messages m set seq = numbered.n from numbered where m.id = numbered.id and m.seq is null;

select setval('public.messages_seq_seq', greatest((select max(seq) from public.messages), 1), (select max(seq) from public.messages) is not null);

alter table public.messages alter column seq set not null;
alter table public.messages add constraint messages_seq_unique unique (seq);
create index if not exists messages_conversation_seq_idx on public.messages (conversation_id, seq);

-- The trigger's: numbered under the conversation's lock, never changed after
create or replace function public.messages_assign_seq()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    perform pg_advisory_xact_lock(hashtextextended('messages:' || new.conversation_id::text, 0));
    new.seq := nextval('public.messages_seq_seq');
  else
    new.seq := old.seq;
  end if;
  return new;
end;
$$;

revoke execute on function public.messages_assign_seq() from public, anon, authenticated;

drop trigger if exists messages_assign_seq on public.messages;
create trigger messages_assign_seq before insert or update on public.messages
  for each row execute function public.messages_assign_seq();

-- 2. The bot's reply, only while it is still the answer
--
-- Newer rows that withhold it, after the answered message:
--   'visitor'  a visitor's message the pipeline will answer itself: role
--              'user', not a reaction (stored, never answered) and not a
--              placeholder for a message with nothing to read (the
--              transport's notice answers those, not the pipeline);
--   'person'   anyone's reply that is not the bot's: role 'agent' (the
--              dashboard, the Page inbox, later the business's phone).
-- The bot's own rows (role 'assistant') never withhold.
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
     and (
       m.role = 'agent'
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
