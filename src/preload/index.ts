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
  onMediaRefused: (listener) => subscribe('media:refused', listener),
  sendMediaCommand: (command) => ipcRenderer.send('media:command', command),
  setBoost: (appId, boost) => ipcRenderer.send('media:boost', appId, boost),

  setInteractive: (interactive) => ipcRenderer.send('widget:interactive', interactive),
  pointerSeen: () => ipcRenderer.send('widget:pointer-seen'),
  alive: () => ipcRenderer.send('widget:alive'),
  setHitRect: (rect) => ipcRenderer.send('widget:hit-rect', rect),
  setPointerActive: (active) => ipcRenderer.send('widget:pointer-active', active),
  startDrag: () => ipcRenderer.send('widget:drag-start'),
  endDrag: () => ipcRenderer.send('widget:drag-end'),
  showMenu: () => ipcRenderer.send('widget:menu'),
  onDirection: (listener) => subscribe('widget:direction', listener),
  onPointer: (listener) => subscribe('widget:pointer', listener),
  onCommand: (listener) => subscribe('widget:command', listener),
  onSettings: (listener) => subscribe('settings:changed', listener),
  onVisibility: (listener) => subscribe('widget:visibility', listener),
  requestAudioCapture: () => ipcRenderer.send('audio:start'),
  reportNoSystemAudio: () => ipcRenderer.send('audio:no-system-audio'),

  eq: {
    apply: (settings) => ipcRenderer.invoke('eq:apply', settings),
    install: () => ipcRenderer.invoke('eq:install'),
    connect: () => ipcRenderer.invoke('eq:connect'),
    refreshStatus: () => ipcRenderer.invoke('eq:status'),
    openDownloadPage: () => ipcRenderer.send('eq:download'),
    onStatus: (listener) => subscribe('eq:status', listener)
  },

  musicEq: {
    install: () => ipcRenderer.invoke('music-eq:install'),
    recheck: () => ipcRenderer.send('music-eq:recheck'),
    openDownloadPage: () => ipcRenderer.send('music-eq:download'),
    onStatus: (listener) => subscribe('music-eq:status', listener),
    onPipeline: (listener) => subscribe('music-eq:pipeline', listener),
    reportPipeline: (state) => ipcRenderer.send('music-eq:pipeline-state', state)
  }
}

contextBridge.exposeInMainWorld('musicWidget', api)
