-- ============================================
-- AI COST IS FOR SUPER ADMINS ONLY
--
-- What the AI costs is the platform's business: agencies and client admins
-- no longer see ai_usage rows, a client's AI usage, or AI cost alerts.
-- ============================================

drop policy if exists "AI usage: super admins, org admins, client admins" on public.ai_usage;

create policy "Super admins see AI usage"
  on public.ai_usage for select
  using (public.is_super_admin());

-- Was readable by a client's agency; the admin panel uses get_ai_usage_report
drop function if exists public.get_client_ai_usage(uuid, int);

-- Org admins keep their usage limit alerts, but not the AI cost ones
drop policy if exists "Org admins see their usage alerts" on public.usage_alerts;

create policy "Org admins see their usage alerts"
  on public.usage_alerts for select
  using (
    public.user_role() = 'org_admin'
    and organization_id = public.user_org()
    and limit_type <> 'ai_cost'
  );
