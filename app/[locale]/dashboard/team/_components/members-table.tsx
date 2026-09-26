'use client'

import { useState, useTransition } from 'react'
import { useFormatter, useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { UserMinus, UsersRound } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { removeTeamMember } from '@/lib/actions/team'
import type { TeamMember } from '@/lib/types/team'

export function MembersTable({
  members,
  currentUserId,
  canRemove,
}: {
  members: TeamMember[]
  currentUserId: string
  canRemove: boolean
}) {
  const t = useTranslations('team')
  const tCommon = useTranslations('common')
  const format = useFormatter()
  const [removing, setRemoving] = useState<TeamMember | null>(null)
  const [isPending, startTransition] = useTransition()

  function confirmRemove(e: React.MouseEvent) {
    e.preventDefault()
    if (!removing) return
    startTransition(async () => {
      const result = await removeTeamMember(removing.id)
      if (result.ok) {
        toast.success(t('toast.removed'))
        setRemoving(null)
      } else {
        toast.error(t(`errors.${result.error}`))
      }
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('members')}</CardTitle>
        <CardDescription>{t('membersCount', { count: members.length })}</CardDescription>
      </CardHeader>
      <CardContent>
        {members.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
            <UsersRound className="size-8" />
            {t('empty')}
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('fields.name')}</TableHead>
                <TableHead>{t('fields.email')}</TableHead>
                <TableHead>{t('fields.role')}</TableHead>
                <TableHead>{t('fields.clients')}</TableHead>
                <TableHead>{t('fields.joinedAt')}</TableHead>
                {canRemove && (
                  <TableHead className="w-12">
                    <span className="sr-only">{t('actions')}</span>
                  </TableHead>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.map((member) => {
                const removable = canRemove && member.id !== currentUserId && member.role !== 'super_admin'
                return (
                  <TableRow key={member.id}>
                    <TableCell className="font-medium">
                      {member.full_name || '—'}
                      {member.id === currentUserId && (
                        <span className="ms-1.5 text-xs text-muted-foreground">({t('you')})</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <span dir="ltr">{member.email}</span>
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">{t(`roles.${member.role}`)}</Badge>
                    </TableCell>
                    <TableCell>
                      {member.clients.length === 0 ? (
                        <span className="text-muted-foreground">
                          {member.role === 'org_admin' || member.role === 'super_admin' ? t('allClients') : '—'}
                        </span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {member.clients.map((client) => (
                            <Badge key={client.id} variant="outline">
                              {client.name}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {format.dateTime(new Date(member.joined_at), { dateStyle: 'medium' })}
                    </TableCell>
                    {canRemove && (
                      <TableCell>
                        {removable && (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="text-destructive hover:text-destructive"
                            aria-label={t('remove', { name: member.full_name || member.email })}
                            onClick={() => setRemoving(member)}
                          >
                            <UserMinus />
                          </Button>
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <AlertDialog open={!!removing} onOpenChange={(open) => !open && !isPending && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('removeTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('removeDescription', { name: removing?.full_name || removing?.email || '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>{tCommon('cancel')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={confirmRemove} disabled={isPending}>
              {t('removeConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}
