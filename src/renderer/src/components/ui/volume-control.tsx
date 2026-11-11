import { Volume2, VolumeX } from 'lucide-react'
import { useState } from 'react'
import { Slider } from '@/components/ui/slider'
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
 * The player's own volume on the elastic slider: the speaker on the left mutes, and the level
 * in percent shows above it while it's hovered or dragged. With a `max` of 2 it goes to 200%: a
 * notch marks 100% and the part above it turns warm.
 */
export function VolumeControl({ value, max = 1, muted, label, hint, tint, onChange, onToggleMute }: VolumeControlProps) {
  const [dragValue, setDragValue] = useState<number | null>(null)
  const shown = Math.min(max, dragValue ?? value)
  const silent = muted || shown === 0
  const boosted = shown > 1.001
  const percent = Math.round(shown * 100)
  // Where 100% falls inside the filled part, for the warm colour above it.
  const full = boosted ? (1 / shown) * 100 : 100
  const range = boosted ? `linear-gradient(90deg, ${tint} 0 ${full}%, ${BOOST_COLOR} ${full}% 100%)` : tint

  return (
    <div
      className="flex h-7 items-center gap-2"
      title={hint ? `${label}. ${hint}` : label}
      onWheel={(event) => {
        const step = event.deltaY < 0 ? WHEEL_STEP : -WHEEL_STEP
        onChange(Math.round(Math.min(max, Math.max(0, shown + step)) * 100) / 100, true)
      }}
    >
      <Slider
        value={shown * 100}
        max={max * 100}
        step={1}
        label={label}
        valueText={`${percent}%${boosted ? ', boosted' : ''}`}
        onChange={(next) => {
          setDragValue(next / 100)
          onChange(next / 100, false)
        }}
        onCommit={(next) => {
          setDragValue(null)
          onChange(next / 100, true)
        }}
        start={
          <button
            type="button"
            data-no-drag
            onClick={onToggleMute}
            aria-label={muted ? `Unmute (${label})` : `Mute (${label})`}
            title={muted ? 'Unmute' : 'Mute'}
            className={cn(
              'grid size-7 place-items-center rounded-full transition-colors hover:bg-white/12 hover:text-white',
              muted ? 'bg-white/14 text-white' : 'text-white/75'
            )}
          >
            <VolumeX className="size-[18px] fill-current" strokeWidth={2.2} />
          </button>
        }
        end={
          <Volume2
            className={cn('size-[18px] fill-current', !boosted && 'text-white/75')}
            style={boosted && !silent ? { color: BOOST_COLOR } : undefined}
            strokeWidth={2.2}
            aria-hidden
          />
        }
        bubble={
          <span className={cn(silent ? 'text-white/50' : !boosted && 'text-white')} style={boosted && !silent ? { color: BOOST_COLOR } : undefined}>
            {muted ? 'Muted' : `${percent}%`}
          </span>
        }
        rangeStyle={{ background: range, opacity: silent ? 0.45 : 1 }}
        marks={
          max > 1 && (
            <span
              className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-black/35"
              style={{ left: `${(1 / max) * 100}%` }}
              aria-hidden
            />
          )
        }
      />
    </div>
  )
}
