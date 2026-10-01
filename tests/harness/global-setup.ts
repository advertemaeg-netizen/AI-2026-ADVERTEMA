import type { TestProject } from 'vitest/node'
import { startStack } from './stack'

declare module 'vitest' {
  export interface ProvidedContext {
    supabaseUrl: string
    supabaseServiceKey: string
  }
}

// One database for the whole run; tests seed their own organization
export default async function setup(project: TestProject) {
  const stack = await startStack()
  project.provide('supabaseUrl', stack.url)
  project.provide('supabaseServiceKey', stack.serviceKey)
  return () => stack.stop()
}
