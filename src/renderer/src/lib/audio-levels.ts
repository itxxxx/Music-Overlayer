/**
 * Frequency data for the visualizer bars.
 *
 * On Windows the main process answers getDisplayMedia() with loopback audio, i.e. whatever the
 * PC is playing, so the bars move with the real music. Anywhere that fails (or in the demo),
 * a synthetic spectrum keeps the bars alive while something is playing.
 */

export const FFT_SIZE = 2048

export interface SpectrumFrame {
  /** Byte magnitudes, FFT_SIZE / 2 bins. */
  spectrum: Uint8Array<ArrayBuffer>
  sampleRate: number
  live: boolean
}

type Listener = (frame: SpectrumFrame, now: number) => void

interface LiveCapture {
  context: AudioContext
  analyser: AnalyserNode
  stream: MediaStream
}

/** After this long without music the audio graph is paused... */
const SUSPEND_AFTER_MS = 2000
/** ...and after this long the system-audio capture is let go entirely. */
const RELEASE_AFTER_MS = 15000

class AudioLevels {
  private readonly listeners = new Set<Listener>()
  private readonly spectrum = new Uint8Array(new ArrayBuffer(FFT_SIZE / 2))
  private raf = 0
  private live: LiveCapture | null = null
  private starting: Promise<boolean> | null = null
  private playing = false
  private energy = 0
  private onLiveEnded: (() => void) | null = null
  private onWantLive: (() => void) | null = null
  /** The capture was let go during a long pause and should come back with the music. */
  private released = false
  private suspendTimer = 0
  private releaseTimer = 0
  private frameInterval = 1000 / 60
  private lastFrameAt = 0
  /** The music-only equalizer's own analyser: just the music, no capture needed. */
  private external: AnalyserNode | null = null

  setPlaying(playing: boolean): void {
    if (playing === this.playing) return
    this.playing = playing
    window.clearTimeout(this.suspendTimer)
    window.clearTimeout(this.releaseTimer)
    if (playing) {
      if (this.live) void this.live.context.resume().catch(() => undefined)
      else if (this.released) {
        this.released = false
        this.onWantLive?.()
      }
      return
    }
    this.scheduleIdle()
  }

  /** Nothing to show while paused: stop processing audio, and later stop capturing it. */
  private scheduleIdle(): void {
    if (!this.live) return
    window.clearTimeout(this.suspendTimer)
    window.clearTimeout(this.releaseTimer)
    this.suspendTimer = window.setTimeout(() => void this.live?.context.suspend().catch(() => undefined), SUSPEND_AFTER_MS)
    this.releaseTimer = window.setTimeout(() => {
      if (!this.live || this.playing) return
      this.stopLive()
      this.released = true
    }, RELEASE_AFTER_MS)
  }

  /**
   * Read the bars from the music-only equalizer's audio path instead of the system loopback
   * (null goes back to the loopback). That path only carries the music app.
   */
  attach(analyser: AnalyserNode | null): void {
    if (analyser === this.external) return
    this.external = analyser
    if (analyser) this.stopLive()
    else this.onWantLive?.()
  }

  /** At most this many frames per second (the display may refresh faster). */
  setMaxFps(fps: number): void {
    this.frameInterval = 1000 / Math.max(1, fps)
  }

  /** Called when the loopback stream dies (e.g. the output device changed). */
  setLiveEndedHandler(handler: () => void): void {
    this.onLiveEnded = handler
  }

  /** Called when music starts again after the capture was let go during a pause. */
  setWantLiveHandler(handler: () => void): void {
    this.onWantLive = handler
  }

  get isLive(): boolean {
    return this.live !== null
  }

