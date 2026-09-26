-- ============================================
-- BOT SETTINGS (one row per client)
-- ============================================

create table public.bot_settings (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null unique references public.clients(id) on delete cascade,
  system_prompt text not null,
  tone text not null default 'friendly'
    check (tone in ('professional', 'friendly', 'formal', 'casual')),
  language text not null default 'ar'
    check (language in ('ar', 'en', 'both')),
  temperature float not null default 0.7
    check (temperature >= 0 and temperature <= 1),
  -- Soft budget in characters, given to the model as an instruction
  max_response_length int not null default 500
    check (max_response_length between 100 and 2000),
  welcome_message text not null,
  fallback_message text not null,
  lead_qualification_enabled boolean not null default true,
  -- { enabled, timezone, days: { sun..sat: { open, from: 'HH:MM', to: 'HH:MM' } } }
  business_hours jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger bot_settings_updated_at before update on public.bot_settings
  for each row execute function update_updated_at();

-- --------------------------------------------
-- Defaults live here only: used for new clients, for backfilling existing
-- ones, and by get_bot_settings when a row is missing
-- --------------------------------------------
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
    now()
$$;

-- Rows built from bot_settings_defaults() carry a null id; give them one
create or replace function public.bot_settings_fill_id()
returns trigger
language plpgsql
as $$
begin
  if new.id is null then
    new.id := gen_random_uuid();
  end if;
  return new;
end;
$$;

create trigger bot_settings_fill_id before insert on public.bot_settings
  for each row execute function public.bot_settings_fill_id();

-- Existing clients
insert into public.bot_settings
select (public.bot_settings_defaults(c.id)).*
  from public.clients c
on conflict (client_id) do nothing;

-- New clients get default settings automatically
create or replace function public.create_default_bot_settings()
returns trigger
security definer
set search_path = public
as $$
begin
  insert into public.bot_settings
  select (public.bot_settings_defaults(new.id)).*
  on conflict (client_id) do nothing;
  return new;
end;
$$ language plpgsql;

create trigger clients_create_bot_settings after insert on public.clients
  for each row execute function public.create_default_bot_settings();

-- --------------------------------------------
-- RLS: anyone with access to the client can read (the playground and
-- read-only views need it); super/org/client admins can change them
-- --------------------------------------------
alter table public.bot_settings enable row level security;

create policy "Users see bot settings of their clients"
  on public.bot_settings for select
  using (public.has_client_access(client_id));

create policy "Admins manage bot settings of their clients"
  on public.bot_settings for all
  using (public.is_client_manager() and public.has_client_access(client_id))
  with check (public.is_client_manager() and public.has_client_access(client_id));

-- --------------------------------------------
-- Settings for a client, or the defaults if it has no row.
-- security invoker: RLS applies, so callers only read what they may see.
-- --------------------------------------------
create or replace function public.get_bot_settings(client_id uuid)
returns public.bot_settings
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(
    (select s from public.bot_settings s where s.client_id = get_bot_settings.client_id),
    public.bot_settings_defaults(get_bot_settings.client_id)
  )
$$;

revoke execute on function public.get_bot_settings(uuid) from public, anon;
grant execute on function public.get_bot_settings(uuid) to authenticated, service_role;
