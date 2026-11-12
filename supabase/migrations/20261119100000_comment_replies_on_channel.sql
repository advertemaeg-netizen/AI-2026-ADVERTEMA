-- ============================================
-- THE COMMENT-REPLIES SWITCH MOVES TO THE CHANNEL, with who changed it
-- (decided 2026-11-08; built 2026-11-12)
-- ============================================
--
-- Until now the switch was clients.comment_replies_enabled (20261109100000),
-- with no control anywhere in the dashboard: only a script set it. The App
-- Review descriptions present comment replies as something a business has,
-- so a business must be able to turn them on and off itself.
--
-- On the channel, because comments arrive per channel: a clinic may want
-- them on its Instagram and off its Facebook Page. Only a Facebook or
-- Instagram channel can have it on (the check below).
--
-- WHO AND WHEN are stamped by the database, never taken from the request:
-- the trigger writes auth.uid() and now() whenever the value changes, and
-- keeps the previous stamp on any other update, so neither can be set or
-- forged through the API. A change made with the service role (a script)
-- has no user: changed_by is null, and the dashboard shows no line.
--
-- Who may change it: whoever may update the channel ("Client admins manage
-- channels": super, org and client admins with access to the client). Team
-- members cannot. RLS is per row (the memory note on clients applies here
-- too): the switch is meant to be the manager's, so that is the rule.
--
-- The value each Facebook and Instagram channel had through its client is
-- copied over, so nothing changes for anyone on deploy. Its stamp starts
-- empty.
--
-- THE CLIENT COLUMN STAYS, in this migration (the owner, 2026-11-12). The
-- code deployed when this is applied still reads clients.comment_replies_
-- enabled, inside the Meta webhook's one channel lookup: dropping it here
-- would fail that lookup for every Meta delivery (WhatsApp, Messenger,
-- Instagram, not only comments) until the new code is live. It is dropped
-- by 20261120100000, applied after the code that reads the channel's
-- switch is deployed. Until then the client column is read by nothing new
-- and changed by nothing.
--
-- channels is readable column by column (20261008100000): the new columns
-- are added to that grant.
-- ============================================

alter table public.channels
  add column comment_replies_enabled boolean not null default false,
  add column comment_replies_changed_by uuid references public.users(id) on delete set null,
  add column comment_replies_changed_at timestamptz,
  add constraint channels_comment_replies_meta_only
    check (not comment_replies_enabled or type in ('facebook', 'instagram'));

update public.channels c
   set comment_replies_enabled = cl.comment_replies_enabled
  from public.clients cl
 where cl.id = c.client_id
   and c.type in ('facebook', 'instagram')
   and cl.comment_replies_enabled;

create or replace function public.stamp_comment_replies_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    new.comment_replies_changed_by := case when new.comment_replies_enabled then auth.uid() end;
    new.comment_replies_changed_at := case when new.comment_replies_enabled then now() end;
  elsif new.comment_replies_enabled is distinct from old.comment_replies_enabled then
    new.comment_replies_changed_by := auth.uid();
    new.comment_replies_changed_at := now();
  else
    new.comment_replies_changed_by := old.comment_replies_changed_by;
    new.comment_replies_changed_at := old.comment_replies_changed_at;
  end if;
  return new;
end;
$$;

create trigger channels_stamp_comment_replies
  before insert or update on public.channels
  for each row execute function public.stamp_comment_replies_change();

grant select (comment_replies_enabled, comment_replies_changed_by, comment_replies_changed_at)
  on public.channels to authenticated;