  startLive(): Promise<boolean> {
    if (this.live || this.external) return Promise.resolve(true)
    if (this.starting) return this.starting
    this.starting = this.openLoopback().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  stopLive(): void {
    window.clearTimeout(this.suspendTimer)
    window.clearTimeout(this.releaseTimer)
    this.released = false
    const live = this.live
    this.live = null
    if (!live) return
    live.stream.getTracks().forEach((track) => track.stop())
    void live.context.close().catch(() => undefined)
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    if (!this.raf) this.raf = requestAnimationFrame(this.frame)
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0 && this.raf) {
        cancelAnimationFrame(this.raf)
        this.raf = 0
      }
    }
  }

  private async openLoopback(): Promise<boolean> {
    let stream: MediaStream | null = null
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        audio: true,
        video: { width: { max: 64 }, height: { max: 64 }, frameRate: { max: 1 } }
      })
      // Only the audio is wanted; drop the screen video right away.
      for (const track of stream.getVideoTracks()) {
        track.stop()
        stream.removeTrack(track)
      }
      const audio = stream.getAudioTracks()[0]
      if (!audio) throw new Error('No system audio track')

      const context = new AudioContext({ latencyHint: 'playback' })
      const source = context.createMediaStreamSource(stream)
      const analyser = context.createAnalyser()
      analyser.fftSize = FFT_SIZE
      analyser.smoothingTimeConstant = 0.5
      analyser.minDecibels = -90
      analyser.maxDecibels = -22
      // Keep the graph pulling audio without making any sound.
      const silent = context.createGain()
      silent.gain.value = 0
      source.connect(analyser)
      analyser.connect(silent)
      silent.connect(context.destination)
      if (context.state === 'suspended') await context.resume().catch(() => undefined)

      audio.addEventListener('ended', () => {
        if (this.live?.stream !== stream) return
        this.stopLive()
        this.onLiveEnded?.()
      })
      this.live = { context, analyser, stream }
      if (!this.playing) this.scheduleIdle()
      return true
    } catch (error) {
      stream?.getTracks().forEach((track) => track.stop())
      console.info('[visualizer] system audio unavailable, using simulated levels:', error)
      return false
    }
  }

  private frame = (now: number): void => {
    this.raf = 0
    if (this.listeners.size === 0) return
    // Skip frames beyond the cap; 1 ms of slack keeps a 60 Hz display at a steady 60.
    if (now - this.lastFrameAt < this.frameInterval - 1) {
      this.raf = requestAnimationFrame(this.frame)
      return
    }
    this.lastFrameAt = now
    let sampleRate = 48000
    if (this.external) {
      sampleRate = this.external.context.sampleRate
      if (this.playing) this.external.getByteFrequencyData(this.spectrum)
      else this.spectrum.fill(0)
    } else if (this.live) {
      sampleRate = this.live.context.sampleRate
      // System audio includes Discord, games and notifications: only listen while music plays.
      if (this.playing) this.live.analyser.getByteFrequencyData(this.spectrum)
      else this.spectrum.fill(0)
    } else if (this.starting || this.released) {
      // The real audio is about to come back; don't show made-up bars in between.
      this.spectrum.fill(0)
    } else {
      this.simulate(now)
    }
    const frame: SpectrumFrame = { spectrum: this.spectrum, sampleRate, live: this.live !== null || this.external !== null }
    for (const listener of this.listeners) listener(frame, now)
    this.raf = requestAnimationFrame(this.frame)
  }

  /** A plausible spectrum: a kick on the beat, moving mids, ticking hats. */
  private simulate(now: number): void {
    const target = this.playing ? 1 : 0
    this.energy += (target - this.energy) * (target > this.energy ? 0.06 : 0.04)
    const t = now / 1000
    const beat = Math.pow(Math.max(0, Math.cos(Math.PI * ((t * 2) % 1))), 10)
    const offbeat = Math.pow(Math.max(0, Math.cos(Math.PI * ((t * 4 + 0.5) % 1))), 18)
    const binHz = 48000 / FFT_SIZE
    for (let i = 0; i < this.spectrum.length; i++) {
      const f = i * binHz
      if (f < 25) {
        this.spectrum[i] = 0
        continue
      }
      const octave = Math.log2(f / 40)
      const tilt = Math.max(0, 1 - octave / 10.5)
      const wobble = 0.5 + 0.5 * Math.sin(t * (1.1 + (i % 9) * 0.29) + i * 0.73)
      const sway = 0.5 + 0.5 * Math.sin(t * 0.7 + octave * 1.3)
      let value = tilt * (0.42 + 0.22 * wobble + 0.18 * sway)
      if (f < 150) value += beat * 0.45
      else if (f < 400) value += beat * 0.18
      if (f > 5000) value += offbeat * 0.3
      this.spectrum[i] = Math.max(0, Math.min(255, value * this.energy * 235))
    }
  }
}

export const audioLevels = new AudioLevels()

/** Log-spaced band edges (count + 1 values). */
export function bandEdges(count: number, minHz: number, maxHz: number): number[] {
  const edges: number[] = []
  for (let i = 0; i <= count; i++) edges.push(minHz * Math.pow(maxHz / minHz, i / count))
  return edges
}

/** Reads band levels (0–1) from a frame into `out`. */
export function readBands(frame: SpectrumFrame, edges: number[], out: Float32Array): void {
  const binHz = frame.sampleRate / FFT_SIZE
  const bins = frame.spectrum.length
  for (let band = 0; band < out.length; band++) {
    const lo = Math.min(bins - 1, Math.max(1, Math.floor(edges[band] / binHz)))
    const hi = Math.min(bins, Math.max(lo + 1, Math.ceil(edges[band + 1] / binHz)))
    let peak = 0
    let sum = 0
    for (let i = lo; i < hi; i++) {
      const value = frame.spectrum[i]
      sum += value
      if (value > peak) peak = value
    }
    const level = (peak * 0.65 + (sum / (hi - lo)) * 0.35) / 255
    // Treble carries less energy; lift it a little so the right side of the bars moves too.
    const lift = 1 + (band / Math.max(1, out.length - 1)) * 0.3
    out[band] = Math.min(1, Math.pow(level * lift, 1.35))
  }
}
