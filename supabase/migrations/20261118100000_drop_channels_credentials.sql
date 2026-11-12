-- ============================================
-- channels.credentials, dropped
-- ============================================
--
-- The column from the initial schema, never read or written by the app:
-- tokens live in channel_secrets (20261102100000), which nothing
-- client-facing can read. It survived only because the column grant of
-- 20261008 hid it, and a secret column guarded by a grant list is a column
-- waiting for someone to widen the list. Checked on production on
-- 2026-11-12 before this was written: two rows held anything, both
-- {"demo": true} from scripts/seed-demo.ts, no tokens. That marker is gone
-- from the script in the same commit.
--
-- The grant on channels to authenticated names its columns, and this one
-- was never among them, so nothing about it changes.

alter table public.channels drop column credentials;
