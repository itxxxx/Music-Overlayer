export function formatTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const ss = seconds.toString().padStart(2, '0')
  return hours > 0 ? `${hours}:${minutes.toString().padStart(2, '0')}:${ss}` : `${minutes}:${ss}`
}

export function formatDb(value: number): string {
  const rounded = Math.round(value * 10) / 10
  if (rounded === 0) return '0 dB'
  return `${rounded > 0 ? '+' : '−'}${Math.abs(rounded).toFixed(1)} dB`
}
