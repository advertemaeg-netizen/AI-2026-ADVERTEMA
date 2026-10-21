/**
 * The legal pages' cache, end to end (npm run check:legal-cache):
 *
 *   1. Interval: a version published outside the editor shows once the
 *      interval has passed (the first request after it serves the cached page
 *      and regenerates; the next one is new).
 *   2. Save: a version published through the editor's server action shows on
 *      the current page on the very next request.
 *   3. (with 5) Version addresses are gone (decided 2026-10-21): /v/N is a
 *      404 for every N, a version that exists (the save's own) included, and
 *      shows no version's text.
 *   4. Outage: with the database unreachable past the interval, the page is
 *      still served, with its last good text, not an error.
 *   5. Those 404s write nothing under .next, however often asked: no request,
 *      whatever it asks for, leaves a stored 404 behind.
 *   6. The pages' first addresses (/privacy, /terms and their /v/N) 301 to the
 *      current pages (LEGAL_PAGES) and write nothing under .next.
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
  return new Promise<{ status: number; body: string; location: string | undefined }>((resolve, reject) => {
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
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, location: res.headers.location }))
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
      const ok = await request(port, '/ar/privacy-policy', { host: site }).then(
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
    const right = await page('/ar/privacy-policy')
    await sleep((INTERVAL + 2) * 1000)
    await page('/ar/privacy-policy') // serves the cached page and starts regenerating
    await sleep(3000)
    const after = await page('/ar/privacy-policy')
    record(
      'interval',
      !shows(right.body, intervalMarker) && shows(after.body, intervalMarker),
      `right after publishing: ${shows(right.body, intervalMarker) ? 'new (not cached?)' : 'cached'}; after ${INTERVAL}s: ${shows(after.body, intervalMarker) ? 'new' : 'still old'}`
    )

    // 2. The save, through the editor's server action
    const { data: versions } = await service
      .from('legal_versions')
      .select('version')
      .eq('document', 'privacy')
      .eq('locale', 'ar')
      .order('version', { ascending: false })
      .limit(1)
      .single<{ version: number }>()
    const nextVersion = (versions?.version ?? 0) + 1
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
    const current = await page('/ar/privacy-policy')
    record(
      'save shows on the next request',
      shows(current.body, saveMarker),
      shows(current.body, saveMarker) ? 'current page is the saved version' : 'current page still old'
    )
    // 3 and 5. Version addresses are gone: every one a 404, the versions that
    // exist (the drafts' v1, the interval's v2, the save just made) exactly like
    // numbers that never existed and things that aren't numbers; none shows any
    // version's text; and none writes anything under .next, however often asked
    const gone = [
      '/ar/privacy-policy/v/1',
      '/en/privacy-policy/v/1',
      '/ar/terms-of-service/v/1',
      '/en/terms-of-service/v/1',
      `/ar/privacy-policy/v/${nextVersion - 1}`,
      `/ar/privacy-policy/v/${nextVersion}`,
      '/ar/privacy-policy/v/999',
      '/en/terms-of-service/v/123',
      '/ar/terms-of-service/v/7',
      '/ar/privacy-policy/v/1000',
      '/en/terms-of-service/v/abc',
      '/en/privacy-policy/v',
    ]
    const filesBefore = snapshot()
    const statuses: number[] = []
    let leaked = 0
    for (let round = 0; round < 3; round += 1) {
      for (const address of gone) {
        const r = await page(address)
        statuses.push(r.status)
        if (shows(r.body, saveMarker) || shows(r.body, intervalMarker) || shows(r.body, '## ')) leaked += 1
      }
    }
    await sleep(3000)
    const written = [...snapshot()].filter(([file, sig]) => filesBefore.get(file) !== sig).map(([file]) => file)
    record(
      'version addresses are gone: 404s that show no version and write nothing',
      statuses.every((s) => s === 404) && leaked === 0 && written.length === 0,
      `${statuses.length} requests to ${gone.length} addresses (existing versions included, the save's v${nextVersion} among them): ${[...new Set(statuses)].join('/')}; responses showing a version's text: ${leaked}; files written or changed under .next: ${written.length}${written.length ? ` (${written.slice(0, 8).join(', ')})` : ''}`
    )

    // 6. The first addresses (/privacy, /terms, before the move to LEGAL_PAGES):
    // a 301 to the current page each, version addresses included, and nothing written
    const moves: [string, string][] = [
      ['/ar/privacy', '/ar/privacy-policy'],
      ['/en/terms', '/en/terms-of-service'],
      ['/ar/privacy/v/1', '/ar/privacy-policy'],
      ['/en/terms/v/1', '/en/terms-of-service'],
      ['/ar/terms/v/999', '/ar/terms-of-service'],
    ]
    const movesBefore = snapshot()
    const moved: string[] = []
    const targets: (string | null)[] = []
    for (const [from, to] of moves) {
      const r = await page(from)
      const target = r.location ? new URL(r.location, `http://${site}`).pathname : null
      targets.push(target)
      moved.push(`${from} ${r.status} → ${r.location ?? 'nowhere'}`)
      if (r.status !== 301 || target !== to) moved.push('WRONG')
    }
    await sleep(3000)
    // The redirects' own writes only: the pages they land on read the cached
    // current version, which the interval may be refreshing by now
    const movesWritten = [...snapshot()].filter(([file, sig]) => movesBefore.get(file) !== sig).map(([file]) => file)
    for (const target of new Set(targets)) {
      if (!target) continue
      const landed = await page(target)
      moved.push(`${target} ${landed.status}`)
      if (landed.status !== 200) moved.push('WRONG LANDING')
    }
    record(
      'old addresses move permanently and write nothing',
      !moved.some((m) => m.startsWith('WRONG')) && movesWritten.length === 0,
      `${moved.join('; ')}; files written or changed under .next: ${movesWritten.length}${movesWritten.length ? ` (${movesWritten.slice(0, 8).join(', ')})` : ''}`
    )

    // 4. Outage past the interval: the last good page, not an error
    databaseDown = true
    await sleep((INTERVAL + 2) * 1000)
    const during = await page('/ar/privacy-policy')
    await sleep(3000)
    const stillDuring = await page('/ar/privacy-policy')
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
