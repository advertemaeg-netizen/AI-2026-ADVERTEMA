import { getTranslations } from 'next-intl/server'
import { FileQuestion } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import { Button } from '@/components/ui/button'

// notFound() anywhere under [locale], and unknown URLs (through [...rest])
export default async function NotFound() {
  const t = await getTranslations('errorPage')

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-8 text-center">
      <FileQuestion className="size-10 text-muted-foreground" aria-hidden />
      <div className="grid gap-1.5">
        <h1 className="text-2xl font-bold tracking-tight">{t('notFound.title')}</h1>
        <p className="max-w-md text-muted-foreground">{t('notFound.description')}</p>
      </div>
      <Button variant="outline" asChild>
        <Link href="/dashboard">{t('backToDashboard')}</Link>
      </Button>
    </div>
  )
}
