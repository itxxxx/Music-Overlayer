import { AnimatePresence, motion } from 'framer-motion'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { APP_CREDIT, APP_NAME, GEOMETRY, PILL_TOP, type RepeatMode } from '../../../../shared/types'
import { NowPlayingCard } from '@/components/ui/now-playing-card'
import { NowPlayingPill } from '@/components/ui/now-playing-pill'
import { EqualizerView } from '@/components/widget/equalizer-view'
import { useCoverPalette, useDisplayedCover } from '@/hooks/use-cover'
import { usePlayback, useTicker } from '@/hooks/use-playback'
import { audioLevels } from '@/lib/audio-levels'
import { useWidget } from '@/lib/store'
import { cn } from '@/lib/utils'

type View = 'player' | 'eq'
type TimerName = 'expand' | 'collapse' | 'idle' | 'resetView' | 'sticky'

const COLLAPSE_DELAY_MS = 600
/** Leaving the equalizer by accident while dragging a slider shouldn't close it. */
const COLLAPSE_DELAY_EQ_MS = 2500
const WAKE_ON_TRACK_CHANGE_MS = 3000
const DRAG_THRESHOLD_PX = 4
const SPRING = { type: 'spring', stiffness: 380, damping: 34, mass: 0.9 } as const

/**
 * The widget: a pill that fades when left alone and opens into the card when the pointer rests
 * on it. Owns hover/idle timing, dragging and the click-through hand-off with the main process.
 */
