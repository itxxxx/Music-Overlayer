import { useCallback, useEffect, useRef, useState } from 'react'
import type { MediaCommand, MediaSession, PlaybackStatus, RepeatMode } from '../../../shared/types'
import { MAX_BOOST } from '@/lib/music-eq'
import { useWidget } from '@/lib/store'

const STATUS_HOLD_MS = 2000
const SEEK_HOLD_MS = 2500
/** How long a clicked shuffle/repeat/volume shows before the player has to confirm it. */
const SETTING_HOLD_MS = 2500
/** While dragging the volume, send at most this often. */
const VOLUME_SEND_MS = 40
/**
 * Close to 100% snaps to exactly 100%, so leaving the boost is easy. Less than a wheel step
 * (5%), so scrolling to 95% or 105% stays there.
 */
const SNAP_TO_FULL = 0.045

interface Held<T> {
  value: T
  until: number
}

/**
 * Shows `requested` until the player reports it, or until the hold runs out (the player
 * ignored it, so its own value shows again).
 */
function useHeld<T>(reported: T, same: (a: T, b: T) => boolean = Object.is): [T, (value: T) => void] {
  const [held, setHeld] = useState<Held<T> | null>(null)
  useEffect(() => {
    if (!held) return
    if (same(reported, held.value)) {
      setHeld(null)
      return
    }
    const timer = window.setTimeout(() => setHeld(null), Math.max(0, held.until - Date.now()))
    return () => window.clearTimeout(timer)
  }, [reported, held, same])
  const hold = useCallback((value: T) => setHeld({ value, until: Date.now() + SETTING_HOLD_MS }), [])
  return [held ? held.value : reported, hold]
}

const sameVolume = (a: number | null, b: number | null): boolean => a !== null && b !== null && Math.abs(a - b) < 0.006

/** Where the track is at `now`, extrapolated from the last position the player reported. */
export function positionAt(session: MediaSession | null, now: number): number {
  if (!session) return 0
  let position = session.positionMs
  if (session.status === 'playing') position += Math.max(0, now - session.updatedAt) * session.rate
  return session.durationMs > 0 ? Math.min(Math.max(0, position), session.durationMs) : Math.max(0, position)
}

/** Re-renders every `intervalMs` while `active`. */
export function useTicker(active: boolean, intervalMs = 250): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const id = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(id)
  }, [active, intervalMs])
  return active ? now : Date.now()
}

/**
 * Current session plus optimistic updates: play/pause and seeks show immediately and are
 * reconciled when the player reports back.
 */
