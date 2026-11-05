import { execFile, spawn } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app, net, shell } from 'electron'
import { buildApoConfig, presetName } from '../../shared/eq'
import type { EqSettings, EqStatus } from '../../shared/types'
import { systemExecutable } from '../paths'

/**
 * Windows has no API for one app to equalize another app's sound; that takes an audio driver
 * component. Equalizer APO (free, open source) is that component. The widget installs it for the
 * user, then writes its bands to its own file in Equalizer APO's config folder and adds one
 * Include line to config.txt. Equalizer APO re-applies the files the moment they change.
 */

export const INCLUDE_FILE = 'music-overlayer-eq.txt'
/** Project page, offered if the automatic install can't run. */
export const DOWNLOAD_URL = 'https://sourceforge.net/projects/equalizerapo/'
/** Official Equalizer APO installer (64-bit), newest first. */
const ENGINE_DOWNLOADS = [
  'https://downloads.sourceforge.net/project/equalizerapo/1.4.2/EqualizerAPO-x64-1.4.2.exe',
  'https://sourceforge.net/projects/equalizerapo/files/1.4.2/EqualizerAPO-x64-1.4.2.exe/download',
  'https://sourceforge.net/projects/equalizerapo/files/latest/download'
]
const START_MARK = '# >>> Music Overlayer equalizer'
const END_MARK = '# <<< Music Overlayer equalizer'
const BLOCK_START = `${START_MARK} (added by Music Overlayer - delete these lines to unlink it)`
const INCLUDE_LINE = /^[ \t]*Include:[ \t]*music-overlayer-eq\.txt[ \t]*$/im
/** What earlier builds (named "Music Widget") wrote; replaced when linking. */
const LEGACY_MARKS: Array<[string, string]> = [['# >>> Music Widget equalizer', '# <<< Music Widget equalizer']]
const LEGACY_FILES = ['music-widget-eq.txt']

interface Location {
  configDir: string
  installDir: string | null
}

export interface EqualizerApoOptions {
  /** Called whenever the status changes. */
  onStatus(status: EqStatus): void
  /** When the widget last installed the engine (to know if a restart is still pending). */
  getInstalledAt(): number | null
  setInstalledAt(time: number): void
}

function readRegistry(key: string): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    const reg = systemExecutable('System32', 'reg.exe')
    execFile(existsSync(reg) ? reg : 'reg', ['query', key, '/reg:64'], { windowsHide: true, timeout: 5000 }, (error, stdout) => {
      if (error) return resolve({})
      const values: Record<string, string> = {}
      for (const line of stdout.split(/\r?\n/)) {
        const match = /^\s+(\S+)\s+REG_(?:EXPAND_)?SZ\s+(.*)$/.exec(line)
        if (match) values[match[1]] = match[2].trim()
      }
      resolve(values)
    })
  })
}

async function locate(): Promise<Location | null> {
  const override = process.env.MUSIC_OVERLAYER_APO_DIR
  if (override) return existsSync(path.join(override, 'config.txt')) ? { configDir: override, installDir: null } : null
  if (process.platform !== 'win32') return null

  const candidates: Location[] = []
  const registry = await readRegistry('HKLM\\SOFTWARE\\EqualizerAPO')
  if (registry.ConfigPath) candidates.push({ configDir: registry.ConfigPath, installDir: registry.InstallPath ?? null })
  if (registry.InstallPath) candidates.push({ configDir: path.join(registry.InstallPath, 'config'), installDir: registry.InstallPath })
  for (const base of [process.env.ProgramW6432, process.env.ProgramFiles, 'C:\\Program Files']) {
    if (base) candidates.push({ configDir: path.join(base, 'EqualizerAPO', 'config'), installDir: path.join(base, 'EqualizerAPO') })
  }
  return candidates.find((candidate) => existsSync(path.join(candidate.configDir, 'config.txt'))) ?? null
}

