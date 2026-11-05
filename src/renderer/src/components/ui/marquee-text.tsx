import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { cn } from '@/lib/utils'

interface MarqueeTextProps {
  text: string
  /** Scroll only while it can be seen; a hidden marquee would keep the GPU busy for nothing. */
  active?: boolean
  className?: string
}

/** One line of text that slowly scrolls back and forth when it doesn't fit. */
export function MarqueeText({ text, active = true, className }: MarqueeTextProps) {
  const outer = useRef<HTMLDivElement>(null)
  const inner = useRef<HTMLSpanElement>(null)
  const [overflow, setOverflow] = useState(0)

  useLayoutEffect(() => {
    const measure = () => {
      const box = outer.current
      const content = inner.current
      if (!box || !content) return
      const extra = content.scrollWidth - box.clientWidth
      setOverflow(extra > 2 ? extra : 0)
    }
    measure()
    const observer = new ResizeObserver(measure)
    if (outer.current) observer.observe(outer.current)
    return () => observer.disconnect()
  }, [text])

  const style: CSSProperties | undefined = overflow && active
    ? ({
        animation: `marquee ${Math.max(7, overflow / 18 + 5).toFixed(1)}s ease-in-out infinite alternate`,
        '--marquee-distance': `-${overflow}px`
      } as CSSProperties)
    : undefined

  return (
    <div
      ref={outer}
      title={text}
      className={cn('overflow-hidden whitespace-nowrap', className)}
      style={
        overflow
          ? {
              maskImage: 'linear-gradient(90deg, transparent 0, #000 10px, #000 calc(100% - 10px), transparent 100%)',
              paddingInline: 10
            }
          : undefined
      }
    >
      <span ref={inner} className="inline-block" style={style}>
        {text}
      </span>
    </div>
  )
}
