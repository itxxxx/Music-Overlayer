import { ChevronLeft, LoaderCircle, Plus, RefreshCw, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { EQ_BANDS, EQ_MAX_DB, EQ_MIN_DB, EQ_PRESETS, PREAMP_MAX_DB, PREAMP_MIN_DB, formatBand } from '../../../../shared/eq'
import { RangeSlider } from '@/components/ui/range-slider'
import { ResponseCurve } from '@/components/ui/response-curve'
import { Switch } from '@/components/ui/switch'
import { useEqualizer } from '@/hooks/use-equalizer'
import { formatDb } from '@/lib/format'
import type { Palette } from '@/lib/palette'
import { cn } from '@/lib/utils'

const BOX_WIDTH = 296
const BOX_PADDING_X = 8
const SLIDER_WIDTH = 22
const SLIDER_AREA_HEIGHT = 132
const THUMB_RADIUS = 7

interface EqualizerViewProps {
  palette: Palette
  onBack(): void
}

function StatusAction({ onClick, children }: { onClick(): void; children: ReactNode }) {
  return (
    <button
      type="button"
      data-no-drag
      onClick={onClick}
      className="flex h-6 shrink-0 items-center gap-1 rounded-full bg-white/12 px-2.5 text-[11.5px] font-bold text-white transition-colors hover:bg-white/20"
    >
      {children}
    </button>
  )
}

export function EqualizerView({ palette, onBack }: EqualizerViewProps) {
  const equalizer = useEqualizer()
  const { eq, status, activePresetId } = equalizer
  const live = status.connected && !status.error

  let statusText: string
  let statusTone: 'live' | 'muted' | 'warn' | 'busy' = 'muted'
  let action: ReactNode = null
  if (!status.supported) {
    statusText = 'The equalizer works on Windows.'
  } else if (status.installing) {
    statusText = 'Setting up the equalizer. Follow the setup window and tick your speakers or headphones.'
    statusTone = 'busy'
  } else if (status.error) {
    statusText = status.error
    statusTone = 'warn'
    action = (
      <StatusAction onClick={() => void (status.installed ? equalizer.recheck() : equalizer.install())}>
        <RefreshCw className="size-3" strokeWidth={2.6} />
        Try again
      </StatusAction>
    )
  } else if (!status.installed) {
    statusText = 'One-time setup: installs the free audio engine that applies these bands.'
    statusTone = 'warn'
    action = <StatusAction onClick={() => void equalizer.install()}>Set up</StatusAction>
  } else if (!status.connected) {
    statusText = 'The equalizer is unlinked.'
    action = <StatusAction onClick={() => void equalizer.connect()}>Link</StatusAction>
  } else if (status.restartPending) {
    statusText = 'Restart Windows to finish setting up the equalizer.'
    statusTone = 'warn'
  } else if (eq.enabled) {
    statusText = 'Applied to everything you hear'
    statusTone = 'live'
  } else {
    statusText = 'Equalizer is off'
  }

  const userPresetIds = new Set(eq.userPresets.map((preset) => preset.id))
  const chips = [...EQ_PRESETS, ...eq.userPresets]

  return (
    <div className="flex flex-col p-3">
      <div className="flex h-9 items-center gap-2">
        <button
          type="button"
          data-no-drag
          onClick={onBack}
          aria-label="Back to player"
          title="Back to player"
          className="grid size-8 place-items-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/18"
        >
          <ChevronLeft className="size-[18px]" strokeWidth={2.6} />
        </button>
        <h2 className="flex-1 text-[15px] font-extrabold tracking-[-0.01em]">Equalizer</h2>
        <Switch
          checked={eq.enabled}
          onCheckedChange={equalizer.setEnabled}
          label={eq.enabled ? 'Turn equalizer off' : 'Turn equalizer on'}
          tint={palette.tint}
          tintInk={palette.tintInk}
        />
      </div>

      <div className="mt-1.5 flex min-h-7 items-center gap-2 pl-1">
        {statusTone === 'busy' ? (
          <LoaderCircle className="size-3.5 shrink-0 animate-spin text-white/80" strokeWidth={2.6} />
        ) : (
          <span
            className={cn(
              'size-1.5 shrink-0 rounded-full',
              statusTone === 'live' ? 'bg-emerald-300 shadow-[0_0_8px_rgb(110_231_183/0.8)]' : statusTone === 'warn' ? 'bg-amber-300' : 'bg-white/35'
            )}
          />
        )}
        <p className={cn('line-clamp-2 flex-1 text-[11.5px] font-semibold leading-[15px]', statusTone === 'warn' ? 'text-amber-100/90' : 'text-white/65')}>
          {statusText}
        </p>
        {action}
      </div>

      <div
        className="relative mt-2 rounded-[18px] bg-black/25 pb-1.5 pt-3 ring-1 ring-inset ring-white/[0.06]"
        style={{ width: BOX_WIDTH, paddingInline: BOX_PADDING_X }}
      >
        <ResponseCurve
          gains={eq.enabled ? eq.gains : EQ_BANDS.map(() => 0)}
          edgeInset={BOX_PADDING_X + SLIDER_WIDTH / 2}
          verticalInset={THUMB_RADIUS}
          width={BOX_WIDTH}
          height={SLIDER_AREA_HEIGHT}
          tint={palette.tint}
          dimmed={!eq.enabled || (!live && status.supported)}
          className="absolute left-0 top-3"
        />
        <div className="relative flex justify-between" style={{ height: SLIDER_AREA_HEIGHT }}>
          {EQ_BANDS.map((freq, index) => (
            <RangeSlider
              key={freq}
              label={`${formatBand(freq)} Hz`}
              value={eq.gains[index] ?? 0}
              min={EQ_MIN_DB}
              max={EQ_MAX_DB}
              format={formatDb}
              disabled={!eq.enabled}
              tint={palette.tint}
              onChange={(value) => equalizer.setGain(index, value)}
            />
          ))}
        </div>
        <div className="mt-1 flex justify-between text-[10px] font-bold tabular-nums text-white/45">
          {EQ_BANDS.map((freq) => (
            <span key={freq} className="text-center" style={{ width: SLIDER_WIDTH }}>
              {formatBand(freq)}
            </span>
          ))}
        </div>
      </div>

      <div className="mt-2.5 flex items-center gap-2.5 px-1">
        <span className="text-[12px] font-bold text-white/70">Preamp</span>
        <RangeSlider
          orientation="horizontal"
          label="Preamp"
          value={eq.preamp}
          min={PREAMP_MIN_DB}
          max={PREAMP_MAX_DB}
          format={formatDb}
          disabled={!eq.enabled}
          tint={palette.tint}
          onChange={equalizer.setPreamp}
          className="flex-1"
        />
        <span className="w-[52px] text-right text-[11.5px] font-bold tabular-nums text-white/70">{formatDb(eq.preamp)}</span>
      </div>

      <div
        className="scrollbar-none -mx-3 mt-2.5 flex gap-1.5 overflow-x-auto px-3"
        style={{ maskImage: 'linear-gradient(90deg, transparent 0, #000 12px, #000 calc(100% - 28px), transparent 100%)' }}
        onWheel={(event) => {
          event.currentTarget.scrollLeft += event.deltaY + event.deltaX
        }}
      >
        {activePresetId === 'custom' && (
          <>
            <span
              className="flex h-7 shrink-0 items-center rounded-full px-3 text-[12px] font-bold"
              style={{ background: palette.tint, color: palette.tintInk }}
            >
              Custom
            </span>
            <button
              type="button"
              data-no-drag
              onClick={equalizer.savePreset}
              className="flex h-7 shrink-0 items-center gap-1 rounded-full bg-white/10 px-2.5 text-[12px] font-bold text-white/85 transition-colors hover:bg-white/16"
            >
              <Plus className="size-3.5" strokeWidth={2.8} />
              Save
            </button>
          </>
        )}
        {chips.map((preset) => {
          const active = preset.id === activePresetId
          const removable = userPresetIds.has(preset.id)
          return (
            <span key={preset.id} className="group relative flex shrink-0">
              <button
                type="button"
                data-no-drag
                onClick={() => equalizer.applyPreset(preset.id)}
                className={cn(
                  'h-7 rounded-full px-3 text-[12px] font-bold transition-colors',
                  !active && 'bg-white/10 text-white/80 hover:bg-white/16 hover:text-white',
                  removable && 'pr-7'
                )}
                style={active ? { background: palette.tint, color: palette.tintInk } : undefined}
              >
                {preset.name}
              </button>
              {removable && (
                <button
                  type="button"
                  data-no-drag
                  aria-label={`Delete ${preset.name}`}
                  title={`Delete ${preset.name}`}
                  onClick={() => equalizer.deletePreset(preset.id)}
                  className="absolute right-1 top-1 grid size-5 place-items-center rounded-full opacity-60 transition-opacity hover:bg-black/20 hover:opacity-100"
                  style={active ? { color: palette.tintInk } : undefined}
                >
                  <X className="size-3" strokeWidth={3} />
                </button>
              )}
            </span>
          )
        })}
      </div>
    </div>
  )
}
