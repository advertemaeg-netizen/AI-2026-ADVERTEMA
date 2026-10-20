/**
 * The legal pages' cache, end to end (npm run check:legal-cache):
 *
 *   1. Interval: a version published outside the editor shows once the
 *      interval has passed (the first request after it serves the cached page
 *      and regenerates; the next one is new).
 *   2. Save: a version published through the editor's server action shows on
 *      the very next request, current page and its own address.
 *   3. The new version's address, requested BEFORE it existed (a 404), shows
 *      the version right after the save.
 *   4. Outage: with the database unreachable past the interval, the page is
 *      still served, with its last good text, not an error.
 *   5. Version addresses with no version behind them answer 404 and write
 *      nothing under .next: earlier versions are never cached, so no request,
 *      whatever number it asks for, leaves a stored 404 behind.
 *
 * Self-contained and local: the test database (tests/harness/stack.ts, every
 * migration applied), a proxy in front of it (Supabase's /rest/v1 paths, the
 * one auth call the server makes, and an off switch for the outage), and the
 * app built and served with LEGAL_REVALIDATE_SECONDS=10 (src/lib/legal.ts) so
 * nothing waits five minutes. Nothing reaches production.
 *
 * It REBUILDS .next with these test settings: build again before serving
 * .next for anything else.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import http from 'node:http'
import { createServer } from 'node:net'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { signJwt } from '../tests/harness/jwt'
import { startStack } from '../tests/harness/stack'

const ROOT = path.resolve(__dirname, '..')
const INTERVAL = 10
const results: { check: string; passed: boolean; detail: string }[] = []
const record = (check: string, passed: boolean, detail: string) => {
  results.push({ check, passed, detail })
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${check} — ${detail}`)
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Every file under .next, as path → size and modification time: what a request wrote shows as a difference */
function snapshot() {
  const files = new Map<string, string>()
  for (const entry of readdirSync(path.join(ROOT, '.next'), { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue
    const full = path.join(entry.parentPath, entry.name)
    const stat = statSync(full)
    files.set(path.relative(ROOT, full), `${stat.size}:${stat.mtimeMs}`)
  }
  return files
}

function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })
}

/** A request with an explicit Host: the site's pages are served on its host only */
function request(
  port: number,
  pathname: string,
  options: {
    host?: string
    method?: string
    headers?: Record<string, string>
    body?: string
  } = {}
) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method: options.method ?? 'GET',
        headers: {
          host: options.host ?? `localhost:${port}`,
          ...options.headers,
        },
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => (body += chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      }
    )
    req.on('error', reject)
    if (options.body) req.write(options.body)
    req.end()
  })
}

// In its own process group: `npx next start` spawns next-server, which a
// signal to npx alone would leave running (and holding this script open)
function run(command: string, args: string[], env: Record<string, string>, log: string[]) {
  const child = spawn(command, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  child.stdout.on('data', (d) => log.push(String(d)))
  child.stderr.on('data', (d) => log.push(String(d)))
  return child
}

function stopGroup(child: ChildProcess | null) {
  if (!child?.pid) return
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    // Already gone
  }
}

