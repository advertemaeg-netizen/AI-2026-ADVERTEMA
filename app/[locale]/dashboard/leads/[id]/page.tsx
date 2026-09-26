import { notFound, redirect } from 'next/navigation'
import { canManage, getSession } from '@/lib/auth/session'
import { getLead } from '@/lib/actions/leads'
import { LeadView } from './_components/lead-view'

export default async function LeadPage({ params }: PageProps<'/[locale]/dashboard/leads/[id]'>) {
  const { id, locale } = await params
  const { profile } = await getSession()
  if (!profile) redirect(`/${locale}/login`)

  const result = await getLead(id)
  if (!result) notFound()

  return (
    <LeadView
      // remount after navigating between leads so local form state resets
      key={`${id}:${result.lead.updated_at}`}
      lead={result.lead}
      events={result.events}
      team={result.team}
      canManage={canManage(profile)}
      currentUserId={profile.id}
    />
  )
}
