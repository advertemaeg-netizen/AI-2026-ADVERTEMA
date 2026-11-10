import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StorageClient } from '@supabase/storage-js'
import { getKnowledgeFileUrl } from '@/lib/actions/knowledge'
import { canManageClient } from '@/lib/auth/permissions'
import { createUser, seedClient, serviceClient, type TestUser } from '../harness/helpers'

/**
 * THE KNOWLEDGE PAGE'S DOWNLOAD BUTTON (2026-11-10): the original file, as
 * uploaded. WHAT THIS DOES NOT PROVE: the test stack has no storage server,
 * so the signing call is faked here. It proves who is let through to it, and
 * what it is asked for (the path, fifteen minutes, the uploaded name); it
 * does NOT prove that a real file comes back or that the storage policy lets
 * a real admin read it. That is checked by downloading a real file from
 * production after the deploy.
 */

const session = { user: null as TestUser | null }
vi.mock('@/lib/auth/session', () => ({
  getSession: async () => {
    const { userClient, serviceClient: service } = await import('../harness/helpers')
    return { supabase: session.user ? userClient(session.user.id) : service(), profile: session.user, impersonation: null }
  },
  isImpersonating: async () => false,
  canManage: (profile: { role: string }) => canManageClient(profile.role),
}))
vi.mock('next/cache', () => ({ revalidatePath: () => {} }))

type Signed = { bucket: string; path: string; seconds: number; options: unknown }
let signed: Signed[] = []

beforeEach(() => {
  signed = []
  vi.spyOn(StorageClient.prototype, 'from').mockImplementation(function (bucket: string) {
    return {
      createSignedUrl: async (path: string, seconds: number, options: unknown) => {
        signed.push({ bucket, path, seconds, options })
        return { data: { signedUrl: `https://storage.test/${path}?token=t` }, error: null }
      },
    } as never
  })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  session.user = null
  vi.restoreAllMocks()
})

async function uploadedDocument() {
  const seeded = await seedClient()
  const service = serviceClient()
  const id = crypto.randomUUID()
  const path = `${seeded.clientId}/${id}.pdf`
  const { error } = await service.from('knowledge_documents').insert({ id, client_id: seeded.clientId, title: 'أسعار العيادة.pdf', file_url: path, file_type: 'pdf', status: 'ready' })
  if (error) throw error
  return { ...seeded, id, path }
}

describe('opening a PDF in a tab', () => {
  it('a PDF gets a link with no download disposition, so the browser shows it', async () => {
    const { organizationId, id, path } = await uploadedDocument()
    session.user = await createUser('org_admin', organizationId, 'مدير')
    expect(await getKnowledgeFileUrl(id, 'view')).toEqual({ ok: true, url: `https://storage.test/${path}?token=t` })
    expect(signed).toEqual([{ bucket: 'knowledge-base', path, seconds: 900, options: undefined }])
  })

  it('Word and plain text are never offered for a tab: nothing is signed', async () => {
    const seeded = await seedClient()
    const service = serviceClient()
    const ids = await Promise.all(
      (['docx', 'txt'] as const).map(async (type) => {
        const id = crypto.randomUUID()
        const { error } = await service.from('knowledge_documents').insert({ id, client_id: seeded.clientId, title: `f.${type}`, file_url: `${seeded.clientId}/${id}.${type}`, file_type: type, status: 'ready' })
        if (error) throw error
        return id
      })
    )
    session.user = await createUser('org_admin', seeded.organizationId, 'مدير')
    for (const id of ids) expect(await getKnowledgeFileUrl(id, 'view')).toEqual({ ok: false, error: 'notFound' })
    expect(signed).toEqual([])
    // Downloading them still works
    expect((await getKnowledgeFileUrl(ids[0])).ok).toBe(true)
  })
})

describe('downloading a knowledge file as uploaded', () => {
  it('an admin of the client gets a fifteen-minute link to the file, under its uploaded name', async () => {
    const { organizationId, id, path } = await uploadedDocument()
    session.user = await createUser('org_admin', organizationId, 'مدير')
    const result = await getKnowledgeFileUrl(id)
    expect(result).toEqual({ ok: true, url: `https://storage.test/${path}?token=t` })
    expect(signed).toEqual([{ bucket: 'knowledge-base', path, seconds: 900, options: { download: 'أسعار العيادة.pdf' } }])
  })

  it('an admin of another organization gets nothing, and nothing is signed', async () => {
    const { id } = await uploadedDocument()
    const other = await seedClient()
    session.user = await createUser('org_admin', other.organizationId, 'غريب')
    expect(await getKnowledgeFileUrl(id)).toEqual({ ok: false, error: 'notFound' })
    expect(signed).toEqual([])
  })

  it('a team member is refused before anything is read', async () => {
    const { organizationId, id } = await uploadedDocument()
    session.user = await createUser('team_member', organizationId, 'موظف')
    expect(await getKnowledgeFileUrl(id)).toEqual({ ok: false, error: 'forbidden' })
    expect(signed).toEqual([])
  })

  it('a chunk row, a bad id, or a document without a file has no link', async () => {
    const { organizationId, clientId, id } = await uploadedDocument()
    const service = serviceClient()
    const chunkId = crypto.randomUUID()
    await service.from('knowledge_documents').insert({ id: chunkId, client_id: clientId, source_document_id: id, title: 'x', content: 'نص', chunk_index: 0, status: 'ready' })
    const bare = crypto.randomUUID()
    await service.from('knowledge_documents').insert({ id: bare, client_id: clientId, title: 'typed', status: 'ready' })
    session.user = await createUser('org_admin', organizationId, 'مدير')
    expect(await getKnowledgeFileUrl(chunkId)).toEqual({ ok: false, error: 'notFound' })
    expect(await getKnowledgeFileUrl('not-a-uuid')).toEqual({ ok: false, error: 'notFound' })
    expect(await getKnowledgeFileUrl(bare)).toEqual({ ok: false, error: 'notFound' })
    expect(signed).toEqual([])
  })
})
