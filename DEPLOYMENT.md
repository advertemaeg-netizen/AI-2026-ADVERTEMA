# Deploying Connecta AI

Production runs as a single Docker container on the VPS, behind the Traefik
instance that already serves n8n.

| | |
|---|---|
| Server | Ubuntu 24.04 · `186.240.149.99` |
| App URL | https://app.srv1995277.hstgr.cloud |
| Reverse proxy | Traefik v3 (Docker provider, `exposedbydefault=false`, Let's Encrypt HTTP challenge, HTTP→HTTPS redirect) |
| Image | `Dockerfile` — Node 22 alpine, Next.js `standalone` output, non-root user |
| Compose | `deploy/docker-compose.yml` |
| Config | `deploy/.env.production` (on the server only — never committed) |

```
Internet ──443──▶ Traefik (host network) ──▶ advertema:3000 on advertema_default
                                                   │
                                     Supabase (DB, auth, storage, realtime) · Gemini
```

Networking mirrors n8n: the app stays on its own compose network
(`advertema_default`, from `name: advertema` in the compose file). Traefik runs
with host networking and discovers the container through the Docker socket, so
no shared or external network is needed.

## Build-time vs runtime configuration

`NEXT_PUBLIC_*` variables are **compiled into the app when the image is built**
(the browser bundle and the server code). Compose passes them as build args,
reading them from `.env.production` — that's why every command below uses
`--env-file .env.production`.

| Variable | When it's read | After changing it |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_APP_URL` | build | rebuild (`./deploy/update.sh`, or `up -d --build`) |
| `SUPABASE_SECRET_KEY`, `GOOGLE_GEMINI_*` | runtime | `docker compose --env-file .env.production up -d` |

Secrets are never build args, so they're not stored in the image.

---

## 1. One-time preparation

### DNS

`app.srv1995277.hstgr.cloud` must resolve to the server, or Let's Encrypt can't
issue the certificate:

```bash
dig +short app.srv1995277.hstgr.cloud      # must print 186.240.149.99
```

If it doesn't, add an `A` record for `app` → `186.240.149.99` in the Hostinger
DNS panel and wait for it to resolve.

### Certificate resolver

The router uses the `letsencrypt` resolver, the same one as n8n. To double-check:

```bash
docker inspect <n8n-container> --format '{{json .Config.Labels}}' | tr ',' '\n' | grep certresolver
```

### Supabase

1. **Auth → URL Configuration**
   - Site URL: `https://app.srv1995277.hstgr.cloud`
   - Redirect URLs: add `https://app.srv1995277.hstgr.cloud/**`

   Without this, sign-up confirmation and invite emails send people to
   `localhost`.
2. **Migrations:** make sure every file in `supabase/migrations` is applied
   (`npx supabase migration list`, then `npx supabase db push` from a dev
   machine linked to the project). The app expects the latest schema.

### Server resources

`next build` needs roughly 2 GB of RAM. On a small VPS without swap the build
can be killed (`exit code 137`); see [Troubleshooting](#troubleshooting).

---

## 2. First deployment

```bash
ssh root@186.240.149.99

# Get the code (private repo: use a deploy key or a GitHub token)
cd /opt
git clone https://github.com/advertemaeg-netizen/AI-2026-ADVERTEMA.git advertema
cd advertema/deploy

# Configuration
cp .env.production.example .env.production
nano .env.production          # fill in Supabase and Gemini
chmod 600 .env.production

# Build and start
docker compose --env-file .env.production up -d --build

# Check it
docker compose --env-file .env.production ps     # STATUS should become "healthy"
docker logs -f advertema                          # Ctrl+C to stop following
curl -s https://app.srv1995277.hstgr.cloud/api/health   # {"ok":true}
```

The first HTTPS request can take a few seconds while Traefik obtains the
certificate.

### After the first deploy

- **Website widgets:** open each client's **Channels** page and copy the embed
  code again. It's always generated from `NEXT_PUBLIC_APP_URL`; snippets copied
  during local development point at `localhost` and must be replaced on the
  client's website.
- Sign up / log in once on the live URL to confirm auth redirects work.

---

## 3. Updating

```bash
cd /opt/advertema
./deploy/update.sh
```

The script:

1. tags the image that's running now as `advertema:previous` and
   `advertema:<its commit>`,
2. `git pull --ff-only`,
3. rebuilds and restarts the container,
4. prunes dangling images.

If a release includes new files in `supabase/migrations`, apply them **before**
updating (new code can depend on them).

Equivalent manual steps:

```bash
cd /opt/advertema && git pull
cd deploy && docker compose --env-file .env.production up -d --build
```

---

## 4. Logs & status

```bash
docker logs -f advertema                 # follow
docker logs --since 1h advertema         # last hour
docker logs advertema 2>&1 | grep -E "lead-detection|webhook|knowledge|error"
docker inspect --format '{{.State.Health.Status}}' advertema   # healthy / unhealthy
docker stats advertema                   # CPU / memory
docker logs <traefik-container> 2>&1 | grep -i advertema       # routing / certificate issues
```

Useful app log prefixes: `[webhook/website]`, `[lead-detection]`, `[bot]`,
`[knowledge]`, `[team]`, `[appointments]`.

---

## 5. Rollback

Back to the image that was running before the last update:

```bash
cd /opt/advertema
./deploy/update.sh rollback
```

Back to a specific earlier release (images are kept per commit by `update.sh`):

```bash
docker images advertema                          # list tags
docker tag advertema:<commit> advertema:latest
cd /opt/advertema/deploy
docker compose --env-file .env.production up -d --no-build --force-recreate
```

Or rebuild from an older commit: `git checkout <commit>` then
`docker compose --env-file .env.production up -d --build`
(`git checkout main` afterwards before the next `update.sh`).

> Rolling back the app does **not** roll back database migrations. If the
> newer release changed the schema, check the older code still works with it.

---

## Troubleshooting

| Symptom | Likely cause → fix |
|---|---|
| `404 page not found` (plain text) from Traefik | Router not picked up: container not running, or labels wrong (`traefik.enable=true` must be present — `exposedbydefault=false`). Check `docker inspect advertema --format '{{json .Config.Labels}}'` and `docker logs <traefik>`. |
| `502 Bad Gateway` / `Gateway Timeout` | Traefik can't reach port 3000: container restarting or unhealthy (`docker logs advertema`). From the host, `curl http://$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' advertema):3000/api/health` should answer. |
| Browser shows a certificate warning / Traefik default cert | Let's Encrypt couldn't validate: DNS not pointing to the server, port 80 closed, or the resolver name doesn't match Traefik's. See `docker logs <traefik>`. |
| Build fails with `Missing build args` or `set NEXT_PUBLIC_... in .env.production` | Run compose from `deploy/` **with** `--env-file .env.production`, and fill in all `NEXT_PUBLIC_*` values. |
| Build killed / `exit code 137` / `JavaScript heap out of memory` | Not enough RAM for `next build`. Add swap: `fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile` (add to `/etc/fstab` to keep it). |
| Changed a `NEXT_PUBLIC_*` value but nothing changed | Those are compiled in — rebuild (`./deploy/update.sh` or `up -d --build`). |
| Sign-up / invite emails link to `localhost` | Supabase **Site URL / Redirect URLs** still point at localhost — see *Supabase* above. |
| `Failed to find Server Action` in logs right after an update | Browsers still have the previous release open; harmless, fixed by reloading the page. |
| Widget doesn't appear on a client's site | The site still has an old (localhost) snippet — re-copy the embed code. Check the browser console on that site; `https://app.srv1995277.hstgr.cloud/widget.js` must load. |
| Widget shows "Chat is unavailable" / AI never answers | `GOOGLE_GEMINI_API_KEY` missing or quota exhausted (Gemini `429` in logs — the free tier is very small); channel paused; client not active. |
| Agent replies don't reach the widget live | Supabase Realtime: the `20260927110000_widget_agent_broadcast` migration must be applied, and Realtime must allow public channels. |
| Knowledge-base PDF upload fails with `Setting up fake worker failed` | The pdf.js worker wasn't copied into the image — `outputFileTracingIncludes` in `next.config.ts` must still list `pdfjs-dist/legacy/build/pdf.worker.mjs`. |
| Times look 2–3 hours off | The app always formats in Africa/Cairo; the container `TZ` only affects log timestamps. Check the server clock with `timedatectl`. |
| Disk filling up | `docker image prune` / `docker builder prune` (keep `advertema:previous` if you may roll back). |
