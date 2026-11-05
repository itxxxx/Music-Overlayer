// Which media sessions the widget shows. It's for music: music apps and browser tabs (where
// SoundCloud, Deezer, YouTube Music and Spotify Web play) are shown; Discord, games and every
// other app are ignored unless the user turns them on in the tray's Players menu.
//
// The patterns are matched against the Windows app id of a session, case-insensitively. They are
// also sent to the PowerShell media bridge, so keep them to regex syntax .NET and JavaScript share.

export type PlayerKind = 'music' | 'browser' | 'other'

export interface PlayerFilter {
  /** Show browser tabs (SoundCloud, YouTube Music, Deezer web, ...). */
  browsers: boolean
  /** App ids the user turned on although they aren't known music players. */
  allowed: string[]
  /** App ids the user turned off. */
  blocked: string[]
}

export const DEFAULT_PLAYER_FILTER: PlayerFilter = { browsers: true, allowed: [], blocked: [] }

interface KnownPlayer {
  pattern: string
  name: string
  kind: PlayerKind
}

const KNOWN_PLAYERS: KnownPlayer[] = [
  // Music apps
  { pattern: 'spotify', name: 'Spotify', kind: 'music' },
  { pattern: 'deezer', name: 'Deezer', kind: 'music' },
  { pattern: 'tidal', name: 'TIDAL', kind: 'music' },
  { pattern: 'applemusic|appleinc\\.apple', name: 'Apple Music', kind: 'music' },
  { pattern: 'itunes', name: 'iTunes', kind: 'music' },
  { pattern: 'amazon.?music|amazonmobilellc', name: 'Amazon Music', kind: 'music' },
  { pattern: 'youtube.?music|ytmdesktop|th-ch', name: 'YouTube Music', kind: 'music' },
  { pattern: 'soundcloud', name: 'SoundCloud', kind: 'music' },
  { pattern: 'qobuz', name: 'Qobuz', kind: 'music' },
  { pattern: 'pandora', name: 'Pandora', kind: 'music' },
  { pattern: 'napster', name: 'Napster', kind: 'music' },
  { pattern: 'anghami', name: 'Anghami', kind: 'music' },
  { pattern: 'jiosaavn', name: 'JioSaavn', kind: 'music' },
  { pattern: 'cloudmusic|netease', name: 'NetEase Cloud Music', kind: 'music' },
  { pattern: 'qqmusic', name: 'QQ Music', kind: 'music' },
  { pattern: 'kugou', name: 'Kugou', kind: 'music' },
  { pattern: 'kuwo', name: 'Kuwo', kind: 'music' },
  { pattern: 'zunemusic|microsoft\\.media\\.player|^mediaplayer', name: 'Media Player', kind: 'music' },
  { pattern: 'foobar', name: 'foobar2000', kind: 'music' },
  { pattern: 'musicbee', name: 'MusicBee', kind: 'music' },
  { pattern: 'aimp', name: 'AIMP', kind: 'music' },
  { pattern: 'winamp', name: 'Winamp', kind: 'music' },
  { pattern: 'mediamonkey', name: 'MediaMonkey', kind: 'music' },
  { pattern: 'vlc', name: 'VLC', kind: 'music' },
  { pattern: 'plexamp', name: 'Plexamp', kind: 'music' },
  { pattern: 'cider', name: 'Cider', kind: 'music' },
  { pattern: 'audirvana', name: 'Audirvana', kind: 'music' },
  { pattern: 'roon', name: 'Roon', kind: 'music' },
  { pattern: 'dopamine', name: 'Dopamine', kind: 'music' },
  { pattern: 'strawberry', name: 'Strawberry', kind: 'music' },
  { pattern: 'clementine', name: 'Clementine', kind: 'music' },
  { pattern: 'tauon', name: 'Tauon', kind: 'music' },
  { pattern: 'harmonoid', name: 'Harmonoid', kind: 'music' },
  { pattern: 'spotube', name: 'Spotube', kind: 'music' },
  { pattern: 'nuclear', name: 'Nuclear', kind: 'music' },
  { pattern: 'audacious', name: 'Audacious', kind: 'music' },
  // Browsers (the tab can be any site, so these follow the "browser tabs" switch)
  { pattern: '^msedge([._!]|$)|microsoftedge', name: 'Edge', kind: 'browser' },
  { pattern: '^(google ?)?chrome([._!]|$)|^chromium', name: 'Chrome', kind: 'browser' },
  { pattern: '^brave', name: 'Brave', kind: 'browser' },
  { pattern: '^vivaldi', name: 'Vivaldi', kind: 'browser' },
  { pattern: '^opera', name: 'Opera', kind: 'browser' },
  // Firefox registers under a 16-character hash of its install folder.
  { pattern: 'firefox|mozilla|^[0-9a-f]{16}$', name: 'Firefox', kind: 'browser' },
  { pattern: '^arc([._!]|$)|thebrowsercompany', name: 'Arc', kind: 'browser' },
  { pattern: '^zen([._!]|$)|floorp|librewolf|waterfox|thorium|yandex', name: 'Browser', kind: 'browser' },
  // Not music: listed only so the Players menu can show a friendly name.
  { pattern: 'discord', name: 'Discord', kind: 'other' },
  { pattern: 'msteams|teams', name: 'Teams', kind: 'other' },
  { pattern: '^steam|valve', name: 'Steam', kind: 'other' },
  { pattern: 'whatsapp', name: 'WhatsApp', kind: 'other' },
  { pattern: 'telegram', name: 'Telegram', kind: 'other' },
  { pattern: 'slack', name: 'Slack', kind: 'other' },
  { pattern: 'zoom', name: 'Zoom', kind: 'other' },
  { pattern: 'xbox|gamebar', name: 'Xbox', kind: 'other' },
  { pattern: 'epicgames', name: 'Epic Games', kind: 'other' },
  { pattern: 'battle\\.net', name: 'Battle.net', kind: 'other' },
  { pattern: 'obs', name: 'OBS', kind: 'other' },
  { pattern: 'msedgewebview2', name: 'Web app', kind: 'other' }
]

