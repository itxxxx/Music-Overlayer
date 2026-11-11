import { useCallback, useEffect, useMemo, useRef } from 'react'
import { EQ_PRESETS, cleanPresetName, defaultPresetName } from '../../../shared/eq'
import type { EqSettings, EqTarget } from '../../../shared/types'
import { getState, setState, useWidget } from '@/lib/store'

const APPLY_DELAY_MS = 60

function sameGains(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, i) => Math.abs(value - b[i]) < 0.01)
}

export function useEqualizer() {
  const eq = useWidget((state) => state.eq)
  const status = useWidget((state) => state.eqStatus)
  const musicEq = useWidget((state) => state.musicEq)
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
    musicEq,
    activePresetId,
    setGain: (index: number, value: number) =>
      update((current) => ({
        ...current,
        gains: current.gains.map((gain, i) => (i === index ? value : gain)),
        presetId: 'custom'
      })),
    setPreamp: (preamp: number) => update((current) => ({ ...current, preamp })),
    setEnabled: (enabled: boolean) => update((current) => ({ ...current, enabled })),
    setTarget: (target: EqTarget) => update((current) => ({ ...current, target })),
    applyPreset: (id: string) =>
      update((current) => {
        const preset = [...EQ_PRESETS, ...current.userPresets].find((p) => p.id === id)
        return preset ? { ...current, gains: [...preset.gains], presetId: preset.id, enabled: true } : current
      }),
    /** The name a new preset starts with, before the user types their own. */
    nextPresetName: () => defaultPresetName(getState().eq.userPresets),
    /** Saves the current curve as a preset with this name (blank: "My preset N"). */
    savePreset: (name = '') =>
      update((current) => {
        const id = `user-${Date.now().toString(36)}`
        const preset = { id, name: cleanPresetName(name, defaultPresetName(current.userPresets)), gains: [...current.gains] }
        return { ...current, userPresets: [...current.userPresets, preset], presetId: id }
      }),
    /** Renames a saved preset (blank keeps the old name). */
    renamePreset: (id: string, name: string) =>
      update((current) => ({
        ...current,
        userPresets: current.userPresets.map((p) => (p.id === id ? { ...p, name: cleanPresetName(name, p.name) } : p))
      })),
    deletePreset: (id: string) =>
      update((current) => ({
        ...current,
        userPresets: current.userPresets.filter((p) => p.id !== id),
        presetId: current.presetId === id ? 'custom' : current.presetId
      })),
    connect: async () => setState({ eqStatus: await window.musicWidget.eq.connect() }),
    install: async () => setState({ eqStatus: await window.musicWidget.eq.install() }),
    recheck: async () => setState({ eqStatus: await window.musicWidget.eq.refreshStatus() }),
    download: () => window.musicWidget.eq.openDownloadPage(),
    installCable: async () => setState({ musicEq: await window.musicWidget.musicEq.install() }),
    recheckCable: () => window.musicWidget.musicEq.recheck()
  }
}
