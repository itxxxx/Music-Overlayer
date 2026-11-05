import { useCallback, useEffect, useMemo, useRef } from 'react'
import { EQ_PRESETS } from '../../../shared/eq'
import type { EqSettings } from '../../../shared/types'
import { getState, setState, useWidget } from '@/lib/store'

const APPLY_DELAY_MS = 60

function sameGains(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, i) => Math.abs(value - b[i]) < 0.01)
}

export function useEqualizer() {
  const eq = useWidget((state) => state.eq)
  const status = useWidget((state) => state.eqStatus)
  const timer = useRef(0)

  useEffect(() => () => window.clearTimeout(timer.current), [])

  const commit = useCallback((next: EqSettings) => {
    setState({ eq: next })
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      void window.musicWidget.eq.apply(getState().eq).then((eqStatus) => setState({ eqStatus }))
    }, APPLY_DELAY_MS)
  }, [])

  const update = useCallback((change: (current: EqSettings) => EqSettings) => commit(change(getState().eq)), [commit])

  /** The preset whose bands match the current curve, if any. */
  const activePresetId = useMemo(() => {
    const all = [...EQ_PRESETS, ...eq.userPresets]
    const named = all.find((preset) => preset.id === eq.presetId)
    if (named && sameGains(named.gains, eq.gains)) return named.id
    return all.find((preset) => sameGains(preset.gains, eq.gains))?.id ?? 'custom'
  }, [eq])

  return {
    eq,
    status,
    activePresetId,
    setGain: (index: number, value: number) =>
      update((current) => ({
        ...current,
        gains: current.gains.map((gain, i) => (i === index ? value : gain)),
        presetId: 'custom'
      })),
    setPreamp: (preamp: number) => update((current) => ({ ...current, preamp })),
    setEnabled: (enabled: boolean) => update((current) => ({ ...current, enabled })),
    applyPreset: (id: string) =>
      update((current) => {
        const preset = [...EQ_PRESETS, ...current.userPresets].find((p) => p.id === id)
        return preset ? { ...current, gains: [...preset.gains], presetId: preset.id, enabled: true } : current
      }),
    savePreset: () =>
      update((current) => {
        const numbers = current.userPresets.map((p) => Number(/(\d+)$/.exec(p.name)?.[1] ?? 0))
        const name = `My preset ${Math.max(0, ...numbers) + 1}`
        const id = `user-${Date.now().toString(36)}`
        return { ...current, userPresets: [...current.userPresets, { id, name, gains: [...current.gains] }], presetId: id }
      }),
    deletePreset: (id: string) =>
      update((current) => ({
        ...current,
        userPresets: current.userPresets.filter((p) => p.id !== id),
        presetId: current.presetId === id ? 'custom' : current.presetId
      })),
    connect: async () => setState({ eqStatus: await window.musicWidget.eq.connect() }),
    install: async () => setState({ eqStatus: await window.musicWidget.eq.install() }),
    recheck: async () => setState({ eqStatus: await window.musicWidget.eq.refreshStatus() }),
    download: () => window.musicWidget.eq.openDownloadPage()
  }
}
