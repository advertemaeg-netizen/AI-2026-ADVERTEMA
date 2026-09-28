'use server'

import { revalidatePath } from 'next/cache'
import { canManage, getSession, isImpersonating } from '@/lib/auth/session'
import { checkOrgLimit, guardLimit, limitErrorFromDb } from '@/lib/subscription-limits'
import { getClientContext } from '@/lib/auth/client-context'
import {
  CLIENT_STATUSES,
  type Client,
  type ClientActionResult,
  type ClientField,
  type ClientFieldError,
  type ClientStatus,
  UUID_PATTERN,
} from '@/lib/types/clients'

const CLIENTS_PATH = '/[locale]/dashboard/clients'
const SLUG_PATTERN = /^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u

function slugify(value: string) {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

/** A taken auto-generated slug gets a short random suffix, like "عيادة-النور-3f9a" */
function withRandomSuffix(slug: string) {
  return `${slug.slice(0, 55)}-${crypto.randomUUID().slice(0, 4)}`
}

/**
 * Runs a clients write; when the slug was generated from the name (the user
 * left it empty) and another client of the organization already has it,
 * retries with a suffixed slug instead of reporting it as taken. A slug the
 * user typed is still reported, since they chose it.
 */
async function writeWithFreeSlug<T extends { error: { code?: string } | null }>(
  values: { slug: string },
  slugIsAuto: boolean,
  write: (slug: string) => PromiseLike<T>
): Promise<T> {
  let result = await write(values.slug)
  for (let attempt = 0; slugIsAuto && result.error?.code === '23505' && attempt < 3; attempt++) {
    result = await write(withRandomSuffix(values.slug))
  }
  return result
}

function parseClientForm(formData: FormData) {
  const str = (key: string) => String(formData.get(key) ?? '').trim()
  const name = str('name')
  const industry = str('industry')
  const logoUrl = str('logo_url')
  const description = str('description')
  const status = str('status') || 'active'
  const slugIsAuto = !str('slug')
  const slug = slugify(str('slug') || name) || `client-${crypto.randomUUID().slice(0, 8)}`

  const fieldErrors: Partial<Record<ClientField, ClientFieldError>> = {}

  if (!name) fieldErrors.name = 'nameRequired'
  else if (name.length > 100) fieldErrors.name = 'nameTooLong'

  if (!SLUG_PATTERN.test(slug)) fieldErrors.slug = 'slugInvalid'

  if (industry.length > 100) fieldErrors.industry = 'industryTooLong'

  if (logoUrl) {
    try {
      const url = new URL(logoUrl)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') fieldErrors.logo_url = 'urlInvalid'
    } catch {
      fieldErrors.logo_url = 'urlInvalid'
    }
  }

  if (description.length > 1000) fieldErrors.description = 'descriptionTooLong'

  if (!(CLIENT_STATUSES as readonly string[]).includes(status)) fieldErrors.status = 'statusInvalid'

  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false as const, fieldErrors }
  }

  return {
    ok: true as const,
    slugIsAuto,
    values: {
      name,
      slug,
      industry: industry || null,
      logo_url: logoUrl || null,
      description: description || null,
      status: status as ClientStatus,
    },
  }
}

function dbError(error: { code?: string; message: string; hint?: string | null }): ClientActionResult {
  // A direct business has exactly one client (database trigger)
  if (error.message?.includes('direct_single_client')) return { ok: false, error: 'directSingleClient' }
  // The subscription limit trigger (a race past the check below)
  const limit = limitErrorFromDb(error)
  if (limit) return { ok: false, error: limit }
  // 23505 = unique_violation on (organization_id, slug)
  if (error.code === '23505') {
    return { ok: false, error: 'slugTaken', fieldErrors: { slug: 'slugTaken' } }
  }
  // 42501 = insufficient_privilege (RLS rejected the write)
  if (error.code === '42501') return { ok: false, error: 'forbidden' }
  console.error('[clients]', error)
  return { ok: false, error: 'unknown' }
}

