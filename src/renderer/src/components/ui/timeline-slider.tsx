import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { cn } from '@/lib/utils'

interface TimelineSliderProps {
  /** Progress, 0–1. */
  value: number
  disabled?: boolean
  /** Called on release with the chosen progress (0–1). */
  onSeek(value: number): void
  /** Called while dragging with the preview progress, and with null when the drag ends. */
  onScrub?(value: number | null): void
  /**
   * Glide between position updates. Only worth it for short tracks: on a normal song the bar
   * moves well under a pixel per update, and gliding would redraw the card 60 times a second.
   */
  smooth?: boolean
  className?: string
}

/** Seek bar adapted from the 21st.dev audio player's CustomSlider, with dragging. */
export function TimelineSlider({ value, disabled, onSeek, onScrub, smooth = false, className }: TimelineSliderProps) {
  const track = useRef<HTMLDivElement>(null)
  const [dragValue, setDragValue] = useState<number | null>(null)
  const previous = useRef(value)
  const shown = dragValue ?? value
  // Big jumps (new track, seek) snap; small steps glide between position updates when `smooth`.
  const jumped = Math.abs(value - previous.current) > 0.02
  const glide = smooth && dragValue === null && !jumped
  useEffect(() => {
    previous.current = value
  })

  const ratio = (event: PointerEvent<HTMLDivElement>): number => {
    const rect = track.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return 0
    return Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
  }

  return (
    <div
      data-no-drag
      role="slider"
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(shown * 100)}
      aria-disabled={disabled || undefined}
      className={cn('group relative flex h-4 touch-none items-center', disabled && 'opacity-40', className)}
      onPointerDown={(event) => {
        if (disabled || event.button !== 0) return
        event.currentTarget.setPointerCapture(event.pointerId)
        const next = ratio(event)
        setDragValue(next)
        onScrub?.(next)
      }}
      onPointerMove={(event) => {
        if (dragValue === null) return
        const next = ratio(event)
        setDragValue(next)
        onScrub?.(next)
      }}
      onPointerUp={(event) => {
        if (dragValue === null) return
        const next = ratio(event)
        setDragValue(null)
        onScrub?.(null)
        onSeek(next)
      }}
      onPointerCancel={() => {
        setDragValue(null)
        onScrub?.(null)
      }}
    >
      <div
        ref={track}
        className={cn(
          'relative h-[5px] w-full overflow-hidden rounded-full bg-white/20 transition-[height] duration-150',
          !disabled && 'group-hover:h-[7px]',
          dragValue !== null && 'h-[7px]'
        )}
      >
        {/* A full-width fill slid into place: moving it needs no layout, just compositing. */}
        <div
          className={cn('absolute inset-0 rounded-full bg-white/90', glide && 'transition-transform duration-300 ease-linear')}
          style={{ transform: `translateX(${(shown - 1) * 100}%)` }}
        />
      </div>
      {!disabled && (
        <div
          className={cn('pointer-events-none absolute inset-0', glide && 'transition-transform duration-300 ease-linear')}
          style={{ transform: `translateX(${shown * 100}%)` }}
        >
          <div
            className={cn(
              'absolute left-0 top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_1px_4px_rgba(0,0,0,0.4)] transition-opacity duration-150',
              dragValue === null ? 'opacity-0 group-hover:opacity-100' : 'opacity-100'
            )}
          />
        </div>
      )}
    </div>
  )
}
