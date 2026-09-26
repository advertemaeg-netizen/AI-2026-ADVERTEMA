import { Camera, Globe, MessageCircle, ThumbsUp, type LucideIcon } from 'lucide-react'
import type { ChannelType } from '@/lib/types/channels'

// lucide no longer ships brand logos, so these are generic stand-ins
export const CHANNEL_ICONS: Record<ChannelType, LucideIcon> = {
  website: Globe,
  facebook: ThumbsUp,
  instagram: Camera,
  whatsapp: MessageCircle,
}

export function embedCode(webhookUrl: string) {
  const origin = new URL(webhookUrl).origin
  return `<script src="${origin}/widget.js" data-webhook="${webhookUrl}" async></script>`
}
