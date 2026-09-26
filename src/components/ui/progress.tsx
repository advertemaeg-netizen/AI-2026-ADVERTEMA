import * as React from "react"
import { cn } from "cn"
import { Progress as ProgressPrimitive } from "radix-ui"

function Progress({
  className,
  value,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root>) {
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      className={cn(
        "relative flex h-1 w-full items-center overflow-x-hidden rounded-full bg-muted [--progress-dir:1] rtl:[--progress-dir:-1]",
        className
      )}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className="size-full flex-1 bg-primary transition-all"
        // translateX is physical, so mirror the offset in RTL to fill from the start side
        style={{ transform: `translateX(calc(-${100 - (value || 0)}% * var(--progress-dir, 1)))` }}
      />
    </ProgressPrimitive.Root>
  )
}

export { Progress }
