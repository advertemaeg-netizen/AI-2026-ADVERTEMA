import path from 'node:path'
import { configDefaults, defineConfig } from 'vitest/config'

/**
 * TWO PROJECTS, TWO DATABASES. The access tests fire hundreds of statements
 * the database refuses on purpose, over the one connection PGlite has, and
 * about one run in three that connection wedges (pglite#958: seen 2026-10-25
 * at c1eb22c and 2026-10-26). While every test shared that connection, the
 * wedge took the whole run down with it: the matrix test sat out its 300 s,
 * then 24 files failed on "Database connection error". Each project runs the
 * same global setup, so each gets its own PGlite and PostgREST: a wedge in
 * the access project reds the access project and nothing else.
 */
const shared = {
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      // Throws outside a React Server environment
      'server-only': path.resolve(import.meta.dirname, 'tests/harness/server-only.ts'),
    },
  },
  test: {
    // One shared database per project; tests seed their own organization
    globalSetup: ['tests/harness/global-setup.ts'],
    setupFiles: ['tests/harness/setup.ts'],
    // One file at a time: PGlite is a single connection
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
    // next-intl's ESM imports 'next/server' without an extension, which Node's
    // resolver refuses; inlined, Vite resolves it (tests/meta imports the proxy)
    server: { deps: { inline: ['next-intl'] } },
  },
}

export default defineConfig({
  test: {
    fileParallelism: false,
    projects: [
      {
        ...shared,
        test: { ...shared.test, name: 'access', include: ['tests/access/**/*.test.ts'] },
      },
      {
        ...shared,
        test: {
          ...shared.test,
          name: 'app',
          include: ['tests/**/*.test.ts'],
          exclude: [...configDefaults.exclude, 'tests/access/**'],
        },
      },
    ],
  },
})
