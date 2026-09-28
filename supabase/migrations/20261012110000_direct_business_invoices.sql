-- ============================================
-- INVOICES FOR DIRECT BUSINESSES
--
-- Three kinds of invoice, one number sequence (INV-<year>-0001):
--   billed_to = 'platform', client_id null  → platform → agency (its agency plan)
--   billed_to = 'platform', client_id set   → platform → direct business
--                                             (its one client's business plan)
--   billed_to = 'agency',   client_id set   → agency → its client
-- Who's billed follows from the organization's type, so the database sets
-- billed_to (and, for a direct business, client_id) on insert.
-- ============================================

alter table public.invoices drop constraint invoices_billed_to_client;
alter table public.invoices
  add constraint invoices_billed_to_client check (billed_to = 'platform' or client_id is not null);

-- Not security definer: current_user tells API calls from trusted functions.
-- Reads organizations/clients the caller can already see (super admins and
-- org admins issue invoices).
create or replace function public.guard_invoice()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_org_type text;
begin
  if tg_op = 'INSERT' then
    if new.client_id is not null then
      select c.organization_id into new.organization_id from public.clients c where c.id = new.client_id;
    end if;
    select o.org_type into v_org_type from public.organizations o where o.id = new.organization_id;

    if v_org_type = 'direct' then
      -- A direct business pays the platform for its one client's plan
      new.billed_to := 'platform';
      new.subscription_id := null;
      if new.client_id is null then
        select c.id into new.client_id from public.clients c where c.organization_id = new.organization_id limit 1;
      end if;
      if new.client_id is null then
        raise exception 'direct business without a client' using errcode = '23514';
      end if;
    elsif new.client_id is not null then
      new.billed_to := 'agency';
      new.subscription_id := null;
    else
      new.billed_to := 'platform';
    end if;

    if current_user in ('authenticated', 'anon') and new.status = 'paid' then
      raise exception 'invoices are marked paid with mark_invoice_paid()' using errcode = '42501';
    end if;
    return new;
  end if;

  if new.invoice_number is distinct from old.invoice_number
     or new.organization_id is distinct from old.organization_id
     or new.client_id is distinct from old.client_id
     or new.billed_to is distinct from old.billed_to then
    raise exception 'invoice parties and number can''t change' using errcode = '42501';
  end if;
  if current_user in ('authenticated', 'anon') and new.status = 'paid' and old.status <> 'paid' then
    raise exception 'invoices are marked paid with mark_invoice_paid()' using errcode = '42501';
  end if;
  return new;
end;
$$;

-- mark_invoice_paid() already pays the client's subscription whenever the
-- invoice has a client_id, and only super admins may pay platform invoices,
-- so a direct business can't mark its own invoice paid.
-- RLS already lets the owner (org_admin) see the organization's invoices;
-- inserting or updating needs billed_to = 'agency', which a direct
-- business's invoices never are.
