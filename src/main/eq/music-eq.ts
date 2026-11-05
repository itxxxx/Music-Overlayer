import os from 'node:os'
import { appDisplayName } from '../../shared/apps'
import type { EqSettings, MusicEqStatus } from '../../shared/types'
import type { MediaHub } from '../media/media-hub'
import type { CableInfo, RouteResult } from '../media/media-source'
import { installCable } from './virtual-cable'

/** Keep the music on the cable through short pauses, so resuming doesn't switch devices. */
const PAUSE_GRACE_MS = 20_000
/** After a failed route, wait this long before trying again. */
const RETRY_MS = 4000
/** Let the last sound drain through the window before its audio path stops. */
const STOP_DELAY_MS = 700
/** A route or unroute the bridge never answered (it restarted) stops blocking after this. */
const ANSWER_TIMEOUT_MS = 5000

/** Written in Equalizer APO's file while the music-only mode is on. */
export const MUSIC_ONLY_NOTE =
  'Music Overlayer is in "Music only" mode: it equalizes just the music app, so this file stays flat.'

interface MusicEqOptions {
  isWindows: boolean
  media: MediaHub
  getEq(): EqSettings
  /** Apps this or an earlier run routed and hasn't undone yet (kept across crashes). */
  getRoutedApps(): string[]
  setRoutedApps(apps: string[]): void
  getCableInstalledAt(): number | null
  setCableInstalledAt(time: number | null): void
  onStatus(status: MusicEqStatus): void
  /** Ask the window to start or stop its audio path (capture CABLE Output, equalize, play). */
  setPipeline(run: boolean): void
  /** Keep Equalizer APO flat (a reason) or let it equalize the device (null). */
  setDeviceBypass(reason: string | null): void
}

/**
 * The music-only equalizer. While the shown player plays, its sound is sent to VB-CABLE; the
 * window captures the cable, equalizes it and plays it on the normal output. Discord, games and
 * everything else keep going straight to the speakers, untouched.
 *
 * Order matters: the window's audio path starts first, then the player is routed, so the music
 * never goes silent. Stopping goes the other way round.
 */
export class MusicEqController {
  private status: MusicEqStatus
  private cable: CableInfo = { id: null, routing: false }
  private pipelineWanted = false
  private pipelineRunning = false
  private pipelineError: string | null = null
  /** The app this run routed and the bridge confirmed. */
  private routedApp: string | null = null
  private pending: { kind: 'route' | 'unroute'; at: number } | null = null
  private routeError: string | null = null
  private retryAt = 0
  private pipelineRetryAt = 0
  private lastPlayingAt = 0
  private installing = false
  private installError: string | null = null
  private stopTimer: NodeJS.Timeout | null = null
  private tickTimer: NodeJS.Timeout | null = null
  private bypass: string | null | undefined = undefined

  constructor(private readonly options: MusicEqOptions) {
    this.status = this.computeStatus()
    const { media } = options
    media.on('cable', (cable) => {
      this.cable = cable
      this.update()
    })
    media.on('routed', (result) => this.onRouted(result))
    media.on('unrouted', (result) => this.onUnrouted(result))
    media.on('session', () => this.update())
    media.on('status', (status) => {
      // A new bridge doesn't know what the last one routed; Windows still does.
      if (status.state === 'ready') {
        this.routedApp = null
        this.pending = null
        this.undoLeftovers()
      }
      this.update()
    })
    media.on('apps', (ids) => this.undoLeftovers(ids))
  }

  get current(): MusicEqStatus {
    return this.status
  }

  /** Whether the window's audio path should be running (for a window that just loaded). */
  get pipelineRequested(): boolean {
    return this.pipelineWanted
  }

  /** Re-evaluates everything. Cheap; called on every change. */
  update(): void {
    const { isWindows, media } = this.options
    const eq = this.options.getEq()
    const musicMode = isWindows && eq.target === 'music'
    this.setBypass(musicMode ? MUSIC_ONLY_NOTE : null)

    const session = media.session
    const now = Date.now()
    if (session?.status === 'playing') this.lastPlayingAt = now
    if (this.pending && now - this.pending.at > ANSWER_TIMEOUT_MS) this.pending = null

    const cableId = this.cable.id
    const app = session?.appId || null
    const wanted =
      musicMode &&
      eq.enabled &&
      Boolean(cableId) &&
      this.cable.routing &&
      app !== null &&
      (session?.status === 'playing' || now - this.lastPlayingAt < PAUSE_GRACE_MS)

    if (wanted && cableId && app) {
      this.cancelStop()
      if (!this.pipelineWanted && now >= this.pipelineRetryAt) {
        this.pipelineWanted = true
        this.options.setPipeline(true)
      }
      if (this.pipelineRunning && !this.pending && this.routedApp !== app && now >= this.retryAt) {
        this.pending = { kind: 'route', at: now }
        media.route(cableId)
      }
    } else {
      if (this.routedApp && !this.pending) {
        this.pending = { kind: 'unroute', at: now }
        media.unroute('*')
      }
      if (!this.routedApp && this.pipelineWanted) this.scheduleStop()
    }
    this.ensureTick(wanted || this.routedApp !== null || this.pipelineWanted)
    this.publish()
  }

