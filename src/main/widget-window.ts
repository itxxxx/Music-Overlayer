import { BrowserWindow, screen, type Rectangle } from 'electron'
import path from 'node:path'
import { APP_NAME, GEOMETRY, PILL_TOP, type ExpandDirection, type HitRect, type PillPosition } from '../shared/types'

const EDGE_GAP = 8
const POLL_MS = 40
const LEAVE_GRACE_MS = 250
const POINTER_HOLD_LIMIT_MS = 15_000

interface WidgetWindowOptions {
  getPosition(): PillPosition | null
  savePosition(position: PillPosition): void
  onDirectionChange?(direction: ExpandDirection): void
}

/**
 * A transparent, always-on-top, click-through window. Only the pill/card inside it takes mouse
 * input: everywhere else clicks fall through to the apps underneath.
 *
 * The window is tall enough for the card to open above or below the pill, so it never has to
 * move or resize while animating.
 */
export class WidgetWindow {
  win: BrowserWindow | null = null
  direction: ExpandDirection = 'down'
  private hitRect: HitRect | null = null
  private interactive = false
  private pointerActive = false
  private pointerActiveSince = 0
  private dragging = false
  private dragOffset = { x: 0, y: 0 }
  private dragTimer: NodeJS.Timeout | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private outsideSince = 0

  constructor(private readonly options: WidgetWindowOptions) {}

  create(showOnReady: boolean): BrowserWindow {
    const centre = this.clampCentre(this.validSavedPosition() ?? this.defaultCentre())
    this.direction = this.directionFor(centre)

    const win = new BrowserWindow({
      ...this.boundsForCentre(centre),
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      // Clicking the widget must never steal focus from the app you're working in.
      focusable: false,
      // Keeps the widget out of Alt+Tab and the taskbar on Windows.
      type: process.platform === 'win32' ? 'toolbar' : undefined,
      title: APP_NAME,
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        spellcheck: false
      }
    })
    this.win = win
    win.setAlwaysOnTop(true, 'screen-saver')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    win.setIgnoreMouseEvents(true, { forward: true })

    win.once('ready-to-show', () => {
      if (showOnReady) this.show()
    })
    win.on('closed', () => {
      this.win = null
      this.stopPolling()
    })

    if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
    else void win.loadFile(path.join(__dirname, '../renderer/index.html'))

