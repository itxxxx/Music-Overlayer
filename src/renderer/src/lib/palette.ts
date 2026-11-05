/** Colours sampled from the album art, so the widget takes on each song's colour. */
export interface Palette {
  hue: number
  /** Pastel accent: play button, visualizer, active states. */
  tint: string
  /** Ink that reads on top of `tint`. */
  tintInk: string
  /** Dark base under the blurred artwork. */
  base: string
}

export const DEFAULT_PALETTE: Palette = {
  hue: 262,
  tint: 'hsl(262 90% 86%)',
  tintInk: 'hsl(262 42% 18%)',
  base: 'hsl(262 14% 11%)'
}

const cache = new Map<string, Palette>()

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255
  g /= 255
  b /= 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0)
  else if (max === g) h = (b - r) / d + 2
  else h = (r - g) / d + 4
  return [h * 60, s, l]
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.decoding = 'async'
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('Artwork failed to load'))
    image.src = src
  })
}

export async function extractPalette(src: string): Promise<Palette> {
  const cached = cache.get(src)
  if (cached) return cached

  const image = await loadImage(src)
  const size = 28
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return DEFAULT_PALETTE
  context.drawImage(image, 0, 0, size, size)
  const { data } = context.getImageData(0, 0, size, size)

  // Hue is averaged as a vector, weighted towards saturated, mid-light pixels.
  let x = 0
  let y = 0
  let weightSum = 0
  let saturationSum = 0
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue
    const [h, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2])
    const weight = s * s * (1 - Math.abs(l - 0.5) * 1.6)
    if (weight <= 0) continue
    const radians = (h * Math.PI) / 180
    x += Math.cos(radians) * weight
    y += Math.sin(radians) * weight
    weightSum += weight
    saturationSum += s * weight
  }

  let palette: Palette
  if (weightSum < 2) {
    // Black-and-white artwork: stay neutral.
    palette = { hue: 0, tint: 'hsl(0 0% 90%)', tintInk: 'hsl(0 0% 12%)', base: 'hsl(0 0% 10%)' }
  } else {
    const hue = Math.round(((Math.atan2(y, x) * 180) / Math.PI + 360) % 360)
    const saturation = Math.min(88, Math.max(42, (saturationSum / weightSum) * 100))
    palette = {
      hue,
      tint: `hsl(${hue} ${saturation.toFixed(0)}% 85%)`,
      tintInk: `hsl(${hue} 45% 16%)`,
      base: `hsl(${hue} ${Math.min(30, saturation / 3).toFixed(0)}% 10%)`
    }
  }
  if (cache.size > 40) cache.clear()
  cache.set(src, palette)
  return palette
}
