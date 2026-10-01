import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      // Throws outside a React Server environment
      'server-only': path.resolve(import.meta.dirname, 'tests/harness/server-only.ts'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/harness/global-setup.ts'],
    setupFiles: ['tests/harness/setup.ts'],
    // One shared database behind a single connection
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
})
