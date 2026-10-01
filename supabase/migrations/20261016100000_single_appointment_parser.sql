-- ============================================
-- One appointment parser, and auto-confirmed appointments
-- ============================================
-- The reply and the stored appointment used to come from two independent
-- readings of the same sentence (the chat model wrote "6", the analysis model
-- stored 19:00). Now the reply call extracts the appointment's components,
-- the app turns them into an instant and stores it before the reply is sent,
-- and the reply quotes the stored value.

-- What the assistant last set as the appointment: { at, approximate, confirmed }.
-- Written only when the assistant books; while appointment_at still equals
-- `at` the time is the assistant's own and it may move it when the visitor
-- changes their mind. Anything the team sets stays.
alter table public.leads add column ai_appointment jsonb;

update public.leads
   set ai_appointment = jsonb_build_object(
         'at', ai_extracted_data ->> 'appointment_at',
         'approximate', coalesce((ai_extracted_data ->> 'appointment_time_approximate')::boolean, false),
         'confirmed', false)
 where ai_extracted_data ->> 'appointment_at' is not null;

-- Per client: on (the default), the assistant's bookings are confirmed at
-- once; off, they wait for the team to confirm them.
alter table public.bot_settings
  add column auto_confirm_appointments boolean not null default true;

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
    true
$$;
