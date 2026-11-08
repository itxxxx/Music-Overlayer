import { Volume, Volume1, Volume2, VolumeX } from 'lucide-react'
import { useRef, useState, type PointerEvent } from 'react'
import { cn } from '@/lib/utils'

interface VolumeControlProps {
  /** 0 to `max`. */
  value: number
  /** 1, or 2 when the player can be boosted to 200%. */
  max?: number
  muted: boolean
  /** e.g. "Spotify volume" or "Chrome volume (all tabs)". */
  label: string
  /** Added to the tooltip, e.g. how to get the boost. */
  hint?: string | null
  tint: string
  /** Called while dragging (final false) and on release or wheel (final true). */
  onChange(value: number, final: boolean): void
  onToggleMute(): void
}

const WHEEL_STEP = 0.05
/** The boosted part of the slider (above 100%): warm, whatever the artwork's colour. */
const BOOST_COLOR = '#ff9d57'

/**
 * The player's own volume: a mute button, a slim slider and the level in percent. With a `max`
 * of 2 the slider goes to 200%: a notch marks 100% and the part above it turns warm.
 */
export function VolumeControl({ value, max = 1, muted, label, hint, tint, onChange, onToggleMute }: VolumeControlProps) {
  const track = useRef<HTMLDivElement>(null)
  const [dragValue, setDragValue] = useState<number | null>(null)
  const shown = Math.min(max, dragValue ?? value)
  const silent = muted || shown === 0
  const boosted = shown > 1.001
  const Icon = silent ? VolumeX : shown < 0.34 ? Volume : shown < 0.67 ? Volume1 : Volume2
  const percent = (level: number): string => `${(level / max) * 100}%`

  const ratio = (event: PointerEvent<HTMLDivElement>): number => {
    const rect = track.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return shown
    return Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)) * max
  }

  return (
    <div
      className="flex h-7 items-center gap-2"
      title={hint ? `${label}. ${hint}` : label}
      onWheel={(event) => {
        const step = event.deltaY < 0 ? WHEEL_STEP : -WHEEL_STEP
        onChange(Math.round(Math.min(max, Math.max(0, shown + step)) * 100) / 100, true)
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
        aria-valuemax={Math.round(max * 100)}
        aria-valuenow={Math.round(shown * 100)}
        aria-valuetext={`${Math.round(shown * 100)}%${boosted ? ', boosted' : ''}`}
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
            style={{ width: percent(Math.min(shown, 1)), background: tint }}
          />
          {boosted && (
            <div
              className={cn('absolute inset-y-0 rounded-r-full', silent && 'opacity-45')}
              style={{ left: percent(1), width: percent(shown - 1), background: BOOST_COLOR }}
            />
          )}
        </div>
        {max > 1 && (
          <div
            className="pointer-events-none absolute top-1/2 h-2.5 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/45"
            style={{ left: percent(1) }}
            aria-hidden
          />
        )}
        <div
          className={cn(
            'pointer-events-none absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_1px_4px_rgba(0,0,0,0.4)] transition-opacity duration-150',
            dragValue === null ? 'opacity-0 group-hover:opacity-100' : 'opacity-100'
          )}
          style={{ left: percent(shown) }}
        />
      </div>
      <span
        className={cn('w-7 shrink-0 text-right text-[11px] font-bold tabular-nums leading-4', silent ? 'text-white/35' : !boosted && 'text-white/55')}
        style={boosted && !silent ? { color: BOOST_COLOR } : undefined}
      >
        {Math.round(shown * 100)}
      </span>
    </div>
  )
}
