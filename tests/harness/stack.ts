import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { vector } from '@electric-sql/pglite-pgvector'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'

/**
 * The database the app talks to, without Supabase: PGlite (in-memory
 * Postgres) with every migration applied, served over the Postgres wire
 * protocol to a real PostgREST, so supabase-js runs unmodified.
 */

const ROOT = path.resolve(__dirname, '../..')
const MIGRATIONS_DIR = path.join(ROOT, 'supabase/migrations')
const POSTGREST_VERSION = 'v16.4'
const CACHE_DIR = path.join(ROOT, 'node_modules/.cache/postgrest', POSTGREST_VERSION)
const JWT_SECRET = 'test-only-jwt-secret-at-least-32-characters'

export type Stack = { url: string; serviceKey: string; stop: () => Promise<void> }

function postgrestAsset() {
  const key = `${process.platform}-${process.arch}`
  const asset = {
    'linux-x64': 'linux-static-x86-64.tar.xz',
    'linux-arm64': 'linux-static-aarch64.tar.xz',
    'darwin-x64': 'macos-x86-64.tar.xz',
    'darwin-arm64': 'macos-aarch64.tar.xz',
  }[key]
  if (!asset) throw new Error(`No PostgREST build for ${key}; set POSTGREST_BIN to a postgrest binary`)
  return `postgrest-${POSTGREST_VERSION}-${asset}`
}

/** POSTGREST_BIN, or the pinned release downloaded once into node_modules/.cache */
async function postgrestBinary() {
  if (process.env.POSTGREST_BIN) return process.env.POSTGREST_BIN
  const bin = path.join(CACHE_DIR, 'postgrest')
  if (existsSync(bin)) return bin

  const asset = postgrestAsset()
  const res = await fetch(`https://github.com/PostgREST/postgrest/releases/download/${POSTGREST_VERSION}/${asset}`)
  if (!res.ok) throw new Error(`Downloading PostgREST failed (${res.status}); set POSTGREST_BIN instead`)
  mkdirSync(CACHE_DIR, { recursive: true })
  const archive = path.join(CACHE_DIR, asset)
  writeFileSync(archive, Buffer.from(await res.arrayBuffer()))
  execFileSync('tar', ['-xJf', archive, '-C', CACHE_DIR])
  chmodSync(bin, 0o755)
  return bin
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

function signJwt(claims: Record<string, unknown>) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const body = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(claims)}`
  return `${body}.${createHmac('sha256', JWT_SECRET).update(body).digest('base64url')}`
}

async function migrate(db: PGlite) {
  await db.exec(readFileSync(path.join(__dirname, 'supabase-stubs.sql'), 'utf8'))
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
    try {
      await db.exec(readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'))
    } catch (error) {
      throw new Error(`Migration ${file} failed: ${(error as Error).message}`)
    }
  }
}

async function waitUntilReady(url: string, postgrest: ChildProcess, logs: () => string) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (postgrest.exitCode !== null) break
    try {
      if ((await fetch(url)).ok) return
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`PostgREST did not start:\n${logs()}`)
}

export async function startStack(): Promise<Stack> {
  const bin = await postgrestBinary()

  const db = await PGlite.create({ extensions: { pgcrypto, vector } })
  await migrate(db)

  const dbPort = await freePort()
  const socket = new PGLiteSocketServer({ db, port: dbPort, host: '127.0.0.1' })
  await socket.start()

  const apiPort = await freePort()
  let output = ''
  const postgrest = spawn(bin, [], {
    env: {
      ...process.env,
      PGRST_DB_URI: `postgres://postgres:postgres@127.0.0.1:${dbPort}/postgres?sslmode=disable`,
      PGRST_DB_SCHEMAS: 'public',
      PGRST_DB_ANON_ROLE: 'anon',
      PGRST_JWT_SECRET: JWT_SECRET,
      PGRST_SERVER_HOST: '127.0.0.1',
      PGRST_SERVER_PORT: String(apiPort),
      // PGlite is a single connection: one pooled connection, no LISTEN, and
      // no named prepared statements (they collide on the shared session)
      PGRST_DB_POOL: '1',
      PGRST_DB_CHANNEL_ENABLED: 'false',
      PGRST_DB_PREPARED_STATEMENTS: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  postgrest.stdout!.on('data', (chunk) => (output += chunk))
  postgrest.stderr!.on('data', (chunk) => (output += chunk))

  const stop = async () => {
    postgrest.kill()
    await socket.stop()
    await db.close()
  }

  const url = `http://127.0.0.1:${apiPort}`
  try {
    await waitUntilReady(url, postgrest, () => output)
  } catch (error) {
    await stop()
    throw error
  }

  return { url, serviceKey: signJwt({ role: 'service_role', iss: 'supabase' }), stop }
}
