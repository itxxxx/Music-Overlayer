import { CoverArt } from '@/components/ui/cover-art'
import { VisualizerBars } from '@/components/ui/visualizer-bars'
import type { Palette } from '@/lib/palette'
import { cn } from '@/lib/utils'

interface NowPlayingPillProps {
  title: string
  subtitle: string
  cover: string | null
  palette: Palette
  visualizerActive: boolean
  muted?: boolean
  className?: string
}

/** The compact, always-visible state: artwork, title, artist and a few live bars. */
export function NowPlayingPill({ title, subtitle, cover, palette, visualizerActive, muted, className }: NowPlayingPillProps) {
  return (
    <div className={cn('flex h-14 items-center gap-3 pl-2 pr-[18px]', className)}>
      <CoverArt src={cover} className="size-10 rounded-[12px]" iconClassName="size-[18px]" />
      <div className="min-w-0 flex-1">
        <p className={cn('truncate text-[14px] font-bold leading-[18px] tracking-[-0.005em]', muted ? 'text-white/80' : 'text-white')}>
          {title}
        </p>
        <p className="truncate text-[12.5px] font-semibold leading-[17px] text-white/55">{subtitle}</p>
      </div>
      <VisualizerBars
        count={5}
        active={visualizerActive}
        minHz={60}
        maxHz={9000}
        floor={0.16}
        className="h-[22px] w-[29px] shrink-0 gap-[3px]"
        barClassName="w-[3.4px] rounded-full"
        barStyle={{ background: palette.tint }}
      />
    </div>
  )
}
