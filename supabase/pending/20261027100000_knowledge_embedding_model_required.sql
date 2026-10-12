-- ============================================
-- NOT APPLIED YET, AND NOT IN supabase/migrations ON PURPOSE.
--
-- `supabase db push` applies every file in supabase/migrations at once, and
-- this one must wait for a deploy. Once the image that writes
-- embedding_model is live (commit "each chunk records the model that
-- embedded it" or later), move this file to
-- supabase/migrations/20261027100000_knowledge_embedding_model_required.sql,
-- delete this notice, and push.
-- ============================================

-- ============================================
-- A VECTOR ALWAYS STATES ITS MODEL
--
-- Follows 20261026100000, which added embedding_model and
-- embedding_dimensions and backfilled them. APPLY ONLY AFTER the image that
-- writes the two columns is live: an older image uploads chunks with a
-- vector and no model name, and these constraints refuse them.
--
-- If this fails on existing rows, a chunk was written without a model name
-- after the backfill (an upload from an older image). Do not backfill it on
-- trust: find the model in ai_usage for that client and time first.
-- ============================================

-- embedding_1536 only. The 768-d `embedding` column holds vectors from two
-- earlier models with no recorded name, and is on its way out.
alter table public.knowledge_documents
  add constraint knowledge_embedding_1536_has_model
    check ((embedding_1536 is null) = (embedding_model is null)),
  -- The stated width is the stored vector's own, not a number typed twice
  add constraint knowledge_embedding_dimensions_match
    check (embedding_dimensions is not distinct from extensions.vector_dims(embedding_1536));
