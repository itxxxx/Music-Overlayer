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
  PipelineRequest,
  UpdateStatus,
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
  /** Turn a player up past 100% (1–2), on top of its own volume. */
  setBoost(appId: string, boost: number): void

  /** Let the window take mouse input (true) or pass clicks through to apps below (false). */
  setInteractive(interactive: boolean): void
  /** The pointer moved over the widget (sent a few times a second at most). */
  pointerSeen(): void
  /**
   * Sent every few seconds, so the main process notices a page that hangs or stops drawing.
   * `longestTaskMs` is the longest the page was busy without a break since the last check-in.
   */
  alive(painted: boolean, longestTaskMs: number): void
  /** What the page is doing right now, for the log (see lib/diagnostics). */
  reportStep(step: string): void
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
  /** System-audio capture gave no sound (for the log). */
  reportNoSystemAudio(): void

  eq: {
    apply(settings: EqSettings): Promise<EqStatus>
    /** Download and run the equalizer engine's installer. Resolves when setup closes. */
    install(): Promise<EqStatus>
    connect(): Promise<EqStatus>
    refreshStatus(): Promise<EqStatus>
    openDownloadPage(): void
    onStatus(listener: (status: EqStatus) => void): Unsubscribe
  }

  /** The app's own updates. */
  update: {
    onStatus(listener: (status: UpdateStatus) => void): Unsubscribe
    /** Restart into the downloaded version, or (portable app) open the download page. */
    install(): void
  }

  /** The music-only equalizer (VB-CABLE). */
  musicEq: {
    /** Download and run VB-CABLE's setup. Resolves when it closes. */
    install(): Promise<MusicEqStatus>
    /** Look for VB-CABLE again. */
    recheck(): void
    openDownloadPage(): void
    onStatus(listener: (status: MusicEqStatus) => void): Unsubscribe
    /** The main process asks the window to start, change or stop its audio path. */
    onPipeline(listener: (request: PipelineRequest) => void): Unsubscribe
    reportPipeline(state: { running: boolean; error?: string }): void
  }
}
