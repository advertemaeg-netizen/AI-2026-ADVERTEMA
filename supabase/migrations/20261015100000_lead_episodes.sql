-- ============================================
-- A lead is one sales episode, not one conversation
-- ============================================
-- A conversation can carry several leads over time (a returning customer
-- opens a new one), but only one of them is open at any moment. Leads that
-- reached a final status (showed_up, no_show, lost) no longer block a new one.
-- Concurrent analyses of the same conversation still collide on this index
-- (23505), which the app handles by enriching the lead that won.
alter table public.leads drop constraint leads_conversation_unique;

create unique index one_open_lead_per_conversation
  on public.leads (conversation_id)
  where status not in ('showed_up', 'no_show', 'lost');

-- A conversation's leads in order (conversation page, visit history)
create index idx_leads_conversation_created
  on public.leads (conversation_id, created_at)
  where conversation_id is not null;
