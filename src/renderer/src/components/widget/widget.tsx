import { AnimatePresence, motion } from 'framer-motion'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { classifyPlayer } from '../../../../shared/apps'
import { APP_AUTHOR, APP_NAME, GEOMETRY, PILL_TOP, type MediaRefusal } from '../../../../shared/types'
import { NowPlayingCard } from '@/components/ui/now-playing-card'
import { NowPlayingPill } from '@/components/ui/now-playing-pill'
import { EqualizerView } from '@/components/widget/equalizer-view'
import { useBackdrop, useCoverPalette, useDisplayedCover } from '@/hooks/use-cover'
import { usePlayback } from '@/hooks/use-playback'
import { audioLevels } from '@/lib/audio-levels'
import { getState, useWidget } from '@/lib/store'
import { cn } from '@/lib/utils'

type View = 'player' | 'eq'
type TimerName = 'expand' | 'collapse' | 'idle' | 'resetView' | 'sticky'

const COLLAPSE_DELAY_MS = 600
/** Leaving the equalizer by accident while dragging a slider shouldn't close it. */
const COLLAPSE_DELAY_EQ_MS = 2500
const WAKE_ON_TRACK_CHANGE_MS = 3000
const DRAG_THRESHOLD_PX = 4
const SPRING = { type: 'spring', stiffness: 380, damping: 34, mass: 0.9 } as const
/** How long "Spotify didn't change shuffle" stays up. */
const REFUSAL_NOTICE_MS = 3500
/** Bars per second, in the pill and in the open card. */
const BARS_FPS = 30
/** Pointer moves over the widget are reported at most this often (see WidgetWindow). */
const POINTER_SEEN_MS = 250
/** The widget's position is re-checked this often, in case something moved it without a resize. */
const HIT_RECT_CHECK_MS = 2000

