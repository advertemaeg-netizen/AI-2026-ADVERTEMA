import { getTranslations } from 'next-intl/server'
import { CheckCircle2, XCircle } from 'lucide-react'
import { AuthFrame, authLinkClass } from '@/components/auth-frame'
import { Link } from '@/i18n/navigation'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { createClient } from '@/lib/supabase/server'
import type { UserRole } from '@/lib/types/team'
import { InviteActions } from './_components/invite-actions'

type InviteInfo = {
  email: string
  invited_name: string | null
  role: UserRole
  organization_name: string
  client_id: string | null
  client_name: string | null
  expires_at: string
  accepted: boolean
  expired: boolean
}

export default async function InvitePage({ params }: PageProps<'/[locale]/invite/[code]'>) {
  const { code } = await params
  const t = await getTranslations('invites.accept')
  const tRoles = await getTranslations('invites.roles')

  const supabase = await createClient()
  // get_invite is callable signed-out: the code itself is the secret
  const [{ data: invite }, { data: auth }] = await Promise.all([
    /^[0-9a-f]{16,64}$/i.test(code)
      ? supabase.rpc('get_invite', { code }).maybeSingle<InviteInfo>()
      : Promise.resolve({ data: null }),
    supabase.auth.getUser(),
  ])

  const problem = !invite ? 'notFound' : invite.accepted ? 'accepted' : invite.expired ? 'expired' : null

  return (
    <AuthFrame>
      <Card className="w-full shadow-raised">
        <CardHeader className="text-center">
          {problem && (
            <div className="flex justify-center mb-4">
              <XCircle className="size-12 animate-pop text-muted-foreground" />
            </div>
          )}
          <CardTitle className="text-2xl font-bold">{problem ? t(`problems.${problem}.title`) : t('title')}</CardTitle>
          <CardDescription className="text-base">
            {problem || !invite
              ? t(`problems.${problem ?? 'notFound'}.description`)
              : invite.client_name
                ? t('invitedToClient', {
                    organization: invite.organization_name,
                    role: tRoles(invite.role as 'client_admin' | 'team_member'),
                    client: invite.client_name,
                  })
                : t('invitedToOrg', {
                    organization: invite.organization_name,
                    role: tRoles(invite.role as 'client_admin' | 'team_member'),
                  })}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {problem || !invite ? (
            <div className="text-center">
              <Link href={auth.user ? '/dashboard' : '/login'} className={`text-sm ${authLinkClass}`}>
                {auth.user ? t('goToDashboard') : t('goToLogin')}
              </Link>
            </div>
          ) : (
            <>
              <InviteActions
                code={code}
                inviteEmail={invite.email}
                invitedName={invite.invited_name}
                signedInEmail={auth.user?.email ?? null}
              />
              <p className="mt-4 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
                <CheckCircle2 className="size-3.5" />
                {t('expiresOn', { date: new Date(invite.expires_at) })}
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </AuthFrame>
  )
}
