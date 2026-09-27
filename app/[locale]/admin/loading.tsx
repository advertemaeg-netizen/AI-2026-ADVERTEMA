import { Skeleton } from '@/components/ui/skeleton'

// Shown inside the shell while a page's data loads
export default function Loading() {
  return (
    <div className="grid gap-6 p-8" aria-busy="true">
      <Skeleton className="h-9 w-56" />
      <Skeleton className="h-5 w-96 max-w-full" />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
      <Skeleton className="h-96" />
    </div>
  )
}
