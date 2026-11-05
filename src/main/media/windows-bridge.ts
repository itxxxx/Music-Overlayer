import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { appDisplayName, playerPatterns, type PlayerFilter } from '../../shared/apps'
import type { MediaCommand, MediaSession, PlaybackStatus, RepeatMode } from '../../shared/types'
import { resourcePath, systemExecutable } from '../paths'
import { MediaSource, type CableInfo, type RouteResult } from './media-source'

/** Session as printed by resources/media-bridge.ps1. */
export interface RawSession {
  app: string
  title: string
  artist: string
  album: string
  albumArtist: string
  st: number
  pos: number
  start: number
  end: number
  upd: number
  rate: number
  ctl: number
  shuffle: boolean | null
  repeat: number | null
  /** Volume-mixer level 0–1 and mute, or null when the player's audio session wasn't found. */
  vol?: number | null
  mute?: boolean | null
  key: string
}

type BridgeMessage =
  | { t: 'hello'; ps: string; os: string }
  | { t: 'native'; ok: boolean; message?: string; from?: string; ms?: number }
  | { t: 'ready' }
  | { t: 'state'; n: number; s: RawSession | null }
  | { t: 'cover'; key: string; mime: string | null; b64: string | null; why?: string }
  | { t: 'cable'; id: string | null; routing: boolean; why?: string }
  | ({ t: 'routed' } & RouteResult)
  | ({ t: 'unrouted' } & RouteResult)
  | { t: 'ack'; cmd: string; ok: boolean }
  | { t: 'error'; message: string }
  | { t: 'fatal'; message: string }
  | { t: 'apps'; ids: string[] }

/** The filter as the bridge expects it: base64 of {"allow": regex, "block": regex}. */
export function encodeFilter(filter: PlayerFilter): string {
  return Buffer.from(JSON.stringify(playerPatterns(filter)), 'utf8').toString('base64')
}

const STATUS: PlaybackStatus[] = ['closed', 'opened', 'changing', 'stopped', 'playing', 'paused']
const REPEAT: RepeatMode[] = ['none', 'track', 'list']
const YEAR_2000 = 946_684_800_000

export function toMediaSession(raw: RawSession, count: number, receivedAt: number): MediaSession {
  const start = Number.isFinite(raw.start) ? raw.start : 0
  const end = Number.isFinite(raw.end) ? raw.end : 0
  const durationMs = Math.max(0, end - start)
  const position = Math.max(0, (Number.isFinite(raw.pos) ? raw.pos : 0) - start)
  const controls = raw.ctl | 0
  return {
    appId: raw.app ?? '',
    appName: appDisplayName(raw.app ?? ''),
    title: raw.title ?? '',
    artist: raw.artist || raw.albumArtist || '',
    album: raw.album ?? '',
    status: STATUS[raw.st] ?? 'stopped',
    positionMs: durationMs > 0 ? Math.min(position, durationMs) : position,
    durationMs,
    // Players say when they sampled the position; a missing or nonsense time means "now".
    updatedAt: raw.upd > YEAR_2000 && raw.upd <= receivedAt + 5000 ? raw.upd : receivedAt,
    rate: raw.rate > 0 ? raw.rate : 1,
    canPlayPause: (controls & (1 | 2 | 128)) !== 0,
    canNext: (controls & 4) !== 0,
    canPrev: (controls & 8) !== 0,
    canSeek: (controls & 16) !== 0 && durationMs > 0,
    canShuffle: (controls & 32) !== 0,
    canRepeat: (controls & 64) !== 0,
    shuffle: typeof raw.shuffle === 'boolean' ? raw.shuffle : null,
    repeat: raw.repeat === null || raw.repeat === undefined ? null : (REPEAT[raw.repeat] ?? null),
    trackKey: raw.key,
    sessionCount: count,
    volume: typeof raw.vol === 'number' && Number.isFinite(raw.vol) ? Math.min(1, Math.max(0, raw.vol)) : null,
    muted: typeof raw.mute === 'boolean' ? raw.mute : null
  }
}

