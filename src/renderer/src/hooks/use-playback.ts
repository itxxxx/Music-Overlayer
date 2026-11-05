import { useCallback, useEffect, useState } from 'react'
import type { MediaCommand, MediaSession, PlaybackStatus, RepeatMode } from '../../../shared/types'
import { useWidget } from '@/lib/store'

const STATUS_HOLD_MS = 2000
const SEEK_HOLD_MS = 2500

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
    setShuffle: (value: boolean) => send({ type: 'shuffle', value }),
    setRepeat: (value: RepeatMode) => send({ type: 'repeat', value }),
    cycleSession: () => send({ type: 'cycle-session' })
  }
}
