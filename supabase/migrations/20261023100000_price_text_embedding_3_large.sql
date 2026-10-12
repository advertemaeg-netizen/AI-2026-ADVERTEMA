-- ============================================
-- PRICE text-embedding-3-large
--
-- The knowledge base moves to text-embedding-3-large (at 1536 dimensions).
-- Priced before the first call is made with it: without a row here its calls
-- are logged with a null cost and the platform's AI cost reads lower than it
-- is.
-- ============================================

-- USD per 1M tokens (OpenAI API list price, 2026-10-12). No output tokens.
-- The price is per input token and does not depend on `dimensions`.
insert into public.model_pricing (model, input_price_per_million, output_price_per_million) values
  ('text-embedding-3-large', 0.13, 0)
on conflict (model) do nothing;
