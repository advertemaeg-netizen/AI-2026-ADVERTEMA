'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Link, useRouter } from '@/i18n/navigation'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { KeyRound, Loader2, XCircle } from 'lucide-react'

const MIN_LENGTH = 6

type LinkState = 'checking' | 'ready' | 'invalid'

export default function ResetPasswordPage() {
  const [linkState, setLinkState] = useState<LinkState>('checking')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [supabase] = useState(createClient)
  const router = useRouter()
  const t = useTranslations('auth')
  const tCommon = useTranslations('common')

  useEffect(() => {
    // The email link lands here with ?code=… (PKCE) — or with ?error=… /
    // #error=… when it's expired or already used. The browser client
    // exchanges the code for a recovery session while it initializes;
    // getSession() waits for that to finish.
    const query = new URLSearchParams(window.location.search)
    const hash = new URLSearchParams(window.location.hash.slice(1))
    const linkError = Boolean(query.get('error') || hash.get('error'))

    let cancelled = false
    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return
      setLinkState(!linkError && data.session ? 'ready' : 'invalid')
      // Don't leave the one-time code in the address bar / history
      if (query.has('code')) window.history.replaceState(null, '', window.location.pathname)
    })
    return () => {
      cancelled = true
    }
  }, [supabase])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    if (password.length < MIN_LENGTH) {
      setError(t('passwordTooShort'))
      return
    }
    if (password !== confirm) {
      setError(t('passwordsDoNotMatch'))
      return
    }

    setLoading(true)
    const { error } = await supabase.auth.updateUser({ password })
    if (error) {
      setLoading(false)
      if (error.code === 'same_password') setError(t('samePassword'))
      else if (error.code === 'weak_password') setError(t('weakPassword'))
      else if (error.code === 'session_not_found' || error.status === 401) setLinkState('invalid')
      else setError(error.message)
      return
    }

    toast.success(t('passwordUpdated'))
    router.push('/dashboard')
    router.refresh()
  }

  const invalid = linkState === 'invalid'

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-background">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="flex justify-center mb-4">
            {invalid ? (
              <XCircle className="w-12 h-12 text-muted-foreground" />
            ) : (
              <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-purple-500 to-orange-500 flex items-center justify-center">
                <KeyRound className="w-6 h-6 text-white" />
              </div>
            )}
          </div>
          <CardTitle className="text-2xl">{invalid ? t('invalidResetLink') : t('resetPasswordTitle')}</CardTitle>
          <CardDescription>{invalid ? t('invalidResetLinkDesc') : 'Advertema AI'}</CardDescription>
        </CardHeader>
        <CardContent>
          {linkState === 'checking' && (
            <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {t('checkingLink')}
            </div>
          )}

          {invalid && (
            <div className="grid gap-3 text-center">
              <Button asChild className="w-full">
                <Link href="/forgot-password">{t('requestNewLink')}</Link>
              </Button>
              <Link href="/login" className="text-sm text-muted-foreground hover:underline">
                {t('backToLogin')}
              </Link>
            </div>
          )}

          {linkState === 'ready' && (
            <form onSubmit={handleSubmit} className="space-y-4" noValidate>
              <div className="space-y-2">
                <Label htmlFor="password">{t('newPassword')}</Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  minLength={MIN_LENGTH}
                  required
                  autoFocus
                />
                <p className="text-xs text-muted-foreground">{t('passwordMin')}</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="confirm">{t('confirmPassword')}</Label>
                <Input
                  id="confirm"
                  type="password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  required
                  aria-invalid={confirm.length > 0 && confirm !== password}
                />
              </div>

              {error && (
                <div role="alert" className="text-sm text-destructive">
                  {error}
                </div>
              )}

              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? tCommon('loading') : tCommon('save')}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
