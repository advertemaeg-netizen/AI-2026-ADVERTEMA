-- ============================================
-- WHICH MODEL PRODUCED EACH VECTOR
--
-- The outage of 2026-10-12 came down to one question nobody could answer
-- from the data: which model produced these vectors? A vector says nothing
-- about where it came from, and every provider is asked for the same 1536
-- dimensions. From here on each chunk states it.
--
-- Safe to apply BEFORE the image that writes the two columns: the columns
-- are nullable and an older image ignores them. The constraints that make
-- the model name mandatory are a separate migration (20261027100000), applied
-- only once that image is live: they refuse a chunk whose vector comes
-- without a model name, which is every upload made by an older image.
-- ============================================

alter table public.knowledge_documents
  add column if not exists embedding_model text,
  add column if not exists embedding_dimensions smallint;

comment on column public.knowledge_documents.embedding_model is
  'The model that produced embedding_1536. Null on rows without a vector (the document rows).';

-- Backfill. Not an assumption: embedding_1536 was created on 2026-10-12
-- (20261024100000) and has had two writers, scripts/reembed-knowledge.ts
-- (text-embedding-3-large by constant) and the upload path. ai_usage shows
-- every embedding call from 2026-10-12 09:03 UTC up to the check made that
-- evening (413 calls) under the one model, text-embedding-3-large, and none
-- under any other. A database where another model has written this column
-- since must not take this value on trust: check ai_usage first.
update public.knowledge_documents
   set embedding_model = 'text-embedding-3-large',
       embedding_dimensions = 1536
 where embedding_1536 is not null
   and embedding_model is null;

-- Retrieval returns the model with each chunk, so the app can say when the
-- model it embeds questions with is not the one that embedded the chunk
-- (src/lib/ai/bot.ts). A new result column means the function is dropped and
-- made again, grants included; nothing else about it changes.
drop function public.match_knowledge_chunks(uuid, extensions.vector, int, float);

create function public.match_knowledge_chunks(
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
  similarity float,
  embedding_model text
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
    1 - (k.embedding_1536 <=> query_embedding) as similarity,
    k.embedding_model
  from public.knowledge_documents k
  where k.client_id = match_knowledge_chunks.client_id
    and k.source_document_id is not null
    and k.embedding_1536 is not null
    and 1 - (k.embedding_1536 <=> query_embedding) >= match_threshold
  order by k.embedding_1536 <=> query_embedding
  limit least(greatest(match_count, 1), 20)
$$;

revoke execute on function public.match_knowledge_chunks(uuid, extensions.vector, int, float) from public, anon;
grant execute on function public.match_knowledge_chunks(uuid, extensions.vector, int, float) to authenticated, service_role;
