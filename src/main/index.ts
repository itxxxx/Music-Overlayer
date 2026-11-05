import {
  Menu,
  Tray,
  app,
  desktopCapturer,
  ipcMain,
  nativeImage,
  session,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent
} from 'electron'
import { sanitizeEq } from '../shared/eq'
import { togglePlayer, type PlayerFilter } from '../shared/apps'
import { APP_NAME, type EqStatus, type InitialState, type MediaCommand, type MediaSession, type WidgetSettings } from '../shared/types'
import { DOWNLOAD_URL, EqualizerApo } from './eq/equalizer-apo'
import { MusicEqController } from './eq/music-eq'
import { CABLE_PAGE } from './eq/virtual-cable'
import { MediaHub, type MediaMode } from './media/media-hub'
import { buildMenu, type MenuContext } from './menu'
import { resourcePath } from './paths'
import { SettingsStore } from './settings'
import { WidgetWindow } from './widget-window'

const isWindows = process.platform === 'win32'
const forceDemo = process.env.MUSIC_OVERLAYER_DEMO === '1'

// The visualizer starts its audio context without a click.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
if (isWindows) {
  // The visualizer hears system audio through screen-capture loopback and drops the video track
  // straight away. Skipping Windows Graphics Capture keeps Windows from drawing a capture border.
  app.commandLine.appendSwitch('disable-features', 'AllowWgcScreenCapturer,AllowWgcWindowCapturer')
}

const COMMAND_TYPES = new Set(['toggle', 'play', 'pause', 'next', 'prev', 'cycle-session', 'seek', 'shuffle', 'repeat', 'volume', 'mute'])

function isMediaCommand(value: unknown): value is MediaCommand {
  if (typeof value !== 'object' || value === null) return false
  const command = value as { type?: unknown; positionMs?: unknown; value?: unknown }
  if (typeof command.type !== 'string' || !COMMAND_TYPES.has(command.type)) return false
  if (command.type === 'seek') return typeof command.positionMs === 'number' && Number.isFinite(command.positionMs)
  if (command.type === 'shuffle' || command.type === 'mute') return typeof command.value === 'boolean'
  if (command.type === 'repeat') return command.value === 'none' || command.value === 'track' || command.value === 'list'
  if (command.type === 'volume') return typeof command.value === 'number' && command.value >= 0 && command.value <= 1
  return true
}

function trayTooltip(media: MediaSession | null): string {
  if (!media || !media.title) return APP_NAME
  const text = media.artist ? `${media.title} – ${media.artist}` : media.title
  return text.length > 120 ? `${text.slice(0, 119)}…` : text
}