export function Widget() {
  const api = window.musicWidget
  const coverState = useWidget((state) => state.cover)
  const bridge = useWidget((state) => state.bridge)
  const settings = useWidget((state) => state.settings)
  const preferredDirection = useWidget((state) => state.direction)

  const playback = usePlayback()
  const { session } = playback
  const coverSrc = useDisplayedCover(session?.trackKey ?? null, coverState)
  const palette = useCoverPalette(coverSrc)

  const [expanded, setExpanded] = useState(false)
  const [view, setView] = useState<View>('player')
  const [idle, setIdle] = useState(false)
  const [cardHeight, setCardHeight] = useState(364)
  // Which way the card opens. The pill sits in the same spot either way, so the direction only
  // changes while the card is folded away; an open card never jumps.
  const [direction, setDirection] = useState(preferredDirection)
  useEffect(() => {
    if (expanded || direction === preferredDirection) return
    const timer = window.setTimeout(() => setDirection(preferredDirection), 450)
    return () => window.clearTimeout(timer)
  }, [expanded, direction, preferredDirection])

  const shellRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const timers = useRef<Record<TimerName, number>>({ expand: 0, collapse: 0, idle: 0, resetView: 0, sticky: 0 })
  const hoveredRef = useRef(false)
  const expandedRef = useRef(false)
  const viewRef = useRef<View>('player')
  const draggingRef = useRef(false)
  const pressRef = useRef<{ x: number; y: number; id: number } | null>(null)
  const settingsRef = useRef(settings)
  settingsRef.current = settings

  const clearTimer = useCallback((name: TimerName) => {
    window.clearTimeout(timers.current[name])
    timers.current[name] = 0
  }, [])

  const startTimer = useCallback(
    (name: TimerName, ms: number, run: () => void) => {
      clearTimer(name)
      timers.current[name] = window.setTimeout(() => {
        timers.current[name] = 0
        run()
      }, ms)
    },
    [clearTimer]
  )

  const scheduleIdle = useCallback(
    (delay = settingsRef.current.idleDelayMs) => {
      startTimer('idle', delay, () => {
        if (!hoveredRef.current && !expandedRef.current) setIdle(true)
      })
    },
    [startTimer]
  )

  const showView = useCallback((next: View) => {
    viewRef.current = next
    setView(next)
  }, [])

  const open = useCallback(
    (nextView?: View) => {
      clearTimer('expand')
      clearTimer('collapse')
      clearTimer('idle')
      clearTimer('resetView')
      expandedRef.current = true
      setExpanded(true)
      setIdle(false)
      if (nextView) showView(nextView)
    },
    [clearTimer, showView]
  )

  const close = useCallback(() => {
    clearTimer('expand')
    clearTimer('collapse')
    clearTimer('sticky')
    expandedRef.current = false
    setExpanded(false)
    // Switch back to the player once the card has folded away.
    startTimer('resetView', 450, () => showView('player'))
    scheduleIdle()
  }, [clearTimer, startTimer, showView, scheduleIdle])

  const handleEnter = useCallback(() => {
    api.setInteractive(true)
    if (hoveredRef.current) return
    hoveredRef.current = true
    clearTimer('collapse')
    clearTimer('idle')
    clearTimer('sticky')
    setIdle(false)
    if (!expandedRef.current && !draggingRef.current) {
      startTimer('expand', settingsRef.current.hoverDelayMs, () => open())
    }
  }, [api, clearTimer, startTimer, open])

  const handleLeave = useCallback(() => {
    if (draggingRef.current) return
    api.setInteractive(false)
    if (!hoveredRef.current) return
    hoveredRef.current = false
    clearTimer('expand')
    if (expandedRef.current) {
      startTimer('collapse', viewRef.current === 'eq' ? COLLAPSE_DELAY_EQ_MS : COLLAPSE_DELAY_MS, close)
    } else {
      scheduleIdle()
    }
  }, [api, clearTimer, startTimer, close, scheduleIdle])

  // Fade after the first few seconds; clean up every timer on unmount.
  useEffect(() => {
    scheduleIdle()
    const pending = timers.current
    return () => {
      for (const id of Object.values(pending)) window.clearTimeout(id)
    }
  }, [scheduleIdle])

  // Pointer enter/leave detected by the main process (backstop for click-through windows).
  useEffect(() => api.onPointer((event) => (event === 'enter' ? handleEnter() : handleLeave())), [api, handleEnter, handleLeave])

  // Commands from the tray menu.
  useEffect(
    () =>
      api.onCommand((command) => {
        open(command === 'open-eq' ? 'eq' : undefined)
        // Opened from the tray: close again if the pointer never comes over.
        startTimer('sticky', 10_000, () => {
          if (!hoveredRef.current) close()
        })
      }),
    [api, open, close, startTimer]
  )

  // A new song wakes the faded pill for a moment.
  const trackKey = session?.trackKey ?? null
  const lastTrack = useRef(trackKey)
  useEffect(() => {
    if (lastTrack.current === trackKey) return
    lastTrack.current = trackKey
    if (!trackKey || hoveredRef.current || expandedRef.current) return
    setIdle(false)
    scheduleIdle(WAKE_ON_TRACK_CHANGE_MS)
  }, [trackKey, scheduleIdle])

  // Visualizer
  useEffect(() => audioLevels.setPlaying(playback.playing), [playback.playing])
  useEffect(() => {
    if (!settings.visualizer) audioLevels.stopLive()
  }, [settings.visualizer])

  // Tell the main process where the widget is, so clicks elsewhere pass through.
  useLayoutEffect(() => {
    const element = shellRef.current
    if (!element) return
    let frame = 0
    const report = () => {
      frame = 0
      const rect = element.getBoundingClientRect()
      api.setHitRect({
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      })
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(report)
    }
    const observer = new ResizeObserver(schedule)
    observer.observe(element)
    schedule()
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [api, direction])

  // The card's height follows its content (player or equalizer).
  useLayoutEffect(() => {
    const element = cardRef.current
    if (!element) return
    const observer = new ResizeObserver(() => setCardHeight(Math.ceil(element.offsetHeight)))
    observer.observe(element)
    setCardHeight(Math.ceil(element.offsetHeight))
    return () => observer.disconnect()
  }, [])

  // Any held button or slider keeps mouse input on the window until it's released.
  useEffect(() => {
    const release = () => api.setPointerActive(false)
    window.addEventListener('pointerup', release)
    window.addEventListener('pointercancel', release)
    return () => {
      window.removeEventListener('pointerup', release)
      window.removeEventListener('pointercancel', release)
    }
  }, [api])

  const endDrag = () => {
    if (!draggingRef.current) return
    draggingRef.current = false
    api.endDrag()
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    api.setPointerActive(true)
    if ((event.target as HTMLElement).closest('[data-no-drag]')) return
    pressRef.current = { x: event.screenX, y: event.screenY, id: event.pointerId }
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const press = pressRef.current
    if (!press || press.id !== event.pointerId || draggingRef.current) return
    if (Math.hypot(event.screenX - press.x, event.screenY - press.y) < DRAG_THRESHOLD_PX) return
    draggingRef.current = true
    clearTimer('expand')
    event.currentTarget.setPointerCapture(event.pointerId)
    api.startDrag()
  }

  const onPointerUp = () => {
    const press = pressRef.current
    pressRef.current = null
    if (draggingRef.current) {
      endDrag()
      return
    }
    // A plain click on the pill opens the card straight away.
    if (press && !expandedRef.current) open()
  }

  // Display values
  const empty = !session || (!session.title && !session.artist)
  const bridgeProblem = bridge.state === 'error' || bridge.state === 'unsupported'
  const pillTitle = empty ? 'Nothing playing' : session.title || session.appName
  const pillSubtitle = empty
    ? bridgeProblem
      ? "Can't read Windows media right now"
      : bridge.state === 'starting'
        ? 'Looking for players…'
        : 'Start music in any app'
    : session.artist || session.appName
  const ticking = expanded && view === 'player' && playback.playing
  const now = useTicker(ticking, 250)
  const repeatCycle: Record<RepeatMode, RepeatMode> = { none: 'list', list: 'track', track: 'none' }
  const visualizerOn = settings.visualizer

  const anchorStyle =
    direction === 'down'
      ? { top: PILL_TOP }
      : { bottom: GEOMETRY.windowHeight - PILL_TOP - GEOMETRY.pillHeight }
  const edgeStyle = direction === 'down' ? { top: 0 } : { bottom: 0 }

  return (
    <div className="relative h-screen w-screen">
      <div className="pointer-events-none absolute inset-x-0 flex justify-center" style={anchorStyle}>
        <motion.div
          ref={shellRef}
          className={cn(
            'pointer-events-auto relative overflow-hidden text-white',
            'shadow-[0_14px_34px_-14px_rgba(0,0,0,0.7),0_2px_8px_-2px_rgba(0,0,0,0.35)]'
          )}
          initial={false}
          animate={{
            width: expanded ? GEOMETRY.cardWidth : GEOMETRY.pillWidth,
            height: expanded ? cardHeight : GEOMETRY.pillHeight,
            borderRadius: expanded ? 28 : 20,
            opacity: idle ? settings.idleOpacity : 1
          }}
          transition={{
            default: SPRING,
            opacity: { duration: idle ? 0.9 : 0.25, ease: 'easeOut' }
          }}
          onMouseEnter={handleEnter}
          onMouseLeave={handleLeave}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onLostPointerCapture={endDrag}
          onContextMenu={(event) => {
            event.preventDefault()
            api.showMenu()
          }}
        >
          {/* Backdrop: the artwork's own colour, blurred, under a darkening wash. */}
          <div className="pointer-events-none absolute inset-0" style={{ background: palette.base }} aria-hidden />
          <div
            className="pointer-events-none absolute left-1/2 -translate-x-1/2"
            style={{ ...edgeStyle, width: GEOMETRY.cardWidth, height: GEOMETRY.cardMaxHeight }}
            aria-hidden
          >
            <AnimatePresence initial={false}>
              {coverSrc && (
                <motion.img
                  key={coverSrc}
                  src={coverSrc}
                  alt=""
                  draggable={false}
                  className="absolute inset-0 h-full w-full scale-[1.5] object-cover blur-[30px] saturate-[1.35]"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 0.62 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.7 }}
                />
              )}
            </AnimatePresence>
          </div>
          <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(0,0,0,0.12),rgba(0,0,0,0.4))]" aria-hidden />
          <motion.div
            className="pointer-events-none absolute inset-0 ring-1 ring-inset ring-white/[0.09]"
            initial={false}
            animate={{ borderRadius: expanded ? 28 : 20 }}
            transition={SPRING}
            aria-hidden
          />

          {/* Pill */}
          <motion.div
            className={cn('absolute inset-x-0', expanded && 'pointer-events-none')}
            style={edgeStyle}
            initial={false}
            animate={{ opacity: expanded ? 0 : 1, filter: expanded ? 'blur(4px)' : 'blur(0px)' }}
            transition={{ duration: expanded ? 0.12 : 0.22, delay: expanded ? 0 : 0.12 }}
            aria-hidden={expanded}
          >
            <NowPlayingPill
              title={pillTitle}
              subtitle={pillSubtitle}
              cover={coverSrc}
              palette={palette}
              muted={empty}
              visualizerActive={!expanded && visualizerOn}
            />
          </motion.div>

          {/* Card */}
          <motion.div
            ref={cardRef}
            className={cn('absolute left-1/2 -translate-x-1/2', !expanded && 'pointer-events-none')}
            style={{ ...edgeStyle, width: GEOMETRY.cardWidth }}
            initial={false}
            animate={{ opacity: expanded ? 1 : 0, filter: expanded ? 'blur(0px)' : 'blur(6px)' }}
            transition={{ duration: expanded ? 0.26 : 0.12, delay: expanded ? 0.08 : 0 }}
            aria-hidden={!expanded}
          >
            <AnimatePresence mode="popLayout" initial={false}>
              {view === 'player' ? (
                <motion.div
                  key="player"
                  initial={{ opacity: 0, x: -28 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -28 }}
                  transition={{ duration: 0.22, ease: 'easeOut' }}
                >
                  <NowPlayingCard
                    title={empty ? 'Nothing playing' : session.title || session.appName}
                    artist={
                      empty
                        ? bridgeProblem
                          ? "Windows media controls didn't respond"
                          : 'Play music in any app or browser tab'
                        : session.artist
                    }
                    appName={session?.appName ?? null}
                    sessionCount={session?.sessionCount ?? 0}
                    cover={coverSrc}
                    palette={palette}
                    playing={playback.playing}
                    positionMs={playback.getPosition(now)}
                    durationMs={session?.durationMs ?? 0}
                    canPlayPause={session?.canPlayPause ?? false}
                    canNext={session?.canNext ?? false}
                    canPrev={session?.canPrev ?? false}
                    canSeek={session?.canSeek ?? false}
                    canShuffle={session?.canShuffle ?? false}
                    canRepeat={session?.canRepeat ?? false}
                    shuffle={session?.shuffle ?? null}
                    repeat={session?.repeat ?? null}
                    visualizerActive={expanded && visualizerOn}
                    showVisualizer={!empty}
                    notice={bridgeProblem ? (bridge.message ?? null) : null}
                    credit={`${APP_NAME}, ${APP_CREDIT}`}
                    onToggle={playback.toggle}
                    onNext={playback.next}
                    onPrev={playback.prev}
                    onSeek={playback.seek}
                    onShuffle={() => playback.setShuffle(!(session?.shuffle ?? false))}
                    onRepeat={() => playback.setRepeat(repeatCycle[session?.repeat ?? 'none'])}
                    onCycleSession={playback.cycleSession}
                    onOpenEqualizer={() => showView('eq')}
                  />
                </motion.div>
              ) : (
                <motion.div
                  key="eq"
                  initial={{ opacity: 0, x: 28 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 28 }}
                  transition={{ duration: 0.22, ease: 'easeOut' }}
                >
                  <EqualizerView palette={palette} onBack={() => showView('player')} />
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        </motion.div>
      </div>
    </div>
  )
}
