import { getFormatter, getTranslations } from 'next-intl/server'
import { ShieldCheck } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { requireSuperAdmin } from '@/lib/auth/guards'
import { getSuperAdmins } from '@/lib/actions/admin'

const GRANT_SQL = "update public.users set role = 'super_admin' where email = 'name@example.com';"

export default async function AdminSettingsPage({ params }: PageProps<'/[locale]/admin/settings'>) {
  const { locale } = await params
  const profile = await requireSuperAdmin(locale)

  const t = await getTranslations('admin.settings')
  const format = await getFormatter()
  const admins = await getSuperAdmins()

  return (
    <div className="p-8 grid gap-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">{t('title')}</h1>
        <p className="text-muted-foreground mt-1">{t('description')}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('superAdmins')}</CardTitle>
          <CardDescription>{t('superAdminsDesc')}</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('columns.name')}</TableHead>
                <TableHead>{t('columns.email')}</TableHead>
                <TableHead>{t('columns.since')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {admins.map((admin) => (
                <TableRow key={admin.id}>
                  <TableCell className="font-medium">
                    <span className="inline-flex items-center gap-2">
                      <ShieldCheck className="size-4 text-muted-foreground" />
                      {admin.full_name || '—'}
                      {admin.id === profile.id && <span className="text-xs text-muted-foreground">{t('you')}</span>}
                    </span>
                  </TableCell>
                  <TableCell dir="ltr" className="text-start">{admin.email}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {format.dateTime(new Date(admin.created_at), { dateStyle: 'medium' })}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('grantTitle')}</CardTitle>
          <CardDescription>{t('grantDesc')}</CardDescription>
        </CardHeader>
        <CardContent>
          <pre dir="ltr" className="overflow-x-auto rounded-md bg-muted p-4 text-sm">
            <code>{GRANT_SQL}</code>
          </pre>
        </CardContent>
      </Card>
    </div>
  )
}
