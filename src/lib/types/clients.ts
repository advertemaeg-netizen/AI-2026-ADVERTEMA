export const CLIENT_STATUSES = ['active', 'paused', 'archived'] as const
export type ClientStatus = (typeof CLIENT_STATUSES)[number]

export const CLIENT_MANAGER_ROLES = ['super_admin', 'org_admin', 'client_admin'] as const

export type Client = {
  id: string
  organization_id: string
  name: string
  slug: string
  industry: string | null
  logo_url: string | null
  description: string | null
  status: ClientStatus
  created_at: string
  updated_at: string
}

export type ClientField = 'name' | 'slug' | 'industry' | 'logo_url' | 'description' | 'status'

export type ClientFieldError =
  | 'nameRequired'
  | 'nameTooLong'
  | 'slugInvalid'
  | 'slugTaken'
  | 'industryTooLong'
  | 'urlInvalid'
  | 'descriptionTooLong'
  | 'statusInvalid'

export type ClientActionError =
  | 'unauthorized'
  | 'forbidden'
  | 'validation'
  | 'slugTaken'
  | 'notFound'
  | 'noOrganization'
  | 'unknown'

export type ClientActionResult =
  | { ok: true }
  | {
      ok: false
      error: ClientActionError
      fieldErrors?: Partial<Record<ClientField, ClientFieldError>>
    }
