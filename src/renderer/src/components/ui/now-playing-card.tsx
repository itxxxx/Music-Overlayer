import { motion } from 'framer-motion'
import {
  ArrowLeftRight,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
  SlidersHorizontal
} from 'lucide-react'
import { useState, type ReactNode } from 'react'
import type { RepeatMode } from '../../../../shared/types'
import { Button } from '@/components/ui/button'
import { CoverArt } from '@/components/ui/cover-art'
import { MarqueeText } from '@/components/ui/marquee-text'
import { TimelineSlider } from '@/components/ui/timeline-slider'
import { VisualizerBars } from '@/components/ui/visualizer-bars'
import { VolumeControl } from '@/components/ui/volume-control'
import { useTicker } from '@/hooks/use-playback'
import { formatTime } from '@/lib/format'
import type { Palette } from '@/lib/palette'
import { cn } from '@/lib/utils'

export interface NowPlayingCardProps {
  title: string
  artist: string
  appName: string | null
  sessionCount: number
  cover: string | null
  palette: Palette
  playing: boolean
  /** The card is open: animate the title and move the timeline. */
  open: boolean
  /** Where the track is at a given time. */
  getPosition(now: number): number
  durationMs: number
  canPlayPause: boolean
  canNext: boolean
  canPrev: boolean
  canSeek: boolean
  canShuffle: boolean
  canRepeat: boolean
  shuffle: boolean | null
  repeat: RepeatMode | null
  /** The player's volume-mixer level (0–1), or null when it can't be controlled. */
  volume: number | null
  muted: boolean | null
  /** Tooltip of the volume row, e.g. "Chrome volume (all tabs)". */
  volumeLabel: string
  visualizerActive: boolean
  /** Hide the bars entirely (nothing is playing). */
  showVisualizer?: boolean
  /** Shown under the artist, e.g. why media can't be read or that a player ignored a button. */
  notice?: string | null
  /** Small line under the controls. */
  credit?: string
  onToggle(): void
  onNext(): void
  onPrev(): void
  onSeek(positionMs: number): void
  onShuffle(): void
  onRepeat(): void
  onVolume(value: number, final: boolean): void
  onToggleMute(): void
  onCycleSession(): void
  onOpenEqualizer(): void
}

function ControlButton({
  label,
  hint,
  disabled,
  active,
  badge,
  soft,
  palette,
  onClick,
  children
}: {
  label: string
  /** Tooltip, when it should say more than the label (e.g. the current state). */
  hint?: string
  disabled?: boolean
  /** A toggle that is on (shuffle, repeat): filled with the tint like the play button. */
  active?: boolean
  /** Small mark on the corner, e.g. "1" for repeat one. */
  badge?: string
  soft?: boolean
  palette: Palette
  onClick(): void
  children: ReactNode
}) {
  return (
    <motion.div className="relative" whileHover={disabled ? undefined : { scale: 1.08 }} whileTap={disabled ? undefined : { scale: 0.9 }}>
      <Button
        variant="ghost"
        size="icon"
        data-no-drag
        aria-label={label}
        aria-pressed={active === undefined ? undefined : active}
        title={hint ?? label}
        disabled={disabled}
        onClick={(event) => {
          event.stopPropagation()
          onClick()
        }}
        className={cn(
          'size-9 rounded-full text-white transition-colors hover:bg-white/15 hover:text-white disabled:opacity-30',
          soft && 'bg-white/10',
          active && 'shadow-[0_4px_12px_-4px_rgba(0,0,0,0.55)]'
        )}
        style={active ? { background: palette.tint, color: palette.tintInk } : undefined}
      >
        {children}
      </Button>
      {badge && (
        <span
          aria-hidden
          className="pointer-events-none absolute -right-0.5 -top-0.5 grid size-[15px] place-items-center rounded-full text-[9.5px] font-extrabold leading-none shadow-[0_1px_3px_rgba(0,0,0,0.45)]"
          style={{ background: palette.tintInk, color: palette.tint }}
        >
          {badge}
        </span>
      )}
    </motion.div>
  )
}

