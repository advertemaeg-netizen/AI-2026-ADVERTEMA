-- ============================================
-- Push human agent replies to the website widget over Realtime broadcast.
-- Visitors are anonymous, so they can't use postgres_changes (RLS); instead
-- each agent message is broadcast on a public topic that embeds the
-- conversation id and the visitor's random id — only their browser knows it.
-- ============================================

create or replace function public.broadcast_agent_message()
returns trigger
security definer
set search_path = public
as $$
declare
  conv record;
begin
  if new.role <> 'agent' then
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

create trigger messages_broadcast_agent after insert on public.messages
  for each row execute function public.broadcast_agent_message();
