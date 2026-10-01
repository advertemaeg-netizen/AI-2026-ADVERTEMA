'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PASSWORD_MIN } from '@/lib/types/settings'

/** Through Supabase Auth, with the signed-in session: it can only ever change the caller's own password. */
export function PasswordForm() {
  const t = useTranslations('settings')
  const tAuth = useTranslations('auth')
  const [supabase] = useState(createClient)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (password.length < PASSWORD_MIN) return setError(tAuth('passwordTooShort'))
    if (password !== confirm) return setError(tAuth('passwordsDoNotMatch'))

    setLoading(true)
    const { error } = await supabase.auth.updateUser({ password })
    setLoading(false)
    if (error) {
      if (error.code === 'same_password') setError(tAuth('samePassword'))
      else if (error.code === 'weak_password') setError(tAuth('weakPassword'))
      else setError(t('errors.unknown'))
      return
    }
    setPassword('')
    setConfirm('')
    toast.success(tAuth('passwordUpdated'))
  }

  return (
    <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2" noValidate>
      <h3 className="font-medium sm:col-span-2">{t('account.password')}</h3>
      <div className="grid content-start gap-2">
        <Label htmlFor="new-password">{tAuth('newPassword')}</Label>
        <Input
          id="new-password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          minLength={PASSWORD_MIN}
          required
        />
        <p className="text-xs text-muted-foreground">{tAuth('passwordMin')}</p>
      </div>
      <div className="grid content-start gap-2">
        <Label htmlFor="confirm-password">{tAuth('confirmPassword')}</Label>
        <Input
          id="confirm-password"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          required
        />
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive sm:col-span-2">
          {error}
        </p>
      )}
      <div className="sm:col-span-2">
        <Button type="submit" disabled={loading || !password || !confirm}>
          {t('account.changePassword')}
        </Button>
      </div>
    </form>
  )
}