/** Timeline and times. Re-renders on its own clock, so the rest of the card stays still. */
function TimelineRow({
  getPosition,
  durationMs,
  ticking,
  canSeek,
  onSeek
}: {
  getPosition(now: number): number
  durationMs: number
  ticking: boolean
  canSeek: boolean
  onSeek(positionMs: number): void
}) {
  const [scrub, setScrub] = useState<number | null>(null)
  const now = useTicker(ticking, 250)
  const position = getPosition(now)
  const hasTimeline = durationMs > 0
  const progress = hasTimeline ? position / durationMs : 0
  const shownPosition = scrub !== null && hasTimeline ? scrub * durationMs : position
  return (
    <div className="mt-3 px-0.5">
      <TimelineSlider value={scrub ?? progress} disabled={!canSeek} onScrub={setScrub} onSeek={(ratio) => onSeek(ratio * durationMs)} />
      <div className="mt-1 flex justify-between text-[11px] font-bold tabular-nums leading-4 text-white/55">
        <span>{formatTime(shownPosition)}</span>
        <span>{hasTimeline ? formatTime(durationMs) : '–:––'}</span>
      </div>
    </div>
  )
}

/**
 * The expanded card. Adapted from the 21st.dev AudioPlayer (components/ui/audio-player.tsx):
 * same layout and controls, but it drives whichever player Windows reports instead of an
 * <audio> element of its own.
 */
