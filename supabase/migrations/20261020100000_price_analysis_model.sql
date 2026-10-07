-- ============================================
-- PRICE THE ANALYSIS MODEL AND THE DEFAULT CHAT MODEL
--
-- gemini-3.5-flash-lite runs on every visitor message (lead analysis) but had
-- no row in model_pricing, so its calls were logged with a null cost and the
-- platform's AI cost read lower than it was.
--
-- gemini-3.8-flash is the chat model the code falls back to when
-- GOOGLE_GEMINI_MODEL is unset; without a row it would log unpriced too.
-- ============================================

-- USD per 1M tokens (Gemini API list prices, standard tier).
-- gemini-3.8-flash is listed at 0.75 / 3.75 through 2026-12-31 and
-- 1.50 / 7.50 from 2027-01-01: update the row then (admin → AI usage).
insert into public.model_pricing (model, input_price_per_million, output_price_per_million) values
  ('gemini-3.5-flash-lite', 0.30, 2.50),
  ('gemini-3.8-flash', 0.75, 3.75)
on conflict (model) do nothing;

-- Calls logged while these models had no price are priced now, as
-- upsert_model_pricing does. Only rows with a null cost: a call that already
-- has a cost keeps it, so past months don't move when a price changes.
update public.ai_usage a
   set estimated_cost_usd = round(
         (a.prompt_tokens * m.input_price_per_million
           + a.completion_tokens * m.output_price_per_million) / 1000000.0,
         6)
  from public.model_pricing m
 where m.model in ('gemini-3.5-flash-lite', 'gemini-3.8-flash')
   and a.model = m.model
   and a.estimated_cost_usd is null;
