# Rolling back the 1536-d embeddings release

The release that moved the knowledge base to `text-embedding-3-large` at 1536
dimensions changed three things that have to agree with each other: the app
image, the `match_knowledge_chunks` function in the database, and one
environment variable. `./deploy/update.sh rollback` only puts the image back.
Rolling back means all three, in this order, back to back.

The release before it is commit `12e003d`.

## What the rollback gives you

The previous image embeds questions with `text-embedding-3-small` at 768
dimensions and uses a chunk only at a similarity of 0.5 or more. On that model
no chunk scored above 0.29, so **retrieval returns nothing and the bot answers
without the knowledge base** ("السعر مش ظاهر عندي"). That is the state this
release was made to fix. Roll back to get a running app back, not working
retrieval.

Knowledge files uploaded after the release have no 768-d vector (new uploads
write `embedding_1536` only), so the previous image does not see them at all.
The 768-d column is a complete rollback target only until the first upload.

Nothing else needs undoing: the `text-embedding-3-large` price row and the
`embedding_1536` column and index are additive, and the previous code ignores
them.

## 1. Environment variable

In `/opt/advertema/deploy/.env.production`:

```bash
# was: OPENAI_EMBEDDING_MODEL=text-embedding-3-large
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
```

`AI_PROVIDER=openai` and `AI_EMBEDDING_PROVIDER=openai` stay as they are. The
previous image asks for 768 dimensions itself; left at
`text-embedding-3-large` it would compare that model's vectors with
`text-embedding-3-small`'s, and nothing would report it.

The file is only read when the container is recreated — step 3 does that.

## 2. The function, back to its 20260928100000 definition

Supabase Dashboard → SQL Editor, on the production project:

```sql
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
```

From this moment until step 3 finishes, the running (new) image gets
"different vector dimensions" from the function and answers without the
knowledge base. Do step 3 straight away.

## 3. The image

```bash
cd /opt/advertema
./deploy/update.sh rollback
```

That recreates the container from `advertema:previous` with the edited env
file. If `advertema:previous` is no longer the release before this one (another
update ran since), use the image kept for the commit instead:

```bash
docker images advertema
docker tag advertema:12e003d advertema:latest
cd /opt/advertema/deploy
docker compose --env-file .env.production up -d --no-build --force-recreate
```

## 4. Check

```bash
docker exec advertema printenv AI_PROVIDER AI_EMBEDDING_PROVIDER OPENAI_EMBEDDING_MODEL
# openai / openai / text-embedding-3-small
docker inspect --format '{{.State.Health.Status}}' advertema
docker logs --since 5m advertema 2>&1 | grep "knowledge retrieval failed"
# no lines: a "different vector dimensions" error here means step 2 or 3 did not take
```

## Going forward again

The migration history still lists `20261025100000` as applied, so
`npx supabase db push` will not put the function back. Run the
`create or replace function` statement from
`supabase/migrations/20261025100000_match_chunks_embedding_1536.sql` in the SQL
editor, set `OPENAI_EMBEDDING_MODEL=text-embedding-3-large` again, then
`./deploy/update.sh`.

If knowledge files were uploaded while rolled back, they have a 768-d vector
and no 1536-d one: `npm run reembed:knowledge` (preview), then `-- --execute`.
