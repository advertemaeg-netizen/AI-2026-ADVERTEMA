-- ============================================
-- ADVERTEMA AI - Initial Schema
-- ============================================

-- Enable required extensions
create extension if not exists "pgcrypto";

-- ============================================
-- ORGANIZATIONS (Agencies using the platform)
-- ============================================
create table organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique not null,
  logo_url text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ============================================
-- USERS (extends Supabase auth.users)
-- ============================================
create type user_role as enum ('super_admin', 'org_admin', 'client_admin', 'team_member');

create table users (
  id uuid primary key references auth.users(id) on delete cascade,
  email text unique not null,
  full_name text,
  avatar_url text,
  role user_role not null default 'team_member',
  organization_id uuid references organizations(id) on delete cascade,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ============================================
-- CLIENTS (Businesses served by the agency)
-- ============================================
create table clients (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  slug text not null,
  industry text,
  logo_url text,
  status text default 'active' check (status in ('active', 'paused', 'archived')),
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(organization_id, slug)
);

-- ============================================
-- CLIENT_MEMBERS (Team members assigned to clients)
-- ============================================
create table client_members (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role user_role not null default 'team_member',
  created_at timestamptz default now(),
  unique(client_id, user_id)
);

-- ============================================
-- CHANNELS (WhatsApp/Facebook/Instagram/Website)
-- ============================================
create type channel_type as enum ('website', 'facebook', 'instagram', 'whatsapp');

create table channels (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  type channel_type not null,
  name text not null,
  external_id text,
  credentials jsonb,
  webhook_url text,
  is_active boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ============================================
-- CONVERSATIONS
-- ============================================
create type conversation_status as enum ('new', 'in_progress', 'converted', 'closed');

create table conversations (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  channel_id uuid not null references channels(id) on delete cascade,
  external_conversation_id text,
  contact_name text,
  contact_identifier text,
  status conversation_status default 'new',
  assigned_to uuid references users(id) on delete set null,
  last_message_at timestamptz default now(),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index idx_conversations_client on conversations(client_id);
create index idx_conversations_status on conversations(status);
create index idx_conversations_last_message on conversations(last_message_at desc);

-- ============================================
-- MESSAGES
-- ============================================
create type message_role as enum ('user', 'assistant', 'agent', 'system');

create table messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  role message_role not null,
  content text not null,
  sender_id uuid references users(id) on delete set null,
  metadata jsonb,
  created_at timestamptz default now()
);

create index idx_messages_conversation on messages(conversation_id, created_at);

-- ============================================
-- LEADS (Qualified conversations)
-- ============================================
create type lead_status as enum ('new', 'contacted', 'appointment_booked', 'showed_up', 'no_show', 'lost');

create table leads (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  conversation_id uuid references conversations(id) on delete set null,
  name text,
  phone text,
  service_requested text,
  budget text,
  branch text,
  notes text,
  status lead_status default 'new',
  appointment_at timestamptz,
  showed_up boolean,
  assigned_to uuid references users(id) on delete set null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index idx_leads_client on leads(client_id);
create index idx_leads_status on leads(status);

-- ============================================
-- KNOWLEDGE DOCUMENTS (for RAG later)
-- ============================================
create table knowledge_documents (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  title text not null,
  content text,
  file_url text,
  file_type text,
  status text default 'processing' check (status in ('processing', 'ready', 'failed')),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ============================================
-- SUBSCRIPTIONS
-- ============================================
create type plan_tier as enum ('starter', 'professional', 'business');

create table subscriptions (
  id uuid primary key default gen_random_uuid(),
  client_id uuid unique not null references clients(id) on delete cascade,
  plan plan_tier not null default 'starter',
  messages_limit integer not null default 1000,
  messages_used integer not null default 0,
  agents_limit integer not null default 2,
  channels_limit integer not null default 2,
  status text default 'active' check (status in ('active', 'past_due', 'cancelled')),
  current_period_start timestamptz default now(),
  current_period_end timestamptz default (now() + interval '30 days'),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ============================================
-- UPDATED_AT TRIGGER
-- ============================================
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger organizations_updated_at before update on organizations
  for each row execute function update_updated_at();
create trigger users_updated_at before update on users
  for each row execute function update_updated_at();
create trigger clients_updated_at before update on clients
  for each row execute function update_updated_at();
create trigger channels_updated_at before update on channels
  for each row execute function update_updated_at();
create trigger conversations_updated_at before update on conversations
  for each row execute function update_updated_at();
create trigger leads_updated_at before update on leads
  for each row execute function update_updated_at();
create trigger knowledge_documents_updated_at before update on knowledge_documents
  for each row execute function update_updated_at();
create trigger subscriptions_updated_at before update on subscriptions
  for each row execute function update_updated_at();