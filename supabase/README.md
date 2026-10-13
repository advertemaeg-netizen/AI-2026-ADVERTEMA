# supabase/

## Before adding a migration: the filenames run ahead of the calendar

The timestamps in `migrations/` are not real dates. They were numbered by hand, a
day per migration, and passed the calendar long ago: on 13 October 2026 the newest
file was `20261026100000_…`, with `20261027100000_…` waiting in `pending/`.

`npx supabase migration new <name>` stamps the file with the current UTC time. Until
the calendar catches up, that name sorts **before** migrations that are already
applied on the remote database. `supabase db push` then refuses it ("Found local
migration files to be inserted before the last migration on remote database"), and
the flag it suggests, `--include-all`, applies it out of order: a file written
against today's schema, recorded as if it ran before the ones it depends on.

So, for every new migration:

1. Take the highest timestamp in `migrations/` **and** `pending/`, and name the new
   file after it (next day, `100000`), the way the existing ones are numbered.
2. If a tool created the file with a real timestamp, rename it before anything else.
3. `npx supabase db push --dry-run` must list only the new file, last. Never pass
   `--include-all` to get past the refusal.

This stops mattering once the real date is past the newest file here; delete this
section then.

## pending/

Migrations that are written but must not be applied yet. `supabase db push` reads
`migrations/` only, so nothing here can be applied by accident; a file is applied by
moving it into `migrations/`. Each one says in its header what it is waiting for.
Its timestamp is reserved: don't number a new migration over it.
