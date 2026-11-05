import { Volume, Volume1, Volume2, VolumeX } from 'lucide-react'
import { useRef, useState, type PointerEvent } from 'react'
import { cn } from '@/lib/utils'

interface VolumeControlProps {
  /** 0–1. */
  value: number
  muted: boolean
  /** e.g. "Spotify volume" or "Chrome volume (all tabs)". */
  label: string
  tint: string
  /** Called while dragging (final false) and on release or wheel (final true). */
  onChange(value: number, final: boolean): void
  onToggleMute(): void
}

const WHEEL_STEP = 0.05

/** The player's own volume: a mute button, a slim slider and the level in percent. */
export function VolumeControl({ value, muted, label, tint, onChange, onToggleMute }: VolumeControlProps) {
  const track = useRef<HTMLDivElement>(null)
  const [dragValue, setDragValue] = useState<number | null>(null)
  const shown = dragValue ?? value
  const silent = muted || shown === 0
  const Icon = silent ? VolumeX : shown < 0.34 ? Volume : shown < 0.67 ? Volume1 : Volume2

  const ratio = (event: PointerEvent<HTMLDivElement>): number => {
    const rect = track.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return shown
    return Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
  }

  return (
    <div
      className="flex h-7 items-center gap-2"
      title={label}
      onWheel={(event) => {
        const step = event.deltaY < 0 ? WHEEL_STEP : -WHEEL_STEP
        onChange(Math.round(Math.min(1, Math.max(0, shown + step)) * 100) / 100, true)
      }}
    >
      <button
        type="button"
        data-no-drag
        onClick={onToggleMute}
        aria-label={muted ? `Unmute (${label})` : `Mute (${label})`}
        title={muted ? 'Unmute' : 'Mute'}
        className="grid size-7 shrink-0 place-items-center rounded-full text-white/75 transition-colors hover:bg-white/12 hover:text-white"
      >
        <Icon className="size-4" strokeWidth={2.4} />
      </button>
      <div
        data-no-drag
        role="slider"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(shown * 100)}
        className="group relative flex h-5 flex-1 touch-none items-center"
        onPointerDown={(event) => {
          if (event.button !== 0) return
          event.currentTarget.setPointerCapture(event.pointerId)
          const next = ratio(event)
          setDragValue(next)
          onChange(next, false)
        }}
        onPointerMove={(event) => {
          if (dragValue === null) return
          const next = ratio(event)
          setDragValue(next)
          onChange(next, false)
        }}
        onPointerUp={(event) => {
          if (dragValue === null) return
          const next = ratio(event)
          setDragValue(null)
          onChange(next, true)
        }}
        onPointerCancel={() => setDragValue(null)}
      >
        <div
          ref={track}
          className={cn(
            'relative h-1 w-full overflow-hidden rounded-full bg-white/18 transition-[height] duration-150 group-hover:h-1.5',
            dragValue !== null && 'h-1.5'
          )}
        >
          <div
            className={cn('absolute inset-y-0 left-0 rounded-full', silent && 'opacity-45')}
            style={{ width: `${shown * 100}%`, background: tint }}
          />
        </div>
        <div
          className={cn(
            'pointer-events-none absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_1px_4px_rgba(0,0,0,0.4)] transition-opacity duration-150',
            dragValue === null ? 'opacity-0 group-hover:opacity-100' : 'opacity-100'
          )}
          style={{ left: `${shown * 100}%` }}
        />
      </div>
      <span className={cn('w-7 shrink-0 text-right text-[11px] font-bold tabular-nums leading-4', silent ? 'text-white/35' : 'text-white/55')}>
        {Math.round(shown * 100)}
      </span>
    </div>
  )
}
