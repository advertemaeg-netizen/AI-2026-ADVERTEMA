'use client'

import { useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { MailPlus, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { RelativeTime } from '@/components/relative-time'
import { cancelInvite } from '@/lib/actions/team'
import type { PendingInvite } from '@/lib/types/team'
import { CopyLinkButton } from './invite-dialog'

export function InvitesList({ invites }: { invites: PendingInvite[] }) {
  const t = useTranslations('invites')
  const [isPending, startTransition] = useTransition()

  function cancel(id: string) {
    startTransition(async () => {
      const result = await cancelInvite(id)
      if (result.ok) toast.success(t('toast.cancelled'))
      else toast.error(t(`errors.${result.error}`))
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('pendingTitle')}</CardTitle>
        <CardDescription>{t('pendingDescription')}</CardDescription>
      </CardHeader>
      <CardContent>
        {invites.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-8 text-center text-sm text-muted-foreground">
            <MailPlus className="size-8" />
            {t('noPending')}
          </div>
        ) : (
          <ul className="divide-y">
            {invites.map((invite) => (
              <li key={invite.id} className="flex flex-wrap items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {invite.invited_name ? `${invite.invited_name} · ` : ''}
                    <span dir="ltr">{invite.email}</span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t(`roles.${invite.role as 'client_admin' | 'team_member'}`)}
                    {invite.client && ` · ${invite.client.name}`}
                    {' · '}
                    {invite.expired ? (
                      t('expired')
                    ) : (
                      <>
                        {t('expires')} <RelativeTime date={invite.expires_at} />
                      </>
                    )}
                  </p>
                </div>
                {invite.expired ? (
                  <Badge variant="secondary">{t('expiredBadge')}</Badge>
                ) : (
                  <CopyLinkButton link={invite.link} label={t('copyLink')} />
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  onClick={() => cancel(invite.id)}
                  disabled={isPending}
                >
                  <X data-icon="inline-start" />
                  {t('cancel')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
