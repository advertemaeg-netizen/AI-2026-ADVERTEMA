-- ============================================
-- PRICE text-embedding-3-small
--
-- The OpenAI provider can now embed the knowledge base
-- (AI_EMBEDDING_PROVIDER=openai). Without a row here its calls are logged
-- with a null cost.
-- ============================================

-- USD per 1M tokens (OpenAI API list price, 2026-10-11). No output tokens.
insert into public.model_pricing (model, input_price_per_million, output_price_per_million) values
  ('text-embedding-3-small', 0.02, 0)
on conflict (model) do nothing;

-- The knowledge base was re-embedded with this model before it had a price,
-- so those calls were logged with a null cost: priced now, as
-- upsert_model_pricing does. Only rows with a null cost.
update public.ai_usage a
   set estimated_cost_usd = round(
         (a.prompt_tokens * m.input_price_per_million
           + a.completion_tokens * m.output_price_per_million) / 1000000.0,
         6)
  from public.model_pricing m
 where m.model = 'text-embedding-3-small'
   and a.model = m.model
   and a.estimated_cost_usd is null;
