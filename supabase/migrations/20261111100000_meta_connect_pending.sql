-- ============================================
-- META CONNECT: the login in flight, and the token waiting for the clinic's pick
-- (.scratch/messenger-instagram-design.md §12)
-- ============================================
--
-- One row per Facebook Login for Business started from a client's channels
-- page. Two phases:
--
--   started   `state` set, no token. `state` is what Meta hands back to the
--             callback; it is bound here to the user who started the login,
--             the client and the flow (a reconnect names its channel), so a
--             token can only ever land on the client the login was started
--             for. Single use: the callback sets it to null as it reads it.
--   picking   the system-user token from the code exchange, and the accounts
--             the token can see (`options`: ids and names, never a token).
--             Meta returns every account ever granted, not the current pick
--             (run 3), so the clinic picks; only an id from `options` is
--             accepted.
--
-- The row is deleted on pick, on cancel, when the same user starts another
-- connect for the same client (a double click leaves no live token behind),
-- and once expired (`expires_at`: 10 minutes from the start, then 10 from the
-- callback). Expired rows are swept whenever a connect starts.
--
-- The token is a channel token in all but name, so the table is held like
-- channel_secrets: row level security on with NO policy, every privilege
-- revoked from anon and authenticated, service role only. Plaintext, like
-- every other token today: the encryption debt in §11 covers this table too.
-- ============================================

create table public.meta_connect_pending (
  id uuid primary key default gen_random_uuid(),
  -- The state sent to Meta; null once the callback has used it
  state text unique,
  user_id uuid not null references public.users(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  -- A reconnect: the channel being refreshed, which keeps its account
  channel_id uuid references public.channels(id) on delete cascade,
  locale text not null check (locale in ('ar', 'en')),
  access_token text,
  options jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index idx_meta_connect_pending_user_client on public.meta_connect_pending (user_id, client_id);
create index idx_meta_connect_pending_expires on public.meta_connect_pending (expires_at);

alter table public.meta_connect_pending enable row level security;
-- No policy, on purpose: see the header.

revoke all on table public.meta_connect_pending from public, anon, authenticated;
grant all on table public.meta_connect_pending to service_role;

-- Impersonation is read-only on every table (tests/access/table-guards.test.ts)
create trigger block_impersonated_writes before insert or update or delete on public.meta_connect_pending
  for each statement execute function public.block_impersonated_writes();
