import { useRef, useState, type PointerEvent } from 'react'
import { cn } from '@/lib/utils'

interface RangeSliderProps {
  value: number
  min: number
  max: number
  step?: number
  /** Value the fill grows from and double-click resets to. */
  origin?: number
  orientation?: 'vertical' | 'horizontal'
  label: string
  /** Text shown in the bubble while dragging. */
  format?(value: number): string
  onChange(value: number): void
  disabled?: boolean
  tint: string
  className?: string
}

/** Pointer-driven slider for equalizer bands (vertical) and preamp (horizontal). */
export function RangeSlider({
  value,
  min,
  max,
  step = 0.5,
  origin = 0,
  orientation = 'vertical',
  label,
  format,
  onChange,
  disabled,
  tint,
  className
}: RangeSliderProps) {
  const track = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)
  const vertical = orientation === 'vertical'
  const span = max - min
  const toRatio = (v: number) => (Math.min(max, Math.max(min, v)) - min) / span
  const ratio = toRatio(value)
  const originRatio = toRatio(origin)

  const valueFromPointer = (event: PointerEvent<HTMLDivElement>): number => {
    const rect = track.current?.getBoundingClientRect()
    if (!rect) return value
    const r = vertical ? 1 - (event.clientY - rect.top) / rect.height : (event.clientX - rect.left) / rect.width
    const raw = min + Math.min(1, Math.max(0, r)) * span
    return Math.round(raw / step) * step
  }

  const emit = (next: number) => {
    const clamped = Math.min(max, Math.max(min, next))
    if (clamped !== value) onChange(clamped)
  }

  const fillStart = Math.min(ratio, originRatio)
  const fillSize = Math.abs(ratio - originRatio)

  return (
    <div
      data-no-drag
      role="slider"
      aria-label={label}
      aria-orientation={orientation}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={format?.(value)}
      aria-disabled={disabled || undefined}
      className={cn('group relative touch-none', vertical ? 'h-full w-[22px]' : 'h-5 w-full', className)}
      onPointerDown={(event) => {
        if (disabled || event.button !== 0) return
        event.currentTarget.setPointerCapture(event.pointerId)
        setDragging(true)
        emit(valueFromPointer(event))
      }}
      onPointerMove={(event) => {
        if (dragging) emit(valueFromPointer(event))
      }}
      onPointerUp={() => setDragging(false)}
      onPointerCancel={() => setDragging(false)}
      onDoubleClick={() => !disabled && emit(origin)}
      onWheel={(event) => {
        if (disabled) return
        emit(value + (event.deltaY < 0 ? step : -step))
      }}
    >
      <div
        ref={track}
        className={cn(
          'absolute rounded-full bg-white/12',
          vertical ? 'inset-y-[7px] left-1/2 w-[3px] -translate-x-1/2' : 'inset-x-[7px] top-1/2 h-[3px] -translate-y-1/2'
        )}
      >
        <div
          className="absolute rounded-full"
          style={{
            background: disabled ? 'rgb(255 255 255 / 0.25)' : tint,
            ...(vertical
              ? { left: 0, right: 0, bottom: `${fillStart * 100}%`, height: `${fillSize * 100}%` }
              : { top: 0, bottom: 0, left: `${fillStart * 100}%`, width: `${fillSize * 100}%` })
          }}
        />
        <div
          className={cn(
            'absolute size-[14px] rounded-full shadow-[0_1px_5px_rgba(0,0,0,0.45)] transition-transform duration-100',
            dragging ? 'scale-110' : 'group-hover:scale-110',
            disabled ? 'bg-white/45' : 'bg-white'
          )}
          style={
            vertical
              ? { left: '50%', bottom: `${ratio * 100}%`, transform: 'translate(-50%, 50%)' }
              : { top: '50%', left: `${ratio * 100}%`, transform: 'translate(-50%, -50%)' }
          }
        />
        {dragging && format && (
          <div
            className="pointer-events-none absolute z-10 whitespace-nowrap rounded-md bg-black/80 px-1.5 py-0.5 text-[10.5px] font-bold tabular-nums text-white"
            style={
              vertical
                ? { left: '50%', bottom: `calc(${ratio * 100}% + 12px)`, transform: 'translateX(-50%)' }
                : { left: `${ratio * 100}%`, bottom: '12px', transform: 'translateX(-50%)' }
            }
          >
            {format(value)}
          </div>
        )}
      </div>
    </div>
  )
}
