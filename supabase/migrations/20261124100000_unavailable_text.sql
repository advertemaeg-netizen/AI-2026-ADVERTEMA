-- ============================================
-- THE "CAN'T ANSWER" TEXT A PATIENT RECEIVES: THE PROMISE, NOT THE REASON
-- (the owner, 2026-11-15)
--
-- The default said "the system is under pressure", which is false for two
-- of its three causes (the plan's messages used up, the subscription
-- inactive) and, for those, tells a patient their clinic has a billing state
-- with us. The patient needs the promise only; the clinic may see the reason
-- (the settings page's hint, unchanged), the patient never may.
--
-- Applies before or after the code that carries the same text
-- (DEFAULT_SERVICE_UNAVAILABLE_MESSAGE): deployed code reads the stored row.
--
-- 1. the column's default and bot_settings_defaults(), for every new client;
-- 2. every client still holding the old default word for word (never one
--    that wrote its own), so no patient gets the old reason again. The review
--    clinic is among them if it never changed it: one row, one text, only
--    ever sent when the assistant cannot answer.
-- ============================================

alter table public.bot_settings alter column service_unavailable_message set default 'مش قادر أرد دلوقتي. الفريق هيشوف رسالتك ويرد عليك قريب.';

update public.bot_settings
   set service_unavailable_message = 'مش قادر أرد دلوقتي. الفريق هيشوف رسالتك ويرد عليك قريب.'
 where service_unavailable_message = 'فيه ضغط على النظام دلوقتي ومش قادر أرد. الفريق هيشوف رسالتك ويرد عليك قريب — ولو مستعجل اتصل بينا.';

-- bot_settings_defaults() as 20261030100000 left it, with the new text
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
    'مش قادر أرد دلوقتي. الفريق هيشوف رسالتك ويرد عليك قريب.',
    null, -- booking_mode: follows the opening hours until someone chooses
    'single'
$$;
