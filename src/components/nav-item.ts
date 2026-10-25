import { cn } from '@/lib/utils'

/** The sidebar's nav (dashboard and admin): holds the NavIndicator that slides between items */
export const navClass = 'group/nav relative flex-1 space-y-1 overflow-y-auto p-4'

/**
 * A sidebar link. Hover fades the periwinkle tint in on ::before. The active
 * item is the selection blue tint (--brand), drawn by
 * the item only until the NavIndicator takes over.
 */
export function navItemClass(isActive: boolean, inSheet: boolean) {
  return cn(
    'group relative isolate flex items-center gap-3 rounded-lg px-3 py-2 text-sm',
    'before:absolute before:inset-0 before:-z-10 before:rounded-lg before:bg-accent before:opacity-0 before:transition-opacity before:duration-fast before:ease-out',
    inSheet && 'min-h-11',
    isActive
      ? 'bg-brand font-semibold text-brand-foreground group-data-[indicator=ready]/nav:bg-transparent after:absolute after:inset-y-1.5 after:start-0 after:w-[3px] after:rounded-full after:bg-primary group-data-[indicator=ready]/nav:after:hidden'
      : 'text-muted-foreground hover:text-foreground hover:before:opacity-60'
  )
}

export const navIconClass = 'size-4 transition-transform duration-base ease-spring group-hover:scale-110'
