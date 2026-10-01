import { z } from 'zod'

export const DISPLAY_NAME_MAX = 100
export const ORGANIZATION_NAME_MAX = 100
export const PASSWORD_MIN = 6

export const displayNameSchema = z.string().trim().min(1).max(DISPLAY_NAME_MAX)
// Same bounds as rename_my_organization()
export const organizationNameSchema = z.string().trim().min(2).max(ORGANIZATION_NAME_MAX)

export type OrganizationSettings = {
  name: string
  /** Fixed at sign-up */
  org_type: 'agency' | 'direct'
}

export type AccountSettings = {
  full_name: string
  email: string
  /** Only for the organization's admins; null for everyone else */
  organization: OrganizationSettings | null
}

export type SettingsActionResult =
  | { ok: true }
  | { ok: false; error: 'unauthorized' | 'forbidden' | 'validation' | 'impersonating' | 'unknown' }
