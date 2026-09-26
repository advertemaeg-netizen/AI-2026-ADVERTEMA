import { Skeleton } from '@/components/ui/skeleton'

// First load only; changing the range keeps the current charts (dimmed)
export default function AnalyticsLoading() {
  return (
    <div className="grid gap-6 p-8" aria-busy="true">
      <Skeleton className="h-9 w-48" />
      <Skeleton className="h-8 w-96 max-w-full" />
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
      <Skeleton className="h-80" />
      <div className="grid gap-6 lg:grid-cols-2">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-72" />
        ))}
      </div>
    </div>
  )
}
