import type {
  BridgeStatus,
  EqSettings,
  EqStatus,
  ExpandDirection,
  HitRect,
  InitialState,
  MediaCommand,
  MediaCover,
  MediaRefusal,
  MediaSession,
  MusicEqStatus,
  WidgetCommand,
  WidgetSettings
} from './types'

type Unsubscribe = () => void

/** Everything the UI can ask of the Electron main process. Exposed as `window.musicWidget`. */
export interface WidgetApi {
  platform: string
  getInitialState(): Promise<InitialState>

  onMediaSession(listener: (session: MediaSession | null) => void): Unsubscribe
  onMediaCover(listener: (cover: MediaCover) => void): Unsubscribe
  onBridgeStatus(listener: (status: BridgeStatus) => void): Unsubscribe
  /** The player turned a command down (shuffle, repeat, volume...). */
  onMediaRefused(listener: (refusal: MediaRefusal) => void): Unsubscribe
  sendMediaCommand(command: MediaCommand): void

  /** Let the window take mouse input (true) or pass clicks through to apps below (false). */
  setInteractive(interactive: boolean): void
  setHitRect(rect: HitRect | null): void
  /** A button or slider is being held, so the window must keep mouse input. */
  setPointerActive(active: boolean): void
  startDrag(): void
  endDrag(): void
  showMenu(): void
  onDirection(listener: (direction: ExpandDirection) => void): Unsubscribe
  /** Pointer entered or left the widget, detected by the main process. */
  onPointer(listener: (event: 'enter' | 'leave') => void): Unsubscribe
  onCommand(listener: (command: WidgetCommand) => void): Unsubscribe
  onSettings(listener: (settings: WidgetSettings) => void): Unsubscribe
  /** The widget was hidden or shown from the tray. */
  onVisibility(listener: (visible: boolean) => void): Unsubscribe
  /** Ask the main process to (re)start system-audio capture for the visualizer. */
  requestAudioCapture(): void

  eq: {
    apply(settings: EqSettings): Promise<EqStatus>
    /** Download and run the equalizer engine's installer. Resolves when setup closes. */
    install(): Promise<EqStatus>
    connect(): Promise<EqStatus>
    refreshStatus(): Promise<EqStatus>
    openDownloadPage(): void
    onStatus(listener: (status: EqStatus) => void): Unsubscribe
  }

  /** The music-only equalizer (VB-CABLE). */
  musicEq: {
    /** Download and run VB-CABLE's setup. Resolves when it closes. */
    install(): Promise<MusicEqStatus>
    /** Look for VB-CABLE again. */
    recheck(): void
    openDownloadPage(): void
    onStatus(listener: (status: MusicEqStatus) => void): Unsubscribe
    /** The main process asks the window to start (true) or stop its audio path. */
    onPipeline(listener: (run: boolean) => void): Unsubscribe
    reportPipeline(state: { running: boolean; error?: string }): void
  }
}
