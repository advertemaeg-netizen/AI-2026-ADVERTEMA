-- ============================================
-- CHANNEL SEATS: checked when a channel is turned on, not only when it is added
-- ============================================
--
-- Since 20261106 a paused channel is not a seat in use, but the plan's limit
-- was still only enforced `before insert` (channels_enforce_limit,
-- 20261006). Pausing a channel, adding another, and turning the first back on
-- left a client over its plan with no error: measured in the test database
-- on 2026-11-05, three active channels on a two-channel plan.
--
-- It matters now because a channel connected through Meta is created PAUSED
-- and turned on later from its card: that update is the moment it takes a
-- seat, so that is where the limit is enforced. The same function as on
-- insert, so the error the app maps is the same (subscription_limit:channels,
-- hint limit_reached or inactive). The row being turned on is still inactive
-- when the check runs, so it is not counted against itself.
-- ============================================

create trigger channels_enforce_limit_on_activation
  before update of is_active on public.channels
  for each row
  when (old.is_active is distinct from true and new.is_active)
  execute function public.enforce_subscription_limit('channels');