/** Bridge command names that the UI cares about when a player turns them down. */
const REFUSABLE = new Set<MediaCommand['type']>(['shuffle', 'repeat', 'volume', 'mute'])

export function toCommandLine(command: MediaCommand, timelineStartMs: number): string {
  switch (command.type) {
    case 'toggle':
    case 'play':
    case 'pause':
    case 'next':
    case 'prev':
      return command.type
    case 'cycle-session':
      return 'cycle'
    case 'seek':
      return `seek ${Math.max(0, Math.round(command.positionMs + timelineStartMs))}`
    case 'shuffle':
      return `shuffle ${command.value ? 1 : 0}`
    case 'repeat':
      return `repeat ${Math.max(0, REPEAT.indexOf(command.value))}`
    case 'volume':
      return `volume ${Math.min(1, Math.max(0, command.value)).toFixed(3)}`
    case 'mute':
      return `mute ${command.value ? 1 : 0}`
  }
}

/**
 * Runs resources/media-bridge.ps1 in Windows PowerShell and translates its output.
 * The script reads Windows' media sessions, so any player that shows up in the Windows
 * volume flyout (Spotify, Deezer, browser tabs, ...) shows up in the widget.
 */
export class WindowsMediaBridge extends MediaSource {
  private child: ChildProcessWithoutNullStreams | null = null
  private running = false
  private restartTimer: NodeJS.Timeout | null = null
  private restartDelayMs = 1000
  private timelineStartMs = 0
  private filter: PlayerFilter
  private lastCoverWhy = ''

  constructor(filter: PlayerFilter) {
    super()
    this.filter = filter
  }

  /** Changes which apps are shown; applies immediately. */
  setFilter(filter: PlayerFilter): void {
    this.filter = filter
    if (!this.child) return
    try {
      this.child.stdin.write(`filter ${encodeFilter(filter)}\n`)
    } catch (error) {
      console.warn('[media-bridge] could not update the player filter', error)
    }
  }

  checkCable(): void {
    this.write('cable')
  }

