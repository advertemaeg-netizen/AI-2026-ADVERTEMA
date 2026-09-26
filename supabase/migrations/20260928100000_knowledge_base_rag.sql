-- ============================================
-- KNOWLEDGE BASE + RAG
--
-- knowledge_documents now holds two kinds of rows:
--   * documents: source_document_id is null — one per uploaded file
--     (status, file path, chunk_count, error)
--   * chunks:    source_document_id → the document, with chunk_index,
--     content and a 768-d embedding. Deleted with their document.
-- ============================================

create extension if not exists vector with schema extensions;

alter table public.knowledge_documents
  add column if not exists embedding extensions.vector(768),
  add column if not exists chunk_index int,
  add column if not exists source_document_id uuid
    references public.knowledge_documents(id) on delete cascade,
  add column if not exists chunk_count int,
  add column if not exists file_size bigint,
  add column if not exists error_message text;

create index if not exists idx_knowledge_source on public.knowledge_documents(source_document_id);
create index if not exists idx_knowledge_client on public.knowledge_documents(client_id, created_at desc);

create index if not exists idx_knowledge_embedding on public.knowledge_documents
  using hnsw (embedding extensions.vector_cosine_ops);

-- --------------------------------------------
-- Nearest chunks for a client. security invoker: callers only see chunks RLS
-- lets them see (anon: nothing). The website webhook calls it with the
-- secret-key client and always passes the channel's client_id.
-- --------------------------------------------
create or replace function public.match_knowledge_chunks(
  client_id uuid,
  query_embedding extensions.vector(768),
  match_count int default 3,
  match_threshold float default 0.5
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
    1 - (k.embedding <=> query_embedding) as similarity
  from public.knowledge_documents k
  where k.client_id = match_knowledge_chunks.client_id
    and k.source_document_id is not null
    and k.embedding is not null
    and 1 - (k.embedding <=> query_embedding) >= match_threshold
  order by k.embedding <=> query_embedding
  limit least(greatest(match_count, 1), 20)
$$;

revoke execute on function public.match_knowledge_chunks(uuid, extensions.vector, int, float) from public, anon;
grant execute on function public.match_knowledge_chunks(uuid, extensions.vector, int, float) to authenticated, service_role;

-- --------------------------------------------
-- Storage: private bucket, files stored as <client_id>/<document_id>/<name>
-- --------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'knowledge-base',
  'knowledge-base',
  false,
  10485760, -- 10 MB
  array[
    'application/pdf',
    'text/plain',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ]
)
on conflict (id) do nothing;

-- Client id from the first path segment, or null if it isn't a uuid
create or replace function public.storage_client_id(object_name text)
returns uuid
language sql
immutable
as $$
  select case
    when split_part(object_name, '/', 1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then split_part(object_name, '/', 1)::uuid
  end
$$;

create policy "Users read knowledge files of their clients"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'knowledge-base'
    and public.has_client_access(public.storage_client_id(name))
  );

create policy "Admins upload knowledge files for their clients"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'knowledge-base'
    and public.is_client_manager()
    and public.has_client_access(public.storage_client_id(name))
  );

create policy "Admins delete knowledge files of their clients"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'knowledge-base'
    and public.is_client_manager()
    and public.has_client_access(public.storage_client_id(name))
  );
