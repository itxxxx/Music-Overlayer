import * as RadixSlider from '@radix-ui/react-slider'
import { animate, motion, useMotionValue, useMotionValueEvent, useTransform } from 'framer-motion'
import { useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** Pulled past an end, the track stretches towards this many pixels, easing off as it goes. */
const MAX_OVERFLOW = 16
/** Under the pointer the slider grows a little (the card leaves no room for more). */
const HOVER_SCALE = 1.06
/** Track thickness at rest and while hovered. */
const TRACK_HEIGHT: [number, number] = [6, 10]

type Region = 'left' | 'middle' | 'right'

export interface SliderProps {
  value: number
  min?: number
  max: number
  step?: number
  /** While dragging (the value under the pointer). */
  onChange(value: number): void
  /** Once, when the pointer lets go (or a keyboard step). */
  onCommit?(value: number): void
  /** For screen readers (and tests): the slider's name and how to read its value. */
  label: string
  valueText?: string
  /** At each end, usually an icon (or a button). It bounces when the track is pulled past it. */
  start: ReactNode
  end: ReactNode
  /** The filled part's look: a colour, or a gradient. */
  rangeStyle?: CSSProperties
  /** Drawn on the track (a notch, say), positioned in percent of its width. */
  marks?: ReactNode
  /** Floats above the slider's position while it's hovered or dragged (the value, say). */
  bubble?: ReactNode
  className?: string
}

/**
 * An elastic slider: it grows under the pointer, and dragging past either end stretches the
 * track and pushes that end's icon out, springing back on release.
 */
export function Slider({ value, min = 0, max, step = 1, onChange, onCommit, label, valueText, start, end, rangeStyle, marks, bubble, className }: SliderProps) {
  const [region, setRegion] = useState<Region>('middle')
  const clientX = useMotionValue(0)
  const overflow = useMotionValue(0)
  /** -1 past the left end, 1 past the right, 0 on the track (for the icons' push). */
  const side = useMotionValue(0)
  const scale = useMotionValue(1)
  const ref = useRef<HTMLSpanElement>(null)
  const dragging = useRef(false)
  const last = useRef(value)

  useMotionValueEvent(clientX, 'change', (latest) => {
    const root = ref.current
    if (!root) return
    const { left, right } = root.getBoundingClientRect()
    let past = 0
    let next: Region = 'middle'
    if (latest < left) {
      next = 'left'
      past = left - latest
    } else if (latest > right) {
      next = 'right'
      past = latest - right
    }
    setRegion(next)
    side.jump(next === 'left' ? -1 : next === 'right' ? 1 : 0)
    overflow.jump(decay(past, MAX_OVERFLOW))
  })

  const opacity = useTransform(scale, [1, HOVER_SCALE], [0.78, 1])
  const bubbleOpacity = useTransform(scale, [1, HOVER_SCALE], [0, 1])
  const startX = useTransform(() => (side.get() < 0 ? -overflow.get() / scale.get() : 0))
  const endX = useTransform(() => (side.get() > 0 ? overflow.get() / scale.get() : 0))
  const scaleX = useTransform(() => {
    const width = ref.current?.getBoundingClientRect().width
    return width ? 1 + overflow.get() / width : 1
  })
  const scaleY = useTransform(overflow, [0, MAX_OVERFLOW], [1, 0.8])
  const transformOrigin = useTransform(() => {
    const rect = ref.current?.getBoundingClientRect()
    if (!rect) return 'center'
    return clientX.get() < rect.left + rect.width / 2 ? 'right' : 'left'
  })
  const height = useTransform(scale, [1, HOVER_SCALE], TRACK_HEIGHT)
  const margin = useTransform(scale, [1, HOVER_SCALE], [0, -(TRACK_HEIGHT[1] - TRACK_HEIGHT[0]) / 2])

  const finish = () => {
    if (!dragging.current) return
    dragging.current = false
    animate(overflow, 0, { type: 'spring', bounce: 0.5 })
    side.jump(0)
    setRegion('middle')
    onCommit?.(last.current)
  }

  return (
    <motion.div
      onHoverStart={() => void animate(scale, HOVER_SCALE)}
      onHoverEnd={() => void animate(scale, 1)}
      onTouchStart={() => void animate(scale, HOVER_SCALE)}
      onTouchEnd={() => void animate(scale, 1)}
      style={{ scale, opacity }}
      className={cn('flex min-w-0 flex-1 touch-none select-none items-center gap-2', className)}
    >
      <motion.div
        className="shrink-0"
        animate={{ scale: region === 'left' ? [1, 1.4, 1] : 1, transition: { duration: 0.25 } }}
        style={{ x: startX }}
      >
        {start}
      </motion.div>

      <RadixSlider.Root
        ref={ref}
        data-no-drag
        data-slot="slider"
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={([next]) => {
          last.current = next
          onChange(next)
        }}
        // Keyboard steps; a drag commits once when the pointer lets go (finish).
        onValueCommit={([next]) => {
          if (!dragging.current) onCommit?.(next)
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          dragging.current = true
          last.current = value
          clientX.jump(event.clientX)
        }}
        onPointerMove={(event) => {
          if (event.buttons > 0) clientX.jump(event.clientX)
        }}
        onLostPointerCapture={finish}
        className="relative flex min-w-0 grow cursor-grab touch-none select-none items-center py-2.5 active:cursor-grabbing"
      >
        <motion.div style={{ scaleX, scaleY, transformOrigin, height, marginTop: margin, marginBottom: margin }} className="flex grow">
          <RadixSlider.Track className="relative isolate h-full grow overflow-hidden rounded-full bg-white/18">
            <RadixSlider.Range className="absolute h-full rounded-full" style={rangeStyle} />
            {marks}
          </RadixSlider.Track>
        </motion.div>
        <RadixSlider.Thumb aria-label={label} aria-valuetext={valueText} className="relative block size-0 outline-none">
          {bubble && (
            <motion.span
              style={{ opacity: bubbleOpacity }}
              className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-black/70 px-1.5 py-px text-[10.5px] font-bold tabular-nums leading-4 ring-1 ring-inset ring-white/10"
              aria-hidden
            >
              {bubble}
            </motion.span>
          )}
        </RadixSlider.Thumb>
      </RadixSlider.Root>

      <motion.div
        className="shrink-0"
        animate={{ scale: region === 'right' ? [1, 1.4, 1] : 1, transition: { duration: 0.25 } }}
        style={{ x: endX }}
      >
        {end}
      </motion.div>
    </motion.div>
  )
}

/** Eases a distance off towards `max` (a sigmoid), so pulling further gives less and less. */
function decay(value: number, max: number): number {
  if (max === 0) return 0
  const entry = value / max
  const sigmoid = 2 * (1 / (1 + Math.exp(-entry)) - 0.5)
  return sigmoid * max
}
