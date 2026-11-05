import { useEffect, useRef } from 'react'
import { audioLevels, bandEdges, readBands } from '@/lib/audio-levels'
import { cn } from '@/lib/utils'

interface VisualizerBarsProps {
  count: number
  /** Animate with the audio. When false the bars settle to `floor` and drawing stops. */
  active: boolean
  minHz?: number
  maxHz?: number
  /** Resting height, 0–1. */
  floor?: number
  /** Size and position of the canvas. */
  className?: string
  /** CSS colour of the bars. */
  color: string
  /** Space between bars, in CSS pixels. */
  gap?: number
  /** Width of each bar in CSS pixels. By default the bars share the full width. */
  barWidth?: number
  /** Fully rounded ends (pill-shaped bars). */
  round?: boolean
  radiusTop?: number
  radiusBottom?: number
}

/**
 * Bars drawn on a canvas straight from the audio frame loop: no React re-renders, no style or
 * layout work per frame, and nothing at all once the bars have settled.
 */
export function VisualizerBars({
  count,
  active,
  minHz = 45,
  maxHz = 14000,
  floor = 0.08,
  className,
  color,
  gap = 3,
  barWidth,
  round = false,
  radiusTop = 0,
  radiusBottom = 0
}: VisualizerBarsProps) {
  const boxRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const colorRef = useRef(color)
  const redraw = useRef<() => void>(() => undefined)
  // Kept across effect runs, so pausing settles from where the bars are.
  const levelsRef = useRef<Float32Array | null>(null)

  colorRef.current = color
  useEffect(() => redraw.current(), [color])

  useEffect(() => {
    const box = boxRef.current
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!box || !canvas || !context) return
    if (!levelsRef.current || levelsRef.current.length !== count) levelsRef.current = new Float32Array(count)
    const levels = levelsRef.current
    let width = 0
    let height = 0
    let scale = 1

    const draw = (): void => {
      if (width <= 0 || height <= 0) return
      context.setTransform(scale, 0, 0, scale, 0, 0)
      context.clearRect(0, 0, width, height)
      context.fillStyle = colorRef.current
      const bar = barWidth ?? Math.max(1, (width - gap * (count - 1)) / count)
      const left = (width - (bar * count + gap * (count - 1))) / 2
      context.beginPath()
      for (let i = 0; i < count; i++) {
        const h = Math.max(floor, Math.min(1, levels[i])) * height
        const limit = Math.min(bar / 2, h / 2)
        const top = round ? limit : Math.min(radiusTop, limit)
        const bottom = round ? limit : Math.min(radiusBottom, limit)
        context.roundRect(left + i * (bar + gap), height - h, bar, h, [top, top, bottom, bottom])
      }
      context.fill()
    }
    redraw.current = draw

    const resize = (): void => {
      // The box sets the size; a canvas's own size would follow its pixel count.
      scale = window.devicePixelRatio || 1
      width = box.clientWidth
      height = box.clientHeight
      canvas.width = Math.max(1, Math.round(width * scale))
      canvas.height = Math.max(1, Math.round(height * scale))
      draw()
    }
    const observer = new ResizeObserver(resize)
    observer.observe(box)
    resize()

    let frame = 0
    let unsubscribe: (() => void) | null = null
    if (active) {
      const edges = bandEdges(count, minHz, maxHz)
      const target = new Float32Array(count)
      unsubscribe = audioLevels.subscribe((spectrum) => {
        readBands(spectrum, edges, target)
        for (let i = 0; i < count; i++) {
          const rate = target[i] > levels[i] ? 0.55 : 0.12
          levels[i] += (target[i] - levels[i]) * rate
        }
        draw()
      })
    } else {
      const settle = (): void => {
        let moving = false
        for (let i = 0; i < count; i++) {
          levels[i] = levels[i] > 0.004 ? levels[i] * 0.82 : 0
          if (levels[i] > 0) moving = true
        }
        draw()
        frame = moving ? requestAnimationFrame(settle) : 0
      }
      settle()
    }

    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
      unsubscribe?.()
      redraw.current = () => undefined
    }
  }, [active, count, minHz, maxHz, floor, gap, barWidth, round, radiusTop, radiusBottom])

  return (
    <div ref={boxRef} className={className} aria-hidden>
      <canvas ref={canvasRef} className={cn('block h-full w-full')} />
    </div>
  )
}
