import type { EqSettings, EqUserPreset } from './types'

/** Centre frequencies (Hz) of the 10 equalizer bands. */
export const EQ_BANDS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const
/** Q of every peaking filter: roughly one octave wide, so neighbouring bands blend smoothly. */
export const EQ_Q = 1.41
export const EQ_MIN_DB = -12
export const EQ_MAX_DB = 12
export const PREAMP_MIN_DB = -12
export const PREAMP_MAX_DB = 6

export interface EqPreset {
  id: string
  name: string
  gains: number[]
}

export const EQ_PRESETS: EqPreset[] = [
  { id: 'flat', name: 'Flat', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { id: 'bass-boost', name: 'Bass boost', gains: [6, 5.5, 4.5, 2.5, 0.5, 0, 0, 0, 0, 0] },
  { id: 'bass-cut', name: 'Less bass', gains: [-6, -5, -3.5, -1.5, 0, 0, 0, 0, 0, 0] },
  { id: 'treble-boost', name: 'Treble boost', gains: [0, 0, 0, 0, 0, 0.5, 2, 4, 5.5, 6] },
  { id: 'vocal', name: 'Vocal', gains: [-2, -2.5, -1.5, 0.5, 2.5, 3.5, 3.5, 2.5, 1, 0] },
  { id: 'rock', name: 'Rock', gains: [5, 4, 2.5, -0.5, -1.5, -0.5, 1.5, 3, 4, 4.5] },
  { id: 'pop', name: 'Pop', gains: [-1, 1, 2.5, 3.5, 3, 0.5, -0.5, -0.5, 1, 1.5] },
  { id: 'electronic', name: 'Electronic', gains: [5, 4.5, 1.5, 0, -1.5, 1, 0.5, 2, 4, 5] },
  { id: 'hip-hop', name: 'Hip-hop', gains: [5, 4.5, 2, 2.5, -0.5, -1, 1, -0.5, 1.5, 2.5] },
  { id: 'jazz', name: 'Jazz', gains: [3, 2, 1, 2, -1, -1, 0, 1, 2, 3] },
  { id: 'classical', name: 'Classical', gains: [4, 3, 2, 1, -1, -1, 0, 2, 3, 4] },
  { id: 'acoustic', name: 'Acoustic', gains: [3, 3, 2, 1, 1.5, 1.5, 2.5, 3, 2.5, 1.5] },
  { id: 'loudness', name: 'Loudness', gains: [6, 4, 0, 0, -1.5, 0, -1, -2, 3.5, 1.5] },
  { id: 'laptop', name: 'Laptop speakers', gains: [-4, -2, 1, 2.5, 2, 1, 1.5, 2.5, 3, 2] }
]

export const DEFAULT_EQ: EqSettings = {
  enabled: true,
  target: 'music',
  gains: [...EQ_PRESETS[0].gains],
  preamp: 0,
  presetId: 'flat',
  userPresets: []
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function roundHalf(value: number): number {
  return Math.round(value * 2) / 2
}

export function sanitizeGains(gains: unknown): number[] {
  const list = Array.isArray(gains) ? gains : []
  return EQ_BANDS.map((_, i) => roundHalf(clamp(finite(list[i], 0), EQ_MIN_DB, EQ_MAX_DB)))
}

/** Normalises anything that claims to be EQ settings (from disk or IPC) into a valid object. */
export function sanitizeEq(input: unknown): EqSettings {
  const raw = (typeof input === 'object' && input !== null ? input : {}) as Partial<EqSettings>
  const userPresets: EqUserPreset[] = Array.isArray(raw.userPresets)
    ? raw.userPresets
        .filter((p): p is EqUserPreset => typeof p === 'object' && p !== null && typeof p.id === 'string')
        .slice(0, 24)
        .map((p) => ({
          id: String(p.id).slice(0, 40),
          name: String(p.name ?? 'My preset').slice(0, 40),
          gains: sanitizeGains(p.gains)
        }))
    : []
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_EQ.enabled,
    target: raw.target === 'device' || raw.target === 'music' ? raw.target : DEFAULT_EQ.target,
    gains: sanitizeGains(raw.gains),
    preamp: roundHalf(clamp(finite(raw.preamp, 0), PREAMP_MIN_DB, PREAMP_MAX_DB)),
    presetId: typeof raw.presetId === 'string' ? raw.presetId.slice(0, 40) : 'custom',
    userPresets
  }
}

/** Magnitude (dB) at `freq` of an RBJ-cookbook peaking filter — the same filter Equalizer APO uses for "PK". */
export function peakingResponseDb(freq: number, centre: number, gainDb: number, q: number, sampleRate = 48000): number {
  if (gainDb === 0) return 0
  const a = Math.pow(10, gainDb / 40)
  const w0 = (2 * Math.PI * centre) / sampleRate
  const alpha = Math.sin(w0) / (2 * q)
  const cosW0 = Math.cos(w0)
  const b0 = 1 + alpha * a
  const b1 = -2 * cosW0
  const b2 = 1 - alpha * a
  const a0 = 1 + alpha / a
  const a1 = -2 * cosW0
  const a2 = 1 - alpha / a
  const w = (2 * Math.PI * freq) / sampleRate
  const c1 = Math.cos(w)
  const s1 = Math.sin(w)
  const c2 = Math.cos(2 * w)
  const s2 = Math.sin(2 * w)
  const numRe = b0 + b1 * c1 + b2 * c2
  const numIm = -(b1 * s1 + b2 * s2)
  const denRe = a0 + a1 * c1 + a2 * c2
  const denIm = -(a1 * s1 + a2 * s2)
  return 10 * Math.log10((numRe * numRe + numIm * numIm) / (denRe * denRe + denIm * denIm))
}

/** Combined response (dB) of all bands at `freq`, without preamp. */
export function eqResponseDb(freq: number, gains: readonly number[]): number {
  let total = 0
  for (let i = 0; i < EQ_BANDS.length; i++) {
    total += peakingResponseDb(freq, EQ_BANDS[i], gains[i] ?? 0, EQ_Q)
  }
  return total
}

/** Log-spaced frequencies between `min` and `max` (inclusive). */
export function logFrequencies(count: number, min = 20, max = 20000): number[] {
  const out: number[] = []
  const ratio = Math.log(max / min)
  for (let i = 0; i < count; i++) out.push(min * Math.exp((ratio * i) / (count - 1)))
  return out
}

const RESPONSE_PROBES = logFrequencies(160)

/** Highest boost anywhere in the audible range. Overlapping bands can add up past a single slider. */
export function peakBoostDb(gains: readonly number[]): number {
  let peak = 0
  for (const f of RESPONSE_PROBES) peak = Math.max(peak, eqResponseDb(f, gains))
  return peak
}

/** Preamp actually written to Equalizer APO: the user's preamp plus enough headroom to avoid clipping. */
export function effectivePreampDb(eq: Pick<EqSettings, 'gains' | 'preamp'>): number {
  const headroom = -peakBoostDb(eq.gains)
  return Math.round((eq.preamp + headroom) * 10) / 10
}

function formatHz(freq: number): string {
  return Number.isInteger(freq) ? String(freq) : freq.toFixed(1)
}

/** Text for the Equalizer APO include file. */
/** `bypass` explains why the file is flat even though the equalizer is on (e.g. music-only mode). */
export function buildApoConfig(eq: EqSettings, presetName: string, bypass: string | null = null): string {
  const lines = [
    '# Music Overlayer equalizer',
    '# Written automatically by Music Overlayer. Changes made here will be overwritten.',
    `# Preset: ${presetName}`,
    ''
  ]
  if (!eq.enabled) {
    lines.push('# Equalizer is switched off in Music Overlayer.')
    return lines.join('\r\n') + '\r\n'
  }
  if (bypass) {
    lines.push(`# ${bypass.replace(/[\r\n]+/g, ' ').slice(0, 160)}`)
    return lines.join('\r\n') + '\r\n'
  }
  lines.push(`Preamp: ${effectivePreampDb(eq).toFixed(1)} dB`)
  EQ_BANDS.forEach((freq, i) => {
    const gain = eq.gains[i] ?? 0
    if (gain === 0) return
    lines.push(`Filter ${i + 1}: ON PK Fc ${formatHz(freq)} Hz Gain ${gain.toFixed(1)} dB Q ${EQ_Q.toFixed(2)}`)
  })
  return lines.join('\r\n') + '\r\n'
}

export function presetName(eq: EqSettings): string {
  const builtIn = EQ_PRESETS.find((p) => p.id === eq.presetId)
  if (builtIn) return builtIn.name
  const user = eq.userPresets.find((p) => p.id === eq.presetId)
  return user ? user.name : 'Custom'
}

export function formatBand(freq: number): string {
  return freq >= 1000 ? `${freq / 1000}k` : String(freq)
}
