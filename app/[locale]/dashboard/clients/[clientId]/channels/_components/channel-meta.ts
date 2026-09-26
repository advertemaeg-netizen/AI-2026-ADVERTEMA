/** The widget's webhook for a channel on this app's current origin. */
export function channelWebhookUrl(appOrigin: string, channelId: string) {
  return `${appOrigin}/api/webhook/website/${channelId}`
}

/**
 * Snippet for the client's website. Built from the current app origin, not
 * the channel's stored webhook_url, so moving domains (localhost → the real
 * domain) never hands out a dead link.
 */
export function embedCode(appOrigin: string, channelId: string) {
  return `<script src="${appOrigin}/widget.js" data-webhook="${channelWebhookUrl(appOrigin, channelId)}" async></script>`
}
