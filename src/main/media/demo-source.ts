import type { MediaCommand, MediaSession, RepeatMode } from '../../shared/types'
import { MediaSource } from './media-source'

interface DemoTrack {
  title: string
  artist: string
  album: string
  durationMs: number
  palette: [string, string, string, string]
}

// Invented tracks with generated artwork, for trying the widget without a player running.
const TRACKS: DemoTrack[] = [
  { title: 'Midnight Transit', artist: 'Lumen Vale', album: 'Night Lines', durationMs: 214_000, palette: ['#1d2550', '#3a2f7a', '#ff8a5c', '#ffd6a5'] },
  { title: 'Paper Satellites', artist: 'The Quiet Arcade', album: 'Low Orbit', durationMs: 187_000, palette: ['#0d3236', '#11585a', '#7de2c3', '#f3f1d8'] },
  { title: 'Golden Hour Static', artist: 'Mira Okafor', album: 'Warm Noise', durationMs: 241_000, palette: ['#3a1838', '#7a2f5c', '#f6a6c1', '#ffe3a3'] },
  { title: 'Signals Over Water — Extended Harbour Mix', artist: 'Halden & The Low Tide Collective', album: 'Coastlines', durationMs: 352_000, palette: ['#14263a', '#24506e', '#8cc8ff', '#e8f4ff'] }
]

function coverSvg(track: DemoTrack, index: number): string {
  const [deep, mid, glow, light] = track.palette
  const rings = Array.from({ length: 5 }, (_, i) => {
    const r = 60 + i * 34
    return `<circle cx="${index % 2 ? 330 : 182}" cy="300" r="${r}" fill="none" stroke="${light}" stroke-opacity="${0.18 - i * 0.03}" stroke-width="2"/>`
  }).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${mid}"/><stop offset="1" stop-color="${deep}"/>
    </linearGradient>
    <radialGradient id="sun" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="${light}"/><stop offset="0.55" stop-color="${glow}"/><stop offset="1" stop-color="${glow}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="512" height="512" fill="url(#bg)"/>
  ${rings}
  <circle cx="${index % 2 ? 330 : 182}" cy="300" r="150" fill="url(#sun)" opacity="0.92"/>
  <rect x="0" y="372" width="512" height="140" fill="${deep}" opacity="0.72"/>
  <path d="M0 372 Q128 ${352 + index * 6} 256 372 T512 372" fill="none" stroke="${light}" stroke-opacity="0.35" stroke-width="3"/>
</svg>`
}

export class DemoMediaSource extends MediaSource {
  private index = 0
  private playing = true
  private positionMs = 38_000
  private sampledAt = Date.now()
  private shuffle = false
  private repeat: RepeatMode = 'none'
  private volume = 0.8
  private muted = false
  private timer: NodeJS.Timeout | null = null

  /** MUSIC_OVERLAYER_FAKE_CABLE=1 pretends VB-CABLE is installed (for trying the music-only path). */
  private readonly fakeCable = process.env.MUSIC_OVERLAYER_FAKE_CABLE === '1'
  private routed = false

  start(): void {
    this.emit('status', { state: 'demo' })
    this.publish(true)
    this.timer = setInterval(() => this.tick(), 500)
    if (this.fakeCable) setTimeout(() => this.checkCable(), 50)
  }

  checkCable(): void {
    // MUSIC_OVERLAYER_FAKE_CABLE_BITS: the sample size to pretend the cable has (24 by default).
    const bits = Number(process.env.MUSIC_OVERLAYER_FAKE_CABLE_BITS) || 24
    if (this.fakeCable) this.emit('cable', { id: '{0.0.0.00000000}.{demo-cable}', routing: true, bits })
  }

  route(): void {
    if (!this.fakeCable) return
    this.routed = true
    setTimeout(() => this.emit('routed', { app: 'demo', n: 1 }), 60)
  }

  unroute(appId: string): void {
    if (!this.fakeCable) return
    const had = this.routed
    this.routed = false
    setTimeout(() => this.emit('unrouted', { app: appId, n: had ? 1 : 0 }), 60)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  command(command: MediaCommand): void {
    const position = this.currentPosition()
    switch (command.type) {
      case 'toggle':
        this.positionMs = position
        this.playing = !this.playing
        break
      case 'play':
      case 'pause':
        this.positionMs = position
        this.playing = command.type === 'play'
        break
      case 'next':
        this.skip(1)
        return
      case 'prev':
        if (position > 3000) this.positionMs = 0
        else {
          this.skip(-1)
          return
        }
        break
      case 'seek':
        this.positionMs = Math.max(0, Math.min(command.positionMs, this.track.durationMs))
        break
      case 'shuffle':
        this.shuffle = command.value
        break
      case 'repeat':
        this.repeat = command.value
        break
      case 'volume':
        this.volume = Math.max(0, Math.min(1, command.value))
        if (this.volume > 0) this.muted = false
        break
      case 'mute':
        this.muted = command.value
        break
      case 'cycle-session':
        return
    }
    this.sampledAt = Date.now()
    // Real players answer after a short delay; mimic that so the UI's optimistic updates get exercised.
    setTimeout(() => this.publish(false), 120)
  }

  private get track(): DemoTrack {
    return TRACKS[this.index]
  }

  private currentPosition(): number {
    if (!this.playing) return this.positionMs
    return Math.min(this.track.durationMs, this.positionMs + (Date.now() - this.sampledAt))
  }

  private skip(step: number): void {
    this.index = (this.index + step + TRACKS.length) % TRACKS.length
    this.positionMs = 0
    this.sampledAt = Date.now()
    this.playing = true
    setTimeout(() => this.publish(true), 150)
  }

  private tick(): void {
    if (this.playing && this.currentPosition() >= this.track.durationMs) {
      if (this.repeat === 'track') {
        this.positionMs = 0
        this.sampledAt = Date.now()
        this.publish(false)
      } else this.skip(1)
    }
  }

  private publish(withCover: boolean): void {
    const track = this.track
    const session: MediaSession = {
      appId: 'demo',
      appName: 'Demo',
      title: track.title,
      artist: track.artist,
      album: track.album,
      status: this.playing ? 'playing' : 'paused',
      positionMs: this.positionMs,
      durationMs: track.durationMs,
      updatedAt: this.sampledAt,
      rate: 1,
      canPlayPause: true,
      canNext: true,
      canPrev: true,
      canSeek: true,
      canShuffle: true,
      canRepeat: true,
      shuffle: this.shuffle,
      repeat: this.repeat,
      trackKey: `demo|${this.index}`,
      sessionCount: 1,
      volume: this.volume,
      muted: this.muted
    }
    this.emit('session', session)
    if (withCover) {
      const svg = coverSvg(track, this.index)
      this.emit('cover', {
        trackKey: session.trackKey,
        dataUrl: `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`
      })
    }
  }
}
