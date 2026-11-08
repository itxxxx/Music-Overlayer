import { app } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'

/** The log is started over (the old one kept as main.old.log) once it passes this size. */
const MAX_BYTES = 512 * 1024
const SIZE_CHECK_MS = 60_000

let chain: Promise<void> = Promise.resolve()
let lastSizeCheck = 0

/**
 * A small log at %APPDATA%\Music Overlayer\logs\main.log: start-ups, media bridge restarts,
 * window hangs and the like, so a rare problem can be traced after the fact. No song titles.
 */
export function log(scope: string, message: string): void {
  const text = message.replace(/\s+/g, ' ').trim().slice(0, 600)
  const line = `${new Date().toISOString()} [${scope}] ${text}\n`
  if (!app.isPackaged) console.info(line.trimEnd())
  chain = chain.then(() => append(line)).catch(() => undefined)
}

async function append(line: string): Promise<void> {
  const folder = path.join(app.getPath('userData'), 'logs')
  const file = path.join(folder, 'main.log')
  if (Date.now() - lastSizeCheck > SIZE_CHECK_MS) {
    lastSizeCheck = Date.now()
    await fs.mkdir(folder, { recursive: true })
    const size = await fs.stat(file).then((stats) => stats.size).catch(() => 0)
    if (size > MAX_BYTES) await fs.rename(file, path.join(folder, 'main.old.log')).catch(() => undefined)
  }
  await fs.appendFile(file, line, 'utf8')
}
