'use client'

import { use, useState } from 'react'
import { useRouter } from '@/i18n/navigation'
import { Link } from '@/i18n/navigation'
import { useTranslations } from 'next-intl'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { AuthFrame, authLinkClass } from '@/components/auth-frame'

export default function LoginPage({ searchParams }: PageProps<'/[locale]/login'>) {
  const t = useTranslations('auth')
  // Set by /auth/org-disabled after signing out a member of a disabled organization
  const { error: errorParam } = use(searchParams)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(errorParam === 'org_disabled' ? t('orgDisabled') : null)
  const router = useRouter()
  const supabase = createClient()
  const tCommon = useTranslations('common')

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)

    const { error } = await supabase.auth.signInWithPassword({ email, password })

    if (error) {
      setError(error.message)
      setLoading(false)
      return
    }

    // Disabled organizations can't sign in (super admins are never locked out)
    const { data: orgDisabled } = await supabase.rpc('org_disabled')
    if (orgDisabled) {
      await supabase.auth.signOut()
      setError(t('orgDisabled'))
      setLoading(false)
      return
    }

    // ?next= lets flows like invite links return after login. Internal paths
    // only: "//evil.com" or "https://…" would be an open redirect.
    const next = new URLSearchParams(window.location.search).get('next')
    const safeNext = next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : null
    router.push(safeNext ?? '/dashboard')
    router.refresh()
  }

  return (
    <AuthFrame>
      <Card className="w-full shadow-raised">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl font-bold">{t('loginTitle')}</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleLogin} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">{tCommon('email')}</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">{tCommon('password')}</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
              <div className="flex justify-end">
                <Link href="/forgot-password" className={`text-xs ${authLinkClass}`}>
                  {t('forgotPassword')}
                </Link>
              </div>
            </div>

            {error && <div className="text-sm text-destructive">{error}</div>}

            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? tCommon('loading') : t('loginButton')}
            </Button>
          </form>

          <p className="text-sm text-muted-foreground mt-4 text-center">
            {t('noAccount')}{' '}
            <Link href="/signup" className={authLinkClass}>
              {tCommon('signup')}
            </Link>
          </p>
        </CardContent>
      </Card>
    </AuthFrame>
  )
}