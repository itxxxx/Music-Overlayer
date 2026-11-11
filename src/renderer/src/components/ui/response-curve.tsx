import { useId, useMemo } from 'react'
import { EQ_MAX_DB, EQ_MIN_DB } from '../../../../shared/eq'
import { cn } from '@/lib/utils'

interface ResponseCurveProps {
  gains: readonly number[]
  /** Horizontal distance from the box edge to the first/last band's slider centre. */
  edgeInset: number
  /** Vertical inset that matches the sliders' thumb travel. */
  verticalInset: number
  width: number
  height: number
  tint: string
  dimmed?: boolean
  className?: string
}

/**
 * A smooth curve through the sliders' handles, behind them, on the same dB scale: what you set,
 * at a glance. It goes exactly through every handle without overshooting between them (a
 * monotone cubic), and runs on flat past the first and last band, so the same level on every
 * band is a straight line.
 */
export function ResponseCurve({ gains, edgeInset, verticalInset, width, height, tint, dimmed, className }: ResponseCurveProps) {
  const gradientId = `eq-fill-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const { line, area, zeroY } = useMemo(() => {
    const travel = height - verticalInset * 2
    const toY = (db: number) => verticalInset + (1 - (db - EQ_MIN_DB) / (EQ_MAX_DB - EQ_MIN_DB)) * travel
    // The handles: one per band, spread like the sliders (evenly, centre to centre).
    const count = gains.length
    const gap = count > 1 ? (width - edgeInset * 2) / (count - 1) : 0
    const xs = gains.map((_, i) => edgeInset + i * gap)
    const ys = gains.map((db) => toY(Math.max(EQ_MIN_DB, Math.min(EQ_MAX_DB, db))))
    const slopes = monotoneSlopes(ys, gap)
    const f = (n: number) => n.toFixed(2)
    // Flat from the left edge to the first handle, cubic pieces between handles, flat to the right edge.
    let path = `M0,${f(ys[0] ?? toY(0))} L${f(xs[0] ?? 0)},${f(ys[0] ?? toY(0))}`
    for (let i = 0; i < count - 1; i++) {
      const third = gap / 3
      path += ` C${f(xs[i] + third)},${f(ys[i] + slopes[i] * third)} ${f(xs[i + 1] - third)},${f(ys[i + 1] - slopes[i + 1] * third)} ${f(xs[i + 1])},${f(ys[i + 1])}`
    }
    path += ` L${f(width)},${f(ys[count - 1] ?? toY(0))}`
    const zero = toY(0)
    return {
      line: path,
      area: `${path} L${f(width)},${f(zero)} L0,${f(zero)} Z`,
      zeroY: zero
    }
  }, [gains, edgeInset, verticalInset, width, height])

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cn('pointer-events-none transition-opacity duration-300', dimmed && 'opacity-35', className)}
      aria-hidden
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={tint} stopOpacity="0.32" />
          <stop offset="0.5" stopColor={tint} stopOpacity="0.06" />
          <stop offset="1" stopColor={tint} stopOpacity="0.32" />
        </linearGradient>
      </defs>
      <line x1="0" x2={width} y1={zeroY} y2={zeroY} stroke="white" strokeOpacity="0.14" strokeDasharray="2 4" />
      <path d={area} fill={`url(#${gradientId})`} />
      <path d={line} fill="none" stroke={tint} strokeOpacity="0.9" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

/**
 * Slopes at each point for a monotone cubic through evenly spaced points (Fritsch-Carlson): flat
 * at a peak, a dip or a level stretch, and never steep enough to overshoot. Flat at both ends,
 * where the curve carries on level.
 */
function monotoneSlopes(ys: readonly number[], gap: number): number[] {
  const n = ys.length
  const slopes = new Array<number>(n).fill(0)
  if (n < 3 || gap <= 0) return slopes
  const secants = ys.slice(1).map((y, i) => (y - ys[i]) / gap)
  for (let i = 1; i < n - 1; i++) {
    const before = secants[i - 1]
    const after = secants[i]
    // Equal spacing: the harmonic mean of the two secants, or flat where they disagree.
    slopes[i] = before * after <= 0 ? 0 : (2 * before * after) / (before + after)
  }
  return slopes
}
