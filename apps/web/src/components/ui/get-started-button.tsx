import { ChevronRight } from "lucide-react"

import { Button } from "~/components/ui/button"

interface GetStartedButtonProps {
    label?: string
    type?: "button" | "submit"
    disabled?: boolean
    className?: string
    onClick?: () => void
}

export function GetStartedButton({ label = "开始测试", type = "button", disabled, className, onClick }: GetStartedButtonProps) {
    return (
        <Button type={type} disabled={disabled} onClick={onClick} className={`group relative overflow-hidden bg-[var(--text-primary)] text-[var(--bg-base)] hover:bg-[var(--text-primary)]/90 ${className ?? ""}`} size="lg">
            <span className="mr-8 transition-opacity duration-500 group-hover:opacity-0">
                {label}
            </span>
            <i className="absolute right-1 top-1 bottom-1 z-10 grid w-1/4 place-items-center rounded-sm bg-[var(--bg-base)]/15 text-[var(--bg-base)] transition-all duration-500 group-hover:w-[calc(100%-0.5rem)] group-active:scale-95">
                <ChevronRight size={16} strokeWidth={2} aria-hidden="true" />
            </i>
        </Button>
    )
}