export async function getClients(): Promise<Client[]> {
  const { supabase, profile } = await getSession()
  if (!profile) return []

  // RLS limits rows to clients the current user has access to
  const { data, error } = await supabase
    .from('clients')
    .select('*')
    .order('created_at', { ascending: false })
    .returns<Client[]>()

  if (error) throw new Error(`Failed to load clients: ${error.message}`)
  return data
}

export async function getClient(id: string): Promise<Client | null> {
  if (!UUID_PATTERN.test(id)) return null
  const { supabase, profile } = await getSession()
  if (!profile) return null

  const { data, error } = await supabase
    .from('clients')
    .select('*')
    .eq('id', id)
    .maybeSingle<Client>()

  if (error) throw new Error(`Failed to load client: ${error.message}`)
  return data
}

export async function getClientPermissions(): Promise<{ canManage: boolean }> {
  const { profile } = await getSession()
  return { canManage: profile ? canManage(profile) : false }
}

export async function createClientAction(formData: FormData): Promise<ClientActionResult> {
  if (await isImpersonating()) return { ok: false, error: 'impersonating' }
  const { supabase, profile } = await getSession()
  if (!profile) return { ok: false, error: 'unauthorized' }
  if (!canManage(profile)) return { ok: false, error: 'forbidden' }
  if (!profile.organization_id) return { ok: false, error: 'noOrganization' }

  // A direct business is one business: its client was created at sign-up
  if ((await getClientContext())?.orgType === 'direct') return { ok: false, error: 'directSingleClient' }

  const parsed = parseClientForm(formData)
  if (!parsed.ok) return { ok: false, error: 'validation', fieldErrors: parsed.fieldErrors }

  // The number of clients is the agency plan's limit
  const blocked = await guardLimit(checkOrgLimit(supabase, profile.organization_id, 'clients'))
  if (blocked) return { ok: false, error: blocked }

  // No .select() here: a client_admin only gains read access through the
  // client_members row added by an AFTER INSERT trigger, so RETURNING would
  // be rejected by RLS.
  const organizationId = profile.organization_id
  const { error } = await writeWithFreeSlug(parsed.values, parsed.slugIsAuto, (slug) =>
    supabase.from('clients').insert({
      id: crypto.randomUUID(),
      organization_id: organizationId,
      ...parsed.values,
      slug,
    })
  )

  if (error) return dbError(error)

  revalidatePath(CLIENTS_PATH, 'page')
  return { ok: true }
}

export async function updateClientAction(
  id: string,
  formData: FormData
): Promise<ClientActionResult> {
  if (await isImpersonating()) return { ok: false, error: 'impersonating' }
  const { supabase, profile } = await getSession()
  if (!profile) return { ok: false, error: 'unauthorized' }
  if (!canManage(profile)) return { ok: false, error: 'forbidden' }

  const parsed = parseClientForm(formData)
  if (!parsed.ok) return { ok: false, error: 'validation', fieldErrors: parsed.fieldErrors }

  const { data, error } = await writeWithFreeSlug(parsed.values, parsed.slugIsAuto, (slug) =>
    supabase
      .from('clients')
      .update({ ...parsed.values, slug })
      .eq('id', id)
      .select('id')
  )

  if (error) return dbError(error)
  // RLS filters out rows the user can't touch, which shows up as zero rows
  if (!data || data.length === 0) return { ok: false, error: 'notFound' }

  revalidatePath(CLIENTS_PATH, 'page')
  return { ok: true }
}

export async function deleteClientAction(id: string): Promise<ClientActionResult> {
  if (await isImpersonating()) return { ok: false, error: 'impersonating' }
  const { supabase, profile } = await getSession()
  if (!profile) return { ok: false, error: 'unauthorized' }
  if (!canManage(profile)) return { ok: false, error: 'forbidden' }

  const { data, error } = await supabase.from('clients').delete().eq('id', id).select('id')

  if (error) return dbError(error)
  if (!data || data.length === 0) return { ok: false, error: 'notFound' }

  revalidatePath(CLIENTS_PATH, 'page')
  return { ok: true }
}