function describeError(error: unknown, directory: string): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code === 'EPERM' || code === 'EACCES') {
    return `Windows blocked writing to ${directory}. Give your account write access to that folder, or start Music Overlayer once as administrator.`
  }
  return `Couldn't update the equalizer: ${error instanceof Error ? error.message : String(error)}`
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Removes the marked blocks and Include lines for the given marks and files from config.txt text. */
function stripLinks(text: string, marks: Array<[string, string]>, files: string[]): string {
  let next = text
  for (const [start, end] of marks) {
    const block = new RegExp(`(\\r?\\n)?${escapeRegExp(start)}[^\\r\\n]*[\\s\\S]*?${escapeRegExp(end)}[^\\r\\n]*(\\r?\\n)?`, 'g')
    next = next.replace(block, (_match, before?: string, after?: string) => (before && after ? before : ''))
  }
  for (const file of files) {
    next = next.replace(new RegExp(`^[ \\t]*Include:[ \\t]*${escapeRegExp(file)}[ \\t]*(\\r?\\n|$)`, 'gim'), '')
  }
  return next
}

/** Downloads the official installer. SourceForge only redirects straight to the file for download tools, hence the user agent. */
async function downloadEngine(): Promise<string> {
  const target = path.join(app.getPath('temp'), 'EqualizerAPO-setup.exe')
  let lastError: unknown = null
  for (const url of ENGINE_DOWNLOADS) {
    try {
      const response = await net.fetch(url, { headers: { 'User-Agent': 'Wget/1.21.4' } })
      if (!response.ok) throw new Error(`the server answered ${response.status}`)
      const data = Buffer.from(await response.arrayBuffer())
      // A Windows program starts with "MZ"; anything else is an error page.
      if (data.length < 1_000_000 || data[0] !== 0x4d || data[1] !== 0x5a) throw new Error('the download was not an installer')
      await fs.writeFile(target, data)
      return target
    } catch (error) {
      lastError = error
    }
  }
  throw new Error(`Couldn't download Equalizer APO (${lastError instanceof Error ? lastError.message : 'no connection'}).`)
}

/** Runs an installer elevated and resolves with its exit code once it closes. */
function runElevated(file: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const powershell = systemExecutable('System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    // The path travels in an environment variable so no quoting can break the command.
    const command = '$p = Start-Process -FilePath $env:MW_SETUP -Verb RunAs -Wait -PassThru; exit $p.ExitCode'
    const child = spawn(existsSync(powershell) ? powershell : 'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      windowsHide: true,
      env: { ...process.env, MW_SETUP: file }
    })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
    child.on('error', reject)
    child.on('exit', (code) => {
      if (/cancel/i.test(stderr)) reject(new Error('Installation was cancelled.'))
      else resolve(code ?? 1)
    })
  })
}

export class EqualizerApo {
  private location: Location | null = null
  private installing = false
  private status: EqStatus = {
    supported: process.platform === 'win32' || Boolean(process.env.MUSIC_OVERLAYER_APO_DIR),
    installed: false,
    connected: false,
    installing: false,
    restartPending: false,
    configDir: null,
    canOpenEditor: false,
    error: null
  }
  private writing: Promise<void> | null = null
  private queued: EqSettings | null = null

  constructor(private readonly options: EqualizerApoOptions) {}

  get current(): EqStatus {
    return this.status
  }

  private restartPending(): boolean {
    const installedAt = this.options.getInstalledAt()
    if (!installedAt) return false
    const bootedAt = Date.now() - os.uptime() * 1000
    return bootedAt < installedAt
  }

  private set(patch: Partial<EqStatus>): EqStatus {
    const next: EqStatus = { ...this.status, ...patch, installing: this.installing, restartPending: this.restartPending() }
    const changed = JSON.stringify(next) !== JSON.stringify(this.status)
    this.status = next
    if (changed) this.options.onStatus(next)
    return next
  }

  async detect(): Promise<EqStatus> {
    const supported = process.platform === 'win32' || Boolean(process.env.MUSIC_OVERLAYER_APO_DIR)
    this.location = supported ? await locate() : null
    if (!this.location) {
      return this.set({ supported, installed: false, connected: false, configDir: null, canOpenEditor: false })
    }
    let connected = false
    try {
      connected = INCLUDE_LINE.test(await fs.readFile(path.join(this.location.configDir, 'config.txt'), 'utf8'))
    } catch {
      connected = false
    }
    const editor = this.location.installDir ? path.join(this.location.installDir, 'Editor.exe') : null
    return this.set({
      supported,
      installed: true,
      connected,
      configDir: this.location.configDir,
      canOpenEditor: Boolean(editor && existsSync(editor))
    })
  }

