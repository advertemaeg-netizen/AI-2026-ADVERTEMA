import { cn } from '@/lib/utils'

/** A sidebar link (dashboard and admin): the active one carries a marker on its inline-start edge */
export function navItemClass(isActive: boolean, inSheet: boolean) {
  return cn(
    'group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors duration-fast ease-out',
    'before:absolute before:inset-y-1.5 before:start-0 before:w-[3px] before:rounded-full before:bg-primary before:transition-transform before:duration-base before:ease-spring',
    inSheet && 'min-h-11',
    isActive
      ? 'bg-accent font-semibold text-primary before:scale-y-100'
      : 'text-muted-foreground before:scale-y-0 hover:bg-accent/60 hover:text-foreground'
  )
}

export const navIconClass = 'size-4 transition-transform duration-base ease-spring group-hover:scale-110'
