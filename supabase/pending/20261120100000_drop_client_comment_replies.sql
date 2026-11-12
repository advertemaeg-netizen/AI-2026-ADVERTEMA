-- ============================================
-- clients.comment_replies_enabled, dropped
-- ============================================
--
-- WAITING FOR: the code that reads the switch from the channel
-- (20261119100000) to be DEPLOYED. Applied before that, the deployed
-- webhook's channel lookup selects this column, fails, and every Meta
-- delivery (WhatsApp, Messenger, Instagram) goes unanswered until the
-- deploy. Moved into migrations/ only after the deploy is confirmed.
--
-- Since 20261119100000 the switch is on each Facebook and Instagram
-- channel, with who changed it. This column was copied from there and then
-- read by nothing: one switch, in one place. It also closes the gap the
-- 2026-11-08 note recorded, that an admin could set it through the API.

alter table public.clients drop column comment_replies_enabled;
