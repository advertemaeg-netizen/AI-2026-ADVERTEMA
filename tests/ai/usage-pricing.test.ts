import { afterEach, expect, it, vi } from 'vitest'
import { seedClient } from '../harness/helpers'
import { recordAiUsage } from '@/lib/ai/usage'

afterEach(() => {
  vi.restoreAllMocks()
})

const tokens = { promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000 }

const loggedCosts = async (supabase: Awaited<ReturnType<typeof seedClient>>['supabase'], clientId: string, model: string) => {
  const { data, error } = await supabase.from('ai_usage').select('estimated_cost_usd').eq('client_id', clientId).eq('model', model)
  if (error) throw error
  return data.map((row) => row.estimated_cost_usd)
}

it('prices text-embedding-3-large, so its calls are logged with a cost and no warning', async () => {
  const { supabase, clientId } = await seedClient()
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

  await recordAiUsage({ operation: 'embedding', clientId }, 'text-embedding-3-large', tokens)

  expect(await loggedCosts(supabase, clientId, 'text-embedding-3-large')).toEqual([0.13])
  expect(warn).not.toHaveBeenCalled()
})

it('logs a model without a price at no cost, and says so once per model', async () => {
  const { supabase, clientId } = await seedClient()
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

  await recordAiUsage({ operation: 'embedding', clientId }, 'model-without-a-price', tokens)
  await recordAiUsage({ operation: 'embedding', clientId }, 'model-without-a-price', tokens)

  expect(await loggedCosts(supabase, clientId, 'model-without-a-price')).toEqual([null, null])
  expect(warn).toHaveBeenCalledTimes(1)
  expect(warn.mock.calls[0][0]).toContain('"model-without-a-price" has no price in model_pricing')
})
