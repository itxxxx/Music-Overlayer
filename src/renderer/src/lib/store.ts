import { useSyncExternalStore } from 'react'
import type {
  BridgeStatus,
  EqSettings,
  EqStatus,
  ExpandDirection,
  InitialState,
  MediaCover,
  MediaSession,
  WidgetSettings
} from '../../../shared/types'

export interface WidgetState {
  platform: string
  session: MediaSession | null
  /** When the current session object arrived. */
  sessionReceivedAt: number
  cover: MediaCover | null
  bridge: BridgeStatus
  settings: WidgetSettings
  direction: ExpandDirection
  eq: EqSettings
  eqStatus: EqStatus
}

type Listener = () => void

let state: WidgetState | null = null
const listeners = new Set<Listener>()

export function initStore(initial: InitialState): void {
  state = {
    platform: initial.platform,
    session: initial.media.session,
    sessionReceivedAt: Date.now(),
    cover: initial.media.cover,
    bridge: initial.media.status,
    settings: initial.settings,
    direction: initial.direction,
    eq: initial.eq,
    eqStatus: initial.eqStatus
  }
}

export function getState(): WidgetState {
  if (!state) throw new Error('Widget store used before initStore()')
  return state
}

export function setState(patch: Partial<WidgetState> | ((current: WidgetState) => Partial<WidgetState>)): void {
  const current = getState()
  const next = typeof patch === 'function' ? patch(current) : patch
  state = { ...current, ...next }
  listeners.forEach((listener) => listener())
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Select a slice of widget state. Selectors should return existing references or primitives. */
export function useWidget<T>(selector: (state: WidgetState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(getState()))
}

/** Wire the store to the main process. Returns a cleanup function. */
export function connectStore(): () => void {
  const api = window.musicWidget
  const offs = [
    api.onMediaSession((session) => setState({ session, sessionReceivedAt: Date.now() })),
    api.onMediaCover((cover) => setState({ cover })),
    api.onBridgeStatus((bridge) => setState({ bridge })),
    api.onDirection((direction) => setState({ direction })),
    api.onSettings((settings) => setState({ settings })),
    api.eq.onStatus((eqStatus) => setState({ eqStatus }))
  ]
  return () => offs.forEach((off) => off())
}
