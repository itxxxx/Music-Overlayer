import { BrowserWindow, screen, type Point, type Rectangle } from 'electron'
import path from 'node:path'
import { APP_NAME, GEOMETRY, PILL_TOP, type ExpandDirection, type HitRect, type PillPosition } from '../shared/types'
import { log } from './log'

const EDGE_GAP = 8
/** Cursor checks: often near the widget, rarely when the cursor is far away or the widget is hidden. */
const POLL_NEAR_MS = 40
const POLL_FAR_MS = 250
const POLL_HIDDEN_MS = 500
const NEAR_DISTANCE = 140
const LEAVE_GRACE_MS = 250
const POINTER_HOLD_LIMIT_MS = 15_000
/** The page saw the pointer on the widget this recently: believe it over the cursor maths here. */
const PAGE_SAW_POINTER_MS = 800
/** A drag whose release was never seen ends by itself. */
const DRAG_LIMIT_MS = 60_000
/** The page checks in every 2 s while shown; this much silence means it hangs. */
const PAGE_SILENCE_MS = 12_000
/** The page still checks in but hasn't drawn a frame for this long. */
const PAGE_NO_PAINT_MS = 15_000

interface WidgetWindowOptions {
  getPosition(): PillPosition | null
  savePosition(position: PillPosition): void
  onDirectionChange?(direction: ExpandDirection): void
  onVisibilityChange?(visible: boolean): void
  /** The page stopped checking in while shown: it hangs and needs reloading. */
  onPageHung?(): void
  /** The page checks in but draws nothing while shown (the window shows nothing). */
  onPageNotPainting?(): void
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
  /** What the page itself says: the pointer is on the widget. */
  private pageHover = false
  private pageSawPointerAt = 0
  private cursorWhenPageSawIt: Point | null = null
  private lastDisagreementLog = 0
  private pageAliveAt = 0
  private pageHungReported = false
  private pagePaintedAt = 0
  private paintStallReported = false
  private pointerActive = false
  private pointerActiveSince = 0
  private dragging = false
  private dragStartedAt = 0
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

