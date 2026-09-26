-- ============================================
-- CONVERSATIONS INBOX
-- ============================================

-- --------------------------------------------
-- 1. Last-message preview on conversations
--    (lets the inbox list render without a per-row messages query)
-- --------------------------------------------
alter table public.conversations
  add column if not exists last_message_preview text,
  add column if not exists last_message_role message_role;

update public.conversations c
   set last_message_preview = left(m.content, 200),
       last_message_role = m.role,
       last_message_at = m.created_at
  from (
    select distinct on (conversation_id) conversation_id, content, role, created_at
      from public.messages
     order by conversation_id, created_at desc
  ) m
 where m.conversation_id = c.id;

create or replace function public.sync_conversation_last_message()
returns trigger
security definer
set search_path = public
as $$
begin
  update public.conversations
     set last_message_at = new.created_at,
         last_message_preview = left(new.content, 200),
         last_message_role = new.role
   where id = new.conversation_id;
  return new;
end;
$$ language plpgsql;

create trigger messages_sync_conversation after insert on public.messages
  for each row execute function public.sync_conversation_last_message();

create index if not exists idx_conversations_assigned on public.conversations(assigned_to);

-- --------------------------------------------
-- 2. Visibility: team members only see conversations assigned to them;
--    super/org/client admins see every conversation of their clients
-- --------------------------------------------
create or replace function public.is_client_manager()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select public.user_role() in ('super_admin', 'org_admin', 'client_admin')
$$;

drop policy if exists "Users see conversations of their clients" on public.conversations;
drop policy if exists "Users update conversations of their clients" on public.conversations;

create policy "Users see conversations they handle"
  on public.conversations for select
  using (
    public.has_client_access(client_id)
    and (public.is_client_manager() or assigned_to = auth.uid())
  );

create policy "Users update conversations they handle"
  on public.conversations for update
  using (
    public.has_client_access(client_id)
    and (public.is_client_manager() or assigned_to = auth.uid())
  )
  with check (
    public.has_client_access(client_id)
    and (public.is_client_manager() or assigned_to = auth.uid())
  );

-- The messages select policy already checks `exists (select from conversations)`,
-- which runs under the conversations RLS above, so it inherits the restriction.

-- Dashboard users may only write agent messages as themselves.
-- (Visitor + AI messages are written server-side with the secret key.)
drop policy if exists "Users insert messages in accessible conversations" on public.messages;

create policy "Users send agent messages in conversations they handle"
  on public.messages for insert
  with check (
    role = 'agent'
    and sender_id = auth.uid()
    and exists (select 1 from public.conversations c where c.id = conversation_id)
  );

-- --------------------------------------------
-- 3. Team of a client: who a conversation can be assigned to, and whose
--    names to show on agent messages. users RLS hides other users from
--    client admins / team members, hence security definer.
-- --------------------------------------------
create or replace function public.client_team(check_client_id uuid)
returns table (id uuid, full_name text, email text, role user_role)
language sql
security definer
stable
set search_path = public
as $$
  select u.id, u.full_name, u.email, u.role
    from public.users u
    join public.clients c on c.id = check_client_id
   where public.has_client_access(check_client_id)
     and u.organization_id = c.organization_id
     and (
       u.role = 'org_admin'
       or exists (
         select 1 from public.client_members cm
          where cm.client_id = c.id and cm.user_id = u.id
       )
     )
   order by u.full_name nulls last, u.email
$$;

revoke execute on function public.client_team(uuid) from public, anon;
grant execute on function public.client_team(uuid) to authenticated;

-- --------------------------------------------
-- 4. Realtime
-- --------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'messages'
  ) then
    alter publication supabase_realtime add table public.messages;
  end if;

  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'conversations'
  ) then
    alter publication supabase_realtime add table public.conversations;
  end if;
end $$;
