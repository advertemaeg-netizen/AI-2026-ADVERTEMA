'use client'

import { useTranslations } from 'next-intl'
import { Link, usePathname } from '@/i18n/navigation'
import { cn } from '@/lib/utils'
import { clientSections } from '@/components/client-sections'

/** Tabs linking a client's sub-pages. */
export function ClientSubnav({ clientId }: { clientId: string }) {
  const t = useTranslations('clientNav')
  const pathname = usePathname()

  return (
    <nav aria-label={t('label')} className="mb-6 flex gap-1 overflow-x-auto border-b">
      {clientSections(clientId).map((section) => {
        const active = pathname === section.href
        return (
          <Link
            key={section.key}
            href={section.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              '-mb-px inline-flex items-center gap-2 border-b-2 px-3 py-2 text-sm whitespace-nowrap transition-colors',
              active
                ? 'border-primary font-medium text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            <section.icon className="size-4" />
            {t(section.key)}
          </Link>
        )
      })}
    </nav>
  )
}
