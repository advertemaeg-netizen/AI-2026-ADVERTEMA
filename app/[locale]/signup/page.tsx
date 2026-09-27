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
import { Sparkles, CheckCircle2, Building2, Store } from 'lucide-react'
import { cn } from '@/lib/utils'

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

  async function handleSignup(e: React.FormEvent) {
    e.preventDefault()
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
      <div className="min-h-screen flex items-center justify-center p-4 bg-background">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="flex justify-center mb-4">
              <CheckCircle2 className="w-12 h-12 text-green-500" />
            </div>
            <CardTitle>{t('checkEmail')}</CardTitle>
            <CardDescription>{t('checkEmailDesc')}</CardDescription>
          </CardHeader>
          <CardContent className="text-center">
            <Link href="/login" className="text-sm text-muted-foreground hover:underline">
              {t('backToLogin')}
            </Link>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-background">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="flex justify-center mb-4">
            <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-purple-500 to-orange-500 flex items-center justify-center">
              <Sparkles className="w-6 h-6 text-white" />
            </div>
          </div>
          <CardTitle className="text-2xl">{t('signupTitle')}</CardTitle>
          <CardDescription>Connecta AI</CardDescription>
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
                      'flex cursor-pointer flex-col gap-1.5 rounded-lg border p-3 text-start transition-colors hover:bg-muted/50',
                      'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring',
                      orgType === value && 'border-primary bg-primary/5 hover:bg-primary/5'
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

            {error && <div className="text-sm text-destructive">{error}</div>}

            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? tCommon('loading') : t('signupButton')}
            </Button>
          </form>

          <p className="text-sm text-muted-foreground mt-4 text-center">
            {t('haveAccount')}{' '}
            <Link href="/login" className="text-foreground font-medium hover:underline">
              {tCommon('login')}
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  )
}