const COMPILED = KNOWN_PLAYERS.map((player) => ({ ...player, regex: new RegExp(player.pattern, 'i') }))

function fallbackName(appId: string): string {
  let name = appId.split('!').pop() ?? appId
  name = name.split('\\').pop() ?? name
  name = name.replace(/\.exe$/i, '')
  if (name.includes('_')) name = name.split('_')[0]
  if (name.includes('.')) name = name.split('.').pop() ?? name
  return name.length > 0 ? name.charAt(0).toUpperCase() + name.slice(1) : 'Media'
}

export function classifyPlayer(appId: string): { name: string; kind: PlayerKind } {
  const id = appId.trim()
  if (!id) return { name: 'Media', kind: 'other' }
  const known = COMPILED.find((player) => player.regex.test(id))
  return known ? { name: known.name, kind: known.kind } : { name: fallbackName(id), kind: 'other' }
}

export function appDisplayName(appId: string): string {
  return classifyPlayer(appId).name
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Allow/block patterns for the media bridge. An empty block pattern blocks nothing. */
export function playerPatterns(filter: PlayerFilter): { allow: string; block: string } {
  const allow = KNOWN_PLAYERS.filter((p) => p.kind === 'music' || (filter.browsers && p.kind === 'browser')).map(
    (p) => `(?:${p.pattern})`
  )
  for (const id of filter.allowed) allow.push(`^${escapeRegExp(id)}$`)
  const block = filter.blocked.map((id) => `^${escapeRegExp(id)}$`)
  return { allow: allow.join('|'), block: block.join('|') }
}

export function isPlayerAllowed(appId: string, filter: PlayerFilter): boolean {
  const { allow, block } = playerPatterns(filter)
  if (block && new RegExp(block, 'i').test(appId)) return false
  return new RegExp(allow, 'i').test(appId)
}

/** Flips one player on or off, keeping the lists minimal. */
export function togglePlayer(filter: PlayerFilter, appId: string): PlayerFilter {
  const onNow = isPlayerAllowed(appId, filter)
  const onByDefault = isPlayerAllowed(appId, { ...filter, allowed: [], blocked: [] })
  const allowed = filter.allowed.filter((id) => id !== appId)
  const blocked = filter.blocked.filter((id) => id !== appId)
  if (onNow && onByDefault) blocked.push(appId)
  if (!onNow && !onByDefault) allowed.push(appId)
  return { ...filter, allowed, blocked }
}

export function sanitizePlayerFilter(input: unknown): PlayerFilter {
  const raw = (typeof input === 'object' && input !== null ? input : {}) as Partial<PlayerFilter>
  const ids = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length < 300).slice(0, 60)
      : []
  return {
    browsers: typeof raw.browsers === 'boolean' ? raw.browsers : DEFAULT_PLAYER_FILTER.browsers,
    allowed: ids(raw.allowed),
    blocked: ids(raw.blocked)
  }
}
