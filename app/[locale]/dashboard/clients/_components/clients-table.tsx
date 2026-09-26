'use client'

import { useState } from 'react'
import { useFormatter, useTranslations } from 'next-intl'
import { BookOpen, Bot, Building2, FlaskConical, MoreHorizontal, Pencil, Radio, Trash2 } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { Client, ClientStatus } from '@/lib/types/clients'
import { ClientFormDialog } from './client-form-dialog'
import { DeleteClientDialog } from './delete-client-dialog'

const STATUS_VARIANT: Record<ClientStatus, 'default' | 'secondary' | 'outline'> = {
  active: 'default',
  paused: 'secondary',
  archived: 'outline',
}

export function ClientsTable({ clients, canManage }: { clients: Client[]; canManage: boolean }) {
  const t = useTranslations('clients')
  const tCommon = useTranslations('common')
  const format = useFormatter()
  const [editing, setEditing] = useState<Client | null>(null)
  const [deleting, setDeleting] = useState<Client | null>(null)

  if (clients.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-12 text-center text-sm text-muted-foreground">
        <Building2 className="size-8" />
        {canManage ? t('empty') : t('emptyReadOnly')}
      </div>
    )
  }

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('fields.name')}</TableHead>
            <TableHead>{t('fields.industry')}</TableHead>
            <TableHead>{t('fields.status')}</TableHead>
            <TableHead>{t('fields.createdAt')}</TableHead>
            {canManage && (
              <TableHead className="w-12">
                <span className="sr-only">{t('actions')}</span>
              </TableHead>
            )}
          </TableRow>
        </TableHeader>
        <TableBody>
          {clients.map((client) => (
            <TableRow key={client.id}>
              <TableCell>
                {/* A client's pages are for managers; team members just see the name */}
                {canManage ? (
                  <Link
                    href={`/dashboard/clients/${client.id}/channels`}
                    className="font-medium hover:underline"
                  >
                    {client.name}
                  </Link>
                ) : (
                  <span className="font-medium">{client.name}</span>
                )}
                <div className="text-xs text-muted-foreground" dir="ltr">
                  {client.slug}
                </div>
              </TableCell>
              <TableCell>{client.industry || '—'}</TableCell>
              <TableCell>
                <Badge variant={STATUS_VARIANT[client.status]}>{t(`status.${client.status}`)}</Badge>
              </TableCell>
              <TableCell className="text-muted-foreground">
                {format.dateTime(new Date(client.created_at), { dateStyle: 'medium' })}
              </TableCell>
              {canManage && (
                <TableCell>
                  <DropdownMenu modal={false}>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon-sm" aria-label={t('actions')}>
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem asChild>
                        <Link href={`/dashboard/clients/${client.id}/channels`}>
                          <Radio />
                          {t('channels')}
                        </Link>
                      </DropdownMenuItem>
                      <DropdownMenuItem asChild>
                        <Link href={`/dashboard/clients/${client.id}/knowledge`}>
                          <BookOpen />
                          {t('knowledge')}
                        </Link>
                      </DropdownMenuItem>
                      <DropdownMenuItem asChild>
                        <Link href={`/dashboard/clients/${client.id}/bot-settings`}>
                          <Bot />
                          {t('botSettings')}
                        </Link>
                      </DropdownMenuItem>
                      <DropdownMenuItem asChild>
                        <Link href={`/dashboard/clients/${client.id}/playground`}>
                          <FlaskConical />
                          {t('playground')}
                        </Link>
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => setEditing(client)}>
                        <Pencil />
                        {tCommon('edit')}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        variant="destructive"
                        onSelect={() => setDeleting(client)}
                      >
                        <Trash2 />
                        {tCommon('delete')}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {editing && (
        <ClientFormDialog
          key={editing.id}
          mode="edit"
          client={editing}
          open
          onOpenChange={(open) => !open && setEditing(null)}
        />
      )}
      {deleting && (
        <DeleteClientDialog
          key={deleting.id}
          client={deleting}
          open
          onOpenChange={(open) => !open && setDeleting(null)}
        />
      )}
    </>
  )
}
