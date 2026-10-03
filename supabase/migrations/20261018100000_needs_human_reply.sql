-- ============================================
-- A conversation the assistant could not answer needs a person
-- ============================================
-- Whenever the visitor did not get a real answer, they are told so (one
-- message, whatever the cause) and the conversation is marked with the cause,
-- so the team sees it in the inbox and on the dashboard. Each cause asks
-- something different of the client:
--   service_down   the AI call failed (rate limit, timeout, overloaded): ours to fix
--   limit_reached  the plan's monthly messages are used up: upgrade the plan
--   inactive       the subscription can't be used: pay
--   no_answer      the answer isn't in the knowledge base: add content

-- --------------------------------------------
-- 1. The mark
-- --------------------------------------------
alter table public.conversations
  add column needs_human_since timestamptz,
  add column needs_human_reason text
    check (needs_human_reason in ('service_down', 'limit_reached', 'inactive', 'no_answer'));

create index idx_conversations_needs_human
  on public.conversations (client_id, needs_human_since)
  where needs_human_since is not null;

-- Only a person's reply settles it. A later AI reply answers a later
-- message: the one that failed may still be waiting.
create function public.clear_needs_human()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.role = 'agent' then
    update public.conversations
       set needs_human_since = null,
           needs_human_reason = null
     where id = new.conversation_id
       and needs_human_since is not null;
  end if;
  return new;
end;
$$;

revoke execute on function public.clear_needs_human() from public, anon, authenticated;

create trigger messages_clear_needs_human after insert on public.messages
  for each row execute function public.clear_needs_human();

-- --------------------------------------------
-- 2. Conversations already waiting: a visitor message that got no reply
--    (before this, a failed AI call left nothing behind). Each visitor
--    message gets one reply when the bot works, so in a run of visitor
--    messages followed by fewer replies, the last ones had none. Marked from
--    the first of them, unless a person has replied since.
-- --------------------------------------------
with ordered as (
  select m.conversation_id, m.role, m.created_at, m.id,
         case when m.role = 'user' and lag(m.role) over w is distinct from 'user' then 1 else 0 end as starts
    from public.messages m
   where m.role <> 'system'
  window w as (partition by m.conversation_id order by m.created_at, m.id)
),
-- A block: a run of visitor messages and the replies that follow it
blocks as (
  select *, sum(starts) over (partition by conversation_id order by created_at, id) as block
    from ordered
),
numbered as (
  select *,
         count(*) filter (where role <> 'user') over (partition by conversation_id, block) as replies,
         row_number() over (partition by conversation_id, block, (role = 'user') order by created_at, id) as nth
    from blocks
),
unanswered as (
  select conversation_id, min(created_at) as since
    from numbered
   where role = 'user' and nth > replies
   group by conversation_id
)
update public.conversations c
   set needs_human_since = u.since,
       needs_human_reason = 'service_down'
  from unanswered u
 where c.id = u.conversation_id
   and not exists (
     select 1 from public.messages a
      where a.conversation_id = c.id and a.role = 'agent' and a.created_at > u.since
   );

-- --------------------------------------------
-- 3. What the visitor is told. Not fallback_message: that one is the
--    assistant's own answer when the information is missing (a gap in the
--    knowledge base); this one is sent when the assistant can't answer at
--    all: the service is down, the plan's messages are used up, or the
--    subscription is inactive.
-- --------------------------------------------
alter table public.bot_settings
  add column service_unavailable_message text not null
    default 'فيه ضغط على النظام دلوقتي ومش قادر أرد. الفريق هيشوف رسالتك ويرد عليك قريب — ولو مستعجل اتصل بينا.';

-- The defaults row is positional: the new column comes last
create or replace function public.bot_settings_defaults(p_client_id uuid)
returns public.bot_settings
language sql
stable
set search_path = public
as $$
  select
    null::uuid, -- filled by the bot_settings_fill_id trigger on insert
    p_client_id,
    'أنت مساعد ذكي ودود بيتكلم عربي بشكل طبيعي وبسيط. '
      || 'مهمتك تساعد زوار الموقع وترد على أسئلتهم عن النشاط وخدماته بدقة ولطف، '
      || 'وتفهم هم محتاجين إيه بالظبط وتوجّههم للخطوة الجاية.',
    'friendly',
    'ar',
    0.7::float,
    500,
    'أهلاً بيك! 👋 إزاي أقدر أساعدك النهارده؟',
    'للأسف مش عندي المعلومة دي دلوقتي، بس سيب لي اسمك ورقم تليفونك وحد من فريقنا هيتواصل معاك في أقرب وقت.',
    true,
    null::jsonb,
    now(),
    now(),
    true,
    'فيه ضغط على النظام دلوقتي ومش قادر أرد. الفريق هيشوف رسالتك ويرد عليك قريب — ولو مستعجل اتصل بينا.'
$$;
