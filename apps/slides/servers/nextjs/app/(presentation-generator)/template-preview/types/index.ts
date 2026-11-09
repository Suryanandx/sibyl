

export interface LoadingState {
    loading: boolean
    error: string | null
}

export interface ComponentProps {
    className?: string
    children?: React.ReactNode
}
