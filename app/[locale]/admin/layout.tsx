import { redirect } from 'next/navigation'
import { requireSuperAdmin } from '@/lib/auth/guards'
import { createClient } from '@/lib/supabase/server'
import { AdminShell } from './_components/admin-shell'

export default async function AdminLayout({ children, params }: LayoutProps<'/[locale]/admin'>) {
  const { locale } = await params
  await requireSuperAdmin(locale)

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect(`/${locale}/login`)

  const { data: profile } = await supabase
    .from('users')
    .select('full_name')
    .eq('id', user.id)
    .single<{ full_name: string | null }>()

  return <AdminShell user={{ email: user.email!, fullName: profile?.full_name }}>{children}</AdminShell>
}
