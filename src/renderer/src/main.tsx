import '@fontsource-variable/manrope'
import './index.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { audioLevels } from './lib/audio-levels'
import { connectStore, initStore } from './lib/store'

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

void window.musicWidget.getInitialState().then((initial) => {
  initStore(initial)
  connectStore()
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>
  )
})
