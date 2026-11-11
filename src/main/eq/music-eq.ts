import os from 'node:os'
import { appDisplayName } from '../../shared/apps'
import type { EqSettings, MusicEqStatus, PipelineRequest } from '../../shared/types'
import { log } from '../log'
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

/**
 * The volume a player on the cable is turned down to, so screen sharing doesn't send the music
 * twice (see `whisper`). 1% (-40 dB) when the cable carries 24-bit sound; 5% (-26 dB) on a
 * 16-bit cable, where 1% would leave too few bits and the overlay would bring up a hiss.
 */
export const QUIET_LEVEL = 0.01
export const QUIET_LEVEL_16_BIT = 0.05
/** Windows has really turned the player down once it reports at most this many times the level. */
const CONFIRMED_RATIO = 1.3
/**
 * The window clips what comes off the cable at this many times the level while it turns it
 * back up: if something turns the player up in the Windows mixer meanwhile, it can't blast out
 * 100 times too loud before the overlay notices. Songs never reach it (Windows' level is exact).
 */
const CEILING_RATIO = 1.5
/**
 * After turning a player down, wait this long before turning it back up: what's already on its
 * way through the cable still has the old volume.
 */
const SETTLE_MS = 250
/** After the window found the cable louder than the whisper, wait longer before trying again. */
const SETTLE_AFTER_LOUD_MS = 1000
/**
 * A player just sent to the cable gets a new audio session there a moment later, with the
 * volume Windows remembers for it on that device. Turn it down once that has happened.
 */
const ROUTE_SETTLE_MS = 800
/** A player still not turned down after this long: send the volume again. */
const RESEND_MS = 1000
/**
 * The window found the cable loud this many times in a row while Windows said the player was
 * down (its sound comes from somewhere the volume can't reach): leave its volume alone.
 */
const LOUD_STRIKES_MAX = 3
/** Loud reports further apart than this don't count as in a row. */
const LOUD_STRIKES_FORGOTTEN_MS = 30_000
/** The window's make-up gain counts as off at or below this. */
const MAKEUP_OFF = 1.01
/** Don't repeat a volume fix for the same player more often than this. */
const VOLUME_RETRY_MS = 2000

/** Written in Equalizer APO's file while the music-only mode is on. */
export const MUSIC_ONLY_NOTE =
  'Music Overlayer is in "Music only" mode: it equalizes just the music app, so this file stays flat.'

interface MusicEqOptions {
  isWindows: boolean
  media: MediaHub
  getEq(): EqSettings
  /** The player's volume boost, 1–2. */
  getBoost(appId: string): number
  /** Set a player's own volume in the Windows mixer. */
  setAppVolume(appId: string, level: number): void
  /** Players turned down on the cable, with the volume to give back (kept across crashes). */
  getWhispering(): Record<string, number>
  setWhispering(levels: Record<string, number>): void
  /** Apps this or an earlier run routed and hasn't undone yet (kept across crashes). */
  getRoutedApps(): string[]
  setRoutedApps(apps: string[]): void
  getCableInstalledAt(): number | null
  setCableInstalledAt(time: number | null): void
  onStatus(status: MusicEqStatus): void
  /** Ask the window to start, change or stop its audio path (capture CABLE Output, equalize, play). */
  setPipeline(request: PipelineRequest): void
  /** Keep Equalizer APO flat (a reason) or let it equalize the device (null). */
  setDeviceBypass(reason: string | null): void
}

