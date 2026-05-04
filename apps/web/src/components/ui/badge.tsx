import { HTMLAttributes } from 'react'

interface BadgeProps extends HTMLAttributes<HTMLDivElement> {
  variant?: 'default' | 'outline'
}

export function Badge({ className = '', variant = 'default', ...props }: BadgeProps) {
  const base = 'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold transition-colors'
  const variants = {
    default: 'bg-primary text-primary-foreground',
    outline: 'border border-current',
  }
  return <div className={`${base} ${variants[variant]} ${className}`} {...props} />
}
