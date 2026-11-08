import { EQ_BANDS, EQ_Q, effectivePreampDb } from '../../../shared/eq'
import type { EqSettings } from '../../../shared/types'
import { FFT_SIZE } from '@/lib/audio-levels'
import { step } from '@/lib/diagnostics'

/**
 * The music-only equalizer's audio path. The main process sends the music app to VB-CABLE's
 * "CABLE Input"; this captures "CABLE Output" (the same sound), runs it through the same ten
 * peaking filters Equalizer APO would use, boosts it if asked, and plays it on the default
 * output device.
 */

/** VB-CABLE's recording side. */
const CABLE_OUTPUT = 'CABLE Output'
const CABLE_INPUT = /CABLE Input/i
/** Filter changes glide over this time constant, so dragging a band doesn't crackle. */
const GLIDE_S = 0.015
/** The boost's limiter leaves everything below this level alone. */
const LIMIT_KNEE = 0.85
/** Loudest boost: 2 is 200%. */
export const MAX_BOOST = 2

/**
 * The limiter's curve, for a signal halved on the way in (so up to 2 fits the curve's -1..1):
 * unchanged up to LIMIT_KNEE, then bending smoothly towards full scale without ever reaching
 * it, so a boosted song gets louder instead of crackling.
 */
function limiterCurve(points = 4096): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(new ArrayBuffer(points * 4))
  const room = 1 - LIMIT_KNEE
  for (let i = 0; i < points; i++) {
    const x = ((i / (points - 1)) * 2 - 1) * 2
    const level = Math.abs(x)
    const y = level <= LIMIT_KNEE ? level : LIMIT_KNEE + room * Math.tanh((level - LIMIT_KNEE) / room)
    curve[i] = Math.sign(x) * y
  }
  return curve
}

export class MusicEqPipeline {
  private context: AudioContext | null = null
  private stream: MediaStream | null = null
  private preamp: GainNode | null = null
  private filters: BiquadFilterNode[] = []
  /**
   * At 100% the sound skips the limiter entirely (it isn't even connected, so it costs no CPU);
   * above, it goes through it.
   */
  private direct: GainNode | null = null
  private boostIn: GainNode | null = null
  private boostOut: GainNode | null = null
  /** The last filter, which feeds both paths. */
  private tail: AudioNode | null = null
  private limiterConnected = false
  private disconnectTimer = 0
  private equalize = true
  private boost = 1
  private starting: Promise<void> | null = null
  private stopped = true
  /** What the bars read: the equalized music and nothing else. */
  analyser: AnalyserNode | null = null
  /** Called when the path breaks by itself (the cable disappeared, the device changed...). */
  onFailure: ((message: string) => void) | null = null

  /** `inputName` is part of the recording device's name; tests point it at a stand-in device. */
  constructor(private readonly inputName: string = CABLE_OUTPUT) {}

  get running(): boolean {
    return this.context !== null
  }

  /** `equalize` false keeps the filters flat (only the boost is wanted). */
  start(eq: EqSettings, equalize = true, boost = 1): Promise<void> {
    this.stopped = false
    this.equalize = equalize
    this.boost = clampBoost(boost)
    if (this.context) {
      this.apply(eq)
      this.applyBoost()
      return Promise.resolve()
    }
    if (!this.starting) {
      this.starting = this.open(eq).finally(() => {
        this.starting = null
      })
    }
    return this.starting
  }

  stop(): void {
    this.stopped = true
    const context = this.context
    const stream = this.stream
    this.context = null
    this.stream = null
    this.preamp = null
    this.filters = []
    this.direct = null
    this.boostIn = null
    this.boostOut = null
    this.tail = null
    this.limiterConnected = false
    window.clearTimeout(this.disconnectTimer)
    this.analyser = null
    stream?.getTracks().forEach((track) => track.stop())
    void context?.close().catch(() => undefined)
  }

  apply(eq: EqSettings): void {
    const context = this.context
    if (!context || !this.preamp) return
    const now = context.currentTime
    const on = eq.enabled && this.equalize
    this.preamp.gain.setTargetAtTime(on ? Math.pow(10, effectivePreampDb(eq) / 20) : 1, now, GLIDE_S)
    this.filters.forEach((filter, i) => filter.gain.setTargetAtTime(on ? (eq.gains[i] ?? 0) : 0, now, GLIDE_S))
  }

  setBoost(boost: number): void {
    this.boost = clampBoost(boost)
    this.applyBoost()
  }

