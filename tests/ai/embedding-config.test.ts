import { afterEach, expect, it, vi } from 'vitest'
import { embeddingModel, replyModel, resolveAiConfig } from '@/lib/ai/provider'

afterEach(() => {
  vi.unstubAllEnvs()
})

it('refuses to pick a chat provider when AI_PROVIDER is unset', () => {
  vi.stubEnv('AI_PROVIDER', '')
  expect(() => replyModel()).toThrow(/AI_PROVIDER is not set/)
  expect(() => resolveAiConfig()).toThrow(/AI_PROVIDER is not set/)
})

it('refuses to pick an embedding provider when AI_EMBEDDING_PROVIDER is unset', () => {
  vi.stubEnv('AI_EMBEDDING_PROVIDER', '')
  expect(() => embeddingModel()).toThrow(/AI_EMBEDDING_PROVIDER is not set/)
  expect(() => resolveAiConfig()).toThrow(/AI_EMBEDDING_PROVIDER is not set/)
})

it('refuses to pick an OpenAI embedding model when OPENAI_EMBEDDING_MODEL is unset', () => {
  vi.stubEnv('AI_EMBEDDING_PROVIDER', 'openai')
  vi.stubEnv('OPENAI_EMBEDDING_MODEL', '')
  expect(() => resolveAiConfig()).toThrow(/OPENAI_EMBEDDING_MODEL is not set/)
})

it('resolves what the startup log prints', () => {
  vi.stubEnv('AI_PROVIDER', 'openai')
  vi.stubEnv('AI_EMBEDDING_PROVIDER', 'openai')
  vi.stubEnv('OPENAI_MODEL', '')
  vi.stubEnv('OPENAI_ANALYSIS_MODEL', '')
  vi.stubEnv('OPENAI_EMBEDDING_MODEL', 'text-embedding-3-large')
  expect(resolveAiConfig()).toEqual({
    chatProvider: 'OpenAI',
    replyModel: 'gpt-6-luna',
    analysisModel: 'gpt-6-luna',
    embeddingProvider: 'OpenAI',
    embeddingModel: 'text-embedding-3-large',
    embeddingDimensions: 1536,
  })
})
