# The marketing site takes over the apex — in deploy/docker-compose.yml on branch site-apex; live once the container is recreated (step below)

Written 2026-10-18 with the site scaffold (`app/[locale]/site`, `src/site`,
`messages/site`). Apply it **only after the site's code is deployed** and the
app checked, never before: until then the apex 302s to the app, as it does
today.

**If the apex misbehaves after the Traefik change, the fix is to put the old
redirect router back ("Rollback" below), not to redeploy.**

Launch order, decided 2026-10-19: deploy main first and check
app.mudrik-ai.com and sign-in; only then apply the Traefik change below.

## DONE 2026-10-21: the legal pages are linked

The site launched on 2026-10-19 with the legal pages unlinked, as drafts.

- Legal review confirmed by: Ahmed, 2026-10-21 — the text written with his
  manager and the lawyer, published from the admin editor (current versions
  then: Arabic privacy 5, terms 4; English privacy 2, terms 2).

Their addresses moved in the same change: `/privacy-policy` and
`/terms-of-service` in both languages (`LEGAL_PAGES`, src/site/config.ts).
The database keeps the documents' names, `privacy` and `terms`. The first
addresses, `/privacy` and `/terms` and their `/v/N`, 301 to the current pages
(src/site/host-routing.ts) for good.

**Only the current version is public** (Ahmed, 2026-10-21): the text was
written once with the lawyer and isn't changing, so a public history would be
links to drafts. `/<page>/v/<anything>` is a 404. Every version stays in the
table and is read in the admin editor; an account's acceptance points at a
version id, whose text is there when it's needed.

**Turning it off again is a commit, a build and a deploy**: `LEGAL_LINKED` is
a constant in the code, not an environment variable. Off, the footer column
and the signup checkbox go, the draft notice comes back on the pages, and
they are no longer indexable. Acceptances already recorded stay.

The order it was done in, kept for the record:

Since 2026-10-20 the texts live in the database (`public.legal_versions`,
migration `20261029100000_legal_versions.sql`), edited in the admin area
(Legal documents) with every version kept. Relinking is one change, in this
order:

1. Publish the lawyer's text as a new version of each document, in both
   languages, from the admin editor.
2. Replace the English stand-ins with Arabic: `admin.legal.*` /
   `admin.nav.legal` in `messages/ar.json` (and the site's version-history
   strings, since deleted with the version pages).
3. `LEGAL_LINKED = true` (`src/lib/legal-linked.ts`). That one switch relinks
   the footer AND turns on the signup checkbox: the pages and the recorded
   acceptance go live together, never one without the other.

**Deploying this code needs the migration first.** The legal pages are
generated at build time from the table, read with the publishable key: if
`20261029100000_legal_versions.sql` isn't applied, or the database can't be
reached during the build, the build fails rather than shipping an empty page.

## LAUNCH BLOCKER: the booking-order fix

**The home page's hero conversation shows the booking order AFTER the
booking-order fix**: the bot takes the day and time first, then asks for the
name, then the number, one thing per message
(src/site/components/hero-conversation.tsx). Today the bot asks for the name
and phone together, and the live prompt orders the name first. The site must
not go public before that fix is deployed, or its first demo is of
behaviour the product doesn't have. The fix is the next bot task (the
handover note, "NEXT BOT TASK").

- Booking-order fix deployed: _(not yet; it ships in the launch deploy of 2026-10-19 — fill in the commit and date)_

## Not a launch gate: the contact form

Decided 2026-10-19: the site launches with the contact page as WhatsApp and
the email address (a mailto link), which work with nothing configured.
`SITE_CONTACT_FORM` (src/site/config.ts) is off, so the form isn't shown.
Its code stays (src/site/contact-mail.ts): it sends by SMTP to
contact@mudrik-ai.com, and without the `CONTACT_SMTP_*` settings
(.env.example) every send fails, honestly, so it must not be switched on
before them. Ahmed's task, in this order:

- `CONTACT_SMTP_*` set on the server: _(not yet)_
- A message sent from the deployed site arrived in the mailbox: _(not yet)_
- Someone reads contact@mudrik-ai.com every working day (who): _(not yet)_
- Then `SITE_CONTACT_FORM = true` and a deploy.

The mailbox is unverified either way: the contact page's mailto link points
at it too.

## What changes, and why

Today `mudrik-ai.com` and `www` hit the app container through the
`advertema-apex` router, whose `advertema-to-app` middleware 302s every request
to `app.mudrik-ai.com`. The site needs the apex requests to reach the container
instead: `proxy.ts` (`src/site/host-routing.ts`) then serves the marketing
pages there, and 302s every other path to the same path on the app's host
(307 for `/api`). One host per concern: auth cookies are per host, so the
product is never served from the apex.

`www` stops being served directly and 302s to the apex, so the site has one
canonical host.

## The change, in `deploy/docker-compose.yml` (labels of the `advertema` service)

Replace these lines:

