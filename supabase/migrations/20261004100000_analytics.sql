-- ============================================
-- ANALYTICS
-- Every function is security invoker, so RLS decides what the caller sees
-- (team members, for example, only count conversations assigned to them).
-- p_client_id null = every client the caller can see. Periods are
-- [p_from, p_to). Days, weeks and hours are Cairo-local.
-- ============================================

-- Bucket start for a Cairo date: the day itself, or the Saturday that
-- starts its week (the business week in Egypt)
create or replace function public.analytics_bucket(d date, granularity text)
returns date
language sql
immutable
as $$
  select case
    when granularity = 'week' then d - ((extract(dow from d)::int + 1) % 7)
    else d
  end
$$;

-- Every bucket in the period, so days without activity plot as zero
create or replace function public.analytics_buckets(p_from timestamptz, p_to timestamptz, granularity text)
returns table (bucket date)
language sql
stable
as $$
  select generate_series(
    public.analytics_bucket((p_from at time zone 'Africa/Cairo')::date, granularity),
    public.analytics_bucket(((p_to - interval '1 microsecond') at time zone 'Africa/Cairo')::date, granularity),
    case when granularity = 'week' then interval '7 days' else interval '1 day' end
  )::date
$$;

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
     group by 1
  )
  select b.bucket, coalesce(counts.n, 0)
    from public.analytics_buckets(p_from, p_to, p_granularity) b
    left join counts using (bucket)
   order by b.bucket
$$;

create or replace function public.get_leads_over_time(
  p_client_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_granularity text default 'day'
)
returns table (bucket date, leads bigint)
language sql
stable
security invoker
set search_path = public
as $$
  with counts as (
    select public.analytics_bucket((l.created_at at time zone 'Africa/Cairo')::date, p_granularity) as bucket,
           count(*) as n
      from public.leads l
     where l.created_at >= p_from and l.created_at < p_to
       and (p_client_id is null or l.client_id = p_client_id)
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
   group by ch.type
   order by 2 desc
$$;

-- First response: from the visitor's first message to the first reply after
-- it (AI or human). Human agents are also reported on their own.
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

-- Visitor messages per Cairo hour (0–23), all hours present
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
     group by 1
  )
  select h.hour, coalesce(counts.n, 0)
    from generate_series(0, 23) as h(hour)
    left join counts using (hour)
   order by h.hour
$$;

-- Leads created in the period by current status, every status present
create or replace function public.get_lead_status_breakdown(
  p_client_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
returns table (status lead_status, leads bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select s.status, count(l.id)
    from unnest(enum_range(null::lead_status)) as s(status)
    left join public.leads l
      on l.status = s.status
     and l.created_at >= p_from and l.created_at < p_to
     and (p_client_id is null or l.client_id = p_client_id)
   group by s.status
   order by array_position(enum_range(null::lead_status), s.status)
$$;

-- Per-client totals for the "top clients" table
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
           where cv.client_id = c.id and cv.created_at >= p_from and cv.created_at < p_to),
         count(l.id),
         count(l.id) filter (where l.appointment_at is not null),
         count(l.id) filter (where l.showed_up is true),
         count(l.id) filter (where l.showed_up is false)
    from public.clients c
    left join public.leads l
      on l.client_id = c.id and l.created_at >= p_from and l.created_at < p_to
   group by c.id, c.name
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'get_conversations_over_time(uuid, timestamptz, timestamptz, text)',
    'get_leads_over_time(uuid, timestamptz, timestamptz, text)',
    'get_channel_distribution(uuid, timestamptz, timestamptz)',
    'get_response_time_stats(uuid, timestamptz, timestamptz)',
    'get_peak_hours(uuid, timestamptz, timestamptz)',
    'get_lead_status_breakdown(uuid, timestamptz, timestamptz)',
    'get_client_performance(timestamptz, timestamptz)'
  ] loop
    execute format('revoke execute on function public.%s from public, anon', fn);
    execute format('grant execute on function public.%s to authenticated, service_role', fn);
  end loop;
end $$;