  /** Writes the widget's settings file. Rapid calls are coalesced so the last settings always win. */
  async apply(eq: EqSettings): Promise<EqStatus> {
    if (!this.location) return this.status
    this.queued = eq
    if (!this.writing) {
      this.writing = (async () => {
        while (this.queued) {
          const next = this.queued
          this.queued = null
          await this.write(next)
        }
      })().finally(() => {
        this.writing = null
      })
    }
    await this.writing
    return this.status
  }

  private async write(eq: EqSettings): Promise<void> {
    if (!this.location) return
    try {
      await fs.writeFile(path.join(this.location.configDir, INCLUDE_FILE), buildApoConfig(eq, presetName(eq)), 'utf8')
      if (this.status.error) this.set({ error: null })
    } catch (error) {
      this.set({ error: describeError(error, this.location.configDir) })
    }
  }

  /** Adds the Include line to Equalizer APO's config.txt (once). */
  async connect(eq: EqSettings): Promise<EqStatus> {
    await this.detect()
    if (!this.location) return this.status
    await this.apply(eq)
    if (this.status.error) return this.status
    const configDir = this.location.configDir
    const configFile = path.join(configDir, 'config.txt')
    try {
      const original = await fs.readFile(configFile, 'utf8')
      let text = stripLinks(original, LEGACY_MARKS, LEGACY_FILES)
      if (!INCLUDE_LINE.test(text)) {
        const eol = text.includes('\r\n') || !text.includes('\n') ? '\r\n' : '\n'
        const lead = text.length === 0 || text.endsWith('\n') ? '' : eol
        // Device/Channel reset so the overlay's bands apply to every device and channel,
        // whatever selection the lines above it made.
        const block = [BLOCK_START, 'Device: all', 'Channel: all', `Include: ${INCLUDE_FILE}`, END_MARK].join(eol)
        text = `${text}${lead}${block}${eol}`
      }
      if (text !== original) await fs.writeFile(configFile, text, 'utf8')
      await Promise.all(LEGACY_FILES.map((file) => fs.rm(path.join(configDir, file), { force: true }).catch(() => undefined)))
      return this.set({ connected: true, error: null })
    } catch (error) {
      return this.set({ error: describeError(error, this.location.configDir) })
    }
  }

  /** Removes what connect() added. The settings file itself is left in place. */
  async disconnect(): Promise<EqStatus> {
    if (!this.location) await this.detect()
    if (!this.location) return this.status
    const configFile = path.join(this.location.configDir, 'config.txt')
    try {
      const text = await fs.readFile(configFile, 'utf8')
      const next = stripLinks(text, [[START_MARK, END_MARK], ...LEGACY_MARKS], [INCLUDE_FILE, ...LEGACY_FILES])
      if (next !== text) await fs.writeFile(configFile, next, 'utf8')
      return this.set({ connected: false, error: null })
    } catch (error) {
      return this.set({ error: describeError(error, this.location.configDir) })
    }
  }

  /**
   * Downloads the official Equalizer APO installer and runs it (Windows asks for permission).
   * Its setup window lets the user tick the speakers/headphones to equalize.
   */
  async installEngine(): Promise<EqStatus> {
    if (process.platform !== 'win32' || this.installing) return this.status
    await this.detect()
    if (this.status.installed) return this.status
    this.installing = true
    this.set({ error: null })
    try {
      const file = await downloadEngine()
      const exitCode = await runElevated(file)
      await fs.rm(file, { force: true }).catch(() => undefined)
      await this.detect()
      if (this.status.installed) this.options.setInstalledAt(Date.now())
      else if (exitCode !== 0) throw new Error('Setup closed before Equalizer APO was installed.')
    } catch (error) {
      this.set({ error: error instanceof Error ? error.message : String(error) })
    } finally {
      this.installing = false
      this.set({})
    }
    return this.status
  }

  /** Equalizer APO's own device picker, to choose which speakers/headphones get the equalizer. */
  async openDevicePicker(): Promise<void> {
    if (!this.location?.installDir) return
    const configurator = path.join(this.location.installDir, 'Configurator.exe')
    if (existsSync(configurator)) await shell.openPath(configurator)
  }

  async openEditor(): Promise<void> {
    if (!this.location?.installDir) return
    const editor = path.join(this.location.installDir, 'Editor.exe')
    if (existsSync(editor)) await shell.openPath(editor)
  }
}
