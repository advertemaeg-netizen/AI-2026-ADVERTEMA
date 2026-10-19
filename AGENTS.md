<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Database migrations: do not use a real timestamp

The filenames in `supabase/migrations/` run ahead of the calendar, so a file made by `supabase migration new` (or named with today's date) sorts before migrations that are already applied. Read `supabase/README.md` before adding one: name it after the highest timestamp in `supabase/migrations/` and `supabase/pending/`, and never pass `--include-all` to `supabase db push`.

# Before committing: `npm run check`

Run `npm run check` after the last edit and before every commit: `tsc --noEmit` over the whole repo (test files included), then `eslint`, then `vitest run`. Vitest alone does not type-check: commit eb21545 landed a test that broke `tsc` while every test passed. The multi-message webhook tests have a known flake: `messages` and `leads` are ordered by `created_at` alone, and rows come back in the wrong order (seen 2026-10-19: the bot answered a visitor's first message in reply to their second). The first dumps show no timestamp ties; the first visitor message was stamped over a second later than rows written after it, which may be the test database's (PGlite's) clock rather than production's. That is open. Report such a failure with what it read; don't rerun until green and call it clean.

The evidence is kept for you: `npm run check` (`scripts/check.sh`) writes everything it prints to `.scratch/check-failures/check-<time>-<commit>.log`, deletes it when the run is clean, and keeps it when the run fails, with the commit and the working tree's state at the top. Each kept failure of a webhook test is a data point on the ordering defect's mechanism — for example, whether the rows read in the wrong order share a `created_at` — so don't delete them; collect them for the ordering fix.

# New dependencies: an exact release at least two weeks old

Pin anything new to an exact version (`npm install --save-exact pkg@x.y.z`): the newest release published at least two weeks ago, found with `npm view <pkg> time --json`, then `npm audit`. Say in the commit which version and why. On 2026-10-19 nodemailer had shipped five releases in one day; 10.0.13 was pinned instead.
