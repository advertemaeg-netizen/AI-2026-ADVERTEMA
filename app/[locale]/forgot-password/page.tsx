'use client'

import { useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { MailCheck, Sparkles } from 'lucide-react'

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)
  const supabase = createClient()
  const locale = useLocale()
  const t = useTranslations('auth')
  const tCommon = useTranslations('common')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)

    // The link must come back to this app; the URL also has to be in
    // Supabase's Auth → Redirect URLs allow-list
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || window.location.origin
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: `${appUrl}/${locale}/reset-password`,
    })

    setLoading(false)
    // Same message whether or not the email has an account (no enumeration).
    // Only Supabase's per-email rate limit is surfaced, as a plain "wait".
    if (error && error.status === 429) {
      setError(t('tooManyRequests'))
      return
    }
    if (error && !error.status) {
      // Network failure — nothing was sent
      setError(t('genericError'))
      return
    }
    setSent(true)
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-background">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="flex justify-center mb-4">
            {sent ? (
              <MailCheck className="w-12 h-12 text-green-500" />
            ) : (
              <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-purple-500 to-orange-500 flex items-center justify-center">
                <Sparkles className="w-6 h-6 text-white" />
              </div>
            )}
          </div>
          <CardTitle className="text-2xl">{sent ? t('resetLinkSent') : t('forgotPasswordTitle')}</CardTitle>
          <CardDescription>{sent ? t('resetLinkSentDesc') : t('forgotPasswordDesc')}</CardDescription>
        </CardHeader>
        <CardContent>
          {!sent && (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">{tCommon('email')}</Label>
                <Input
                  id="email"
                  type="email"
                  dir="ltr"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoFocus
                />
              </div>

              {error && <div className="text-sm text-destructive">{error}</div>}

              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? tCommon('loading') : t('sendResetLink')}
              </Button>
            </form>
          )}

          <p className="text-sm text-muted-foreground mt-4 text-center">
            <Link href="/login" className="text-foreground font-medium hover:underline">
              {t('backToLogin')}
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
