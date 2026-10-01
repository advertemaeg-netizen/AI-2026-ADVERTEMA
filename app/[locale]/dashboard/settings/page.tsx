import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { getSession } from '@/lib/auth/session'
import { getAccountSettings } from '@/lib/actions/settings'
import { DisplayNameForm } from './_components/display-name-form'
import { PasswordForm } from './_components/password-form'
import { LanguageChoice } from './_components/language-choice'
import { OrganizationForm } from './_components/organization-form'

/**
 * Every role: its own account. Organization admins: the organization too.
 * Who sees what is decided by getAccountSettings() (the organization is
 * null for everyone else), and each action checks the caller again.
 */
export default async function SettingsPage({ params }: PageProps<'/[locale]/dashboard/settings'>) {
  const { locale } = await params
  const { profile, impersonation } = await getSession()
  if (!profile) redirect(`/${locale}/login`)

  const settings = await getAccountSettings()
  if (!settings) redirect(`/${locale}/login`)

  const t = await getTranslations('settings')
  // A super admin viewing a customer's account: nothing here is theirs to change
  const readOnly = impersonation !== null

  return (
    <div className="grid max-w-3xl gap-6 p-8 max-md:p-4">
      <div>
        <h1 className="text-3xl font-bold tracking-tight max-md:text-2xl">{t('title')}</h1>
        <p className="mt-1 text-muted-foreground">{t('description')}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('account.title')}</CardTitle>
          <CardDescription>{t('account.description')}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-8">
          <DisplayNameForm name={settings.full_name} email={settings.email} disabled={readOnly} />
          {!readOnly && <PasswordForm />}
          <LanguageChoice />
        </CardContent>
      </Card>

      {settings.organization && (
        <Card>
          <CardHeader>
            <CardTitle>{t('organization.title')}</CardTitle>
            <CardDescription>{t('organization.description')}</CardDescription>
          </CardHeader>
          <CardContent>
            <OrganizationForm organization={settings.organization} disabled={readOnly} />
          </CardContent>
        </Card>
      )}
    </div>
  )
}
