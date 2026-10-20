import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { createUser, serviceClient, userClient } from '../harness/helpers'
import { signJwt } from '../harness/jwt'

/**
 * supabase/migrations/20261029100000_legal_versions.sql: the legal pages,
 * versioned. Append-only, read by anyone (published columns only), written
 * only by a super admin through publish_legal_version, and an account's
 * acceptance recorded once at signup and never changed.
 */

type Version = { id: string; document: string; locale: string; version: number; title: string; body: string; created_at: string }

/** A visitor with no account: the public site's publishable key */
const anonClient = () =>
  createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, signJwt({ role: 'anon', iss: 'supabase' }), {
    auth: { persistSession: false, autoRefreshToken: false },
  })

async function rpc<T>(fn: string, args: Record<string, unknown>) {
  const { data, error } = await serviceClient().rpc(fn, args)
  if (error) throw new Error(`${fn}: ${error.message}`)
  return data as T
}

/** The SQLSTATE the database refuses `statement` with, or null (tests/branches/schema.test.ts) */
const refusal = (statement: string) => rpc<string | null>('test_sqlstate', { statement })

async function current(document: 'privacy' | 'terms', locale: 'ar' | 'en') {
  const { data, error } = await anonClient()
    .from('legal_versions')
    .select('id, document, locale, version, title, body, created_at')
    .eq('document', document)
    .eq('locale', locale)
    .order('version', { ascending: false })
    .limit(1)
    .single<Version>()
  if (error) throw new Error(error.message)
  return data
}

describe('version 1 is the current drafts', () => {
  it('holds all four documents, readable by anyone', async () => {
    for (const document of ['privacy', 'terms'] as const) {
      for (const locale of ['ar', 'en'] as const) {
        const { data } = await anonClient().from('legal_versions').select('version').eq('document', document).eq('locale', locale).eq('version', 1)
        expect(data).toHaveLength(1)
      }
    }
  })
})

describe('what a visitor can read', () => {
  it('reads the published columns', async () => {
    const version = await current('terms', 'en')
    expect(version.title.length).toBeGreaterThan(0)
    expect(version.body).toContain('## ')
  })

  it('cannot read who saved a version, or its internal note', async () => {
    for (const column of ['created_by', 'note']) {
      const { error } = await anonClient().from('legal_versions').select(column).limit(1)
      expect(error, column).not.toBeNull()
    }
  })

  it('cannot write: no insert, and no publishing', async () => {
    expect(await refusal(`set local role anon; insert into public.legal_versions (document, locale, version, title, body) values ('terms', 'en', 99, 'x', 'y')`)).toBe('42501')
    const { error } = await anonClient().rpc('publish_legal_version', { p_document: 'terms', p_locale: 'en', p_title: 'x', p_body: 'y' })
    expect(error).not.toBeNull()
  })
})

describe('append-only', () => {
  it('refuses to update, delete or truncate a version, for everyone (service role included)', async () => {
    expect(await refusal(`update public.legal_versions set body = 'changed' where version = 1`)).toBe('42501')
    expect(await refusal(`delete from public.legal_versions where version = 1`)).toBe('42501')
    // Refused before the trigger is reached: users references the table (0A000)
    expect(await refusal(`truncate public.legal_versions`)).not.toBeNull()
  })
})

describe('publishing a version', () => {
  it('is refused to anyone but a super admin, and adds nothing', async () => {
    const admin = await createUser('org_admin', null, 'Org admin')
    const before = await current('terms', 'en')
    const { error } = await userClient(admin.id).rpc('publish_legal_version', { p_document: 'terms', p_locale: 'en', p_title: 'T', p_body: 'B' })
    // Over REST the refusal drops pglite's connection, so only that it failed is
    // visible here (helpers.ts); the version count is the evidence
    expect(error).not.toBeNull()
    expect((await current('terms', 'en')).version).toBe(before.version)
  })

  it('adds the next version of that document in that language, with who saved it, and leaves the old one as it was', async () => {
    const superAdmin = await createUser('super_admin', null, 'Platform')
    const before = await current('privacy', 'ar')
    const otherLanguage = await current('privacy', 'en')
    const title = `Privacy ${randomUUID().slice(0, 6)}`

    const { data, error } = await userClient(superAdmin.id).rpc('publish_legal_version', {
      p_document: 'privacy',
      p_locale: 'ar',
      p_title: title,
      p_body: 'Body',
      p_note: 'test',
    })
    expect(error).toBeNull()
    expect(data).toMatchObject({ document: 'privacy', locale: 'ar', version: before.version + 1, title, created_by: superAdmin.id })

    expect((await current('privacy', 'ar')).title).toBe(title)
    // The previous version is untouched, and the other language has its own history
    const { data: old } = await anonClient().from('legal_versions').select('title, body').eq('id', before.id).single()
    expect(old).toEqual({ title: before.title, body: before.body })
    expect((await current('privacy', 'en')).version).toBe(otherLanguage.version)
  })

  it('shows a super admin who saved each version, through the admin function only', async () => {
    const superAdmin = await createUser('super_admin', null, 'Platform')
    const { data } = await userClient(superAdmin.id).rpc('admin_legal_versions')
    expect((data as { created_by: string | null }[]).length).toBeGreaterThan(0)
    const member = await createUser('team_member', null, 'Member')
    const { data: none } = await userClient(member.id).rpc('admin_legal_versions')
    expect(none).toEqual([])
  })
})

