-- ============================================
-- PRICE gpt-6-luna
--
-- The OpenAI provider (AI_PROVIDER=openai) writes replies and lead analyses
-- with gpt-6-luna. Without a row here its calls are logged with a null cost.
-- ============================================

-- USD per 1M tokens (OpenAI API list prices, standard tier, 2026-10-07).
-- Cached input is listed at 0.01; ai_usage doesn't tell cached tokens apart,
-- so they are priced as input and the cost reads slightly high, never low.
insert into public.model_pricing (model, input_price_per_million, output_price_per_million) values
  ('gpt-6-luna', 0.10, 0.50)
on conflict (model) do nothing;
