import '@fontsource-variable/manrope'
import './index.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { audioLevels } from './lib/audio-levels'
import { MusicEqPipeline } from './lib/music-eq'
import { connectStore, getState, initStore, subscribeState } from './lib/store'

// The main process calls this with a user gesture once the page has loaded (Windows only).
window.__musicWidgetStartAudio = () => {
  void audioLevels.startLive()
}

// If the system-audio stream ends (e.g. the output device changed), ask for a new one.
let lastRestart = 0
audioLevels.setLiveEndedHandler(() => {
  if (Date.now() - lastRestart < 10_000) return
  lastRestart = Date.now()
  window.setTimeout(() => window.musicWidget.requestAudioCapture(), 1500)
})
// The capture is let go during long pauses; music playing again brings it back.
audioLevels.setWantLiveHandler(() => window.musicWidget.requestAudioCapture())
// No sound from the capture: the main process has another way to try (once).
audioLevels.setNoAudioHandler(() => window.musicWidget.reportNoSystemAudio())
// Check in regularly: if this page ever hangs, the main process reloads it.
window.musicWidget.alive()
window.setInterval(() => window.musicWidget.alive(), 2000)
// Hidden from the tray: stop listening. Showing it again starts the capture from the main process.
window.musicWidget.onVisibility((visible) => {
  if (!visible) audioLevels.stopLive()
})

/**
 * The music-only equalizer's audio path runs whenever the main process asks (it routes the
 * player only once this reports "running", and stops it only after the player is routed back).
 */
function connectMusicEq(inputName: string | undefined): void {
  const api = window.musicWidget.musicEq
  const pipeline = new MusicEqPipeline(inputName)
  let wanted = false
  pipeline.onFailure = (message) => {
    audioLevels.attach(null)
    api.reportPipeline({ running: false, error: message })
  }
  // For tests: the audio path as it stands.
  ;(window as unknown as { __musicWidgetPipeline: () => object }).__musicWidgetPipeline = () => ({
    running: pipeline.running,
    boost: pipeline.boostLevel
  })
  api.onPipeline((request) => {
    if (!request.run) {
      wanted = false
      pipeline.stop()
      audioLevels.attach(null)
      api.reportPipeline({ running: false })
      return
    }
    // Already running: only the equalizer switch or the boost changed.
    const alreadyAsked = wanted && pipeline.running
    wanted = true
    const starting = pipeline.start(getState().eq, request.equalize, request.boost)
    if (alreadyAsked) return
    starting
      .then(() => {
        if (!wanted || !pipeline.running) return
        audioLevels.attach(pipeline.analyser)
        api.reportPipeline({ running: true })
      })
      .catch((error: unknown) => {
        pipeline.stop()
        audioLevels.attach(null)
        api.reportPipeline({ running: false, error: error instanceof Error ? error.message : String(error) })
      })
  })
  // Band and preamp changes apply straight away, without going through the main process.
  let lastEq = getState().eq
  subscribeState(() => {
    const eq = getState().eq
    if (eq === lastEq) return
    lastEq = eq
    pipeline.apply(eq)
  })
}

void window.musicWidget.getInitialState().then((initial) => {
  initStore(initial)
  connectStore()
  connectMusicEq(initial.testCableInput)
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>
  )
})
