'use client'

import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { CheckCircle2 } from 'lucide-react'
import { Link, useRouter } from '@/i18n/navigation'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { acceptInvite } from '@/lib/actions/team'

/**
 * Signed out: sign up with the invited email (locked). The signup trigger
 * reads invite_code and joins the organization + client.
 * Signed in with the invited email: accept. Signed in as someone else: switch.
 */
export function InviteActions({
  code,
  inviteEmail,
  invitedName,
  signedInEmail,
}: {
  code: string
  inviteEmail: string
  invitedName: string | null
  signedInEmail: string | null
}) {
  const t = useTranslations('invites.accept')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [fullName, setFullName] = useState(invitedName ?? '')
  const [password, setPassword] = useState('')
  const [checkEmail, setCheckEmail] = useState(false)

  const invitePath = `/invite/${code}`

  function accept() {
    setError(null)
    startTransition(async () => {
      const { status } = await acceptInvite(code)
      if (status === 'ok') {
        router.push('/dashboard')
        router.refresh()
      } else {
        setError(t(`errors.${status}`))
      }
    })
  }

  function signOut() {
    startTransition(async () => {
      await createClient().auth.signOut()
      router.refresh()
    })
  }

  function signUp(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    startTransition(async () => {
      const supabase = createClient()
      const { data, error: signUpError } = await supabase.auth.signUp({
        email: inviteEmail,
        password,
        options: {
          data: { full_name: fullName, invite_code: code },
          emailRedirectTo: `${window.location.origin}/auth/callback`,
        },
      })
      if (signUpError) {
        setError(signUpError.message)
        return
      }
      // An existing account comes back with no identities (and no email sent)
      if (data.user && data.user.identities?.length === 0) {
        setError(t('errors.accountExists'))
        return
      }
      if (data.session) {
        router.push('/dashboard')
        router.refresh()
      } else {
        setCheckEmail(true)
      }
    })
  }

  if (checkEmail) {
    return (
      <div className="grid gap-2 text-center">
        <CheckCircle2 className="mx-auto size-10 text-green-500" />
        <p className="font-medium">{t('checkEmailTitle')}</p>
        <p className="text-sm text-muted-foreground">{t('checkEmailDescription', { email: inviteEmail })}</p>
      </div>
    )
  }

  if (signedInEmail && signedInEmail.toLowerCase() === inviteEmail.toLowerCase()) {
    return (
      <div className="grid gap-3">
        <Button className="w-full" onClick={accept} disabled={isPending}>
          {isPending ? tCommon('loading') : t('acceptButton')}
        </Button>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
    )
  }

  if (signedInEmail) {
    return (
      <div className="grid gap-3 text-center">
        <p className="text-sm text-muted-foreground">
          {t('wrongAccount', { current: signedInEmail, invited: inviteEmail })}
        </p>
        <Button variant="outline" onClick={signOut} disabled={isPending}>
          {t('switchAccount')}
        </Button>
      </div>
    )
  }

  return (
    <form onSubmit={signUp} className="grid gap-4">
      <div className="grid gap-2">
        <Label htmlFor="invite-email">{tCommon('email')}</Label>
        <Input id="invite-email" type="email" dir="ltr" value={inviteEmail} readOnly disabled />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="invite-name">{tCommon('fullName')}</Label>
        <Input id="invite-name" value={fullName} onChange={(e) => setFullName(e.target.value)} required />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="invite-password">{t('password')}</Label>
        <Input
          id="invite-password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          minLength={6}
          required
        />
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button type="submit" className="w-full" disabled={isPending}>
        {isPending ? tCommon('loading') : t('signupButton')}
      </Button>
      <p className="text-center text-sm text-muted-foreground">
        {t('haveAccount')}{' '}
        <Link
          href={{ pathname: '/login', query: { next: invitePath } }}
          className="font-medium text-foreground hover:underline"
        >
          {tCommon('login')}
        </Link>
      </p>
    </form>
  )
}
