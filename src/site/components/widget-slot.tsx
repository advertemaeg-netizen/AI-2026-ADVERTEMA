import { APP_ORIGIN, SITE_WIDGET_CHANNEL_ID } from '@/site/config'

/**
 * Mudrik's own widget, live on Mudrik's site: the same snippet a client pastes
 * (channel-meta.ts embedCode). Nothing until the channel id is set in
 * src/site/config.ts. The record and channel are created through the normal
 * onboarding, not by a script.
 */
export function WidgetSlot() {
  if (!SITE_WIDGET_CHANNEL_ID) return null
  return <script src={`${APP_ORIGIN}/widget.js`} data-webhook={`${APP_ORIGIN}/api/webhook/website/${SITE_WIDGET_CHANNEL_ID}`} async />
}
