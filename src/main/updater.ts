import { app, net, shell } from 'electron'
import type { UpdateStatus } from '../shared/types'
import { log } from './log'

/** First look a little after start-up (the app has enough to do then), then every few hours. */
const FIRST_CHECK_MS = 20_000
const CHECK_EVERY_MS = 6 * 60 * 60_000
const RELEASES_PAGE = 'https://github.com/itxxxx/Music-Overlayer/releases/latest'
const LATEST_RELEASE_API = 'https://api.github.com/repos/itxxxx/Music-Overlayer/releases/latest'

/** Whether version `a` (like "1.10.0") is newer than `b`. */
export function isNewer(a: string, b: string): boolean {
  const parse = (version: string): number[] => version.replace(/^v/i, '').split(/[.-]/).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0)
  const [x, y] = [parse(a), parse(b)]
  for (let i = 0; i < 3; i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  }
  return false
}

type Updater = typeof import('electron-updater').autoUpdater

interface UpdaterOptions {
  onStatus(status: UpdateStatus): void
}

/**
 * Updates from the GitHub releases (electron-updater reads latest.yml there). The installed app
 * downloads a new version by itself and installs it on "Restart to update", or the next time it
 * quits. The portable app can't replace itself: it only says a new version is out and opens the
 * download page. Running from source, there's nothing to update.
 */
export class AppUpdater {
  private status: UpdateStatus
  private updater: Updater | null = null
  private timer: NodeJS.Timeout | null = null
  private manual = false
  private readonly portable = Boolean(process.env.PORTABLE_EXECUTABLE_FILE)
  /** For tests: pretend this version is downloaded and ready. */
  private readonly fake = process.env.MUSIC_OVERLAYER_FAKE_UPDATE

  constructor(private readonly options: UpdaterOptions) {
    this.status = this.fake ? { state: 'idle' } : app.isPackaged && process.platform === 'win32' ? { state: 'idle' } : { state: 'unsupported' }
  }

  get current(): UpdateStatus {
    return this.status
  }

  start(): void {
    if (this.fake) {
      this.timer = setTimeout(() => this.set({ state: 'ready', version: this.fake ?? '' }), 1500)
      return
    }
    if (this.status.state === 'unsupported') return
    this.timer = setTimeout(() => {
      void this.check(false)
      this.timer = setInterval(() => void this.check(false), CHECK_EVERY_MS)
    }, FIRST_CHECK_MS)
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** Looks for a new version now (from the menu). */
  async check(manual = true): Promise<void> {
    const state = this.status.state
    if (state === 'unsupported' || state === 'checking' || state === 'downloading' || state === 'ready') return
    if (this.fake) return
    this.manual = manual
    try {
      if (this.portable) await this.checkPortable()
      else await (await this.load()).checkForUpdates()
    } catch (error) {
      this.failed(error)
    }
  }

  /** Installs the downloaded version (restarting the app), or opens the download page. */
  install(): void {
    if (this.status.state === 'available') {
      void shell.openExternal(RELEASES_PAGE)
      return
    }
    if (this.status.state !== 'ready') return
    log('update', `installing ${this.status.version}`)
    if (this.fake || !this.updater) return
    // Silent install, then start the new version.
    this.updater.quitAndInstall(true, true)
  }

  /** The portable app only asks GitHub which release is the newest. */
  private async checkPortable(): Promise<void> {
    this.set({ state: 'checking', manual: this.manual })
    const response = await net.fetch(LATEST_RELEASE_API, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Music-Overlayer' }
    })
    if (!response.ok) throw new Error(`GitHub answered ${response.status}`)
    const release = (await response.json()) as { tag_name?: unknown }
    const latest = String(release.tag_name ?? '').replace(/^v/i, '')
    if (latest && isNewer(latest, app.getVersion())) {
      log('update', `version ${latest} is out (portable: download by hand)`)
      this.set({ state: 'available', version: latest })
    } else {
      this.set(this.manual ? { state: 'latest', version: app.getVersion() } : { state: 'idle' })
    }
  }

  private async load(): Promise<Updater> {
    if (this.updater) return this.updater
    // A separate file, loaded only when needed: the app starts without it, and running from
    // source it isn't loaded at all.
    const { autoUpdater } = await import('electron-updater')
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.allowPrerelease = false
    autoUpdater.logger = {
      info: () => undefined,
      warn: (message: unknown) => log('update', `warning: ${String(message)}`),
      error: (message: unknown) => log('update', `error: ${String(message)}`),
      debug: () => undefined
    }
    autoUpdater.on('checking-for-update', () => this.set({ state: 'checking', manual: this.manual }))
    autoUpdater.on('update-not-available', () => {
      log('update', `up to date (${app.getVersion()})`)
      this.set(this.manual ? { state: 'latest', version: app.getVersion() } : { state: 'idle' })
    })
    autoUpdater.on('update-available', (info) => {
      log('update', `version ${info.version} is out, downloading`)
      this.set({ state: 'downloading', version: info.version, percent: 0 })
    })
    autoUpdater.on('download-progress', (progress) => {
      if (this.status.state !== 'downloading') return
      const percent = Math.round(progress.percent)
      if (percent !== this.status.percent) this.set({ ...this.status, percent })
    })
    autoUpdater.on('update-downloaded', (info) => {
      log('update', `version ${info.version} downloaded, ready to install`)
      this.set({ state: 'ready', version: info.version })
    })
    autoUpdater.on('error', (error) => this.failed(error))
    this.updater = autoUpdater
    return autoUpdater
  }

  private failed(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    log('update', `failed: ${message.split('\n')[0]}`)
    // A failed check in the background isn't worth a message; one asked for is.
    this.set(this.manual ? { state: 'error', message: "Couldn't check for updates" } : { state: 'idle' })
  }

  private set(status: UpdateStatus): void {
    if (JSON.stringify(status) === JSON.stringify(this.status)) return
    this.status = status
    this.options.onStatus(status)
  }
}
