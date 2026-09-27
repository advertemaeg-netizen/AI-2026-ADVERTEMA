import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { appOrigin } from '@/lib/app-url'

/**
 * Where the dashboard sends members of a disabled organization: signs them
 * out and shows the reason on the login page. Only signs out when the
 * organization really is disabled, so a stray link can't log anyone out.
 */
export async function GET() {
  const origin = await appOrigin()
  const supabase = await createClient()

  const { data: disabled } = await supabase.rpc('org_disabled')
  if (!disabled) return NextResponse.redirect(`${origin}/dashboard`)

  await supabase.auth.signOut()
  return NextResponse.redirect(`${origin}/login?error=org_disabled`)
}
