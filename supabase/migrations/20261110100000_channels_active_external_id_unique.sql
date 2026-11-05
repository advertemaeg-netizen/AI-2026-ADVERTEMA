-- ============================================
-- ONE ACTIVE CHANNEL PER META ACCOUNT
-- (.scratch/messenger-instagram-design.md §12, decision 5)
-- ============================================
--
-- The Meta webhook finds a channel by (type, external_id): the WhatsApp
-- phone_number_id, the Page id, the Instagram account id. Nothing stopped two
-- ACTIVE rows carrying the same id, and when two match the lookup takes the
-- first. With connect flows that write channels from Meta's own answer, that
-- is a clinic's account delivered to another client: the same failure class
-- as merging two patients. The webhook's "active one first" rule handles a
-- duplicate; this index makes an active duplicate impossible.
--
-- Partial, on is_active, on purpose:
--   - a paused row may share the id with the live one (the WhatsApp
--     placeholder of 2026-10-02 beside the real channel, still on file);
--   - resuming that paused row while the other is active is refused (23505),
--     which is the point: two live channels for one account is the defect;
--   - external_id null (website channels) never conflicts.
-- Checked before writing: no active duplicates existed on 2026-11-05.
-- ============================================

create unique index channels_active_external_id_unique
  on public.channels (type, external_id)
  where is_active and external_id is not null;
