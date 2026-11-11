import { EventEmitter } from 'node:events'
import type { PlayerFilter } from '../../shared/apps'
import type { BridgeStatus, MediaCommand, MediaCover, MediaSession } from '../../shared/types'

/** VB-CABLE as the bridge sees it. */
export interface CableInfo {
  /** Endpoint id of "CABLE Input", or null when VB-CABLE isn't there. */
  id: string | null
  /** Windows lets the overlay choose another app's output device. */
  routing: boolean
  /** Bits per sample the cable carries (16 or 24 usually), null when unknown. */
  bits?: number | null
  why?: string
}

export interface RouteResult {
  /** App id, or "*" for everything that was routed. */
  app: string
  /** How many of the app's processes changed. */
  n: number
  why?: string
  /** The routed app quit. */
  exited?: boolean
}

/** What a helper process of the source (the PowerShell bridge) uses. */
export interface HelperUsage {
  /** Share of the whole CPU, like Task Manager shows it (0–100). */
  cpuPercent: number
  memoryMb: number
}

export interface MediaSourceEvents {
  session: [MediaSession | null]
  cover: [MediaCover]
  status: [BridgeStatus]
  /** App ids of every player with a media session, including ones the filter hides. */
  apps: [string[]]
  /** The player turned a command down. */
  refused: [MediaCommand['type']]
  cable: [CableInfo]
  /** The shown player's sound now goes through VB-CABLE (or couldn't: n is 0). */
  routed: [RouteResult]
  /** An app's sound went back to the default device. */
  unrouted: [RouteResult]
}

/** Something that reports what's playing and can control it: the Windows bridge or the demo. */
export abstract class MediaSource extends EventEmitter<MediaSourceEvents> {
  abstract start(): void
  abstract stop(): void
  abstract command(command: MediaCommand): void
  /** Which apps to show. Sources that only ever have music (the demo) ignore it. */
  setFilter(_filter: PlayerFilter): void {}
  /** Look for VB-CABLE again; answers with a "cable" event. */
  checkCable(): void {}
  /** Send the shown player's sound to this output device (answers with "routed"). */
  route(_endpointId: string): void {}
  /** Send an app's sound (or "*": everything routed) back to the default device. */
  unroute(_appId: string): void {}
  /** CPU and memory of the source's own helper process, if it has one. */
  get helperUsage(): HelperUsage | null {
    return null
  }
}
