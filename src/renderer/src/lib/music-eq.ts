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
/**
 * A glide never quite ends on its own, and while one is running Chromium works out each filter
 * again for every single sample (instead of once per block of 128). So once it's all but there
 * (8 time constants: 0.03% away), each glided parameter is set to its target outright.
 */
const SETTLE_MS = GLIDE_S * 1000 * 8 + 30
/** The boost's limiter leaves everything below this level alone. */
const LIMIT_KNEE = 0.85
/** Loudest boost: 2 is 200%. */
export const MAX_BOOST = 2
/**
 * While the player is turned down, how often the cable's level is checked (see watchCable): often
 * just after the make-up gain goes up (when a player's sound may still be moving to the cable),
 * then a little less.
 */
const WATCH_MS = 50
const WATCH_SLOW_MS = 100
const WATCH_FAST_FOR_MS = 3000
/** The check looks at this many samples (85 ms at 48 kHz): every one since the last check. */
const WATCH_SAMPLES = 4096
/** This many samples above the ceiling in one check means the player isn't turned down. */
const LOUD_SAMPLES = 64
/** The guard's curve has a point every 1/1000 (ceilings are rounded to match), so it's exact. */
const GUARD_POINTS = 2001

/**
 * The guard's curve: unchanged up to ±ceiling, flat beyond (see PipelineRequest.ceiling). The
 * ceiling falls on a point, so between them the straight-line interpolation is the input itself.
 */
