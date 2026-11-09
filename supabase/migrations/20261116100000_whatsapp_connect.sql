-- ============================================
-- A WHATSAPP CHANNEL A CLIENT CONNECTS ITSELF (Embedded Signup)
-- (.scratch/whatsapp-go-and-strings.md; decided 2026-11-09)
-- ============================================
--
-- 1. THE NUMBER'S PIN. Registering a number with the Cloud API sets its
--    two-step verification PIN, and the number cannot be registered again
--    (a reconnect, or anywhere else) without it. We generate it, so we keep
--    it: in channel_secrets, the server-only table (no policy, every
--    privilege revoked; tests/access/channel-secrets.test.ts). Never logged,
--    never in an error, never rendered.
--    IT BELONGS TO THE BUSINESS, NOT TO US. A clinic that leaves and wants to
--    register its number elsewhere needs it, and we must never be the only
--    ones able to open a business's own number. It is given back on request
--    by the support command (npm run whatsapp:pin -- <channelId>), which
--    prints it to the operator's terminal and nowhere else.
--
-- 2. WHAT THE CHANNEL'S CARD MUST SAY, beyond on or paused:
--      name_pending          the number's display name is still under
--                            WhatsApp's review; replies work meanwhile
--      removed_by_business   the business removed our access in WhatsApp
--                            (account_update, PARTNER_REMOVED): the channel
--                            is paused until it is connected again
--    Set by the server only. channels is readable column by column
--    (20261008100000: "a new channels column must be added to this grant"),
--    so it is added to that grant.
-- ============================================

alter table public.channel_secrets
  add column registration_pin text check (registration_pin is null or registration_pin ~ '^[0-9]{6}$');

comment on column public.channel_secrets.registration_pin is
  'The WhatsApp number''s two-step verification PIN, set when we registered it. The business''s, not ours: give it back on request (npm run whatsapp:pin). Never logged or rendered.';

alter table public.channels
  add column connection_notice text check (connection_notice in ('name_pending', 'removed_by_business'));

grant select (connection_notice) on public.channels to authenticated;
