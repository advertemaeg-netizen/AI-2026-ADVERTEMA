import { Camera, Globe, MessageCircle, ThumbsUp, type LucideIcon } from 'lucide-react'
import type { ChannelType } from '@/lib/types/channels'

// lucide no longer ships brand logos, so these are generic stand-ins
export const CHANNEL_ICONS: Record<ChannelType, LucideIcon> = {
  website: Globe,
  facebook: ThumbsUp,
  instagram: Camera,
  whatsapp: MessageCircle,
}

export function ChannelIcon({ type, className }: { type: ChannelType; className?: string }) {
  const Icon = CHANNEL_ICONS[type]
  return <Icon className={className} aria-hidden />
}
