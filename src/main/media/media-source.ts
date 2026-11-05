import { EventEmitter } from 'node:events'
import type { PlayerFilter } from '../../shared/apps'
import type { BridgeStatus, MediaCommand, MediaCover, MediaSession } from '../../shared/types'

export interface MediaSourceEvents {
  session: [MediaSession | null]
  cover: [MediaCover]
  status: [BridgeStatus]
  /** App ids of every player with a media session, including ones the filter hides. */
  apps: [string[]]
}

/** Something that reports what's playing and can control it: the Windows bridge or the demo. */
export abstract class MediaSource extends EventEmitter<MediaSourceEvents> {
  abstract start(): void
  abstract stop(): void
  abstract command(command: MediaCommand): void
  /** Which apps to show. Sources that only ever have music (the demo) ignore it. */
  setFilter(_filter: PlayerFilter): void {}
}
