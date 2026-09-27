-- ============================================
-- CLIENT TEAM SEATS IN THE DATABASE (AUDIT.md I4)
-- ============================================
-- "Admins manage client members" lets admins add (or move) members of
-- their organization to their clients straight through the API, which
-- skipped the client plan's team seat limit that createInvite and
-- accept_invite check. Every new seat now goes through this trigger.
--
-- Same rule as accept_invite: only a reached limit refuses; an inactive
-- subscription doesn't. A row that already exists for (client, user) takes
-- no new seat, so accept_invite's "on conflict do update" (a role change)
-- still works at the limit.

create or replace function public.enforce_client_seat_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status jsonb;
begin
  if tg_op = 'UPDATE' and new.client_id is not distinct from old.client_id then
    return new;
  end if;

  if exists (
    select 1 from public.client_members cm
     where cm.client_id = new.client_id and cm.user_id = new.user_id
  ) then
    return new;
  end if;

  v_status := public.client_limit_status(new.client_id, 'team_members');
  if v_status->>'reason' = 'limit_reached' then
    raise exception 'subscription_limit:team_members'
      using errcode = 'P0001', hint = 'limit_reached';
  end if;
  return new;
end;
$$;

revoke execute on function public.enforce_client_seat_limit() from public, anon, authenticated;

create trigger client_members_enforce_limit
  before insert or update of client_id on public.client_members
  for each row execute function public.enforce_client_seat_limit();

-- Moving a member between clients must recount both; the existing usage
-- trigger only runs on insert / delete
create or replace function public.sync_client_members_move()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.refresh_client_usage(old.client_id);
  perform public.refresh_client_usage(new.client_id);
  return null;
end;
$$;

revoke execute on function public.sync_client_members_move() from public, anon, authenticated;

create trigger client_members_sync_usage_move
  after update of client_id on public.client_members
  for each row
  when (old.client_id is distinct from new.client_id)
  execute function public.sync_client_members_move();
