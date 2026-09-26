import 'server-only'
import { createClient } from '@supabase/supabase-js'

/**
 * Supabase client with the secret key — bypasses RLS.
 * Only for server code that serves unauthenticated callers (e.g. the public
 * website widget webhook). Every query must scope itself explicitly.
 */
export function createAdminClient() {
  const secretKey = process.env.SUPABASE_SECRET_KEY
  if (!secretKey) throw new Error('SUPABASE_SECRET_KEY is not set')

  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}
