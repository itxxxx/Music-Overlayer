import { app } from 'electron'
import { existsSync } from 'node:fs'
import path from 'node:path'

/** Files shipped in /resources: next to the app when packaged, in the project folder during development. */
export function resourcePath(name: string): string {
  if (app.isPackaged) {
    const packaged = path.join(process.resourcesPath, name)
    if (existsSync(packaged)) return packaged
  }
  return path.join(app.getAppPath(), 'resources', name)
}

export function systemExecutable(...segments: string[]): string {
  const root = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows'
  return path.join(root, ...segments)
}
