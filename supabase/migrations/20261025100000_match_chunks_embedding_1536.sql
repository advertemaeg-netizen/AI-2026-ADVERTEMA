-- ============================================
-- RETRIEVAL READS THE 1536-D VECTORS
--
-- match_knowledge_chunks now compares against embedding_1536
-- (text-embedding-3-large at 1536 dimensions) instead of the 768-d
-- `embedding`. Every chunk already carries its 1536-d vector
-- (scripts/reembed-knowledge.ts), and new uploads write that column.
--
-- The app must be deployed with this: a build that still embeds questions at
-- 768 dimensions gets "different vector dimensions" from this function and
-- answers without the knowledge base.
--
-- The 768-d column and its index stay: they are dropped on their own, once
-- the new vectors have passed the eval. Going back before then means
-- re-running the function as 20260928100000 defines it.
--
-- The argument's type is still `vector` (a declared length is not part of a
-- function's signature), so this replaces the function and keeps its grants.
-- ============================================

-- match_threshold defaults to 0: which chunks are worth using is the
-- caller's decision, per embedding model (src/lib/ai/bot.ts)
create or replace function public.match_knowledge_chunks(
  client_id uuid,
  query_embedding extensions.vector(1536),
  match_count int default 5,
  match_threshold float default 0
)
returns table (
  id uuid,
  source_document_id uuid,
  title text,
  content text,
  chunk_index int,
  similarity float
)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select
    k.id,
    k.source_document_id,
    k.title,
    k.content,
    k.chunk_index,
    1 - (k.embedding_1536 <=> query_embedding) as similarity
  from public.knowledge_documents k
  where k.client_id = match_knowledge_chunks.client_id
    and k.source_document_id is not null
    and k.embedding_1536 is not null
    and 1 - (k.embedding_1536 <=> query_embedding) >= match_threshold
  order by k.embedding_1536 <=> query_embedding
  limit least(greatest(match_count, 1), 20)
$$;
