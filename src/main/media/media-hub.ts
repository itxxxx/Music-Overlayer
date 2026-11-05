import { EventEmitter } from 'node:events'
import type { PlayerFilter } from '../../shared/apps'
import type { BridgeStatus, MediaCommand, MediaCover, MediaSession } from '../../shared/types'
import { ArtworkLookup } from './artwork-lookup'
import { DemoMediaSource } from './demo-source'
import type { MediaSource, MediaSourceEvents } from './media-source'
import { WindowsMediaBridge } from './windows-bridge'

export type MediaMode = 'windows' | 'demo'

const MAX_SEEN_APPS = 20
/** The bridge reads artwork at 0, 1.5 and 4.5 s after a track change; look online only after that. */
const ONLINE_COVER_DELAY_MS = 5500

interface MediaHubOptions {
  filter: PlayerFilter
  onlineCovers: boolean
}

/** Holds the latest media state and lets the app switch between real sessions and the demo. */
export class MediaHub extends EventEmitter<MediaSourceEvents> {
  session: MediaSession | null = null
  cover: MediaCover | null = null
  status: BridgeStatus = { state: 'starting' }
  /** Players seen since the app started, most recent first (for the Players menu). */
  seenApps: string[] = []
  private source: MediaSource | null = null
  private mode: MediaMode | null = null
  private filter: PlayerFilter
  private onlineCovers: boolean
  private readonly artwork = new ArtworkLookup()
  private coverTimer: NodeJS.Timeout | null = null

  constructor(options: MediaHubOptions) {
    super()
    this.filter = options.filter
    this.onlineCovers = options.onlineCovers
  }

  use(mode: MediaMode): void {
    if (mode === this.mode) return
    this.source?.stop()
    this.source?.removeAllListeners()
    this.mode = mode
    this.session = null
    this.cover = null
    this.clearCoverTimer()
    this.emit('session', null)

    const source = mode === 'demo' ? new DemoMediaSource() : new WindowsMediaBridge(this.filter)
    source.on('session', (session) => {
      const previousKey = this.session?.trackKey ?? null
      this.session = session
      this.emit('session', session)
      if ((session?.trackKey ?? null) !== previousKey) this.scheduleOnlineCover()
    })
    source.on('cover', (cover) => {
      this.cover = cover
      this.emit('cover', cover)
    })
    source.on('status', (status) => {
      this.status = status
      this.emit('status', status)
    })
    source.on('apps', (ids) => {
      const merged = [...ids, ...this.seenApps.filter((id) => !ids.includes(id))].slice(0, MAX_SEEN_APPS)
      if (merged.join('\n') === this.seenApps.join('\n')) return
      this.seenApps = merged
      this.emit('apps', merged)
    })
    source.on('refused', (command) => this.emit('refused', command))
    source.on('cable', (cable) => this.emit('cable', cable))
    source.on('routed', (result) => this.emit('routed', result))
    source.on('unrouted', (result) => this.emit('unrouted', result))
    this.source = source
    source.start()
  }

  setFilter(filter: PlayerFilter): void {
    this.filter = filter
    this.source?.setFilter(filter)
  }

  checkCable(): void {
    this.source?.checkCable()
  }

  route(endpointId: string): void {
    this.source?.route(endpointId)
  }

  unroute(appId: string): void {
    this.source?.unroute(appId)
  }

  setOnlineCovers(enabled: boolean): void {
    this.onlineCovers = enabled
    if (enabled) this.scheduleOnlineCover()
    else this.clearCoverTimer()
  }

  command(command: MediaCommand): void {
    this.source?.command(command)
  }

  stop(): void {
    this.clearCoverTimer()
    this.source?.stop()
    this.source?.removeAllListeners()
    this.source = null
    this.mode = null
  }

  private clearCoverTimer(): void {
    if (this.coverTimer) clearTimeout(this.coverTimer)
    this.coverTimer = null
  }

  private hasPlayerCover(trackKey: string): boolean {
    return Boolean(this.cover && this.cover.trackKey === trackKey && this.cover.dataUrl)
  }

  /** If the player still hasn't shared artwork a few seconds into a track, look it up online. */
  private scheduleOnlineCover(): void {
    this.clearCoverTimer()
    const session = this.session
    if (!this.onlineCovers || this.mode !== 'windows' || !session?.title || !session.artist) return
    const trackKey = session.trackKey
    this.coverTimer = setTimeout(() => {
      this.coverTimer = null
      if (this.session?.trackKey !== trackKey || this.hasPlayerCover(trackKey)) return
      void this.artwork.find({ title: session.title, artist: session.artist, album: session.album }).then((dataUrl) => {
        if (!dataUrl || !this.onlineCovers || this.session?.trackKey !== trackKey || this.hasPlayerCover(trackKey)) return
        this.cover = { trackKey, dataUrl, source: 'online' }
        this.emit('cover', this.cover)
      })
    }, ONLINE_COVER_DELAY_MS)
  }
}