/**
 * The music-only equalizer, and the volume boost past 100%. While the shown player plays, its
 * sound is sent to VB-CABLE; the window captures the cable, equalizes and/or boosts it and plays
 * it on the normal output. Discord, games and everything else keep going straight to the
 * speakers, untouched.
 *
 * Order matters: the window's audio path starts first, then the player is routed, so the music
 * never goes silent. Stopping goes the other way round.
 *
 * Sharing the whole screen on Discord records every program's own sound, wherever it plays: the
 * player (into the cable) and the overlay (its equalized copy, a moment later). So the player on
 * the cable is also turned down to a whisper in the Windows mixer and the window turns it back
 * up: viewers get the overlay's copy, and the player's is too quiet to hear.
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
  /** The last request sent to the window, to send changes only. */
  private request: PipelineRequest | null = null
  /** When each player was last seen playing: the pause grace is per player. */
  private playedAt = new Map<string, number>()
  /**
   * The player on the cable, turned down to `quiet` in the Windows mixer, and the volume the
   * user chose for it (`level`). `confirmed` once Windows reports it turned down: only then does
   * the window turn it back up (the make-up gain), so it can never come out loud.
   */
  private whisper: { app: string; level: number; quiet: number; confirmed: boolean; at: number; settle: number } | null = null
  /** When the bridge confirmed the shown player went on the cable. */
  private routedAt = 0
  private loudStrikes = 0
  private lastLoudAt = 0
  /** A player whose volume is left alone (see LOUD_STRIKES_MAX) until it's routed again. */
  private noWhisper: string | null = null
  private settleTimer: NodeJS.Timeout | null = null
  /** A whispering player whose volume goes back once no make-up gain can reach it. */
  private restoring: { app: string; level: number } | null = null
  /** The make-up gain the window last said it applies. */
  private appliedMakeup = 1
  private volumeFixedAt = new Map<string, number>()
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

  /** A window that just (re)loaded has no audio path: ask again if it should have one. */
  pageLoaded(): void {
    if (this.pipelineWanted && this.request?.run) this.options.setPipeline(this.request)
  }

  /** The volume to show for a player while it's turned down on the cable, else null. */
  whisperLevel(app: string | null | undefined): number | null {
    if (!app) return null
    if (this.whisper?.app === app) return this.whisper.level
    if (this.restoring?.app === app) return this.restoring.level
    return null
  }

  /**
   * The user moved the volume of a player that's turned down on the cable: it changes the
   * make-up gain, not the player's Windows volume (that one stays at a whisper). False if the
   * player isn't turned down, so the caller sets its Windows volume as usual.
   */
  setWhisperLevel(app: string, level: number): boolean {
    if (this.whisper?.app !== app) return false
    this.whisper.level = Math.min(1, Math.max(0, level))
    this.saveWhispering(app, this.whisper.level)
    this.update()
    return true
  }

  /** Re-evaluates everything. Cheap; called on every change. */
  update(): void {
    const { isWindows, media } = this.options
    const eq = this.options.getEq()
    const musicMode = isWindows && eq.target === 'music'
    this.setBypass(musicMode ? MUSIC_ONLY_NOTE : null)
    this.updateWhisper()
    const loud = this.whisper?.confirmed ? this.whisper : null
    const makeup = loud ? loud.level / loud.quiet : 1
    const ceiling = loud ? loud.quiet * CEILING_RATIO : 1

    const session = media.session
    const now = Date.now()
    const app = session?.appId || null
    if (app && session?.status === 'playing') this.playedAt.set(app, now)
    if (this.pending && now - this.pending.at > ANSWER_TIMEOUT_MS) this.pending = null

    const cableId = this.cable.id
    const equalize = musicMode && eq.enabled
    const boost = app ? this.options.getBoost(app) : 1
    // Only the shown player's own pause counts: another player that was just playing doesn't
    // keep this one on the cable.
    const recent = app !== null && now - (this.playedAt.get(app) ?? 0) < PAUSE_GRACE_MS
    const wanted =
      isWindows &&
      (equalize || boost > 1) &&
      Boolean(cableId) &&
      this.cable.routing &&
      app !== null &&
      (session?.status === 'playing' || recent)

    if (wanted && cableId && app) {
      this.cancelStop()
      if (!this.pipelineWanted && now >= this.pipelineRetryAt) {
        this.pipelineWanted = true
        this.request = null
      }
      if (this.pipelineWanted) this.sendPipeline({ run: true, equalize, boost, makeup, ceiling })
      // A new player only goes on the cable once no make-up gain is left from another one.
      const quiet = this.appliedMakeup <= MAKEUP_OFF
      if (this.pipelineRunning && quiet && !this.pending && this.routedApp !== app && now >= this.retryAt) {
        this.pending = { kind: 'route', at: now }
        media.route(cableId)
      }
    } else {
      if (this.request?.run && this.request.makeup !== 1) this.sendPipeline({ ...this.request, makeup: 1, ceiling: 1 })
      if (this.routedApp && !this.pending) {
        this.pending = { kind: 'unroute', at: now }
        media.unroute('*')
      }
      if (!this.routedApp && this.pipelineWanted) this.scheduleStop()
    }
    this.ensureTick(wanted || this.routedApp !== null || this.pipelineWanted || this.whisper !== null || this.restoring !== null)
    this.publish()
  }

  /**
   * The whisper (see `whisper`). Turning down comes first, and the make-up gain only once
   * Windows confirms it; turning back up waits until the make-up gain is off (or the player is
   * off the cable). Players left turned down by a crash get their volume back.
   */
  private updateWhisper(): void {
    const session = this.options.media.session
    const app = session?.appId || null
    const volume = typeof session?.volume === 'number' ? session.volume : null
    const onCable = app !== null && this.routedApp === app && this.pipelineRunning
    const quiet = (this.cable.bits ?? 0) >= 24 ? QUIET_LEVEL : QUIET_LEVEL_16_BIT

    // Off the cable, or the cable switched between 16 and 24 bit: back up first (a deeper or
    // shallower whisper starts over once the make-up gain is off).
    if (this.whisper && !(onCable && app === this.whisper.app && quiet === this.whisper.quiet)) {
      log('music-eq', `giving ${this.whisper.app} its volume back once the make-up gain is off`)
      this.restoring = { app: this.whisper.app, level: this.whisper.level }
      this.whisper = null
    }

    if (this.restoring) {
      const { app: target, level } = this.restoring
      const safe = this.appliedMakeup <= MAKEUP_OFF || !this.pipelineRunning || this.routedApp !== target
      if (safe) {
        this.restoring = null
        this.fixVolume(target, level, true)
      }
    }

    const sinceRouted = Date.now() - this.routedAt
    const canJoin = !this.whisper && !this.restoring && onCable && app !== null && app !== this.noWhisper && volume !== null
    if (canJoin && app && volume !== null && sinceRouted < ROUTE_SETTLE_MS) {
      this.settleSoon(ROUTE_SETTLE_MS - sinceRouted + 10)
    } else if (canJoin && app && volume !== null) {
      // A record left by a crash holds the real level: Windows' figure would be the whisper.
      const level = this.options.getWhispering()[app] ?? volume
      this.whisper = { app, level, quiet, confirmed: false, at: Date.now(), settle: SETTLE_MS }
      this.saveWhispering(app, level)
      const bits = this.cable.bits ? `${this.cable.bits}-bit cable` : 'cable of unknown bit depth'
      log('music-eq', `turning ${app} down to ${quiet * 100}% on the ${bits}, the overlay plays it at ${Math.round(level * 100)}%`)
      this.fixVolume(app, quiet, true)
      this.settleSoon(SETTLE_MS + 10)
    }

    const whisper = this.whisper
    if (whisper && app === whisper.app && volume !== null) {
      const waited = Date.now() - whisper.at
      if (volume <= whisper.quiet * CONFIRMED_RATIO) {
        if (!whisper.confirmed && waited >= whisper.settle) whisper.confirmed = true
      } else if (whisper.confirmed) {
        // Louder again: turned up in the Windows mixer, or its sound moved to a new session
        // (Windows keeps one per device). No make-up gain until it's down again; the volume
        // the user chose on the overlay stays as it was.
        log('music-eq', `${app} is at ${Math.round(volume * 100)}% in the Windows mixer again, turning it down`)
        this.unconfirm(SETTLE_MS)
      } else if (waited >= RESEND_MS) {
        // Still not down (the command missed a session that just appeared): again.
        this.fixVolume(app, whisper.quiet, false)
      }
    }

    // A record for a player that isn't whispering: it was turned down and not given back yet.
    const records = this.options.getWhispering()
    if (app && volume !== null && records[app] !== undefined && this.whisper?.app !== app) {
      if (volume > QUIET_LEVEL_16_BIT * CONFIRMED_RATIO) this.saveWhispering(app, null)
      else if (this.appliedMakeup <= MAKEUP_OFF || this.routedApp !== app || !this.pipelineRunning) {
        this.fixVolume(app, records[app], false)
      }
    }
  }

  /** The make-up gain off until the player is down again (and has been for `settle` ms). */
  private unconfirm(settle: number): void {
    const whisper = this.whisper
    if (!whisper) return
    whisper.confirmed = false
    whisper.at = Date.now()
    whisper.settle = settle
    this.fixVolume(whisper.app, whisper.quiet, true)
    this.settleSoon(settle + 10)
  }

  /** Looks again in `ms` (once the sound turned down has come through the cable, say). */
  private settleSoon(ms: number): void {
    if (this.settleTimer) clearTimeout(this.settleTimer)
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null
      this.update()
    }, ms)
  }

  /** Sets a player's Windows volume, at most every VOLUME_RETRY_MS unless `now`. */
  private fixVolume(app: string, level: number, now: boolean): void {
    const at = Date.now()
    if (!now && at - (this.volumeFixedAt.get(app) ?? 0) < VOLUME_RETRY_MS) return
    this.volumeFixedAt.set(app, at)
    this.options.setAppVolume(app, level)
  }

  private saveWhispering(app: string, level: number | null): void {
    const records = { ...this.options.getWhispering() }
    delete records[app]
    if (level !== null) records[app] = level
    this.options.setWhispering(records)
  }

  /**
   * The window reports whether its audio path runs and the make-up gain it applies. `loud`: it
   * found the cable louder than the whisper and took the make-up gain off by itself.
   */
  setPipelineState(running: boolean, error: string | null, makeup?: number, loud = false): void {
    this.pipelineRunning = running
    this.appliedMakeup = running ? (makeup ?? this.appliedMakeup) : 1
    const whisper = this.whisper
    if (loud && whisper) {
      const now = Date.now()
      this.loudStrikes = now - this.lastLoudAt > LOUD_STRIKES_FORGOTTEN_MS ? 1 : this.loudStrikes + 1
      this.lastLoudAt = now
      if (this.loudStrikes >= LOUD_STRIKES_MAX) {
        log('music-eq', `${whisper.app} stays louder than ${whisper.quiet * 100}% on the cable, so its volume is left as it was`)
        this.noWhisper = whisper.app
        this.loudStrikes = 0
        this.restoring = { app: whisper.app, level: whisper.level }
        this.whisper = null
      } else {
        log('music-eq', `the overlay heard ${whisper.app} louder than ${whisper.quiet * 100}% on the cable, turning it down again`)
        this.unconfirm(SETTLE_AFTER_LOUD_MS)
      }
    }
    if (running) this.pipelineError = null
    else {
      if (error) {
        if (error !== this.pipelineError) log('music-eq', `audio path failed: ${error}`)
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
    this.request = null
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
    if (this.settleTimer) clearTimeout(this.settleTimer)
    this.settleTimer = null
    // Quitting with the player turned down: take it off the cable first (the bridge does the
    // commands in order), then give it its volume back.
    const turnedDown = this.whisper ?? this.restoring
    if (turnedDown) {
      this.options.media.unroute('*')
      this.options.setAppVolume(turnedDown.app, turnedDown.level)
    }
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
      this.routedAt = Date.now()
      this.noWhisper = null
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
      this.sendPipeline({ run: false, equalize: false, boost: 1, makeup: 1, ceiling: 1 })
      this.publish()
    }, STOP_DELAY_MS)
  }

  private sendPipeline(request: PipelineRequest): void {
    const previous = this.request
    if (
      previous &&
      previous.run === request.run &&
      previous.equalize === request.equalize &&
      previous.boost === request.boost &&
      previous.makeup === request.makeup &&
      previous.ceiling === request.ceiling
    ) {
      return
    }
    this.request = request
    this.options.setPipeline(request)
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
    const supported = this.options.isWindows
    let error = this.installError ?? this.pipelineError ?? this.routeError
    if (!error && cable && !this.cable.routing) {
      error = this.cable.why ? `Windows won't let apps move another app's sound: ${this.cable.why}` : "Windows won't let apps move another app's sound."
    }
    return {
      supported,
      cable,
      routing: this.cable.routing,
      boostAvailable: supported && cable && this.cable.routing,
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