  /** The window reports whether its audio path runs. */
  setPipelineState(running: boolean, error: string | null): void {
    this.pipelineRunning = running
    if (running) this.pipelineError = null
    else {
      if (error) {
        this.pipelineError = error
        // Ask again later rather than in a loop.
        this.pipelineWanted = false
        this.pipelineRetryAt = Date.now() + RETRY_MS
      }
      // Nothing carries the cable to the speakers any more: send the music straight there.
      if (this.routedApp) {
        this.pending = { kind: 'unroute', at: Date.now() }
        this.options.media.unroute('*')
      }
    }
    this.update()
  }

  /** The window went away (crash or reload): its audio path is gone. */
  windowGone(): void {
    this.pipelineWanted = false
    this.setPipelineState(false, null)
  }

  /** Checks for VB-CABLE again (after the user installed it by hand, say). */
  recheck(): void {
    this.options.media.checkCable()
  }

  async install(): Promise<MusicEqStatus> {
    if (!this.options.isWindows || this.installing) return this.status
    this.installing = true
    this.installError = null
    this.publish()
    try {
      await installCable()
      this.options.setCableInstalledAt(Date.now())
      this.options.media.checkCable()
      // The bridge answers with a "cable" message; give it a moment before reporting back.
      await new Promise((resolve) => setTimeout(resolve, 1200))
    } catch (error) {
      this.installError = error instanceof Error ? error.message : String(error)
    } finally {
      this.installing = false
      this.update()
    }
    return this.status
  }

  dispose(): void {
    this.cancelStop()
    this.ensureTick(false)
  }

  // --- answers from the bridge --------------------------------------------------------------

  private onRouted(result: RouteResult): void {
    this.pending = null
    if (result.n > 0 && result.app) {
      // The bridge undid the app routed before (if any) itself. Leftovers from earlier runs stay
      // listed until they're undone.
      const previous = this.routedApp
      const listed = this.options.getRoutedApps().filter((app) => app !== previous && app !== result.app)
      this.routedApp = result.app
      this.routeError = null
      this.options.setRoutedApps([...listed, result.app])
    } else {
      this.routeError = result.why ? `Couldn't send the music through VB-CABLE: ${result.why}` : "Couldn't send the music through VB-CABLE."
      this.retryAt = Date.now() + RETRY_MS
    }
    this.update()
  }

  private onUnrouted(result: RouteResult): void {
    if (this.pending?.kind === 'unroute') this.pending = null
    const listed = this.options.getRoutedApps()
    if (result.app === '*') {
      // Everything this bridge routed: that's this run's app.
      const undone = this.routedApp
      this.routedApp = null
      this.options.setRoutedApps(listed.filter((app) => app !== undone))
    } else {
      if (result.app === this.routedApp) this.routedApp = null
      if (result.n > 0 || result.exited) this.options.setRoutedApps(listed.filter((app) => app !== result.app))
    }
    this.update()
  }

  /**
   * Apps an earlier run routed and couldn't undo (it crashed, or the app was closed while
   * routed): undo them as soon as they're running. `seen` limits it to apps that just showed up.
   */
  private undoLeftovers(seen?: string[]): void {
    for (const app of this.options.getRoutedApps()) {
      if (app === this.routedApp) continue
      if (seen && !seen.includes(app)) continue
      this.options.media.unroute(app)
    }
  }

  // --- helpers --------------------------------------------------------------------------------

  private setBypass(reason: string | null): void {
    if (reason === this.bypass) return
    this.bypass = reason
    this.options.setDeviceBypass(reason)
  }

  private scheduleStop(): void {
    if (this.stopTimer) return
    this.stopTimer = setTimeout(() => {
      this.stopTimer = null
      if (this.routedApp || !this.pipelineWanted) return
      this.pipelineWanted = false
      this.pipelineRunning = false
      this.options.setPipeline(false)
      this.publish()
    }, STOP_DELAY_MS)
  }

  private cancelStop(): void {
    if (this.stopTimer) clearTimeout(this.stopTimer)
    this.stopTimer = null
  }

  /** A slow tick only while routing is involved, for the pause grace and retries. */
  private ensureTick(on: boolean): void {
    if (on && !this.tickTimer) this.tickTimer = setInterval(() => this.update(), 1000)
    else if (!on && this.tickTimer) {
      clearInterval(this.tickTimer)
      this.tickTimer = null
    }
  }

  private computeStatus(): MusicEqStatus {
    const installedAt = this.options.getCableInstalledAt()
    const bootedAt = Date.now() - os.uptime() * 1000
    const cable = Boolean(this.cable.id)
    let error = this.installError ?? this.pipelineError ?? this.routeError
    if (!error && cable && !this.cable.routing) {
      error = this.cable.why ? `Windows won't let apps move another app's sound: ${this.cable.why}` : "Windows won't let apps move another app's sound."
    }
    return {
      supported: this.options.isWindows,
      cable,
      routing: this.cable.routing,
      installing: this.installing,
      restartPending: !cable && installedAt !== null && bootedAt < installedAt,
      active: this.routedApp && this.pipelineRunning ? appDisplayName(this.routedApp) : null,
      error
    }
  }

  private publish(): void {
    const next = this.computeStatus()
    if (JSON.stringify(next) === JSON.stringify(this.status)) return
    this.status = next
    this.options.onStatus(next)
  }
}