async function main() {
  const stack = await startStack()
  let proxy: http.Server | null = null
  let server: ChildProcess | null = null
  const serverLog: string[] = []
  try {
    const anon = signJwt({ role: 'anon', iss: 'supabase' })
    // The proxy: /rest/v1 → PostgREST, GET /auth/v1/user → the super admin, and an off switch
    let databaseDown = false
    let adminId = ''
    const email = `legal-check-${Date.now()}@example.com`
    const target = new URL(stack.url)
    const proxyPort = await freePort()
    proxy = http.createServer((req, res) => {
      const url = req.url ?? '/'
      if (url.startsWith('/auth/v1/user')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            id: adminId,
            aud: 'authenticated',
            role: 'authenticated',
            email,
            app_metadata: {},
            user_metadata: {},
          })
        )
        return
      }
      if (databaseDown) {
        res.writeHead(503)
        res.end('down for the outage check')
        return
      }
      const forward = http.request(
        {
          host: target.hostname,
          port: target.port,
          method: req.method,
          path: url.startsWith('/rest/v1') ? url.slice('/rest/v1'.length) || '/' : url,
          headers: { ...req.headers, host: target.host },
        },
        (upstream) => {
          res.writeHead(upstream.statusCode ?? 502, upstream.headers)
          upstream.pipe(res)
        }
      )
      forward.on('error', () => {
        res.writeHead(502)
        res.end()
      })
      req.pipe(forward)
    })
    await new Promise<void>((resolve) => proxy!.listen(proxyPort, '127.0.0.1', resolve))
    const supabaseUrl = `http://127.0.0.1:${proxyPort}`

    const service = createClient(supabaseUrl, stack.serviceKey, {
      auth: { persistSession: false },
    })

    // A super admin, signed in as the browser would be
    const { data: createdId, error: userError } = await service.rpc('test_create_auth_user', { p_email: email })
    if (userError) throw userError
    adminId = createdId as string
    const { error: profileError } = await service.from('users').upsert({
      id: adminId,
      email,
      full_name: 'Legal check',
      role: 'super_admin',
    })
    if (profileError) throw profileError
    const adminToken = signJwt({
      sub: adminId,
      role: 'authenticated',
      iss: 'supabase',
      aud: 'authenticated',
      email,
    })

    const env = {
      NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: anon,
      SUPABASE_SECRET_KEY: stack.serviceKey,
      LEGAL_REVALIDATE_SECONDS: String(INTERVAL),
    }

    console.log(`building with LEGAL_REVALIDATE_SECONDS=${INTERVAL} against the test database…`)
    const buildLog: string[] = []
    const build = run('npx', ['next', 'build'], env, buildLog)
    const buildCode = await new Promise<number>((resolve) => build.on('exit', (code) => resolve(code ?? 1)))
    if (buildCode !== 0) throw new Error(`next build failed:\n${buildLog.join('').slice(-3000)}`)

    const port = await freePort()
    server = run('npx', ['next', 'start', '-p', String(port)], env, serverLog)
    const site = `site.localhost:${port}`
    for (let i = 0; ; i += 1) {
      const ok = await request(port, '/ar/privacy', { host: site }).then(
        (r) => r.status === 200,
        () => false
      )
      if (ok) break
      if (i > 60) throw new Error(`the server did not start:\n${serverLog.join('').slice(-2000)}`)
      await sleep(1000)
    }
    const page = (pathname: string) => request(port, pathname, { host: site })
    const shows = (body: string, marker: string) => body.includes(marker)

    // 1. Interval: published straight through the database, so nothing refreshes it
    const admin = createClient(supabaseUrl, adminToken, {
      auth: { persistSession: false },
    })
    const intervalMarker = `INTERVAL-${Date.now()}`
    const { error: publishError } = await admin.rpc('publish_legal_version', {
      p_document: 'privacy',
      p_locale: 'ar',
      p_title: intervalMarker,
      p_body: '## Section\n\nPublished outside the editor.',
    })
    if (publishError) throw publishError
    const right = await page('/ar/privacy')
    await sleep((INTERVAL + 2) * 1000)
    await page('/ar/privacy') // serves the cached page and starts regenerating
    await sleep(3000)
    const after = await page('/ar/privacy')
    record(
      'interval',
      !shows(right.body, intervalMarker) && shows(after.body, intervalMarker),
      `right after publishing: ${shows(right.body, intervalMarker) ? 'new (not cached?)' : 'cached'}; after ${INTERVAL}s: ${shows(after.body, intervalMarker) ? 'new' : 'still old'}`
    )

    // 2 and 3. The save, through the editor's server action; the new version's
    // address requested first, while it doesn't exist
    const { data: versions } = await service
      .from('legal_versions')
      .select('version')
      .eq('document', 'privacy')
      .eq('locale', 'ar')
      .order('version', { ascending: false })
      .limit(1)
      .single<{ version: number }>()
    const nextVersion = (versions?.version ?? 0) + 1
    const before404 = await page(`/ar/privacy/v/${nextVersion}`)
    const manifest = JSON.parse(readFileSync(path.join(ROOT, '.next/server/server-reference-manifest.json'), 'utf8')) as {
      node: Record<string, { exportedName?: string; filename?: string }>
    }
    const actionId = Object.entries(manifest.node).find(([, entry]) => entry.exportedName === 'publishLegalVersion')?.[0]
    if (!actionId) throw new Error('publishLegalVersion is not in the server action manifest')
    const session = {
      access_token: adminToken,
      refresh_token: 'not-used',
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: { id: adminId, aud: 'authenticated', role: 'authenticated', email },
    }
    const cookie = `sb-127-auth-token=base64-${Buffer.from(JSON.stringify(session)).toString('base64url')}`
    const saveMarker = `SAVED-${Date.now()}`
    const saved = await request(port, '/ar/admin/legal', {
      method: 'POST',
      headers: {
        'next-action': actionId,
        'content-type': 'text/plain;charset=UTF-8',
        accept: 'text/x-component',
        origin: `http://localhost:${port}`,
        cookie,
      },
      body: JSON.stringify([
        {
          document: 'privacy',
          locale: 'ar',
          title: saveMarker,
          body: '## Section\n\nSaved in the editor.',
        },
      ]),
    })
    const savedOk = saved.status === 200 && saved.body.includes(`"version":${nextVersion}`)
    record('save went through the server action', savedOk, `status ${saved.status}${savedOk ? `, version ${nextVersion}` : `: ${saved.body.slice(0, 200)}`}`)
    const current = await page('/ar/privacy')
    record(
      'save shows on the next request',
      shows(current.body, saveMarker),
      shows(current.body, saveMarker) ? 'current page is the saved version' : 'current page still old'
    )
    const ownAddress = await page(`/ar/privacy/v/${nextVersion}`)
    record(
      "the new version's address, a 404 before it existed",
      before404.status === 404 && ownAddress.status === 200 && shows(ownAddress.body, saveMarker),
      `before the save: ${before404.status}; right after: ${ownAddress.status}`
    )

    // 5. Addresses with no version behind them: a 404 each, and nothing written
    // for them. A version page also reads its document's current version and
    // history, a fixed set of cached reads per document and language: one
    // missing number per pair first, so those are in place, then different
    // numbers, which must write nothing at all.
    for (const address of ['/ar/privacy/v/901', '/en/privacy/v/901', '/ar/terms/v/901', '/en/terms/v/901']) await page(address)
    await sleep(3000)
    const missing = ['/ar/privacy/v/999', '/ar/privacy/v/517', '/en/terms/v/123', '/ar/terms/v/7', '/en/privacy/v/88']
    const filesBefore = snapshot()
    const statuses: number[] = []
    for (let round = 0; round < 3; round += 1) {
      for (const address of missing) statuses.push((await page(address)).status)
    }
    // Longer than three digits never reaches a render: the proxy sends it on
    const tooLong = await page('/ar/privacy/v/1000')
    await sleep(3000)
    const filesAfter = snapshot()
    const written = [...filesAfter].filter(([file, sig]) => filesBefore.get(file) !== sig).map(([file]) => file)
    record(
      'missing versions are 404s that write nothing',
      statuses.every((s) => s === 404) && tooLong.status === 302 && written.length === 0,
      `${statuses.length} requests: ${[...new Set(statuses)].join('/')}; /v/1000: ${tooLong.status}; files written or changed under .next: ${written.length}${written.length ? ` (${written.slice(0, 8).join(', ')})` : ''}`
    )

    // 4. Outage past the interval: the last good page, not an error
    databaseDown = true
    await sleep((INTERVAL + 2) * 1000)
    const during = await page('/ar/privacy')
    await sleep(3000)
    const stillDuring = await page('/ar/privacy')
    databaseDown = false
    record(
      'outage',
      during.status === 200 && stillDuring.status === 200 && shows(stillDuring.body, saveMarker),
      `database unreachable for ${INTERVAL + 5}s: ${during.status}, then ${stillDuring.status}, ${shows(stillDuring.body, saveMarker) ? 'last good text' : 'text lost'}`
    )
  } finally {
    stopGroup(server)
    proxy?.close()
    await stack.stop()
  }

  const failed = results.filter((r) => !r.passed)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  if (failed.length > 0) {
    console.log(`server log (tail):\n${serverLog.join('').slice(-3000)}`)
    process.exit(1)
  }
  // Nothing left open may keep the run alive
  process.exit(0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