async function main(): Promise<void> {
  await app.whenReady()
  if (isWindows) app.setAppUserModelId('com.itx.musicoverlayer')
  Menu.setApplicationMenu(null)

  const settings = new SettingsStore(app.getPath('userData'))
  await settings.load()

  const widget = new WidgetWindow({
    getPosition: () => settings.get().position,
    savePosition: (position) => settings.update({ position }),
    onDirectionChange: (direction) => widget.send('widget:direction', direction),
    onVisibilityChange: (visible) => {
      if (visible) startAudioCapture()
    }
  })
  const media = new MediaHub({ filter: settings.get().players, onlineCovers: settings.get().widget.onlineCovers })
  let tray: Tray | null = null
  let eqStatus: EqStatus
  const apo = new EqualizerApo({
    onStatus: (status) => {
      eqStatus = status
      widget.send('eq:status', status)
      refreshTray()
    },
    getInstalledAt: () => settings.get().apoInstalledAt,
    setInstalledAt: (time) => settings.update({ apoInstalledAt: time })
  })

  /** Re-detects the engine and links the widget to it, unless the user unlinked it. */
  const refreshEq = async (): Promise<EqStatus> => {
    let status = await apo.detect()
    if (status.installed && !status.connected && !settings.get().apoUnlinked) status = await apo.connect(settings.get().eq)
    if (status.connected) status = await apo.apply(settings.get().eq)
    return status
  }
  // The music-only equalizer: VB-CABLE plus the window's own audio path.
  const musicEq = new MusicEqController({
    isWindows: isWindows || process.env.MUSIC_OVERLAYER_FAKE_CABLE === '1',
    media,
    getEq: () => settings.get().eq,
    getRoutedApps: () => settings.get().routedApps,
    setRoutedApps: (routedApps) => settings.update({ routedApps }),
    getCableInstalledAt: () => settings.get().cableInstalledAt,
    setCableInstalledAt: (cableInstalledAt) => settings.update({ cableInstalledAt }),
    onStatus: (status) => widget.send('music-eq:status', status),
    setPipeline: (run) => widget.send('music-eq:pipeline', run),
    setDeviceBypass: (reason) => void apo.setBypass(reason)
  })

  // Before Equalizer APO's file is first written: in music-only mode it must stay flat.
  musicEq.update()
  eqStatus = await refreshEq()

  const mediaMode = (): MediaMode => (settings.get().widget.demo || !isWindows || forceDemo ? 'demo' : 'windows')
  const canStartAtLogin = isWindows && app.isPackaged
  const isOwnSender = (event: IpcMainEvent | IpcMainInvokeEvent): boolean =>
    Boolean(widget.win && !widget.win.isDestroyed() && event.sender === widget.win.webContents)

  function startAudioCapture(): void {
    // Hidden, the widget doesn't listen at all; it starts again when it's shown.
    if (!isWindows || !settings.get().widget.visualizer || !widget.isVisible()) return
    const contents = widget.win?.webContents
    if (!contents || contents.isDestroyed()) return
    // Run with a user gesture: Chromium only grants screen/audio capture to user-initiated calls.
    contents.executeJavaScript('window.__musicWidgetStartAudio && window.__musicWidgetStartAudio()', true).catch(() => undefined)
  }

  const setVisible = (visible: boolean): void => {
    if (visible) widget.show()
    else widget.hide()
    settings.update({ hidden: !visible })
    refreshTray()
  }

  const updateSettings = (patch: Partial<WidgetSettings>): void => {
    const before = settings.get().widget
    const next = settings.updateWidget(patch)
    widget.send('settings:changed', next)
    if (next.demo !== before.demo) media.use(mediaMode())
    if (next.onlineCovers !== before.onlineCovers) media.setOnlineCovers(next.onlineCovers)
    if (next.visualizer && !before.visualizer) startAudioCapture()
    refreshTray()
  }

  const setPlayers = (players: PlayerFilter): void => {
    settings.update({ players })
    media.setFilter(players)
    refreshTray()
  }

  const menuContext = (): MenuContext => ({
    visible: widget.isVisible(),
    settings: settings.get().widget,
    eqStatus,
    players: settings.get().players,
    seenApps: media.seenApps,
    isWindows,
    canStartAtLogin,
    startAtLogin: canStartAtLogin && app.getLoginItemSettings().openAtLogin,
    toggleVisible: () => setVisible(!widget.isVisible()),
    openEqualizer: () => {
      setVisible(true)
      widget.send('widget:command', 'open-eq')
    },
    updateSettings,
    togglePlayer: (appId) => setPlayers(togglePlayer(settings.get().players, appId)),
    setBrowsers: (enabled) => setPlayers({ ...settings.get().players, browsers: enabled }),
    setStartAtLogin: (enabled) => {
      app.setLoginItemSettings({ openAtLogin: enabled })
      refreshTray()
    },
    openDevicePicker: () => void apo.openDevicePicker(),
    openApoEditor: () => void apo.openEditor(),
    unlinkApo: () => {
      settings.update({ apoUnlinked: true })
      void apo.disconnect()
    },
    resetPosition: () => widget.resetPosition(),
    quit: () => app.quit()
  })

  function refreshTray(): void {
    tray?.setContextMenu(buildMenu(menuContext()))
  }

  // System audio for the visualizer: answer the page's getDisplayMedia() with loopback audio.
  if (isWindows) {
    session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
      desktopCapturer
        .getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
        .then((sources) => {
          if (sources[0]) callback({ video: sources[0], audio: 'loopback' })
          else callback({})
        })
        .catch(() => callback({}))
    })
  }
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
    const own = Boolean(widget.win && contents === widget.win.webContents)
    callback(own && (permission === 'media' || permission === 'display-capture'))
  })
  // Device names (to find VB-CABLE's "CABLE Output") are only listed when this says yes.
  session.defaultSession.setPermissionCheckHandler((contents, permission) => {
    const own = Boolean(contents && widget.win && contents === widget.win.webContents)
    return own && (permission === 'media' || permission === 'display-capture')
  })

  media.on('session', (current) => {
    widget.send('media:session', current)
    tray?.setToolTip(trayTooltip(current))
  })
  media.on('cover', (cover) => widget.send('media:cover', cover))
  media.on('status', (status) => widget.send('media:status', status))
  media.on('apps', () => refreshTray())
  media.on('refused', (command) => widget.send('media:refused', { command, at: Date.now() }))
  media.use(mediaMode())

  ipcMain.handle('app:initial-state', (event): InitialState | null => {
    if (!isOwnSender(event)) return null
    return {
      platform: process.platform,
      settings: settings.get().widget,
      eq: settings.get().eq,
      eqStatus,
      musicEq: musicEq.current,
      testCableInput: process.env.MUSIC_OVERLAYER_FAKE_CABLE_INPUT || undefined,
      direction: widget.direction,
      media: { session: media.session, cover: media.cover, status: media.status }
    }
  })
  ipcMain.on('media:command', (event, command: unknown) => {
    if (isOwnSender(event) && isMediaCommand(command)) media.command(command)
  })
  ipcMain.on('widget:interactive', (event, interactive: unknown) => {
    if (isOwnSender(event)) widget.setInteractive(interactive === true)
  })
  ipcMain.on('widget:hit-rect', (event, rect: unknown) => {
    if (isOwnSender(event)) widget.setHitRect(rect as never)
  })
  ipcMain.on('widget:pointer-active', (event, active: unknown) => {
    if (isOwnSender(event)) widget.setPointerActive(active === true)
  })
  ipcMain.on('widget:drag-start', (event) => {
    if (isOwnSender(event)) widget.beginDrag()
  })
  ipcMain.on('widget:drag-end', (event) => {
    if (isOwnSender(event)) widget.endDrag()
  })
  ipcMain.on('widget:menu', (event) => {
    if (isOwnSender(event) && widget.win) buildMenu(menuContext()).popup({ window: widget.win })
  })
  ipcMain.handle('eq:apply', async (event, input: unknown) => {
    if (!isOwnSender(event)) return eqStatus
    const eq = sanitizeEq(input)
    settings.update({ eq })
    musicEq.update()
    eqStatus = await apo.apply(eq)
    return apo.current
  })
  ipcMain.handle('eq:connect', async (event) => {
    if (!isOwnSender(event)) return eqStatus
    settings.update({ apoUnlinked: false })
    return refreshEq()
  })
  ipcMain.handle('eq:status', async (event) => {
    if (!isOwnSender(event)) return eqStatus
    return refreshEq()
  })
  ipcMain.handle('eq:install', async (event) => {
    if (!isOwnSender(event)) return eqStatus
    settings.update({ apoUnlinked: false })
    await apo.installEngine()
    return refreshEq()
  })
  ipcMain.on('eq:download', (event) => {
    if (isOwnSender(event)) void shell.openExternal(DOWNLOAD_URL)
  })
  ipcMain.on('audio:start', (event) => {
    if (isOwnSender(event)) startAudioCapture()
  })
  ipcMain.handle('music-eq:install', async (event) => {
    if (!isOwnSender(event)) return musicEq.current
    return musicEq.install()
  })
  ipcMain.on('music-eq:recheck', (event) => {
    if (isOwnSender(event)) musicEq.recheck()
  })
  ipcMain.on('music-eq:pipeline-state', (event, state: unknown) => {
    if (!isOwnSender(event) || typeof state !== 'object' || state === null) return
    const { running, error } = state as { running?: unknown; error?: unknown }
    musicEq.setPipelineState(running === true, typeof error === 'string' ? error.slice(0, 300) : null)
  })
  ipcMain.on('music-eq:download', (event) => {
    if (isOwnSender(event)) void shell.openExternal(CABLE_PAGE)
  })

  const win = widget.create(!settings.get().hidden)
  win.webContents.on('did-finish-load', () => {
    startAudioCapture()
    // A reloaded window has no audio path yet; ask again if the music-only equalizer needs it.
    if (musicEq.pipelineRequested) widget.send('music-eq:pipeline', true)
  })
  // If the window dies, nothing carries VB-CABLE to the speakers: send the music back directly.
  win.webContents.on('render-process-gone', () => musicEq.windowGone())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => event.preventDefault())

  try {
    const icon = nativeImage.createFromPath(resourcePath(isWindows ? 'tray.ico' : 'tray.png'))
    tray = new Tray(icon)
    tray.setToolTip(trayTooltip(media.session))
    tray.on('click', () => setVisible(!widget.isVisible()))
    refreshTray()
  } catch (error) {
    console.warn('[tray] unavailable', error)
  }

  app.on('second-instance', () => setVisible(true))
  app.on('before-quit', () => {
    // Stopping the bridge also sends any routed player back to the normal output device.
    musicEq.dispose()
    settings.flush()
    media.stop()
    widget.dispose()
  })
  app.on('window-all-closed', () => app.quit())
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  main().catch((error) => {
    console.error('[music-overlayer] failed to start', error)
    app.quit()
  })
}
