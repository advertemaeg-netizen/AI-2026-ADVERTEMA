<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Database migrations: do not use a real timestamp

The filenames in `supabase/migrations/` run ahead of the calendar, so a file made by `supabase migration new` (or named with today's date) sorts before migrations that are already applied. Read `supabase/README.md` before adding one: name it after the highest timestamp in `supabase/migrations/` and `supabase/pending/`, and never pass `--include-all` to `supabase db push`.
