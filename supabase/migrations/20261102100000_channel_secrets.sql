-- ============================================
-- CHANNEL SECRETS: the token that sends messages as the client, in a table
-- nothing client-facing can read (.scratch/whatsapp-send-design.md §1)
-- ============================================
--
-- channels.credentials exists and nothing reads or writes it; it stays
-- unused. channels is read by the dashboard, and a `select *` anywhere in
-- client-facing code would carry an access token to the browser. The
-- column-level grant of 20261008 hides that one column today, but a secret
-- that depends on a grant list being maintained is a secret waiting for the
-- column someone adds without it. So the token lives in its own table:
--
--   - row level security on, with NO policy. Not a restricted policy: none.
--     Only the service role, which bypasses RLS, reaches it, and only on the
--     server (the webhook, the send path).
--   - every table privilege revoked from anon and authenticated, so a read
--     is refused outright (42501) rather than answered with no rows. In this
--     project the default privileges grant all on new tables to those roles
--     (Supabase does the same), so the revoke is what makes the table
--     unreadable, and tests/access/channel-secrets.test.ts fails the day it
--     is dropped.
--   - never selected in anything that renders for a client, an admin or a
--     super admin; never logged, never returned from an API route, never in
--     an error message. The access test guards the first; the rest is code
--     review.
--
-- The phone_number_id stays in channels.external_id: the webhook looks the
-- channel up there and that works.
-- ============================================

create table public.channel_secrets (
  channel_id uuid primary key references public.channels(id) on delete cascade,
  -- The channel's access token (WhatsApp: the system user token for the WABA)
  access_token text not null,
  -- The WhatsApp Business Account the channel's number belongs to (subscribed_apps is called on it)
  waba_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.channel_secrets enable row level security;
-- No policy, on purpose: see the header.

revoke all on table public.channel_secrets from public, anon, authenticated;
grant all on table public.channel_secrets to service_role;

create trigger channel_secrets_updated_at before update on public.channel_secrets
  for each row execute function public.update_updated_at();

-- Impersonation is read-only on every table (tests/access/table-guards.test.ts)
create trigger block_impersonated_writes before insert or update or delete on public.channel_secrets
  for each statement execute function public.block_impersonated_writes();
