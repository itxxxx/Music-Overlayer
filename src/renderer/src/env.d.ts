/// <reference types="vite/client" />

import type { WidgetApi } from '../../shared/api'

declare global {
  interface Window {
    musicWidget: WidgetApi
    /** Called by the main process (with a user gesture) to start listening to system audio. */
    __musicWidgetStartAudio?: () => void
  }
}

export {}
