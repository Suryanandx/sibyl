import { cn } from "@/lib/utils"
import { SibylLoader } from "@/components/sibyl/SibylLoader"

interface LoaderProps {
    text?: string
    className?: string
}

export const Loader = ({ text, className }: LoaderProps) => {
    return (
        <div className={cn("flex flex-col items-center justify-center", className)}>
            <SibylLoader state="working" size={32} className="text-[var(--text)]" />
            {text && (
                <p className="mt-4 text-[var(--text-2)] text-sm">{text}</p>
            )}
        </div>
    )
} 