function guardCurve(ceiling: number): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(new ArrayBuffer(GUARD_POINTS * 4))
  const half = (GUARD_POINTS - 1) / 2
  for (let i = 0; i < GUARD_POINTS; i++) {
    const x = i / half - 1
    curve[i] = Math.max(-ceiling, Math.min(ceiling, x))
  }
  return curve
}

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
  /**
   * The player plays into the cable turned down (so a screen share doesn't get the music twice):
   * the guard clips anything louder than that whisper, then the make-up gain turns it back up.
   */
  private guard: WaveShaperNode | null = null
  private ceiling = 1
  /** The ceiling the guard's curve has now (1: no curve, so the sound goes through untouched). */
  private guardCeiling = 1
  private makeupNode: GainNode | null = null
  private makeup = 1
  /** What comes off the cable, before the guard: checked while the make-up gain is up. */
  private meter: AnalyserNode | null = null
  private meterData: Float32Array<ArrayBuffer> | null = null
  private watchTimer = 0
  private watchFastUntil = 0
  private preamp: GainNode | null = null
  private filters: BiquadFilterNode[] = []
  /**
   * Which bands are in the path. A band at 0 dB changes nothing but costs as much CPU as any
   * other, so once it has settled there it's taken out, and put back (still at exactly 0 dB, so
   * the sound doesn't change by a single bit) just before it moves.
   */
  private inPath: boolean[] = []
  /** After the bands, before the boost: where the path always continues from. */
  private post: GainNode | null = null
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
  /** Parameters gliding to a target, set outright once the glide is done (see SETTLE_MS). */
  private gliding = new Map<AudioParam, number>()
  private settleTimer = 0
  private starting: Promise<void> | null = null
  private stopped = true
  /** What the bars read: the equalized music and nothing else. */
  analyser: AnalyserNode | null = null
  /** Called when the path breaks by itself (the cable disappeared, the device changed...). */
  onFailure: ((message: string) => void) | null = null
  /**
   * Called when the cable turned out louder than the whisper while the make-up gain was up (or
   * about to go up): the gain is already back to 1, so it can't come out too loud.
   */
  onLoud: (() => void) | null = null

  /** `inputName` is part of the recording device's name; tests point it at a stand-in device. */
  constructor(private readonly inputName: string = CABLE_OUTPUT) {}

  get running(): boolean {
    return this.context !== null
  }

  /** `equalize` false keeps the filters flat (only the boost is wanted). */
  start(eq: EqSettings, equalize = true, boost = 1, makeup = 1, ceiling = 1): Promise<void> {
    this.stopped = false
    this.equalize = equalize
    this.boost = clampBoost(boost)
    this.makeup = clampMakeup(makeup)
    this.ceiling = clampCeiling(ceiling)
    if (this.context) {
      this.apply(eq)
      this.applyBoost()
      this.applyMakeup()
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
    this.guard = null
    this.guardCeiling = 1
    this.makeupNode = null
    this.meter = null
    this.meterData = null
    this.stopWatching()
    this.preamp = null
    this.filters = []
    this.inPath = []
    this.post = null
    this.direct = null
    this.boostIn = null
    this.boostOut = null
    this.tail = null
    this.limiterConnected = false
    window.clearTimeout(this.disconnectTimer)
    window.clearTimeout(this.settleTimer)
    this.gliding.clear()
    this.analyser = null
    stream?.getTracks().forEach((track) => track.stop())
    void context?.close().catch(() => undefined)
  }

  apply(eq: EqSettings): void {
    const context = this.context
    if (!context || !this.preamp) return
    const now = context.currentTime
    const on = eq.enabled && this.equalize
    const targets = this.filters.map((_, i) => (on ? (eq.gains[i] ?? 0) : 0))
    // A band about to move off 0 dB goes back in the path first.
    if (targets.some((target, i) => target !== 0 && !this.inPath[i])) {
      this.inPath = targets.map((target, i) => this.inPath[i] || target !== 0)
      this.rewire()
    }
    this.glide(this.preamp.gain, on ? Math.pow(10, effectivePreampDb(eq) / 20) : 1, now)
    this.filters.forEach((filter, i) => {
      if (this.inPath[i]) this.glide(filter.gain, targets[i], now)
    })
  }

  /** Connects the preamp, the bands in the path, and `post`, in that order. */
  private rewire(): void {
    const { preamp, post, filters } = this
    if (!preamp || !post) return
    preamp.disconnect()
    for (const filter of filters) filter.disconnect()
    let node: AudioNode = preamp
    filters.forEach((filter, i) => {
      if (!this.inPath[i]) return
      node.connect(filter)
      node = filter
    })
    node.connect(post)
  }

  /** The make-up gain now applied (1 while the player isn't turned down, or before the path runs). */
  get makeupLevel(): number {
    return this.makeupNode ? this.makeup : 1
  }

  /** For tests: how many bands are in the audio path right now. */
  get bandsInPath(): number {
    return this.inPath.filter(Boolean).length
  }

  /** For tests: where the guard clips (1: it doesn't). */
  get guardLevel(): number {
    return this.guardCeiling
  }

  private applyMakeup(): void {
    const context = this.context
    if (!context || !this.makeupNode) return
    // Turning up while the cable is still loud would come out many times too loud (clipped by
    // the guard): stay at 1 and say so.
    if (this.makeup > 1 && this.cableLouderThan(this.ceiling)) {
      this.dropMakeup()
      return
    }
    // Down at once and then the guard, or the guard first and then up with a short glide: in
    // between, the sound can only be quieter, never louder.
    const target = this.makeup
    const param = this.makeupNode.gain
    if (target < param.value) {
      this.gliding.delete(param)
      param.cancelScheduledValues(context.currentTime)
      param.setValueAtTime(target, context.currentTime)
      this.applyGuard()
    } else {
      this.applyGuard()
      this.glide(param, target, context.currentTime)
    }
    if (target > 1) this.watchCable()
    else this.stopWatching()
  }

  /** Make-up gain back to 1 at once, guard off, and tell the main process. */
  private dropMakeup(): void {
    const context = this.context
    this.makeup = 1
    this.stopWatching()
    if (context && this.makeupNode) {
      this.gliding.delete(this.makeupNode.gain)
      this.makeupNode.gain.cancelScheduledValues(context.currentTime)
      this.makeupNode.gain.setValueAtTime(1, context.currentTime)
    }
    this.ceiling = 1
    this.applyGuard()
    this.onLoud?.()
  }

  /**
   * While the make-up gain is up: if the player's sound on the cable gets louder than the whisper
   * (its volume went back up, or it moved to a new audio session Windows hadn't turned down), drop
   * the gain within WATCH_MS instead of playing it many times too loud until the main process
   * notices.
   */
  private watchCable(): void {
    this.watchFastUntil = performance.now() + WATCH_FAST_FOR_MS
    if (this.watchTimer) return
    const check = () => {
      this.watchTimer = 0
      if (this.makeup <= 1) return
      if (this.cableLouderThan(this.guardCeiling)) {
        this.dropMakeup()
        return
      }
      this.watchTimer = window.setTimeout(check, performance.now() < this.watchFastUntil ? WATCH_MS : WATCH_SLOW_MS)
    }
    this.watchTimer = window.setTimeout(check, WATCH_MS)
  }

  private stopWatching(): void {
    window.clearTimeout(this.watchTimer)
    this.watchTimer = 0
  }

  /** Whether the last WATCH_SAMPLES off the cable went above `ceiling` more than a stray peak. */
  private cableLouderThan(ceiling: number): boolean {
    const { meter, meterData } = this
    if (!meter || !meterData || ceiling >= 1) return false
    meter.getFloatTimeDomainData(meterData)
    let over = 0
    for (let i = 0; i < meterData.length; i++) {
      if (meterData[i] > ceiling || meterData[i] < -ceiling) {
        over++
        if (over >= LOUD_SAMPLES) return true
      }
    }
    return false
  }

  private applyGuard(): void {
    if (!this.guard || this.ceiling === this.guardCeiling) return
    this.guard.curve = this.ceiling < 1 ? guardCurve(this.ceiling) : null
    this.guardCeiling = this.ceiling
  }

  /** Glides `param` to `target`, and sets it outright once there (see SETTLE_MS). */
  private glide(param: AudioParam, target: number, now: number): void {
    param.setTargetAtTime(target, now, GLIDE_S)
    this.gliding.set(param, target)
    window.clearTimeout(this.settleTimer)
    this.settleTimer = window.setTimeout(() => this.settle(), SETTLE_MS)
  }

  private settle(): void {
    if (!this.context) return
    for (const [param, target] of this.gliding) {
      param.cancelScheduledValues(0)
      param.value = target
    }
    this.gliding.clear()
    // Bands that came to rest at 0 dB leave the path.
    const flat = this.filters.map((filter, i) => this.inPath[i] && filter.gain.value === 0)
    if (flat.some(Boolean)) {
      this.inPath = this.inPath.map((inPath, i) => inPath && !flat[i])
      this.rewire()
    }
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
    this.glide(direct.gain, boosted ? 0 : 1, now)
    this.glide(boostOut.gain, boosted ? 1 : 0, now)
    // Halved to fit the limiter's curve, which doubles it back.
    this.glide(boostIn.gain, this.boost / 2, now)
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
    const guard = context.createWaveShaper()
    guard.oversample = 'none'
    const meter = context.createAnalyser()
    meter.fftSize = WATCH_SAMPLES
    const makeupNode = context.createGain()
    makeupNode.gain.value = 1
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
    const post = context.createGain()
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

    source.connect(guard)
    source.connect(meter)
    guard.connect(makeupNode)
    makeupNode.connect(preamp)
    // The bands go in between as they're needed (see inPath).
    preamp.connect(post)
    post.connect(direct)
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
    this.guard = guard
    this.guardCeiling = 1
    this.meter = meter
    this.meterData = new Float32Array(new ArrayBuffer(WATCH_SAMPLES * 4))
    this.makeupNode = makeupNode
    this.preamp = preamp
    this.filters = filters
    this.inPath = filters.map(() => false)
    this.post = post
    this.direct = direct
    this.boostIn = boostIn
    this.boostOut = boostOut
    this.tail = post
    this.limiterConnected = false
    this.analyser = analyser
    this.apply(eq)
    this.applyBoost()
    this.applyMakeup()
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

/** The player is turned down to 1% at the least: at most 100x back up. */
const MAX_MAKEUP = 100

function clampMakeup(makeup: number): number {
  return Number.isFinite(makeup) ? Math.min(MAX_MAKEUP, Math.max(0, makeup)) : 1
}

/** Rounded to a point of the guard's curve (1/1000), or 1 for none. */
function clampCeiling(ceiling: number): number {
  if (!Number.isFinite(ceiling) || ceiling >= 1) return 1
  return Math.max(0.001, Math.round(ceiling * 1000) / 1000)
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
