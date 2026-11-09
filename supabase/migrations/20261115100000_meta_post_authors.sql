-- ============================================
-- WHO WROTE A FACEBOOK POST: CACHED
-- (.scratch/facebook-comments-brief.md §2.3; decided 2026-11-06)
-- ============================================
--
-- We never reply on a post that is not the clinic's own. A Page's feed
-- carries other people's posts to the Page, and their post ids start with the
-- Page's id as well, so only the post's author decides: one Graph call
-- (GET /{post-id}?fields=from), made once per post, because a post's author
-- never changes. This holds the answer.
--
-- Only a definite answer is stored. A call that failed stores nothing, the
-- comment is not answered (unknown is never ours), and the next comment on
-- that post asks again.
--
-- Meta's ids and our channel only: no person id, no text. Service role only,
-- like meta_comment_replies.
-- ============================================

create table public.meta_post_authors (
  -- The post's id exactly as the webhook's post_id carries it (<page>_<post>)
  post_id text primary key,
  channel_id uuid not null references public.channels(id) on delete cascade,
  -- Written by the Page itself: only these posts' comments are answered
  page_owned boolean not null,
  checked_at timestamptz not null default now()
);

create index idx_meta_post_authors_channel on public.meta_post_authors (channel_id);

alter table public.meta_post_authors enable row level security;
-- No policy, on purpose: see the header.

revoke all on table public.meta_post_authors from public, anon, authenticated;
grant all on table public.meta_post_authors to service_role;

-- Impersonation is read-only on every table (tests/access/table-guards.test.ts)
create trigger block_impersonated_writes before insert or update or delete on public.meta_post_authors
  for each statement execute function public.block_impersonated_writes();