    // Starting hidden (from the tray): let the page sleep until it's shown.
    if (!showOnReady) win.webContents.setBackgroundThrottling(true)
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
    this.pageAlive(true)
    // Hidden, the page may sleep; shown, its animations and timers must run at full speed.
    this.win.webContents.setBackgroundThrottling(false)
    this.win.showInactive()
    this.win.setAlwaysOnTop(true, 'screen-saver')
    this.win.moveTop()
    this.send('widget:visibility', true)
    this.options.onVisibilityChange?.(true)
  }

  hide(): void {
    this.setInteractive(false)
    if (!this.win || this.win.isDestroyed()) return
    this.send('widget:visibility', false)
    this.win.webContents.setBackgroundThrottling(true)
    this.win.hide()
    this.options.onVisibilityChange?.(false)
  }

  setInteractive(interactive: boolean): void {
    if (!this.win || this.win.isDestroyed()) return
    this.outsideSince = 0
    if (interactive === this.interactive) return
    this.interactive = interactive
    if (interactive) this.win.setIgnoreMouseEvents(false)
    else this.win.setIgnoreMouseEvents(true, { forward: true })
  }

  /** The page's own view of the pointer, from its mouseenter and mouseleave. */
  setPageHover(hovered: boolean): void {
    this.pageHover = hovered
    if (hovered) this.pageSawPointer()
    this.setInteractive(hovered)
  }

  /** The page saw the pointer move over the widget. */
  pageSawPointer(): void {
    this.pageSawPointerAt = Date.now()
    this.cursorWhenPageSawIt = screen.getCursorScreenPoint()
  }

  /** The page checks in regularly, saying whether it drew a frame since; see PAGE_SILENCE_MS. */
  pageAlive(painted: boolean): void {
    this.pageAliveAt = Date.now()
    this.pageHungReported = false
    if (painted) {
      this.pagePaintedAt = this.pageAliveAt
      this.paintStallReported = false
    }
  }

  /** The page is about to be reloaded: forget what the old one said. */
  pageReset(): void {
    this.pageHover = false
    this.hitRect = null
    this.pointerActive = false
    this.endDrag()
    this.setInteractive(false)
    this.pageAlive(true)
  }

  setHitRect(rect: HitRect | null): void {
    const valid = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
    if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(valid)) {
      this.hitRect = null
      return
    }
    // The page measures in its own pixels. Should they ever differ from the window's (a zoomed
    // page, or a window Windows resized after a display change), scale them over.
    let scale = 1
    if (valid(rect.viewWidth) && rect.viewWidth > 0 && this.win && !this.win.isDestroyed()) {
      const ratio = this.win.getBounds().width / rect.viewWidth
      if (ratio > 0.25 && ratio < 4 && Math.abs(ratio - 1) > 0.01) scale = ratio
    }
    this.hitRect = { x: rect.x * scale, y: rect.y * scale, width: rect.width * scale, height: rect.height * scale }
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
    this.dragStartedAt = Date.now()
    if (this.dragTimer) clearInterval(this.dragTimer)
    this.dragTimer = setInterval(() => {
      if (!this.win || this.win.isDestroyed()) return
      if (Date.now() - this.dragStartedAt > DRAG_LIMIT_MS) {
        this.endDrag()
        return
      }
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
    const loop = (): void => {
      let delay = POLL_NEAR_MS
      try {
        delay = this.poll()
      } finally {
        this.pollTimer = setTimeout(loop, delay)
      }
    }
    this.pollTimer = setTimeout(loop, POLL_NEAR_MS)
  }

  private stopPolling(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer)
    this.pollTimer = null
  }

  /** Returns how long to wait before the next check. */
  private poll(): number {
    const win = this.win
    const rect = this.hitRect
    if (!win || win.isDestroyed() || !win.isVisible()) return POLL_HIDDEN_MS
    this.checkPageAlive()
    if (this.dragging || !rect) return POLL_NEAR_MS
    const point = screen.getCursorScreenPoint()
    const bounds = win.getBounds()
    const left = bounds.x + rect.x
    const top = bounds.y + rect.y
    const dx = Math.max(left - point.x, 0, point.x - (left + rect.width))
    const dy = Math.max(top - point.y, 0, point.y - (top + rect.height))
    const inside = dx <= 2 && dy <= 2

    if (inside) {
      this.outsideSince = 0
      if (!this.interactive) {
        this.setInteractive(true)
        this.send('widget:pointer', 'enter')
      }
      return POLL_NEAR_MS
    }
    const near = dx < NEAR_DISTANCE && dy < NEAR_DISTANCE
    // A held slider keeps the mouse; a press whose release was never seen stops counting after a while.
    const holding = this.pointerActive && Date.now() - this.pointerActiveSince < POINTER_HOLD_LIMIT_MS
    if (!this.interactive || holding) {
      this.outsideSince = 0
      return near || this.interactive ? POLL_NEAR_MS : POLL_FAR_MS
    }
    if (!this.outsideSince) this.outsideSince = Date.now()
    else if (Date.now() - this.outsideSince > LEAVE_GRACE_MS) {
      if (this.pageSeesPointer(point)) {
        // The maths here say the pointer left, the page says it's still on the widget. Trust
        // the page: taking the mouse away now would leave a widget that can't be clicked or
        // dragged. (Seen with some multi-monitor and scaling setups.)
        this.outsideSince = 0
        if (Date.now() - this.lastDisagreementLog > 60_000) {
          this.lastDisagreementLog = Date.now()
          log('widget', `pointer at ${point.x},${point.y} looks outside the widget (${Math.round(left)},${Math.round(top)} ${Math.round(rect.width)}x${Math.round(rect.height)}) but the page still sees it`)
        }
        return POLL_NEAR_MS
      }
      this.setInteractive(false)
      this.send('widget:pointer', 'leave')
    }
    return POLL_NEAR_MS
  }

  /** Whether the page has recently seen the pointer on the widget, and it hasn't moved since. */
  private pageSeesPointer(point: Point): boolean {
    if (!this.pageHover) return false
    if (Date.now() - this.pageSawPointerAt < PAGE_SAW_POINTER_MS) return true
    const seen = this.cursorWhenPageSawIt
    return seen !== null && Math.abs(seen.x - point.x) <= 1 && Math.abs(seen.y - point.y) <= 1
  }

  private checkPageAlive(): void {
    if (!this.pageAliveAt) return
    const now = Date.now()
    if (!this.pageHungReported && now - this.pageAliveAt >= PAGE_SILENCE_MS) {
      this.pageHungReported = true
      this.pageHover = false
      this.setInteractive(false)
      this.options.onPageHung?.()
      return
    }
    if (!this.paintStallReported && this.pagePaintedAt && now - this.pagePaintedAt >= PAGE_NO_PAINT_MS) {
      this.paintStallReported = true
      this.options.onPageNotPainting?.()
    }
  }
}
