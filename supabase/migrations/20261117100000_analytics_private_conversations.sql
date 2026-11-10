-- ============================================
-- ANALYTICS COUNT PRIVATE CONVERSATIONS ONLY
-- (.scratch/comments-tab-decisions.md, 1: "a comment thread leaves the
-- conversations list entirely"; written 2026-11-10)
-- ============================================
--
-- A public comment lives in its author's comment thread, a conversations row
-- with thread 'comments' (20261108100000). The inbox, the home page and the
-- analytics KPIs now count private conversations only (thread 'dm'); these
-- five functions still counted comment threads too, so the analytics page
-- disagreed with itself: the KPI said N conversations and the chart beside it
-- said more. Each now leaves comment threads out, and nothing else changes:
--   get_conversations_over_time  the conversations chart
--   get_channel_distribution     the channels chart
--   get_response_time_stats      first-response time (a comment's fixed public
--                                reply is instant and would flatter it)
--   get_peak_hours               visitor messages per hour (comments are not
--                                messages to the clinic)
--   get_client_performance       the top clients table
-- Copied from their latest definitions (20261004100000; get_client_performance
-- from 20261030100000) with one condition added to each. `create or replace`
-- keeps their grants. The super admin's platform counts (get_platform_stats,
-- get_organizations_overview, get_organization_details) are left as they are:
-- they measure usage of the platform, and a comment thread is usage.
-- ============================================

create or replace function public.get_conversations_over_time(
  p_client_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_granularity text default 'day'
)
returns table (bucket date, conversations bigint)
language sql
stable
security invoker
set search_path = public
as $$
  with counts as (
    select public.analytics_bucket((c.created_at at time zone 'Africa/Cairo')::date, p_granularity) as bucket,
           count(*) as n
      from public.conversations c
     where c.created_at >= p_from and c.created_at < p_to
       and (p_client_id is null or c.client_id = p_client_id)
       and c.thread <> 'comments'
     group by 1
  )
  select b.bucket, coalesce(counts.n, 0)
    from public.analytics_buckets(p_from, p_to, p_granularity) b
    left join counts using (bucket)
   order by b.bucket
$$;

create or replace function public.get_channel_distribution(
  p_client_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
returns table (channel text, conversations bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select ch.type::text, count(*)
    from public.conversations c
    join public.channels ch on ch.id = c.channel_id
   where c.created_at >= p_from and c.created_at < p_to
     and (p_client_id is null or c.client_id = p_client_id)
     and c.thread <> 'comments'
   group by ch.type
   order by 2 desc
$$;

create or replace function public.get_response_time_stats(
  p_client_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
returns table (
  conversations bigint,
  responded bigint,
  avg_seconds numeric,
  median_seconds numeric,
  agent_responded bigint,
  agent_avg_seconds numeric
)
language sql
stable
security invoker
set search_path = public
as $$
  with conv as (
    select c.id
      from public.conversations c
     where c.created_at >= p_from and c.created_at < p_to
       and (p_client_id is null or c.client_id = p_client_id)
       and c.thread <> 'comments'
  ),
  firsts as (
    select conv.id,
           fu.first_user,
           (select min(m.created_at) from public.messages m
             where m.conversation_id = conv.id and m.role in ('assistant', 'agent')
               and m.created_at >= fu.first_user) as first_reply,
           (select min(m.created_at) from public.messages m
             where m.conversation_id = conv.id and m.role = 'agent'
               and m.created_at >= fu.first_user) as first_agent
      from conv
      cross join lateral (
        select min(m.created_at) as first_user
          from public.messages m
         where m.conversation_id = conv.id and m.role = 'user'
      ) fu
     where fu.first_user is not null
  )
  select
    count(*),
    count(first_reply),
    round(avg(extract(epoch from first_reply - first_user))::numeric, 1),
    round((percentile_cont(0.5) within group (order by extract(epoch from first_reply - first_user)))::numeric, 1),
    count(first_agent),
    round(avg(extract(epoch from first_agent - first_user))::numeric, 1)
  from firsts
$$;

create or replace function public.get_peak_hours(
  p_client_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
returns table (hour int, messages bigint)
language sql
stable
security invoker
set search_path = public
as $$
  with counts as (
    select extract(hour from m.created_at at time zone 'Africa/Cairo')::int as hour, count(*) as n
      from public.messages m
      join public.conversations c on c.id = m.conversation_id
     where m.role = 'user'
       and m.created_at >= p_from and m.created_at < p_to
       and (p_client_id is null or c.client_id = p_client_id)
       and c.thread <> 'comments'
     group by 1
  )
  select h.hour, coalesce(counts.n, 0)
    from generate_series(0, 23) as h(hour)
    left join counts using (hour)
   order by h.hour
$$;

create or replace function public.get_client_performance(
  p_from timestamptz,
  p_to timestamptz
)
returns table (
  client_id uuid,
  client_name text,
  conversations bigint,
  leads bigint,
  booked bigint,
  showed_up bigint,
  no_show bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  select c.id, c.name,
         (select count(*) from public.conversations cv
           where cv.client_id = c.id and cv.created_at >= p_from and cv.created_at < p_to
             and cv.thread <> 'comments'),
         count(l.id),
         count(l.id) filter (where l.appointment_at is not null),
         count(l.id) filter (where l.showed_up is true),
         count(l.id) filter (where l.showed_up is false)
    from public.clients c
    left join public.leads l
      on l.client_id = c.id and l.is_complete and l.created_at >= p_from and l.created_at < p_to
   group by c.id, c.name
$$;
