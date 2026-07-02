import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"
import { useState, type CSSProperties } from "react"

import { cn } from "~/lib/utils"

const buttonVariants = cva(
    "group/button relative isolate inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
    {
        variants: {
            variant: {
                default: "bg-primary text-primary-foreground [a]:hover:bg-primary/80",
                outline:
                    "border-border bg-background hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
                secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80 aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
                ghost: "hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50",
                destructive:
                    "bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30 dark:focus-visible:ring-destructive/40",
                link: "text-primary underline-offset-4 hover:underline",
            },
            size: {
                default: "h-8 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
                xs: "h-6 gap-1 rounded-[min(var(--radius-md),10px)] px-2 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
                sm: "h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
                lg: "h-9 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
                icon: "size-8",
                "icon-xs": "size-6 rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
                "icon-sm": "size-7 rounded-[min(var(--radius-md),12px)] in-data-[slot=button-group]:rounded-lg",
                "icon-lg": "size-9",
            },
        },
        defaultVariants: {
            variant: "default",
            size: "default",
        },
    },
)

interface Ripple {
    key: number
    x: number
    y: number
    size: number
}

function Button({ className, variant = "default", size = "default", onClick, children, ...props }: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
    const [ripples, setRipples] = useState<Ripple[]>([])

    const handleClick: NonNullable<ButtonPrimitive.Props["onClick"]> = (event) => {
        const button = event.currentTarget
        const rect = button.getBoundingClientRect()
        const size = Math.max(rect.width, rect.height) * 2
        const x = event.clientX - rect.left - size / 2
        const y = event.clientY - rect.top - size / 2
        const key = Date.now()
        setRipples(prev => [...prev, { key, x, y, size }])
        setTimeout(() => setRipples(prev => prev.filter(r => r.key !== key)), 600)
        onClick?.(event)
    }

    return (
        <ButtonPrimitive data-slot="button" className={cn(buttonVariants({ variant, size, className }))} onClick={handleClick} {...props}>
            {children}
            <span className="pointer-events-none absolute inset-0 z-0 overflow-hidden rounded-[inherit]">
                {ripples.map(ripple => (
                    <span
                        key={ripple.key}
                        className="absolute rounded-full animate-button-ripple"
                        style={{
                            left: ripple.x,
                            top: ripple.y,
                            width: ripple.size,
                            height: ripple.size,
                            backgroundColor: "var(--button-ripple-color, rgba(0,0,0,0.1))",
                        } as CSSProperties}
                    />
                ))}
            </span>
        </ButtonPrimitive>
    )
}

export { Button, buttonVariants }