  private applyBoost(): void {
    const context = this.context
    const { direct, boostIn, boostOut, tail } = this
    if (!context || !direct || !boostIn || !boostOut || !tail) return
    const now = context.currentTime
    const boosted = this.boost > 1.001
    window.clearTimeout(this.disconnectTimer)
    if (boosted && !this.limiterConnected) {
      tail.connect(boostIn)
      this.limiterConnected = true
    }
    direct.gain.setTargetAtTime(boosted ? 0 : 1, now, GLIDE_S)
    boostOut.gain.setTargetAtTime(boosted ? 1 : 0, now, GLIDE_S)
    // Halved to fit the limiter's curve, which doubles it back.
    boostIn.gain.setTargetAtTime(this.boost / 2, now, GLIDE_S)
    if (!boosted && this.limiterConnected) {
      // Once the crossfade back has finished, take the limiter out of the path.
      this.disconnectTimer = window.setTimeout(() => {
        if (this.tail !== tail || this.boost > 1.001 || !this.limiterConnected) return
        tail.disconnect(boostIn)
        this.limiterConnected = false
      }, GLIDE_S * 1000 * 8)
    }
  }

  private async open(eq: EqSettings): Promise<void> {
    step('music path', 'looking for CABLE Output')
    const input = await findCableOutput(this.inputName)
    step('music path', 'creating its audio context')
    // 'balanced': audio in slightly bigger chunks, so the audio thread wakes up half as often.
    // It adds about 10 ms to the music's small delay, which nobody hears.
    const context = new AudioContext({ latencyHint: 'balanced' })
    let stream: MediaStream | null = null
    step('music path', 'opening CABLE Output')
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: { exact: input },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: { ideal: 2 },
          sampleRate: { ideal: context.sampleRate }
        },
        video: false
      })
    } catch (error) {
      void context.close().catch(() => undefined)
      const name = error instanceof DOMException ? error.name : ''
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        throw new Error(
          'Windows blocks apps from using recording devices, and VB-CABLE counts as one. Turn on Settings → Privacy → Microphone → Let desktop apps access your microphone.'
        )
      }
      throw new Error(`Couldn't open VB-CABLE's "CABLE Output" (${name || String(error)}).`)
    }
    if (this.stopped) {
      stream.getTracks().forEach((track) => track.stop())
      void context.close().catch(() => undefined)
      return
    }

    step('music path', 'building the equalizer and limiter')
    const source = context.createMediaStreamSource(stream)
    const preamp = context.createGain()
    const filters = EQ_BANDS.map((frequency) => {
      const filter = context.createBiquadFilter()
      // Web Audio's peaking filter is the same RBJ-cookbook filter as Equalizer APO's "PK".
      filter.type = 'peaking'
      filter.frequency.value = frequency
      filter.Q.value = EQ_Q
      filter.gain.value = 0
      return filter
    })
    const direct = context.createGain()
    const boostIn = context.createGain()
    const limiter = context.createWaveShaper()
    limiter.curve = limiterCurve()
    limiter.oversample = '2x'
    const boostOut = context.createGain()
    direct.gain.value = 1
    boostIn.gain.value = 0.5
    boostOut.gain.value = 0
    const analyser = context.createAnalyser()
    analyser.fftSize = FFT_SIZE
    analyser.smoothingTimeConstant = 0.5
    analyser.minDecibels = -90
    analyser.maxDecibels = -22

    source.connect(preamp)
    let node: AudioNode = preamp
    for (const filter of filters) {
      node.connect(filter)
      node = filter
    }
    node.connect(direct)
    boostIn.connect(limiter)
    limiter.connect(boostOut)
    direct.connect(analyser)
    boostOut.connect(analyser)
    analyser.connect(context.destination)
    if (context.state === 'suspended') await context.resume().catch(() => undefined)

    stream.getAudioTracks()[0]?.addEventListener('ended', () => {
      if (this.stream !== stream) return
      this.stop()
      this.onFailure?.("VB-CABLE's recording side went away.")
    })

    this.context = context
    this.stream = stream
    this.preamp = preamp
    this.filters = filters
    this.direct = direct
    this.boostIn = boostIn
    this.boostOut = boostOut
    this.tail = node
    this.limiterConnected = false
    this.analyser = analyser
    this.apply(eq)
    this.applyBoost()
  }

  /** For tests: what the boost stage is set to. */
  get boostLevel(): number {
    return this.boost
  }

  /** For tests: whether the limiter is in the audio path. */
  get limiterInPath(): boolean {
    return this.limiterConnected
  }
}

function clampBoost(boost: number): number {
  return Number.isFinite(boost) ? Math.min(MAX_BOOST, Math.max(1, boost)) : 1
}

/** The device id of "CABLE Output", checking that the cable isn't Windows' default output too. */
async function findCableOutput(inputName: string): Promise<string> {
  const devices = await navigator.mediaDevices.enumerateDevices()
  const wanted = inputName.toLowerCase()
  const input = devices.find((device) => device.kind === 'audioinput' && device.label.toLowerCase().includes(wanted))
  if (!input) throw new Error('VB-CABLE\'s "CABLE Output" isn\'t there. If you just installed it, restart Windows.')
  const defaultOutput = devices.find((device) => device.kind === 'audiooutput' && device.deviceId === 'default')
  // The cable as the default output would send the equalized music back into itself.
  if (defaultOutput && CABLE_INPUT.test(defaultOutput.label)) {
    throw new Error('Windows plays everything into VB-CABLE. Choose your speakers or headphones as the default output device.')
  }
  return input.deviceId
}
