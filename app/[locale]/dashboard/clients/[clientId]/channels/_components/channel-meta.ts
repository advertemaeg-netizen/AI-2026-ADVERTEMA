export function embedCode(webhookUrl: string) {
  const origin = new URL(webhookUrl).origin
  return `<script src="${origin}/widget.js" data-webhook="${webhookUrl}" async></script>`
}