export function NowPlayingCard(props: NowPlayingCardProps) {
  const { palette } = props
  // Players that can't shuffle or repeat (browsers, Apple Music...) don't get dead buttons.
  const sideButtons = props.canShuffle || props.canRepeat

  return (
    <div className="flex flex-col p-3">
      {/* Artwork with live bars */}
      <div className="relative h-[172px] overflow-hidden rounded-[18px]">
        <CoverArt src={props.cover} className="absolute inset-0" iconClassName="size-10" />
        {props.showVisualizer !== false && (
          <>
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[62%] bg-gradient-to-t from-black/55 via-black/15 to-transparent" />
            <VisualizerBars
              count={26}
              active={props.visualizerActive}
              floor={0.05}
              className="pointer-events-none absolute inset-x-3 bottom-2.5 h-[48%]"
              color="rgb(255 255 255 / 0.8)"
              gap={3}
              radiusTop={3}
              radiusBottom={1.5}
            />
          </>
        )}
        {props.appName && (
          <button
            type="button"
            data-no-drag
            disabled={props.sessionCount < 2}
            onClick={props.onCycleSession}
            title={props.sessionCount > 1 ? 'Switch to another player' : `Playing in ${props.appName}`}
            className="absolute left-2.5 top-2.5 flex h-7 items-center gap-1.5 rounded-full bg-black/45 px-2.5 text-[11.5px] font-bold text-white/90 transition-colors enabled:hover:bg-black/60"
          >
            {props.appName}
            {props.sessionCount > 1 && <ArrowLeftRight className="size-3 opacity-75" strokeWidth={2.6} />}
          </button>
        )}
        <button
          type="button"
          data-no-drag
          onClick={props.onOpenEqualizer}
          aria-label="Equalizer"
          title="Equalizer"
          className="absolute right-2.5 top-2.5 grid size-8 place-items-center rounded-full bg-black/45 text-white/90 transition-colors hover:bg-black/60"
        >
          <SlidersHorizontal className="size-4" strokeWidth={2.4} />
        </button>
      </div>

      {/* Title and artist */}
      <div className="mt-3.5 min-w-0 text-center">
        <MarqueeText text={props.title} active={props.open} className="text-[16.5px] font-extrabold leading-[22px] tracking-[-0.01em]" />
        <p className="mt-0.5 truncate px-2 text-[13px] font-semibold leading-[18px] text-white/60">{props.artist}</p>
        {props.notice && <p className="mt-1 line-clamp-2 px-2 text-[11.5px] font-medium leading-4 text-amber-200/90">{props.notice}</p>}
      </div>

      <TimelineRow
        getPosition={props.getPosition}
        durationMs={props.durationMs}
        ticking={props.open && props.playing}
        canSeek={props.canSeek}
        onSeek={props.onSeek}
      />

      {/* Controls */}
      <div
        className={cn(
          'mt-2.5 flex items-center rounded-[20px] bg-black/25 px-3 py-2 ring-1 ring-inset ring-white/[0.06]',
          sideButtons ? 'justify-between' : 'justify-center gap-6'
        )}
      >
        {props.canShuffle ? (
          <ControlButton
            label="Shuffle"
            hint={props.shuffle ? 'Shuffle is on' : 'Shuffle is off'}
            soft
            active={props.shuffle === true}
            palette={palette}
            onClick={props.onShuffle}
          >
            <Shuffle className="size-[17px]" strokeWidth={2.4} />
          </ControlButton>
        ) : (
          sideButtons && <span className="size-9" aria-hidden />
        )}
        <ControlButton label="Previous" disabled={!props.canPrev} palette={palette} onClick={props.onPrev}>
          <SkipBack className="size-5 fill-current" strokeWidth={2.2} />
        </ControlButton>
        <motion.div whileHover={props.canPlayPause ? { scale: 1.06 } : undefined} whileTap={props.canPlayPause ? { scale: 0.92 } : undefined}>
          <Button
            variant="ghost"
            size="icon"
            data-no-drag
            aria-label={props.playing ? 'Pause' : 'Play'}
            title={props.playing ? 'Pause' : 'Play'}
            disabled={!props.canPlayPause}
            onClick={(event) => {
              event.stopPropagation()
              props.onToggle()
            }}
            className="size-[46px] rounded-full shadow-[0_6px_18px_-6px_rgba(0,0,0,0.6)] transition-[filter] hover:brightness-105 disabled:opacity-40"
            style={{ background: palette.tint, color: palette.tintInk }}
          >
            {props.playing ? (
              <Pause className="size-[19px] fill-current" strokeWidth={2.2} />
            ) : (
              <Play className="ml-0.5 size-[19px] fill-current" strokeWidth={2.2} />
            )}
          </Button>
        </motion.div>
        <ControlButton label="Next" disabled={!props.canNext} palette={palette} onClick={props.onNext}>
          <SkipForward className="size-5 fill-current" strokeWidth={2.2} />
        </ControlButton>
        {props.canRepeat ? (
          <ControlButton
            label="Repeat"
            hint={props.repeat === 'track' ? 'Repeating this track' : props.repeat === 'list' ? 'Repeating all' : 'Repeat is off'}
            soft
            active={props.repeat === 'list' || props.repeat === 'track'}
            badge={props.repeat === 'track' ? '1' : undefined}
            palette={palette}
            onClick={props.onRepeat}
          >
            {props.repeat === 'track' ? (
              <Repeat1 className="size-[17px]" strokeWidth={2.4} />
            ) : (
              <Repeat className="size-[17px]" strokeWidth={2.4} />
            )}
          </ControlButton>
        ) : (
          sideButtons && <span className="size-9" aria-hidden />
        )}
      </div>

      {props.volume !== null && (
        <div className="mt-1.5 pl-1 pr-1.5">
          <VolumeControl
            value={props.volume}
            muted={props.muted === true}
            label={props.volumeLabel}
            tint={palette.tint}
            onChange={props.onVolume}
            onToggleMute={props.onToggleMute}
          />
        </div>
      )}

      {props.credit && (
        <p className="-mb-1 mt-2 text-center text-[10px] font-semibold leading-3 tracking-[0.02em] text-white/30">{props.credit}</p>
      )}
    </div>
  )
}
