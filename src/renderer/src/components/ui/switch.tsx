import { cn } from '@/lib/utils'

interface SwitchProps {
  checked: boolean
  onCheckedChange(checked: boolean): void
  label: string
  tint: string
  tintInk: string
  className?: string
}

export function Switch({ checked, onCheckedChange, label, tint, tintInk, className }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      data-no-drag
      onClick={() => onCheckedChange(!checked)}
      className={cn('relative h-[22px] w-[38px] shrink-0 rounded-full transition-colors duration-200', className)}
      style={{ background: checked ? tint : 'rgb(255 255 255 / 0.18)' }}
    >
      <span
        className={cn(
          'absolute left-[3px] top-[3px] size-4 rounded-full shadow transition-transform duration-200',
          checked && 'translate-x-4'
        )}
        style={{ background: checked ? tintInk : 'white' }}
      />
    </button>
  )
}