```yaml
      # mudrik-ai.com and www → the app, with a real certificate, until a
      # marketing site takes the apex over. Temporary (302), so browsers don't
      # cache it. $$ is compose's escape for the regex's $.
      - traefik.http.routers.advertema-apex.rule=Host(`mudrik-ai.com`) || Host(`www.mudrik-ai.com`)
      - traefik.http.routers.advertema-apex.entrypoints=websecure
      - traefik.http.routers.advertema-apex.tls.certresolver=letsencrypt
      - traefik.http.routers.advertema-apex.service=advertema
      - traefik.http.routers.advertema-apex.middlewares=advertema-to-app
      - traefik.http.middlewares.advertema-to-app.redirectregex.regex=^https?://[^/]+/?(.*)$$
      - traefik.http.middlewares.advertema-to-app.redirectregex.replacement=https://app.mudrik-ai.com/$${1}
      - traefik.http.middlewares.advertema-to-app.redirectregex.permanent=false
```

with:

```yaml
      # The marketing site: the apex reaches the app, whose proxy serves the
      # site's pages there and sends every other path to app.mudrik-ai.com
      - traefik.http.routers.advertema-apex.rule=Host(`mudrik-ai.com`)
      - traefik.http.routers.advertema-apex.entrypoints=websecure
      - traefik.http.routers.advertema-apex.tls.certresolver=letsencrypt
      - traefik.http.routers.advertema-apex.service=advertema
      # www → the apex, same path. Temporary (302) while things still move.
      # $$ is compose's escape for the regex's $.
      - traefik.http.routers.advertema-www.rule=Host(`www.mudrik-ai.com`)
      - traefik.http.routers.advertema-www.entrypoints=websecure
      - traefik.http.routers.advertema-www.tls.certresolver=letsencrypt
      - traefik.http.routers.advertema-www.service=advertema
      - traefik.http.routers.advertema-www.middlewares=advertema-to-apex
      - traefik.http.middlewares.advertema-to-apex.redirectregex.regex=^https?://[^/]+/?(.*)$$
      - traefik.http.middlewares.advertema-to-apex.redirectregex.replacement=https://mudrik-ai.com/$${1}
      - traefik.http.middlewares.advertema-to-apex.redirectregex.permanent=false
```

The `www` router is new, so Let's Encrypt is asked for its certificate on the
first request (the apex and www already have one from the current router; the
name on the router changes, the hostnames don't).

Deploy as usual (`./deploy/update.sh`): the labels are read when the container
is recreated.

## Check after it

```bash
curl -sI https://mudrik-ai.com/ar            # 200, the site's home
curl -sI https://mudrik-ai.com/ar/pricing    # 200
curl -sI https://mudrik-ai.com/ar/login      # 302 → https://app.mudrik-ai.com/ar/login
curl -sI https://mudrik-ai.com/              # 307/302 → /ar (the locale)
curl -sI https://www.mudrik-ai.com/ar        # 302 → https://mudrik-ai.com/ar
curl -sI https://app.mudrik-ai.com/ar/site   # 404: the app's host never shows the site
curl -sI https://app.mudrik-ai.com/ar/dashboard  # unchanged (302 to login when signed out)
```

## Rollback

Put the eight original lines back (above), remove the `advertema-www` router
and `advertema-to-apex` middleware lines, and recreate the container:

```bash
cd /opt/advertema/deploy
docker compose --env-file .env.production up -d --no-build --force-recreate
```

`--no-build` keeps the image: only the routing goes back, and the apex 302s to
the app again. The site's code stays in the image, unreachable, because only
the site's hosts are rewritten into it. If the image itself has to go back,
`./deploy/update.sh rollback`.

## When the site leaves this container

**Trigger: the first real client going live.** Decided 2026-10-18. Until then
a copy change redeploys this container, which serves `widget.js` and the
webhook for every client's website, so each site deploy is a few seconds in
which every client's widget can't answer. That's acceptable while all traffic
is test, and not once a real client depends on it. The split stays cheap
because the site lives apart: `app/[locale]/site`, `src/site`, `messages/site`
(plus the shared `app/globals.css` tokens and `src/components/brand.tsx`).

---

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
-- Since 20261026100000 the function also returns embedding_model, and a
-- function's result columns can't be changed in place: drop it first. The
-- drop takes the grants with it, hence the two lines at the end.
drop function if exists public.match_knowledge_chunks(uuid, extensions.vector, int, float);

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

The migration history still lists the function's migrations as applied, so
`npx supabase db push` will not put the function back. Run the `drop
function`, `create function` and grant statements from
`supabase/migrations/20261026100000_knowledge_embedding_model.sql` in the SQL
editor, set `OPENAI_EMBEDDING_MODEL=text-embedding-3-large` again, then
`./deploy/update.sh`.

If knowledge files were uploaded while rolled back, they have a 768-d vector
and no 1536-d one: `npm run reembed:knowledge` (preview), then `-- --execute`.
