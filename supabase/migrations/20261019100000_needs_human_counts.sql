-- ============================================
-- How many conversations wait for a person, per reason
-- ============================================
-- The dashboard banner used to fetch the marked rows (at most 1000) and count
-- them itself, so above 1000 it showed a number that was too low. Counted
-- here instead. Security invoker: RLS still limits the count to the
-- conversations this user handles. A null reason comes back as null; the app
-- decides what it shows for it.

create function public.needs_human_counts()
returns table (reason text, conversations bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select needs_human_reason, count(*)
    from public.conversations
   where needs_human_since is not null
   group by needs_human_reason;
$$;

revoke execute on function public.needs_human_counts() from public, anon;
grant execute on function public.needs_human_counts() to authenticated;