    screen.on('display-metrics-changed', this.onDisplaysChanged)
    screen.on('display-removed', this.onDisplaysChanged)
    this.startPolling()
    return win
  }

  send(channel: string, payload?: unknown): void {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(channel, payload)
  }

  isVisible(): boolean {
    return Boolean(this.win && !this.win.isDestroyed() && this.win.isVisible())
  }

  show(): void {
    if (!this.win || this.win.isDestroyed()) return
    this.win.showInactive()
    this.win.setAlwaysOnTop(true, 'screen-saver')
    this.win.moveTop()
  }

  hide(): void {
    this.setInteractive(false)
    this.win?.hide()
  }

  setInteractive(interactive: boolean): void {
    if (!this.win || this.win.isDestroyed()) return
    this.outsideSince = 0
    if (interactive === this.interactive) return
    this.interactive = interactive
    if (interactive) this.win.setIgnoreMouseEvents(false)
    else this.win.setIgnoreMouseEvents(true, { forward: true })
  }

  setHitRect(rect: HitRect | null): void {
    if (
      rect &&
      [rect.x, rect.y, rect.width, rect.height].every((value) => typeof value === 'number' && Number.isFinite(value))
    ) {
      this.hitRect = rect
    } else this.hitRect = null
  }

  setPointerActive(active: boolean): void {
    this.pointerActive = active
    this.pointerActiveSince = active ? Date.now() : 0
  }

  beginDrag(): void {
    if (!this.win || this.win.isDestroyed()) return
    const cursor = screen.getCursorScreenPoint()
    const bounds = this.win.getBounds()
    this.dragOffset = { x: cursor.x - bounds.x, y: cursor.y - bounds.y }
    this.dragging = true
    if (this.dragTimer) clearInterval(this.dragTimer)
    this.dragTimer = setInterval(() => {
      if (!this.win || this.win.isDestroyed()) return
      const point = screen.getCursorScreenPoint()
      const x = point.x - this.dragOffset.x
      const y = point.y - this.dragOffset.y
      const current = this.win.getBounds()
      if (current.x !== x || current.y !== y) {
        this.win.setBounds({ x, y, width: GEOMETRY.windowWidth, height: GEOMETRY.windowHeight })
      }
    }, 10)
  }

  endDrag(): void {
    if (this.dragTimer) clearInterval(this.dragTimer)
    this.dragTimer = null
    if (!this.dragging) return
    this.dragging = false
    this.settle()
  }

  resetPosition(): void {
    this.placeAt(this.defaultCentre())
  }

  dispose(): void {
    screen.removeListener('display-metrics-changed', this.onDisplaysChanged)
    screen.removeListener('display-removed', this.onDisplaysChanged)
    this.stopPolling()
    if (this.dragTimer) clearInterval(this.dragTimer)
  }

  // --- geometry ----------------------------------------------------------------------------

  private boundsForCentre(centre: PillPosition): Rectangle {
    return {
      x: Math.round(centre.cx - GEOMETRY.windowWidth / 2),
      y: Math.round(centre.cy - (PILL_TOP + GEOMETRY.pillHeight / 2)),
      width: GEOMETRY.windowWidth,
      height: GEOMETRY.windowHeight
    }
  }

  private centreForBounds(bounds: Rectangle): PillPosition {
    return { cx: bounds.x + GEOMETRY.windowWidth / 2, cy: bounds.y + PILL_TOP + GEOMETRY.pillHeight / 2 }
  }

  private workAreaFor(centre: PillPosition): Rectangle {
    return screen.getDisplayNearestPoint({ x: Math.round(centre.cx), y: Math.round(centre.cy) }).workArea
  }

  /** Keeps the pill (and the card's width) inside the screen's work area. */
  private clampCentre(centre: PillPosition): PillPosition {
    const area = this.workAreaFor(centre)
    const halfWidth = GEOMETRY.cardWidth / 2 + EDGE_GAP
    const halfHeight = GEOMETRY.pillHeight / 2 + EDGE_GAP
    return {
      cx: Math.min(Math.max(centre.cx, area.x + halfWidth), area.x + area.width - halfWidth),
      cy: Math.min(Math.max(centre.cy, area.y + halfHeight), area.y + area.height - halfHeight)
    }
  }

  /** Open the card towards the larger side of the screen. */
  private directionFor(centre: PillPosition): ExpandDirection {
    const area = this.workAreaFor(centre)
    return centre.cy > area.y + area.height / 2 ? 'up' : 'down'
  }

  private defaultCentre(): PillPosition {
    const area = screen.getPrimaryDisplay().workArea
    return {
      cx: area.x + area.width - GEOMETRY.cardWidth / 2 - 24,
      cy: area.y + GEOMETRY.pillHeight / 2 + 24
    }
  }

  private validSavedPosition(): PillPosition | null {
    const saved = this.options.getPosition()
    if (!saved) return null
    const onScreen = screen.getAllDisplays().some(({ workArea: a }) => {
      return saved.cx >= a.x && saved.cx <= a.x + a.width && saved.cy >= a.y && saved.cy <= a.y + a.height
    })
    return onScreen ? saved : null
  }

  private placeAt(centre: PillPosition): void {
    if (!this.win || this.win.isDestroyed()) return
    const clamped = this.clampCentre(centre)
    this.win.setBounds(this.boundsForCentre(clamped))
    this.options.savePosition(clamped)
    const direction = this.directionFor(clamped)
    if (direction !== this.direction) {
      this.direction = direction
      this.options.onDirectionChange?.(direction)
    }
  }

  private settle(): void {
    if (!this.win || this.win.isDestroyed()) return
    this.placeAt(this.centreForBounds(this.win.getBounds()))
  }

  private onDisplaysChanged = (): void => {
    if (!this.dragging) this.settle()
  }

  // --- hover detection ---------------------------------------------------------------------

  /**
   * While the window ignores the mouse, Chromium still gets forwarded mouse moves on Windows,
   * but this poll is a backstop: it notices the pointer entering the pill even if forwarding
   * misses it, and releases the mouse if the pointer has clearly left.
   */
  private startPolling(): void {
    this.stopPolling()
    this.pollTimer = setInterval(() => this.poll(), POLL_MS)
  }

  private stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
  }

  private poll(): void {
    const win = this.win
    const rect = this.hitRect
    if (!win || win.isDestroyed() || !win.isVisible() || this.dragging || !rect) return
    const point = screen.getCursorScreenPoint()
    const bounds = win.getBounds()
    const inside =
      point.x >= bounds.x + rect.x - 2 &&
      point.x <= bounds.x + rect.x + rect.width + 2 &&
      point.y >= bounds.y + rect.y - 2 &&
      point.y <= bounds.y + rect.y + rect.height + 2

    if (inside) {
      this.outsideSince = 0
      if (!this.interactive) {
        this.setInteractive(true)
        this.send('widget:pointer', 'enter')
      }
      return
    }
    // A held slider keeps the mouse; a press whose release was never seen stops counting after a while.
    const holding = this.pointerActive && Date.now() - this.pointerActiveSince < POINTER_HOLD_LIMIT_MS
    if (!this.interactive || holding) {
      this.outsideSince = 0
      return
    }
    if (!this.outsideSince) this.outsideSince = Date.now()
    else if (Date.now() - this.outsideSince > LEAVE_GRACE_MS) {
      this.setInteractive(false)
      this.send('widget:pointer', 'leave')
    }
  }
}
