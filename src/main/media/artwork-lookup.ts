import { net } from 'electron'

/**
 * Finds album art online for players that don't share any, by title and artist, using Apple's
 * public iTunes Search API. Only used when the player has no artwork and the user hasn't
 * turned "Find missing covers online" off.
 */

const SEARCH_URL = 'https://itunes.apple.com/search'
const TIMEOUT_MS = 6000
/** At most one search every few seconds, however fast tracks change. */
const MIN_GAP_MS = 2500
const CACHE_SIZE = 80
const MAX_IMAGE_BYTES = 2_000_000

export interface TrackQuery {
  title: string
  artist: string
  album: string
}

interface SearchResult {
  trackName?: string
  artistName?: string
  collectionName?: string
  artworkUrl100?: string
}

/** Lower case, no accents, no "(feat. ...)", "[Official Video]", " - Topic" or punctuation. */
export function normalizeForMatch(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+-\s+topic$/, '')
    .replace(/[([{][^)\]}]*[)\]}]/g, ' ')
    .replace(/\s+-\s+(remaster(ed)?|live|radio edit|single version|official|lyrics?|audio|video)\b.*$/, ' ')
    .replace(/\b(feat|ft|featuring)\.?\s.*$/, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** True when two names are the same once normalized, or one contains the other. */
export function namesMatch(a: string, b: string): boolean {
  const x = normalizeForMatch(a)
  const y = normalizeForMatch(b)
  if (!x || !y) return false
  if (x === y) return true
  const [short, long] = x.length <= y.length ? [x, y] : [y, x]
  return short.length >= 3 && (` ${long} `.includes(` ${short} `))
}

/** Picks the result that really is this track (or at least this artist's album), or null. */
export function pickResult(results: SearchResult[], query: TrackQuery): SearchResult | null {
  const usable = results.filter((r) => typeof r.artworkUrl100 === 'string' && r.artworkUrl100.startsWith('https://'))
  const byArtist = (r: SearchResult): boolean => Boolean(query.artist) && namesMatch(r.artistName ?? '', query.artist)
  return (
    usable.find((r) => byArtist(r) && namesMatch(r.trackName ?? '', query.title)) ??
    (query.album ? usable.find((r) => byArtist(r) && namesMatch(r.collectionName ?? '', query.album)) : undefined) ??
    null
  )
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class ArtworkLookup {
  private readonly cache = new Map<string, string | null>()
  private readonly pending = new Map<string, Promise<string | null>>()
  private lastRequestAt = 0

  /** A data: URL of the artwork, or null when nothing reliable was found. */
  find(query: TrackQuery): Promise<string | null> {
    const title = query.title.trim()
    const artist = query.artist.trim()
    if (!title || !artist) return Promise.resolve(null)
    const key = `${normalizeForMatch(artist)}|${normalizeForMatch(title)}`
    if (this.cache.has(key)) {
      const hit = this.cache.get(key) ?? null
      // Keep recently used entries at the end, so the oldest are dropped first.
      this.cache.delete(key)
      this.cache.set(key, hit)
      return Promise.resolve(hit)
    }
    const running = this.pending.get(key)
    if (running) return running
    const search = this.search({ title, artist, album: query.album.trim() })
      .catch((error: unknown) => {
        console.info('[covers] online lookup failed:', error instanceof Error ? error.message : error)
        return null
      })
      .then((result) => {
        this.pending.delete(key)
        this.cache.set(key, result)
        while (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value as string)
        return result
      })
    this.pending.set(key, search)
    return search
  }

  private async request(url: string): Promise<Response> {
    const wait = this.lastRequestAt + MIN_GAP_MS - Date.now()
    if (wait > 0) await delay(wait)
    this.lastRequestAt = Date.now()
    const response = await net.fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { Accept: 'application/json, image/*' } })
    if (!response.ok) throw new Error(`the server answered ${response.status}`)
    return response
  }

  private async search(query: TrackQuery): Promise<string | null> {
    const term = `${query.artist.replace(/\s+-\s+Topic$/i, '')} ${query.title}`.slice(0, 150)
    const url = `${SEARCH_URL}?term=${encodeURIComponent(term)}&media=music&entity=song&limit=10`
    const data = (await (await this.request(url)).json()) as { results?: SearchResult[] }
    const match = pickResult(Array.isArray(data.results) ? data.results : [], query)
    if (!match?.artworkUrl100) return null

    const imageUrl = match.artworkUrl100.replace(/\/\d+x\d+(bb)?\.(jpg|png|webp)$/i, '/300x300bb.jpg')
    const image = await net.fetch(imageUrl, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    const type = image.headers.get('content-type') ?? ''
    if (!image.ok || !type.startsWith('image/')) return null
    const bytes = Buffer.from(await image.arrayBuffer())
    if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return null
    return `data:${type.split(';')[0]};base64,${bytes.toString('base64')}`
  }
}
