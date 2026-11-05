import { promises as fs, writeFileSync, renameSync } from 'node:fs'
import path from 'node:path'
import { DEFAULT_EQ, clamp, sanitizeEq } from '../shared/eq'
import { DEFAULT_PLAYER_FILTER, sanitizePlayerFilter, type PlayerFilter } from '../shared/apps'
import { DEFAULT_WIDGET_SETTINGS, type EqSettings, type PillPosition, type WidgetSettings } from '../shared/types'

export interface StoredState {
  position: PillPosition | null
  hidden: boolean
  widget: WidgetSettings
  eq: EqSettings
  /** Which apps the widget shows. */
  players: PlayerFilter
  /** The user unlinked the widget from Equalizer APO; don't link it again on our own. */
  apoUnlinked: boolean
  /** When the widget installed Equalizer APO (a restart is needed after that). */
  apoInstalledAt: number | null
}

function defaults(): StoredState {
  return {
    position: null,
    hidden: false,
    widget: { ...DEFAULT_WIDGET_SETTINGS },
    eq: sanitizeEq(DEFAULT_EQ),
    players: { ...DEFAULT_PLAYER_FILTER },
    apoUnlinked: false,
    apoInstalledAt: null
  }
}

function num(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? clamp(value, min, max) : fallback
}

export function sanitizeWidgetSettings(input: unknown, base: WidgetSettings = DEFAULT_WIDGET_SETTINGS): WidgetSettings {
  const raw = (typeof input === 'object' && input !== null ? input : {}) as Partial<WidgetSettings>
  return {
    idleOpacity: num(raw.idleOpacity, base.idleOpacity, 0.2, 1),
    idleDelayMs: num(raw.idleDelayMs, base.idleDelayMs, 1000, 30000),
    hoverDelayMs: num(raw.hoverDelayMs, base.hoverDelayMs, 0, 2000),
    visualizer: typeof raw.visualizer === 'boolean' ? raw.visualizer : base.visualizer,
    demo: typeof raw.demo === 'boolean' ? raw.demo : base.demo
  }
}

function sanitize(input: unknown): StoredState {
  const raw = (typeof input === 'object' && input !== null ? input : {}) as Partial<StoredState>
  const position =
    raw.position && Number.isFinite(raw.position.cx) && Number.isFinite(raw.position.cy)
      ? { cx: raw.position.cx, cy: raw.position.cy }
      : null
  return {
    position,
    hidden: raw.hidden === true,
    widget: sanitizeWidgetSettings(raw.widget),
    eq: sanitizeEq(raw.eq ?? DEFAULT_EQ),
    players: sanitizePlayerFilter(raw.players),
    apoUnlinked: raw.apoUnlinked === true,
    apoInstalledAt: typeof raw.apoInstalledAt === 'number' && Number.isFinite(raw.apoInstalledAt) ? raw.apoInstalledAt : null
  }
}

/** Small JSON settings file in the user's app data folder. */
export class SettingsStore {
  private readonly file: string
  private state: StoredState = defaults()
  private saveTimer: NodeJS.Timeout | null = null

  constructor(directory: string) {
    this.file = path.join(directory, 'settings.json')
  }

  async load(): Promise<void> {
    try {
      this.state = sanitize(JSON.parse(await fs.readFile(this.file, 'utf8')))
    } catch {
      this.state = defaults()
    }
  }

  get(): StoredState {
    return this.state
  }

  update(patch: Partial<StoredState>): void {
    this.state = { ...this.state, ...patch }
    this.scheduleSave()
  }

  updateWidget(patch: Partial<WidgetSettings>): WidgetSettings {
    this.state = { ...this.state, widget: sanitizeWidgetSettings({ ...this.state.widget, ...patch }) }
    this.scheduleSave()
    return this.state.widget
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.save()
    }, 400)
  }

  private async save(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true })
      const temp = `${this.file}.tmp`
      await fs.writeFile(temp, JSON.stringify(this.state, null, 2), 'utf8')
      await fs.rename(temp, this.file)
    } catch (error) {
      console.error('[settings] save failed', error)
    }
  }

  /** Synchronous save for app shutdown. */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    try {
      const temp = `${this.file}.tmp`
      writeFileSync(temp, JSON.stringify(this.state, null, 2), 'utf8')
      renameSync(temp, this.file)
    } catch (error) {
      console.error('[settings] flush failed', error)
    }
  }
}