describe('acceptance at signup', () => {
  const signUp = async (meta: Record<string, unknown>) => {
    const id = await rpc<string>('test_create_auth_user_with_meta', {
      p_email: `${randomUUID().slice(0, 12)}@example.com`,
      p_meta: { organization_name: `Org ${randomUUID().slice(0, 6)}`, ...meta },
    })
    const { data, error } = await serviceClient()
      .from('users')
      .select('accepted_terms_version_id, accepted_privacy_version_id, legal_accepted_at')
      .eq('id', id)
      .single<{ accepted_terms_version_id: string | null; accepted_privacy_version_id: string | null; legal_accepted_at: string | null }>()
    if (error) throw new Error(error.message)
    return { id, ...data }
  }

  it('records the versions the person agreed to, and when', async () => {
    const terms = await current('terms', 'ar')
    const privacy = await current('privacy', 'ar')
    const user = await signUp({ accepted_legal: { terms: terms.id, privacy: privacy.id } })
    expect(user).toMatchObject({ accepted_terms_version_id: terms.id, accepted_privacy_version_id: privacy.id })
    expect(user.legal_accepted_at).not.toBeNull()
  })

  it('records nothing when the form sent nothing (the checkbox is off until the pages are relinked)', async () => {
    expect(await signUp({})).toMatchObject({ accepted_terms_version_id: null, accepted_privacy_version_id: null, legal_accepted_at: null })
  })

  it('records nothing for ids that are not versions of those documents, or for only one of the two', async () => {
    const terms = await current('terms', 'en')
    const privacy = await current('privacy', 'en')
    const none = { accepted_terms_version_id: null, accepted_privacy_version_id: null, legal_accepted_at: null }
    // Swapped: a privacy version given as the terms
    expect(await signUp({ accepted_legal: { terms: privacy.id, privacy: terms.id } })).toMatchObject(none)
    expect(await signUp({ accepted_legal: { terms: randomUUID(), privacy: privacy.id } })).toMatchObject(none)
    expect(await signUp({ accepted_legal: { terms: 'not-a-uuid', privacy: privacy.id } })).toMatchObject(none)
    expect(await signUp({ accepted_legal: { terms: terms.id } })).toMatchObject(none)
  })

  it('never changes a recorded acceptance afterwards', async () => {
    const terms = await current('terms', 'en')
    const privacy = await current('privacy', 'en')
    const user = await signUp({ accepted_legal: { terms: terms.id, privacy: privacy.id } })
    expect(await refusal(`update public.users set accepted_terms_version_id = null where id = '${user.id}'`)).toBe('42501')
    expect(await refusal(`update public.users set legal_accepted_at = now() where id = '${user.id}'`)).toBe('42501')
    // Other columns still change
    expect(await refusal(`update public.users set full_name = 'Renamed' where id = '${user.id}'`)).toBeNull()
  })

  it('does not take an acceptance written straight into the profile row', async () => {
    const terms = await current('terms', 'en')
    const id = await rpc<string>('test_create_auth_user_with_meta', { p_email: `${randomUUID().slice(0, 12)}@example.com`, p_meta: {} })
    // The sign-up trigger's fallback made the profile, with nothing accepted
    const { data } = await serviceClient().from('users').select('accepted_terms_version_id').eq('id', id).single<{ accepted_terms_version_id: string | null }>()
    expect(data?.accepted_terms_version_id ?? null).toBeNull()
    expect(await refusal(`update public.users set accepted_terms_version_id = '${terms.id}' where id = '${id}'`)).toBe('42501')
  })
})
