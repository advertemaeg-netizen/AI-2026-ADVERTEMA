-- ============================================
-- A conversation the assistant could not answer needs a person
-- ============================================
-- When the AI call fails (rate limit, timeout, the model overloaded) the
-- visitor gets a message saying so instead of an error, and the conversation
-- is marked so the team sees it in the inbox and on the dashboard: nobody has
-- actually answered the visitor.

-- --------------------------------------------
-- 1. The mark
-- --------------------------------------------
alter table public.conversations
  add column needs_human_since timestamptz;

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
       set needs_human_since = null
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
-- 2. What the visitor is told. Not fallback_message: that one means "I don't
--    have this information" (a gap in the knowledge base); this one means
--    the service is down, whatever the knowledge base holds.
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
