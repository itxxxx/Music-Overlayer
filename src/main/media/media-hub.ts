import { EventEmitter } from 'node:events'
import type { PlayerFilter } from '../../shared/apps'
import type { BridgeStatus, MediaCommand, MediaCover, MediaSession } from '../../shared/types'
import { DemoMediaSource } from './demo-source'
import type { MediaSource, MediaSourceEvents } from './media-source'
import { WindowsMediaBridge } from './windows-bridge'

export type MediaMode = 'windows' | 'demo'

const MAX_SEEN_APPS = 20

/** Holds the latest media state and lets the app switch between real sessions and the demo. */
export class MediaHub extends EventEmitter<MediaSourceEvents> {
  session: MediaSession | null = null
  cover: MediaCover | null = null
  status: BridgeStatus = { state: 'starting' }
  /** Players seen since the app started, most recent first (for the Players menu). */
  seenApps: string[] = []
  private source: MediaSource | null = null
  private mode: MediaMode | null = null

  constructor(private filter: PlayerFilter) {
    super()
  }

  use(mode: MediaMode): void {
    if (mode === this.mode) return
    this.source?.stop()
    this.source?.removeAllListeners()
    this.mode = mode
    this.session = null
    this.cover = null
    this.emit('session', null)

    const source = mode === 'demo' ? new DemoMediaSource() : new WindowsMediaBridge(this.filter)
    source.on('session', (session) => {
      this.session = session
      this.emit('session', session)
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
    this.source = source
    source.start()
  }

  setFilter(filter: PlayerFilter): void {
    this.filter = filter
    this.source?.setFilter(filter)
  }

  command(command: MediaCommand): void {
    this.source?.command(command)
  }

  stop(): void {
    this.source?.stop()
    this.source?.removeAllListeners()
    this.source = null
    this.mode = null
  }
}
