-- ============================================
-- KNOWLEDGE BASE: A SECOND, 1536-D EMBEDDING COLUMN
--
-- Retrieval moves from text-embedding-3-small at 768 dimensions to
-- text-embedding-3-large at 1536. The new vectors go in their own column,
-- next to the 768-d one, so the chunks can be re-embedded
-- (scripts/reembed-knowledge.ts) and measured while retrieval still reads
-- the old column. Same rows, same ids: only a vector is added.
--
-- Nothing reads embedding_1536 yet, and the old column is not dropped here.
-- ============================================

alter table public.knowledge_documents
  add column if not exists embedding_1536 extensions.vector(1536);

create index if not exists idx_knowledge_embedding_1536 on public.knowledge_documents
  using hnsw (embedding_1536 extensions.vector_cosine_ops);
