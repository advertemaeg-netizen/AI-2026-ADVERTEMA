# syntax=docker/dockerfile:1
#
# Advertema AI — production image (Next.js standalone output).
# Build/run through deploy/docker-compose.yml; see DEPLOYMENT.md.

ARG NODE_IMAGE=node:22-alpine

# ---- 1. deps: exact dependency tree from the lockfile ---------------------
FROM ${NODE_IMAGE} AS deps
# Some native npm packages expect glibc symbols
RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# ---- 2. builder: next build → .next/standalone ----------------------------
FROM ${NODE_IMAGE} AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# NEXT_PUBLIC_* values are compiled into the JavaScript at build time (browser
# and server), so they must be present now — runtime env vars can't change
# them. Secrets (SUPABASE_SECRET_KEY, GOOGLE_GEMINI_API_KEY) are NOT build args:
# they're only read at runtime and never baked into the image.
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
ARG NEXT_PUBLIC_APP_URL
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=$NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY \
    NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL \
    NEXT_TELEMETRY_DISABLED=1

RUN test -n "$NEXT_PUBLIC_SUPABASE_URL" \
    && test -n "$NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY" \
    && test -n "$NEXT_PUBLIC_APP_URL" \
    || (echo "Missing build args: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, NEXT_PUBLIC_APP_URL" && exit 1)

RUN npm run build

# ---- 3. runner: only the standalone server + static assets ----------------
FROM ${NODE_IMAGE} AS runner
# tzdata so TZ=Africa/Cairo applies to logs; the app itself always formats
# dates in Cairo time explicitly
RUN apk add --no-cache tzdata
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

RUN addgroup -S -g 1001 nodejs && adduser -S -u 1001 -G nodejs nextjs

# standalone = server.js + the traced node_modules files; it doesn't include
# public/ or .next/static, so copy those next to it for server.js to serve
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

USER nextjs
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1

CMD ["node", "server.js"]
