-- ============================================
-- ROW LEVEL SECURITY POLICIES
-- ============================================

-- Enable RLS on all tables
alter table organizations enable row level security;
alter table users enable row level security;
alter table clients enable row level security;
alter table client_members enable row level security;
alter table channels enable row level security;
alter table conversations enable row level security;
alter table messages enable row level security;
alter table leads enable row level security;
alter table knowledge_documents enable row level security;
alter table subscriptions enable row level security;

-- ============================================
-- HELPER FUNCTIONS (in public schema)
-- ============================================

create or replace function public.user_role()
returns user_role as $$
  select role from public.users where id = auth.uid()
$$ language sql security definer stable;

create or replace function public.user_org()
returns uuid as $$
  select organization_id from public.users where id = auth.uid()
$$ language sql security definer stable;

create or replace function public.has_client_access(check_client_id uuid)
returns boolean as $$
  select exists (
    select 1 from public.clients c
    where c.id = check_client_id
    and (
      public.user_role() = 'super_admin'
      or (public.user_role() = 'org_admin' and c.organization_id = public.user_org())
      or exists (
        select 1 from public.client_members cm
        where cm.client_id = c.id and cm.user_id = auth.uid()
      )
    )
  )
$$ language sql security definer stable;

-- ============================================
-- ORGANIZATIONS POLICIES
-- ============================================
create policy "Super admins see all orgs"
  on organizations for select
  using (public.user_role() = 'super_admin');

create policy "Users see their own org"
  on organizations for select
  using (id = public.user_org());

create policy "Super admins manage orgs"
  on organizations for all
  using (public.user_role() = 'super_admin');

-- ============================================
-- USERS POLICIES
-- ============================================
create policy "Users see themselves"
  on users for select
  using (id = auth.uid());

create policy "Super admins see all users"
  on users for select
  using (public.user_role() = 'super_admin');

create policy "Org admins see users in their org"
  on users for select
  using (
    public.user_role() = 'org_admin'
    and organization_id = public.user_org()
  );

create policy "Users update themselves"
  on users for update
  using (id = auth.uid());

create policy "Org admins manage users in their org"
  on users for all
  using (
    public.user_role() in ('super_admin', 'org_admin')
    and (organization_id = public.user_org() or public.user_role() = 'super_admin')
  );

-- ============================================
-- CLIENTS POLICIES
-- ============================================
create policy "Users see clients they have access to"
  on clients for select
  using (public.has_client_access(id));

create policy "Org admins manage clients in their org"
  on clients for all
  using (
    public.user_role() in ('super_admin', 'org_admin')
    and (organization_id = public.user_org() or public.user_role() = 'super_admin')
  );

-- ============================================
-- CLIENT_MEMBERS POLICIES
-- ============================================
create policy "Members see their assignments"
  on client_members for select
  using (
    user_id = auth.uid()
    or public.has_client_access(client_id)
  );

create policy "Admins manage client members"
  on client_members for all
  using (
    public.user_role() in ('super_admin', 'org_admin', 'client_admin')
    and public.has_client_access(client_id)
  );

-- ============================================
-- CHANNELS POLICIES
-- ============================================
create policy "Users see channels of their clients"
  on channels for select
  using (public.has_client_access(client_id));

create policy "Client admins manage channels"
  on channels for all
  using (
    public.user_role() in ('super_admin', 'org_admin', 'client_admin')
    and public.has_client_access(client_id)
  );

-- ============================================
-- CONVERSATIONS POLICIES
-- ============================================
create policy "Users see conversations of their clients"
  on conversations for select
  using (public.has_client_access(client_id));

create policy "Users update conversations of their clients"
  on conversations for update
  using (public.has_client_access(client_id));

create policy "Users insert conversations"
  on conversations for insert
  with check (public.has_client_access(client_id));

-- ============================================
-- MESSAGES POLICIES
-- ============================================
create policy "Users see messages of accessible conversations"
  on messages for select
  using (
    exists (
      select 1 from conversations c
      where c.id = conversation_id
      and public.has_client_access(c.client_id)
    )
  );

create policy "Users insert messages in accessible conversations"
  on messages for insert
  with check (
    exists (
      select 1 from conversations c
      where c.id = conversation_id
      and public.has_client_access(c.client_id)
    )
  );

-- ============================================
-- LEADS POLICIES
-- ============================================
create policy "Users see leads of their clients"
  on leads for select
  using (public.has_client_access(client_id));

create policy "Users manage leads of their clients"
  on leads for all
  using (public.has_client_access(client_id));

-- ============================================
-- KNOWLEDGE DOCUMENTS POLICIES
-- ============================================
create policy "Users see knowledge of their clients"
  on knowledge_documents for select
  using (public.has_client_access(client_id));

create policy "Client admins manage knowledge"
  on knowledge_documents for all
  using (
    public.user_role() in ('super_admin', 'org_admin', 'client_admin')
    and public.has_client_access(client_id)
  );

-- ============================================
-- SUBSCRIPTIONS POLICIES
-- ============================================
create policy "Users see their subscription"
  on subscriptions for select
  using (public.has_client_access(client_id));

create policy "Admins manage subscriptions"
  on subscriptions for all
  using (
    public.user_role() in ('super_admin', 'org_admin')
  );