'use client'

import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Check, Copy, UserPlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { createInvite } from '@/lib/actions/team'
import { INVITABLE_ROLES, type InvitableRole } from '@/lib/types/team'
import type { ClientOption } from '@/lib/auth/client-context'

export function CopyLinkButton({ link, label }: { link: string; label: string }) {
  const t = useTranslations('invites')
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
      toast.success(t('toast.copied'))
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error(t('errors.copyFailed'))
    }
  }

  return (
    <Button type="button" variant="outline" size="sm" onClick={copy}>
      {copied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}
      {copied ? t('copied') : label}
    </Button>
  )
}

/**
 * With a client in focus (client admins always, org admins after picking one
 * in the switcher) the invite goes to it and there's no client to choose.
 * Org admins on "all clients" pick the client here.
 */
export function InviteDialog({
  clients,
  lockedClient,
}: {
  clients: ClientOption[]
  lockedClient: ClientOption | null
}) {
  const t = useTranslations('invites')
  const tCommon = useTranslations('common')
  const [open, setOpen] = useState(false)
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [role, setRole] = useState<InvitableRole>('team_member')
  const initialClientId = lockedClient?.id ?? (clients.length === 1 ? clients[0].id : '')
  const [clientId, setClientId] = useState(initialClientId)
  const [link, setLink] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  function reset() {
    setEmail('')
    setName('')
    setRole('team_member')
    setClientId(initialClientId)
    setLink(null)
  }

  function handleOpenChange(next: boolean) {
    if (isPending) return
    setOpen(next)
    if (!next) reset()
  }

  function submit(e: React.FormEvent) {
    e.preventDefault()
    startTransition(async () => {
      const result = await createInvite({ email, name, role, clientId })
      if (result.ok) {
        setLink(result.link)
        toast.success(t('toast.created'))
        return
      }
      const fieldErrors: Record<string, 'clientRequired' | 'invalidEmail'> = {
        clientId: 'clientRequired',
        email: 'invalidEmail',
      }
      const key = result.error === 'validation' ? (fieldErrors[result.field ?? ''] ?? 'validation') : result.error
      toast.error(t(`errors.${key}`))
    })
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button>
          <UserPlus data-icon="inline-start" />
          {t('invite')}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        {link ? (
          <div className="grid gap-4">
            <DialogHeader>
              <DialogTitle>{t('createdTitle')}</DialogTitle>
              <DialogDescription>{t('createdDescription', { email })}</DialogDescription>
            </DialogHeader>
            <Input value={link} readOnly dir="ltr" onFocus={(e) => e.currentTarget.select()} aria-label={t('link')} />
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={reset}>
                {t('inviteAnother')}
              </Button>
              <CopyLinkButton link={link} label={t('copyLink')} />
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={submit} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>{t('title')}</DialogTitle>
              <DialogDescription>
                {lockedClient ? t('descriptionForClient', { client: lockedClient.name }) : t('description')}
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-2">
              <Label htmlFor="invite-email">{t('fields.email')} *</Label>
              <Input
                id="invite-email"
                type="email"
                dir="ltr"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="invite-name">{t('fields.name')}</Label>
              <Input id="invite-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
            </div>
            <div className={lockedClient ? 'grid gap-4' : 'grid gap-4 sm:grid-cols-2'}>
              <div className="grid gap-2">
                <Label htmlFor="invite-role">{t('fields.role')}</Label>
                <Select value={role} onValueChange={(v) => setRole(v as InvitableRole)}>
                  <SelectTrigger id="invite-role" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {INVITABLE_ROLES.map((r) => (
                      <SelectItem key={r} value={r}>
                        {t(`roles.${r}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {!lockedClient && (
                <div className="grid gap-2">
                  <Label htmlFor="invite-client">{t('fields.client')} *</Label>
                  <Select value={clientId} onValueChange={setClientId}>
                    <SelectTrigger id="invite-client" className="w-full">
                      <SelectValue placeholder={t('pickClient')} />
                    </SelectTrigger>
                    <SelectContent>
                      {clients.map((client) => (
                        <SelectItem key={client.id} value={client.id}>
                          {client.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
            <p className="text-xs text-muted-foreground">{t(`roleHints.${role}`)}</p>

            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline" disabled={isPending}>
                  {tCommon('cancel')}
                </Button>
              </DialogClose>
              <Button type="submit" disabled={isPending || !email || !clientId}>
                {isPending ? tCommon('loading') : t('create')}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
