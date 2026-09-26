import { BookOpen, Bot, FlaskConical, Radio } from 'lucide-react'

/** Per-client sub-pages, shared by the client tabs and the sidebar. */
export function clientSections(clientId: string) {
  return [
    { key: 'channels', href: `/dashboard/clients/${clientId}/channels`, icon: Radio },
    { key: 'knowledge', href: `/dashboard/clients/${clientId}/knowledge`, icon: BookOpen },
    { key: 'botSettings', href: `/dashboard/clients/${clientId}/bot-settings`, icon: Bot },
    { key: 'playground', href: `/dashboard/clients/${clientId}/playground`, icon: FlaskConical },
  ] as const
}

const CLIENT_PATH = /^\/dashboard\/clients\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i

/** The client id when the (locale-less) pathname is inside a client's pages. */
export function clientIdFromPath(pathname: string) {
  return pathname.match(CLIENT_PATH)?.[1] ?? null
}