function refusalText(refusal: MediaRefusal, appName: string): string {
  const player = appName || 'The player'
  if (refusal.command === 'shuffle') return `${player} didn't change shuffle`
  if (refusal.command === 'repeat') return `${player} didn't change repeat`
  return `Couldn't change ${player}'s volume`
}

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
  const backdrop = useBackdrop(coverSrc, GEOMETRY.cardWidth, GEOMETRY.cardMaxHeight)
  const refusal = useWidget((state) => state.refusal)
  const [notice, setNotice] = useState<string | null>(null)
  const appNameRef = useRef('')
  appNameRef.current = session?.appName ?? ''
  useEffect(() => {
    if (!refusal || Date.now() - refusal.at > REFUSAL_NOTICE_MS) return
    setNotice(refusalText(refusal, appNameRef.current))
    const timer = window.setTimeout(() => setNotice(null), REFUSAL_NOTICE_MS)
    return () => window.clearTimeout(timer)
  }, [refusal])

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
  const pointerSeenAt = useRef(0)
  const pointerSeenTimer = useRef(0)
  useEffect(() => () => window.clearTimeout(pointerSeenTimer.current), [])
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
      // Typing a name: stay open (the countdown starts once it's done, see below).
      if (!getState().typing) startTimer('collapse', viewRef.current === 'eq' ? COLLAPSE_DELAY_EQ_MS : COLLAPSE_DELAY_MS, close)
    } else {
      scheduleIdle()
    }
  }, [api, clearTimer, startTimer, close, scheduleIdle])

  // Done typing with the pointer gone: close as if it had just left.
  const typing = useWidget((state) => state.typing)
  useEffect(() => {
    if (typing) {
      clearTimer('collapse')
      return
    }
    if (expandedRef.current && !hoveredRef.current) {
      startTimer('collapse', viewRef.current === 'eq' ? COLLAPSE_DELAY_EQ_MS : COLLAPSE_DELAY_MS, close)
    }
  }, [typing, clearTimer, startTimer, close])

  // Fade after the first few seconds; clean up every timer on unmount.
  useEffect(() => {
    scheduleIdle()
    const pending = timers.current
    return () => {
      for (const id of Object.values(pending)) window.clearTimeout(id)
    }
  }, [scheduleIdle])

  // Pointer enter/leave detected by the main process (backstop for click-through windows).
  useEffect(
    () =>
      api.onPointer((event) => {
        if (event === 'enter') {
          handleEnter()
          return
        }
        // The main process thinks the pointer left, but it's still right here: keep the mouse,
        // or the widget couldn't be clicked or dragged until the pointer went away and back.
        if (shellRef.current?.matches(':hover')) {
          api.setInteractive(true)
          return
        }
        handleLeave()
      }),
    [api, handleEnter, handleLeave]
  )

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
  useEffect(() => audioLevels.setMaxFps(BARS_FPS), [])
  useEffect(() => {
    if (!settings.visualizer) audioLevels.stopLive()
  }, [settings.visualizer])

  // Tell the main process where the widget is, so clicks elsewhere pass through.
  useLayoutEffect(() => {
    const element = shellRef.current
    if (!element) return
    let frame = 0
    let last = ''
    const report = (force: boolean) => {
      frame = 0
      const rect = element.getBoundingClientRect()
      const next = {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        viewWidth: window.innerWidth
      }
      const key = JSON.stringify(next)
      if (!force && key === last) return
      last = key
      api.setHitRect(next)
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(() => report(true))
    }
    const observer = new ResizeObserver(schedule)
    observer.observe(element)
    window.addEventListener('resize', schedule)
    // Size changes are seen straight away; this catches a move without one (a resized window).
    const check = window.setInterval(() => report(false), HIT_RECT_CHECK_MS)
    schedule()
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', schedule)
      window.clearInterval(check)
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

  const endDrag = useCallback(() => {
    pressRef.current = null
    if (!draggingRef.current) return
    draggingRef.current = false
    api.endDrag()
  }, [api])

  // Any held button or slider keeps mouse input on the window until it's released, and a
  // release anywhere ends a drag (even one whose pointer capture went missing).
  useEffect(() => {
    const release = () => {
      api.setPointerActive(false)
      if (draggingRef.current) endDrag()
    }
    window.addEventListener('pointerup', release)
    window.addEventListener('pointercancel', release)
    return () => {
      window.removeEventListener('pointerup', release)
      window.removeEventListener('pointercancel', release)
    }
  }, [api, endDrag])

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    api.setPointerActive(true)
    if ((event.target as HTMLElement).closest('[data-no-drag]')) return
    pressRef.current = { x: event.screenX, y: event.screenY, id: event.pointerId }
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    // Proof the pointer is on the widget: tell the main process now and then (always including
    // where it came to rest), and pick the hover back up if it was dropped by mistake.
    const wait = pointerSeenAt.current + POINTER_SEEN_MS - performance.now()
    window.clearTimeout(pointerSeenTimer.current)
    const report = () => {
      pointerSeenAt.current = performance.now()
      api.pointerSeen()
    }
    if (wait <= 0) report()
    else pointerSeenTimer.current = window.setTimeout(report, wait)
    if (!hoveredRef.current && !draggingRef.current) handleEnter()
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
  const visualizerOn = settings.visualizer
  const isBrowser = session ? classifyPlayer(session.appId).kind === 'browser' : false
  const volumeLabel = session?.appName ? `${session.appName} volume${isBrowser ? ' (the whole browser)' : ''}` : 'Volume'
  const musicEq = useWidget((state) => state.musicEq)
  const update = useWidget((state) => state.update)
  const updateNotice =
    update.state === 'ready'
      ? { label: `Restart to update to ${update.version}`, action: true }
      : update.state === 'available'
        ? { label: `Get version ${update.version}`, action: true }
        : update.state === 'downloading'
          ? { label: `Downloading version ${update.version}… ${update.percent}%`, action: false }
          : null
  const volumeHint =
    musicEq.supported && !musicEq.boostAvailable ? 'To go up to 200%, set up VB-CABLE in the equalizer (Music only).' : null

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
              {backdrop && (
                <motion.img
                  key={backdrop}
                  src={backdrop}
                  alt=""
                  draggable={false}
                  className="absolute inset-0 h-full w-full object-cover"
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
            // The blur is only for the crossfade; left on, it would make the GPU redraw the pill every frame.
            animate={{
              opacity: expanded ? 0 : 1,
              filter: expanded ? 'blur(4px)' : 'blur(0px)',
              transitionEnd: expanded ? undefined : { filter: 'none' }
            }}
            transition={{ duration: expanded ? 0.12 : 0.22, delay: expanded ? 0 : 0.12 }}
            aria-hidden={expanded}
          >
            <NowPlayingPill
              title={pillTitle}
              subtitle={pillSubtitle}
              cover={coverSrc}
              palette={palette}
              muted={empty}
              visualizerActive={!expanded && visualizerOn && playback.playing}
            />
          </motion.div>

          {/* Card */}
          <motion.div
            ref={cardRef}
            className={cn('absolute left-1/2 -translate-x-1/2', !expanded && 'pointer-events-none')}
            style={{ ...edgeStyle, width: GEOMETRY.cardWidth }}
            initial={false}
            animate={{
              opacity: expanded ? 1 : 0,
              filter: expanded ? 'blur(0px)' : 'blur(6px)',
              transitionEnd: expanded ? { filter: 'none' } : undefined
            }}
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
                    open={expanded && view === 'player'}
                    getPosition={playback.getPosition}
                    durationMs={session?.durationMs ?? 0}
                    canPlayPause={session?.canPlayPause ?? false}
                    canNext={session?.canNext ?? false}
                    canPrev={session?.canPrev ?? false}
                    canSeek={session?.canSeek ?? false}
                    canShuffle={session?.canShuffle ?? false}
                    canRepeat={session?.canRepeat ?? false}
                    shuffle={playback.shuffle}
                    repeat={playback.repeat}
                    volume={empty ? null : playback.volume}
                    volumeMax={playback.maxVolume}
                    muted={playback.muted}
                    volumeLabel={volumeLabel}
                    volumeHint={volumeHint}
                    visualizerActive={expanded && visualizerOn && playback.playing}
                    showVisualizer={!empty}
                    notice={bridgeProblem ? (bridge.message ?? null) : notice}
                    credit={
                      <>
                        {APP_NAME}, made by{' '}
                        <button
                          type="button"
                          data-no-drag
                          onClick={() => api.openAuthorPage()}
                          title={`${APP_AUTHOR} on Discord`}
                          className="rounded-sm font-extrabold text-white/60 underline decoration-white/25 underline-offset-2 transition-colors hover:text-white hover:decoration-white/70"
                        >
                          {APP_AUTHOR}
                        </button>
                      </>
                    }
                    update={updateNotice}
                    onUpdate={() => api.update.install()}
                    onToggle={playback.toggle}
                    onNext={playback.next}
                    onPrev={playback.prev}
                    onSeek={playback.seek}
                    onShuffle={playback.toggleShuffle}
                    onRepeat={playback.cycleRepeat}
                    onVolume={playback.setVolume}
                    onToggleMute={playback.toggleMute}
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
