-- ============================================
-- LAUNCH AUDIT FIXES (see AUDIT.md)
-- ============================================

-- --------------------------------------------
-- 1. Channel credentials never reach the API.
--    "Users see channels of their clients" lets every member of a client
--    (team members too) read channels, which is needed to show where a
--    conversation came from. That included `credentials` (platform tokens).
--    The app never reads it through the API, so logged-in users get every
--    column but that one; the service role and security definer functions
--    are unaffected. A new channels column must be added to this grant.
-- --------------------------------------------
revoke select on public.channels from anon, authenticated;
grant select (id, client_id, type, name, external_id, webhook_url, is_active, created_at, updated_at)
  on public.channels to authenticated;

-- --------------------------------------------
-- 2. Only client managers delete leads.
--    "Users manage leads of their clients" (FOR ALL) let team members delete
--    leads straight through the API; the app only hid the button.
-- --------------------------------------------
drop policy if exists "Users manage leads of their clients" on public.leads;

create policy "Users add leads to their clients"
  on public.leads for insert
  with check (public.has_client_access(client_id));

create policy "Users update leads of their clients"
  on public.leads for update
  using (public.has_client_access(client_id))
  with check (public.has_client_access(client_id));

create policy "Admins delete leads of their clients"
  on public.leads for delete
  using (public.is_client_manager() and public.has_client_access(client_id));

-- --------------------------------------------
-- 3. Team seats are enforced when an invite is accepted.
--    createInvite counts seats (pending invites included), but invites can
--    also be inserted straight through the API, so the plan limits were
--    never checked in the database. Joining the organization needs a free
--    agency seat; joining a client needs a free seat on the client's plan.
--    Only a reached limit refuses; an inactive subscription doesn't lock
--    people out of an invite they already have.
-- --------------------------------------------
create or replace function public.accept_invite(code text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  inv record;
  me record;
  auth_email text;
  seats jsonb;
begin
  if auth.uid() is null then
    return 'not_found';
  end if;

  select * into inv from public.organization_invites where invite_code = code for update;
  if not found then return 'not_found'; end if;
  if inv.accepted_at is not null then return 'already_accepted'; end if;
  if inv.expires_at <= now() then return 'expired'; end if;

  select email into auth_email from auth.users where id = auth.uid();
  if lower(auth_email) <> lower(inv.email) then return 'email_mismatch'; end if;

  select * into me from public.users where id = auth.uid();
  if me.id is not null and me.organization_id is not null and me.organization_id <> inv.organization_id then
    return 'other_organization';
  end if;

  if me.id is null or me.organization_id is null then
    seats := public.subscription_limit_status(inv.organization_id, 'team_members');
    if seats->>'reason' = 'limit_reached' then return 'limit_reached'; end if;
  end if;

  if inv.client_id is not null
     and not exists (
       select 1 from public.client_members cm
        where cm.client_id = inv.client_id and cm.user_id = auth.uid()
     ) then
    seats := public.client_limit_status(inv.client_id, 'team_members');
    if seats->>'reason' = 'limit_reached' then return 'limit_reached'; end if;
  end if;

  if me.id is null then
    insert into public.users (id, email, full_name, role, organization_id)
    values (auth.uid(), auth_email, coalesce(inv.invited_name, ''), inv.role, inv.organization_id);
  else
    update public.users
       set organization_id = inv.organization_id,
           role = case when public.role_rank(inv.role) > public.role_rank(me.role) then inv.role else me.role end,
           full_name = coalesce(nullif(full_name, ''), inv.invited_name, '')
     where id = auth.uid();
  end if;

  if inv.client_id is not null then
    insert into public.client_members (client_id, user_id, role)
    values (inv.client_id, auth.uid(), inv.role)
    on conflict (client_id, user_id) do update set role = excluded.role;
  end if;

  update public.organization_invites set accepted_at = now() where id = inv.id;
  return 'ok';
end;
$$;

revoke execute on function public.accept_invite(text) from public, anon;
grant execute on function public.accept_invite(text) to authenticated;

-- --------------------------------------------
-- 4. Indexes on hot lookups and on foreign keys that deletes must scan.
--    Deleting a conversation cascades to its messages, and every deleted
--    message sets leads.source_message_id to null: without an index that
--    is a full scan of leads per message. Same for users → messages.
-- --------------------------------------------
create index if not exists idx_leads_source_message on public.leads(source_message_id)
  where source_message_id is not null;
create index if not exists idx_leads_assigned_to on public.leads(assigned_to)
  where assigned_to is not null;
create index if not exists idx_messages_sender on public.messages(sender_id)
  where sender_id is not null;
create index if not exists idx_lead_events_actor on public.lead_events(actor_id)
  where actor_id is not null;
create index if not exists idx_conversations_channel on public.conversations(channel_id);
-- The inbox: one client's conversations, latest first
create index if not exists idx_conversations_client_last_message
  on public.conversations(client_id, last_message_at desc);
create index if not exists idx_channels_client on public.channels(client_id);
create index if not exists idx_users_organization on public.users(organization_id);
create index if not exists idx_client_members_user on public.client_members(user_id);
create index if not exists idx_organization_invites_organization on public.organization_invites(organization_id);
