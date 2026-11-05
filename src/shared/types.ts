// Types and constants shared by the Electron main process, the preload script and the UI.

export type PlaybackStatus = 'closed' | 'opened' | 'changing' | 'stopped' | 'playing' | 'paused'
export type RepeatMode = 'none' | 'track' | 'list'

/** One media session as reported by Windows (Spotify, a browser tab, Deezer, ...). */
export interface MediaSession {
  /** Windows app id of the player, e.g. "Spotify.exe" or "chrome". */
  appId: string
  /** Friendly player name, e.g. "Spotify". */
  appName: string
  title: string
  artist: string
  album: string
  status: PlaybackStatus
  /** Position at the moment `updatedAt` was sampled. */
  positionMs: number
  /** 0 when the player doesn't publish a timeline. */
  durationMs: number
  /** Unix time (ms) that `positionMs` refers to. */
  updatedAt: number
  rate: number
  canPlayPause: boolean
  canNext: boolean
  canPrev: boolean
  canSeek: boolean
  canShuffle: boolean
  canRepeat: boolean
  shuffle: boolean | null
  repeat: RepeatMode | null
  /** Changes whenever the track changes; covers are matched against it. */
  trackKey: string
  /** How many players currently have a media session. */
  sessionCount: number
  /**
   * The player's level in the Windows volume mixer (0–1), or null when it can't be found.
   * For a browser tab this is the whole browser: Windows has no volume per tab.
   */
  volume: number | null
  muted: boolean | null
}

export interface MediaCover {
  trackKey: string
  /** data: URL of the artwork, or null when the player has none. */
  dataUrl: string | null
  /** Where the artwork came from: the player itself, or an online lookup by title and artist. */
  source?: 'player' | 'online'
}

export type BridgeState = 'starting' | 'ready' | 'error' | 'unsupported' | 'demo'

export interface BridgeStatus {
  state: BridgeState
  message?: string
}

export type MediaCommand =
  | { type: 'toggle' | 'play' | 'pause' | 'next' | 'prev' | 'cycle-session' }
  | { type: 'seek'; positionMs: number }
  | { type: 'shuffle'; value: boolean }
  | { type: 'repeat'; value: RepeatMode }
  /** The player's volume-mixer level, 0–1. */
  | { type: 'volume'; value: number }
  | { type: 'mute'; value: boolean }

/** A command the player turned down, e.g. shuffle in a player that ignores it. */
export interface MediaRefusal {
  command: MediaCommand['type']
  at: number
}

/** Which way the card opens from the pill. Chosen so the card always fits on screen. */
export type ExpandDirection = 'down' | 'up'

/** Pill centre in screen coordinates (DIP). */
export interface PillPosition {
  cx: number
  cy: number
}

/** Interactive area of the widget, relative to the window. */
export interface HitRect {
  x: number
  y: number
  width: number
  height: number
}

export interface WidgetSettings {
  /** Opacity of the pill once it has faded (0–1). */
  idleOpacity: number
  /** How long the pill waits before fading. */
  idleDelayMs: number
  /** How long the pointer must rest on the pill before the card opens. */
  hoverDelayMs: number
  visualizer: boolean
  /** Show generated tracks instead of real media sessions. */
  demo: boolean
  /** Look up artwork by title and artist when a player shares none. */
  onlineCovers: boolean
}

export interface EqUserPreset {
  id: string
  name: string
  gains: number[]
}

/**
 * What the equalizer changes. "music": only the player the overlay shows (its sound goes
 * through VB-CABLE and the overlay equalizes it). "device": everything on the output device,
 * through Equalizer APO.
 */
export type EqTarget = 'music' | 'device'

export interface EqSettings {
  enabled: boolean
  target: EqTarget
  /** One gain (dB) per band in EQ_BANDS. */
  gains: number[]
  /** Manual preamp (dB). Automatic headroom is added on top so boosts never clip. */
  preamp: number
  /** Built-in preset id, a user preset id, or "custom". */
  presetId: string
  userPresets: EqUserPreset[]
}

export interface EqStatus {
  /** False on platforms where Equalizer APO can't exist. */
  supported: boolean
  /** The audio engine (Equalizer APO) is installed. */
  installed: boolean
  /** Equalizer APO's config.txt includes the widget's settings file. */
  connected: boolean
  /** The widget is downloading/running the engine's installer. */
  installing: boolean
  /** The engine was just installed; Windows must restart before it's heard. */
  restartPending: boolean
  configDir: string | null
  canOpenEditor: boolean
  error: string | null
}

/** The music-only equalizer: VB-CABLE, routing and the overlay's own audio path. */
export interface MusicEqStatus {
  /** Windows only. */
  supported: boolean
  /** VB-CABLE's playback side ("CABLE Input") is there. */
  cable: boolean
  /** Windows lets the overlay choose another app's output device. */
  routing: boolean
  /** The overlay is downloading or running VB-CABLE's setup. */
  installing: boolean
  /** VB-CABLE was installed but doesn't show up yet: Windows must restart. */
  restartPending: boolean
  /** The player being equalized right now (its name), or null. */
  active: string | null
  error: string | null
}

export type WidgetCommand = 'open-eq' | 'expand'

export interface InitialState {
  platform: string
  settings: WidgetSettings
  eq: EqSettings
  eqStatus: EqStatus
  musicEq: MusicEqStatus
  /** Only for tests: the recording device that stands in for VB-CABLE's "CABLE Output". */
  testCableInput?: string
  direction: ExpandDirection
  media: {
    session: MediaSession | null
    cover: MediaCover | null
    status: BridgeStatus
  }
}

/** Window geometry. The pill sits in the vertical middle so the card can open up or down. */
export const GEOMETRY = {
  windowWidth: 360,
  windowHeight: 900,
  pillWidth: 288,
  pillHeight: 56,
  cardWidth: 320,
  cardMaxHeight: 470
} as const

export const APP_NAME = 'Music Overlayer'
export const APP_CREDIT = 'made by ITX'

/** Distance from the window top to the pill top. */
export const PILL_TOP = (GEOMETRY.windowHeight - GEOMETRY.pillHeight) / 2

export const DEFAULT_WIDGET_SETTINGS: WidgetSettings = {
  idleOpacity: 0.75,
  idleDelayMs: 4000,
  hoverDelayMs: 300,
  visualizer: true,
  demo: false,
  onlineCovers: false
}
