import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { WidgetApi } from '../shared/api'

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: T): void => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}

const api: WidgetApi = {
  platform: process.platform,
  getInitialState: () => ipcRenderer.invoke('app:initial-state'),

  onMediaSession: (listener) => subscribe('media:session', listener),
  onMediaCover: (listener) => subscribe('media:cover', listener),
  onBridgeStatus: (listener) => subscribe('media:status', listener),
  sendMediaCommand: (command) => ipcRenderer.send('media:command', command),

  setInteractive: (interactive) => ipcRenderer.send('widget:interactive', interactive),
  setHitRect: (rect) => ipcRenderer.send('widget:hit-rect', rect),
  setPointerActive: (active) => ipcRenderer.send('widget:pointer-active', active),
  startDrag: () => ipcRenderer.send('widget:drag-start'),
  endDrag: () => ipcRenderer.send('widget:drag-end'),
  showMenu: () => ipcRenderer.send('widget:menu'),
  onDirection: (listener) => subscribe('widget:direction', listener),
  onPointer: (listener) => subscribe('widget:pointer', listener),
  onCommand: (listener) => subscribe('widget:command', listener),
  onSettings: (listener) => subscribe('settings:changed', listener),
  requestAudioCapture: () => ipcRenderer.send('audio:start'),

  eq: {
    apply: (settings) => ipcRenderer.invoke('eq:apply', settings),
    install: () => ipcRenderer.invoke('eq:install'),
    connect: () => ipcRenderer.invoke('eq:connect'),
    refreshStatus: () => ipcRenderer.invoke('eq:status'),
    openDownloadPage: () => ipcRenderer.send('eq:download'),
    onStatus: (listener) => subscribe('eq:status', listener)
  }
}

contextBridge.exposeInMainWorld('musicWidget', api)
