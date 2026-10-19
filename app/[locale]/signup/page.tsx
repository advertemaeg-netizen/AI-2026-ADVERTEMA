'use client'

import { useState } from 'react'
import { useRouter } from '@/i18n/navigation'
import { Link } from '@/i18n/navigation'
import { useTranslations } from 'next-intl'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { CheckCircle2, Building2, Store } from 'lucide-react'
import { cn } from '@/lib/utils'
import { AuthFrame, authLinkClass } from '@/components/auth-frame'
import { LegalConsentField, useLegalConsent } from '@/components/legal-consent'

type OrgType = 'agency' | 'direct'

export default function SignupPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [fullName, setFullName] = useState('')
  const [organizationName, setOrganizationName] = useState('')
  const [orgType, setOrgType] = useState<OrgType>('agency')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const router = useRouter()
  const supabase = createClient()
  const t = useTranslations('auth')
  const tCommon = useTranslations('common')
  // Off until the legal pages are relinked (LEGAL_LINKED): then a tick is required
  const consent = useLegalConsent()
  const [consentMissing, setConsentMissing] = useState(false)

  async function handleSignup(e: React.FormEvent) {
    e.preventDefault()
    if (!consent.ready) {
      // Not ticked: the copy's own error under the box. Ticked, but the versions
      // to record never loaded: a connection problem, and still no signup
      if (consent.accepted) setError(t('genericError'))
      else setConsentMissing(true)
      return
    }
    setLoading(true)
    setError(null)

    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          full_name: fullName,
          organization_name: organizationName,
          org_type: orgType,
          ...consent.metadata,
        },
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      },
    })

    if (error) {
      setError(error.message)
      setLoading(false)
      return
    }

    const { data: { user } } = await supabase.auth.getUser()
    if (user) {
      router.push('/dashboard')
      router.refresh()
      return
    }

    setSuccess(true)
    setLoading(false)
  }

  if (success) {
    return (
      <AuthFrame>
        <Card className="w-full shadow-raised">
          <CardHeader className="text-center">
            <div className="flex justify-center mb-4">
              <CheckCircle2 className="size-12 animate-pop text-positive" />
            </div>
            <CardTitle className="text-xl font-bold">{t('checkEmail')}</CardTitle>
            <CardDescription>{t('checkEmailDesc')}</CardDescription>
          </CardHeader>
          <CardContent className="text-center">
            <Link href="/login" className={authLinkClass}>
              {t('backToLogin')}
            </Link>
          </CardContent>
        </Card>
      </AuthFrame>
    )
  }

  return (
    <AuthFrame>
      <Card className="w-full shadow-raised">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl font-bold">{t('signupTitle')}</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSignup} className="space-y-4">
            <fieldset className="space-y-2">
              <legend className="mb-2 text-sm font-medium">{t('accountType')}</legend>
              <div className="grid grid-cols-2 gap-3">
                {(
                  [
                    { value: 'agency', icon: Building2, label: t('agencyOption'), description: t('agencyOptionDesc') },
                    { value: 'direct', icon: Store, label: t('directOption'), description: t('directOptionDesc') },
                  ] as const
                ).map(({ value, icon: Icon, label, description }) => (
                  <label
                    key={value}
                    className={cn(
                      'lift flex cursor-pointer flex-col gap-1.5 rounded-lg border bg-card p-3 text-start hover:bg-accent/60',
                      'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring',
                      orgType === value && 'border-primary bg-accent hover:bg-accent'
                    )}
                  >
                    <input
                      type="radio"
                      name="orgType"
                      value={value}
                      checked={orgType === value}
                      onChange={() => setOrgType(value)}
                      className="sr-only"
                    />
                    <Icon className={cn('size-5', orgType === value ? 'text-primary' : 'text-muted-foreground')} aria-hidden />
                    <span className="text-sm font-medium">{label}</span>
                    <span className="text-xs text-muted-foreground">{description}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="space-y-2">
              <Label htmlFor="organizationName">{t(orgType === 'agency' ? 'agencyName' : 'businessName')}</Label>
              <Input
                id="organizationName"
                type="text"
                value={organizationName}
                onChange={(e) => setOrganizationName(e.target.value)}
                required
                placeholder={t(orgType === 'agency' ? 'agencyPlaceholder' : 'businessPlaceholder')}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="fullName">{tCommon('fullName')}</Label>
              <Input
                id="fullName"
                type="text"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                required
              />
            </div>
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
                minLength={6}
                placeholder={t('passwordMin')}
              />
            </div>

            <LegalConsentField consent={consent} invalid={consentMissing && !consent.accepted} />

            {error && <div className="text-sm text-destructive">{error}</div>}

            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? tCommon('loading') : t('signupButton')}
            </Button>
          </form>

          <p className="text-sm text-muted-foreground mt-4 text-center">
            {t('haveAccount')}{' '}
            <Link href="/login" className={authLinkClass}>
              {tCommon('login')}
            </Link>
          </p>
        </CardContent>
      </Card>
    </AuthFrame>
  )
}