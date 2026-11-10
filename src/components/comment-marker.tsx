import { useTranslations } from 'next-intl'
import { MessageSquareQuote } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * WHAT MARKS A PUBLIC COMMENT APART FROM A PRIVATE MESSAGE (comments tab
 * decisions, 5; chosen 2026-11-10, .scratch/comments-tab-choices.md): a word
 * and a shape, never a colour. An outlined pill with a quote-bubble glyph and
 * «تعليق». Outlined and neutral on purpose: a channel's colour says WHO, a
 * state tone says HOW IT WENT, and this says WHAT KIND, so it takes neither.
 * The word reads without colour vision; the outline reads without reading.
 */
export function CommentMarker({ className }: { className?: string }) {
  const t = useTranslations('comments')
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full border border-foreground/40 px-2 py-0.5 text-xs font-medium',
        className
      )}
    >
      <MessageSquareQuote className="size-3.5" aria-hidden />
      {t('badge')}
    </span>
  )
}
