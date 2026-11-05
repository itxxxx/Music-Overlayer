import { useEffect, useRef, type CSSProperties } from 'react'
import { audioLevels, bandEdges, readBands } from '@/lib/audio-levels'
import { cn } from '@/lib/utils'

interface VisualizerBarsProps {
  count: number
  /** Animate with the audio. When false the bars settle to `floor`. */
  active: boolean
  minHz?: number
  maxHz?: number
  /** Resting height, 0–1. */
  floor?: number
  className?: string
  barClassName?: string
  barStyle?: CSSProperties
}

/** Bars driven straight from the audio frame loop, without React re-renders. */
export function VisualizerBars({
  count,
  active,
  minHz = 45,
  maxHz = 14000,
  floor = 0.08,
  className,
  barClassName,
  barStyle
}: VisualizerBarsProps) {
  const container = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const root = container.current
    if (!root) return
    const bars = Array.from(root.children) as HTMLElement[]
    const paint = (levels: ArrayLike<number>) => {
      for (let i = 0; i < bars.length; i++) {
        bars[i].style.height = `${(Math.max(floor, Math.min(1, levels[i] ?? 0)) * 100).toFixed(2)}%`
      }
    }
    if (!active) {
      bars.forEach((bar) => (bar.style.transition = 'height 420ms ease-out'))
      paint(new Float32Array(count))
      return
    }
    bars.forEach((bar) => (bar.style.transition = 'none'))
    const edges = bandEdges(count, minHz, maxHz)
    const target = new Float32Array(count)
    const smooth = new Float32Array(count)
    return audioLevels.subscribe((frame) => {
      readBands(frame, edges, target)
      for (let i = 0; i < count; i++) {
        const rate = target[i] > smooth[i] ? 0.55 : 0.12
        smooth[i] += (target[i] - smooth[i]) * rate
      }
      paint(smooth)
    })
  }, [active, count, minHz, maxHz, floor])

  return (
    <div ref={container} className={cn('flex items-end', className)} aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <span key={i} className={cn('block', barClassName)} style={{ height: `${floor * 100}%`, ...barStyle }} />
      ))}
    </div>
  )
}
