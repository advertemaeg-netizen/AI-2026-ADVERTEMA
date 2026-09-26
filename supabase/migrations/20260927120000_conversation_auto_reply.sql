-- ============================================
-- Human handoff: once an agent replies manually, the AI stops auto-replying
-- in that conversation (until someone turns it back on).
-- ============================================

alter table public.conversations
  add column if not exists auto_reply_enabled boolean not null default true;

-- Conversations an agent has already answered start handed off
update public.conversations c
   set auto_reply_enabled = false
 where exists (
   select 1 from public.messages m
    where m.conversation_id = c.id and m.role = 'agent'
 );

-- Extend the existing per-message trigger so the switch-off is atomic with
-- the agent message insert, whichever code path wrote it
create or replace function public.sync_conversation_last_message()
returns trigger
security definer
set search_path = public
as $$
begin
  update public.conversations
     set last_message_at = new.created_at,
         last_message_preview = left(new.content, 200),
         last_message_role = new.role,
         auto_reply_enabled = case when new.role = 'agent' then false else auto_reply_enabled end
   where id = new.conversation_id;
  return new;
end;
$$ language plpgsql;
