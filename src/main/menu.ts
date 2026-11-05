import { Menu, type MenuItemConstructorOptions } from 'electron'
import { classifyPlayer, isPlayerAllowed, type PlayerFilter } from '../shared/apps'
import { APP_CREDIT, APP_NAME, type EqStatus, type WidgetSettings } from '../shared/types'

export interface MenuContext {
  visible: boolean
  settings: WidgetSettings
  eqStatus: EqStatus
  players: PlayerFilter
  /** Players seen since the app started. */
  seenApps: string[]
  isWindows: boolean
  canStartAtLogin: boolean
  startAtLogin: boolean
  toggleVisible(): void
  openEqualizer(): void
  updateSettings(patch: Partial<WidgetSettings>): void
  togglePlayer(appId: string): void
  setBrowsers(enabled: boolean): void
  setStartAtLogin(enabled: boolean): void
  openDevicePicker(): void
  openApoEditor(): void
  unlinkApo(): void
  resetPosition(): void
  quit(): void
}

const OPACITY_CHOICES = [0.5, 0.6, 0.75, 0.9]
const DELAY_CHOICES = [3000, 4000, 5000]

function playersMenu(ctx: MenuContext): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = ctx.seenApps.map((appId) => {
    const { name, kind } = classifyPlayer(appId)
    const suffix = kind === 'browser' ? ' (browser)' : kind === 'other' ? ' (not a music app)' : ''
    return {
      label: `${name}${suffix}`,
      type: 'checkbox' as const,
      checked: isPlayerAllowed(appId, ctx.players),
      click: () => ctx.togglePlayer(appId)
    }
  })
  if (items.length === 0) items.push({ label: 'Players show up here once they play something', enabled: false })
  items.push(
    { type: 'separator' },
    {
      label: 'Show browser tabs (SoundCloud, YouTube Music…)',
      type: 'checkbox',
      checked: ctx.players.browsers,
      click: (item) => ctx.setBrowsers(item.checked)
    }
  )
  return items
}

/** Used for both the tray icon and right-clicking the widget. */
export function buildMenu(ctx: MenuContext): Menu {
  const { settings, eqStatus } = ctx
  const template: MenuItemConstructorOptions[] = [
    { label: `${APP_NAME}, ${APP_CREDIT}`, enabled: false },
    { type: 'separator' },
    { label: ctx.visible ? 'Hide overlay' : 'Show overlay', click: () => ctx.toggleVisible() },
    { label: 'Equalizer…', click: () => ctx.openEqualizer() },
    { label: 'Players', submenu: playersMenu(ctx), enabled: ctx.isWindows && !settings.demo },
    { type: 'separator' },
    {
      label: 'Faded opacity',
      submenu: OPACITY_CHOICES.map((value) => ({
        label: `${Math.round(value * 100)}%`,
        type: 'radio' as const,
        checked: Math.abs(settings.idleOpacity - value) < 0.001,
        click: () => ctx.updateSettings({ idleOpacity: value })
      }))
    },
    {
      label: 'Fade after',
      submenu: DELAY_CHOICES.map((value) => ({
        label: `${value / 1000} seconds`,
        type: 'radio' as const,
        checked: settings.idleDelayMs === value,
        click: () => ctx.updateSettings({ idleDelayMs: value })
      }))
    },
    {
      label: 'Visualizer',
      type: 'checkbox',
      checked: settings.visualizer,
      click: (item) => ctx.updateSettings({ visualizer: item.checked })
    },
    {
      label: 'Find missing covers online',
      toolTip: "When a player shares no artwork, look it up by title and artist on Apple's iTunes Search.",
      type: 'checkbox',
      checked: settings.onlineCovers,
      enabled: ctx.isWindows && !settings.demo,
      click: (item) => ctx.updateSettings({ onlineCovers: item.checked })
    },
    {
      label: 'Demo tracks',
      type: 'checkbox',
      checked: settings.demo || !ctx.isWindows,
      enabled: ctx.isWindows,
      click: (item) => ctx.updateSettings({ demo: item.checked })
    }
  ]

  if (ctx.canStartAtLogin) {
    template.push({
      label: 'Start with Windows',
      type: 'checkbox',
      checked: ctx.startAtLogin,
      click: (item) => ctx.setStartAtLogin(item.checked)
    })
  }

  if (eqStatus.installed) {
    template.push({
      label: 'Equalizer engine',
      submenu: [
        { label: 'Choose speakers and headphones…', enabled: eqStatus.canOpenEditor, click: () => ctx.openDevicePicker() },
        { label: 'Open Equalizer APO editor', enabled: eqStatus.canOpenEditor, click: () => ctx.openApoEditor() },
        { type: 'separator' },
        { label: 'Unlink Music Overlayer', enabled: eqStatus.connected, click: () => ctx.unlinkApo() }
      ]
    })
  }

  template.push(
    { label: 'Reset position', click: () => ctx.resetPosition() },
    { type: 'separator' },
    { label: 'Quit Music Overlayer', click: () => ctx.quit() }
  )
  return Menu.buildFromTemplate(template)
}