  route(endpointId: string): void {
    // Endpoint ids look like {0.0.0.00000000}.{guid}: no spaces.
    if (/^[\w{}.\-#]+$/.test(endpointId)) this.write(`route ${endpointId}`)
  }

  unroute(appId: string): void {
    this.write(appId === '*' ? 'unroute *' : `unroute ${Buffer.from(appId, 'utf8').toString('base64')}`)
  }

  private write(line: string): void {
    if (!this.child) return
    try {
      this.child.stdin.write(`${line}\n`)
    } catch (error) {
      console.warn('[media-bridge] could not send', line.split(' ')[0], error)
    }
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.emit('status', { state: 'starting' })
    this.launch()
  }

  stop(): void {
    this.running = false
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    const child = this.child
    this.child = null
    if (!child) return
    try {
      child.stdin.end()
    } catch {
      // already closed
    }
    setTimeout(() => {
      if (child.exitCode === null) child.kill()
    }, 1500).unref()
  }

  command(command: MediaCommand): void {
    this.write(toCommandLine(command, this.timelineStartMs))
  }

  private launch(): void {
    const script = resourcePath('media-bridge.ps1')
    if (!existsSync(script)) {
      this.emit('status', { state: 'error', message: `Missing ${script}` })
      return
    }
    const bundled = systemExecutable('System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const powershell = existsSync(bundled) ? bundled : 'powershell.exe'
    const args = [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      script,
      '-PollMs',
      '500',
      '-IdlePollMs',
      '1500',
      '-Filter',
      encodeFilter(this.filter)
    ]

    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(powershell, args, { windowsHide: true })
    } catch (error) {
      this.scheduleRestart(`Couldn't start PowerShell: ${(error as Error).message}`)
      return
    }
    this.child = child
    let stderr = ''
    let fatal: string | null = null

    child.stdin.on('error', () => {
      // EPIPE while the process is exiting; the exit handler restarts it.
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-4000)
    })
    createInterface({ input: child.stdout }).on('line', (line) => {
      const message = this.parse(line)
      if (message?.t === 'fatal') fatal = message.message
      if (message) this.handle(message)
    })
    child.on('error', (error) => {
      if (this.child !== child) return
      this.child = null
      this.scheduleRestart(`Couldn't start PowerShell: ${error.message}`)
    })
    child.on('exit', (code) => {
      if (this.child !== child) return
      this.child = null
      if (!this.running) return
      if (fatal || code === 3) {
        // Media controls aren't available on this PC; try again much later.
        this.scheduleRestart(fatal ?? 'Windows media controls are not available.', 60_000, 'unsupported')
        return
      }
      const detail = stderr.trim().split(/\r?\n/).slice(-3).join(' ')
      this.scheduleRestart(detail || `The media bridge stopped (exit code ${code}).`)
    })
  }

  private parse(line: string): BridgeMessage | null {
    const text = line.replace(/^﻿/, '').trim()
    if (!text.startsWith('{')) return null
    try {
      return JSON.parse(text) as BridgeMessage
    } catch {
      return null
    }
  }

  private handle(message: BridgeMessage): void {
    switch (message.t) {
      case 'hello':
        console.info(`[media-bridge] Windows PowerShell ${message.ps} on Windows ${message.os}`)
        break
      case 'native':
        if (message.ok) console.info(`[media-bridge] native helper loaded (${message.from ?? '?'}, ${message.ms ?? '?'} ms)`)
        else console.warn('[media-bridge] no per-app volume:', message.message)
        break
      case 'ready':
        this.restartDelayMs = 1000
        this.emit('status', { state: 'ready' })
        break
      case 'state':
        if (!message.s) {
          this.timelineStartMs = 0
          this.emit('session', null)
        } else {
          this.timelineStartMs = Number.isFinite(message.s.start) ? message.s.start : 0
          this.emit('session', toMediaSession(message.s, message.n, Date.now()))
        }
        break
      case 'cover':
        if (!message.b64 && message.why && message.why !== this.lastCoverWhy) {
          this.lastCoverWhy = message.why
          console.info('[media-bridge] no artwork:', message.why)
        }
        this.emit('cover', {
          trackKey: message.key,
          dataUrl: message.b64 && message.mime ? `data:${message.mime};base64,${message.b64}` : null,
          source: 'player'
        })
        break
      case 'cable': {
        const cable: CableInfo = { id: typeof message.id === 'string' && message.id ? message.id : null, routing: message.routing === true }
        if (message.why) cable.why = message.why
        if (!cable.routing && message.why) console.info('[media-bridge] no per-app routing:', message.why)
        this.emit('cable', cable)
        break
      }
      case 'routed':
      case 'unrouted': {
        const result: RouteResult = { app: String(message.app ?? ''), n: Number(message.n) || 0 }
        if (message.why) result.why = String(message.why)
        if (message.exited) result.exited = true
        if (message.t === 'routed' && result.n === 0) console.info('[media-bridge] could not route', result.app, result.why ?? '')
        this.emit(message.t, result)
        break
      }
      case 'error':
        console.warn('[media-bridge]', message.message)
        break
      case 'fatal':
        this.emit('status', { state: 'unsupported', message: message.message })
        break
      case 'ack':
        if (!message.ok) {
          console.info(`[media-bridge] the player ignored "${message.cmd}"`)
          if (REFUSABLE.has(message.cmd as MediaCommand['type'])) this.emit('refused', message.cmd as MediaCommand['type'])
        }
        break
      case 'apps':
        if (Array.isArray(message.ids)) this.emit('apps', message.ids.filter((id) => typeof id === 'string'))
        break
    }
  }

  private scheduleRestart(reason: string, delayMs?: number, state: 'error' | 'unsupported' = 'error'): void {
    if (!this.running) return
    this.emit('status', { state, message: reason })
    this.emit('session', null)
    const delay = delayMs ?? this.restartDelayMs
    this.restartDelayMs = Math.min(this.restartDelayMs * 2, 30_000)
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (this.running) this.launch()
    }, delay)
  }
}