export function usePlayback() {
  const session = useWidget((state) => state.session)
  const receivedAt = useWidget((state) => state.sessionReceivedAt)
  const boostAvailable = useWidget((state) => state.musicEq.boostAvailable)
  const [heldStatus, setHeldStatus] = useState<{ status: PlaybackStatus; until: number } | null>(null)
  const [heldSeek, setHeldSeek] = useState<{ positionMs: number; at: number } | null>(null)

  useEffect(() => {
    if (!heldStatus) return
    if (!session || session.status === heldStatus.status) {
      setHeldStatus(null)
      return
    }
    const timer = window.setTimeout(() => setHeldStatus(null), Math.max(0, heldStatus.until - Date.now()))
    return () => window.clearTimeout(timer)
  }, [session, heldStatus])

  useEffect(() => {
    if (!heldSeek) return
    if (!session) {
      setHeldSeek(null)
      return
    }
    // The player confirmed the new position.
    if (receivedAt > heldSeek.at + 200) {
      const now = Date.now()
      const expected = heldSeek.positionMs + (session.status === 'playing' ? now - heldSeek.at : 0)
      if (Math.abs(positionAt(session, now) - expected) < 2500) {
        setHeldSeek(null)
        return
      }
    }
    const timer = window.setTimeout(() => setHeldSeek(null), Math.max(0, heldSeek.at + SEEK_HOLD_MS - Date.now()))
    return () => window.clearTimeout(timer)
  }, [session, receivedAt, heldSeek])

  const status: PlaybackStatus = heldStatus?.status ?? session?.status ?? 'stopped'
  const playing = status === 'playing'
  const [shuffle, holdShuffle] = useHeld<boolean | null>(session?.shuffle ?? null)
  const [repeat, holdRepeat] = useHeld<RepeatMode | null>(session?.repeat ?? null)
  // What the slider shows: the player's own level times the overlay's boost (up to 200%).
  const reportedVolume = typeof session?.volume === 'number' ? session.volume * (session.boost ?? 1) : null
  const [volume, holdVolume] = useHeld<number | null>(reportedVolume, sameVolume)
  const [muted, holdMuted] = useHeld<boolean | null>(session?.muted ?? null)
  const maxVolume = boostAvailable ? MAX_BOOST : 1
  const lastVolumeSend = useRef(0)
  const lastSent = useRef<{ app: string; level: number; boost: number } | null>(null)
  const volumeTimer = useRef(0)
  useEffect(() => () => window.clearTimeout(volumeTimer.current), [])

  const getPosition = useCallback(
    (now: number): number => {
      if (!session) return 0
      if (heldSeek) {
        const position = heldSeek.positionMs + (playing ? now - heldSeek.at : 0)
        return session.durationMs > 0 ? Math.min(position, session.durationMs) : position
      }
      if (heldStatus && session.status !== heldStatus.status) {
        // Freeze or resume from where the player last was.
        const base = positionAt(session, now)
        return heldStatus.status === 'paused' ? positionAt(session, heldStatus.until - STATUS_HOLD_MS) : base
      }
      return positionAt(session, now)
    },
    [session, heldSeek, heldStatus, playing]
  )

  const send = useCallback((command: MediaCommand) => window.musicWidget.sendMediaCommand(command), [])

  const toggle = useCallback(() => {
    send({ type: 'toggle' })
    setHeldStatus({ status: playing ? 'paused' : 'playing', until: Date.now() + STATUS_HOLD_MS })
  }, [send, playing])

  const seek = useCallback(
    (positionMs: number) => {
      send({ type: 'seek', positionMs })
      setHeldSeek({ positionMs, at: Date.now() })
    },
    [send]
  )

  return {
    session,
    status,
    playing,
    getPosition,
    toggle,
    seek,
    next: () => send({ type: 'next' }),
    prev: () => send({ type: 'prev' }),
    shuffle,
    repeat,
    toggleShuffle: () => {
      const value = !(shuffle ?? false)
      holdShuffle(value)
      send({ type: 'shuffle', value })
    },
    /** Off, repeat all, repeat one, off: the same order as most players. */
    cycleRepeat: () => {
      const value: RepeatMode = repeat === 'list' ? 'track' : repeat === 'track' ? 'none' : 'list'
      holdRepeat(value)
      send({ type: 'repeat', value })
    },
    volume,
    muted,
    /** 1, or 2 (200%) when the overlay can boost the player. */
    maxVolume,
    /**
     * 0 to `maxVolume`. Up to 100% it's the player's own level in the Windows mixer; above, the
     * player stays at 100% and the overlay boosts it. While dragging pass `final: false`; the
     * last value is always sent.
     */
    setVolume: (value: number, final: boolean) => {
      let target = Math.min(maxVolume, Math.max(0, value))
      if (maxVolume > 1 && Math.abs(target - 1) < SNAP_TO_FULL) target = 1
      holdVolume(target)
      if (muted && target > 0) {
        holdMuted(false)
        send({ type: 'mute', value: false })
      }
      const app = session?.appId ?? ''
      const level = Math.min(1, target)
      const boost = Math.max(1, Math.round(target * 100) / 100)
      window.clearTimeout(volumeTimer.current)
      const wait = lastVolumeSend.current + VOLUME_SEND_MS - Date.now()
      const fire = () => {
        lastVolumeSend.current = Date.now()
        const previous = lastSent.current?.app === app ? lastSent.current : null
        if (final || !previous || Math.abs(previous.level - level) > 0.0005) send({ type: 'volume', value: level })
        const currentBoost = previous?.boost ?? session?.boost ?? 1
        if (app && (boost !== currentBoost || (final && boost !== (session?.boost ?? 1)))) {
          window.musicWidget.setBoost(app, boost)
        }
        lastSent.current = { app, level, boost }
      }
      if (final || wait <= 0) fire()
      else volumeTimer.current = window.setTimeout(fire, wait)
    },
    toggleMute: () => {
      const value = !(muted ?? false)
      holdMuted(value)
      send({ type: 'mute', value })
    },
    cycleSession: () => send({ type: 'cycle-session' })
  }
}
