import { CountUp, type CountUpOptions } from '@/components/count-up'

export type Stat = {
  name: string
  value: number
  options?: CountUpOptions
  /** The icon, rendered (a component cannot cross to the client) */
  icon: React.ReactNode
  hint: string
}

/**
 * The overview's four numbers on ONE glass panel: a single blurred surface
 * rather than four, which keeps the page inside the blur budget. The tiles
 * rise in one after another and their numbers count up.
 */
export function StatPanel({ stats }: { stats: Stat[] }) {
  return (
    <div className="glass glass-page mb-8 grid grid-cols-4 gap-2 rounded-2xl border p-2 max-lg:grid-cols-2 max-md:mb-4 max-md:gap-1.5 max-md:p-1.5">
      {stats.map((stat, i) => (
        <div
          key={stat.name}
          className="animate-enter stagger flex flex-col gap-2 rounded-xl bg-card/60 p-4 max-md:p-3"
          style={{ '--i': i + 1 } as React.CSSProperties}
        >
          <div className="flex items-center justify-between gap-2 max-md:items-start">
            <p className="text-sm font-medium text-muted-foreground">{stat.name}</p>
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent text-primary [&>svg]:size-4">
              {stat.icon}
            </span>
          </div>
          <CountUp value={stat.value} options={stat.options} className="text-3xl font-bold" />
          <p className="text-xs text-muted-foreground">{stat.hint}</p>
        </div>
      ))}
    </div>
  )
}
