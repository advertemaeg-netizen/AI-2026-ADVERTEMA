import 'server-only'
import { headers } from 'next/headers'

/**
 * Public origin of the app, for links that leave the dashboard (webhook URLs,
 * invite links). NEXT_PUBLIC_APP_URL wins so links stay right behind proxies;
 * otherwise fall back to the request host.
 */
export async function appOrigin() {
  const configured = process.env.NEXT_PUBLIC_APP_URL
  if (configured) return configured.replace(/\/+$/, '')

  const h = await headers()
  const host = h.get('x-forwarded-host') ?? h.get('host')
  const proto = h.get('x-forwarded-proto') ?? (host?.startsWith('localhost') ? 'http' : 'https')
  return `${proto}://${host}`
}
