import { useEffect, useState } from 'react'
import type { MediaCover } from '../../../shared/types'
import { DEFAULT_PALETTE, extractPalette, type Palette } from '@/lib/palette'

const ARTWORK_GRACE_MS = 1500

/**
 * Artwork to show for the current track. Right after a track change the previous artwork stays
 * up briefly, because players often publish the new title a moment before the new artwork.
 */
export function useDisplayedCover(trackKey: string | null, cover: MediaCover | null): string | null {
  const [shown, setShown] = useState<string | null>(() =>
    cover && trackKey && cover.trackKey === trackKey ? cover.dataUrl : null
  )
  useEffect(() => {
    if (!trackKey) {
      setShown(null)
      return
    }
    if (cover && cover.trackKey === trackKey) {
      setShown(cover.dataUrl)
      return
    }
    const timer = window.setTimeout(() => setShown(null), ARTWORK_GRACE_MS)
    return () => window.clearTimeout(timer)
  }, [trackKey, cover])
  return shown
}

/** Colours sampled from the artwork; keeps the previous palette while new artwork loads. */
export function useCoverPalette(src: string | null): Palette {
  const [palette, setPalette] = useState<Palette>(DEFAULT_PALETTE)
  useEffect(() => {
    if (!src) {
      setPalette(DEFAULT_PALETTE)
      return
    }
    let cancelled = false
    extractPalette(src)
      .then((next) => {
        if (!cancelled) setPalette(next)
      })
      .catch(() => {
        if (!cancelled) setPalette(DEFAULT_PALETTE)
      })
    return () => {
      cancelled = true
    }
  }, [src])
  return palette
}
