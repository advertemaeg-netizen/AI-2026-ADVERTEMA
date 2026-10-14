import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import {
  CalendarClockIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDotDashedIcon,
  CircleDotIcon,
  CircleMinusIcon,
  OctagonAlertIcon,
  TriangleAlertIcon,
  type LucideIcon,
} from "lucide-react"
import { cn } from "cn"
import { Slot } from "radix-ui"

const badgeVariants = cva(
  "group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-4xl border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 has-data-[icon=inline-end]:pe-1.5 has-data-[icon=inline-start]:ps-1.5 aria-invalid:border-destructive aria-invalid:ring-destructive/20 [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground [a]:hover:bg-primary-strong",
        secondary:
          "bg-secondary text-secondary-foreground [a]:hover:bg-accent",
        destructive:
          "bg-destructive-fill text-destructive-fill-foreground focus-visible:ring-destructive/20 [a]:hover:bg-destructive/20",
        outline:
          "border-border text-foreground [a]:hover:bg-muted [a]:hover:text-muted-foreground",
        ghost:
          "hover:bg-muted hover:text-muted-foreground",
        link: "text-primary underline-offset-4 hover:underline",
        // State tones (see the state tokens in app/globals.css)
        info: "bg-info-fill text-info-fill-foreground",
        progress: "border-border bg-muted text-foreground",
        scheduled: "bg-primary text-primary-foreground",
        positive: "bg-positive-fill text-positive-fill-foreground",
        warning: "bg-warning-fill text-warning-fill-foreground",
        critical: "bg-critical-fill text-critical-fill-foreground",
        quiet: "bg-muted text-muted-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>["variant"]>

/**
 * Every state badge carries a glyph, so its meaning never rests on hue alone
 * (critical and destructive share the rose; the glyph tells them apart).
 */
const STATE_GLYPH: Partial<Record<BadgeVariant, LucideIcon>> = {
  info: CircleDotIcon,
  progress: CircleDotDashedIcon,
  scheduled: CalendarClockIcon,
  positive: CircleCheckIcon,
  warning: TriangleAlertIcon,
  critical: OctagonAlertIcon,
  destructive: CircleAlertIcon,
  quiet: CircleMinusIcon,
}

function Badge({
  className,
  variant = "default",
  asChild = false,
  glyph = true,
  children,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & {
    asChild?: boolean
    /** false when the badge already shows its own icon */
    glyph?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "span"
  const Glyph = glyph && !asChild ? STATE_GLYPH[variant ?? "default"] : undefined

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    >
      {Glyph && <Glyph aria-hidden />}
      {children}
    </Comp>
  )
}

/**
 * A badge that shows a record's state: it pops in on the spring when it
 * appears and again whenever the state changes (the key remounts it).
 */
function StateBadge({
  state,
  variant,
  className,
  children,
}: {
  state: string
  variant: BadgeVariant
  className?: string
  children: React.ReactNode
}) {
  return (
    <Badge key={state} variant={variant} className={cn("animate-pop", className)}>
      {children}
    </Badge>
  )
}

export { Badge, StateBadge, badgeVariants, type BadgeVariant }
