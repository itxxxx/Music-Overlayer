import { useId, useMemo } from 'react'
import { EQ_BANDS, EQ_MAX_DB, EQ_MIN_DB, eqResponseDb } from '../../../../shared/eq'
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

const FIRST = Math.log2(EQ_BANDS[0])
const LAST = Math.log2(EQ_BANDS[EQ_BANDS.length - 1])

/**
 * The equalizer's real combined frequency response (the same peaking filters Equalizer APO
 * runs), drawn behind the sliders on the same frequency and dB scale.
 */
export function ResponseCurve({ gains, edgeInset, verticalInset, width, height, tint, dimmed, className }: ResponseCurveProps) {
  const gradientId = `eq-fill-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const { line, area, zeroY } = useMemo(() => {
    const travel = height - verticalInset * 2
    const toY = (db: number) => verticalInset + (1 - (db - EQ_MIN_DB) / (EQ_MAX_DB - EQ_MIN_DB)) * travel
    const xSpan = width - edgeInset * 2
    const points: string[] = []
    for (let x = 0; x <= width; x += 3) {
      const octave = FIRST + ((x - edgeInset) / xSpan) * (LAST - FIRST)
      const freq = Math.min(22000, Math.max(16, Math.pow(2, octave)))
      const db = Math.max(EQ_MIN_DB, Math.min(EQ_MAX_DB, eqResponseDb(freq, gains)))
      points.push(`${x.toFixed(1)},${toY(db).toFixed(2)}`)
    }
    const zero = toY(0)
    return {
      line: `M${points.join(' L')}`,
      area: `M0,${zero} L${points.join(' L')} L${width},${zero} Z`,
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
