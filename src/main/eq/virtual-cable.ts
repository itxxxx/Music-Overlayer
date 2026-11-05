import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { app, net } from 'electron'
import { runElevated, runPowerShell } from '../system'

/**
 * VB-CABLE (VB-Audio, donationware) adds a virtual output device, "CABLE Input", whose sound
 * comes out of a virtual recording device, "CABLE Output". The music-only equalizer sends the
 * music app to CABLE Input, equalizes CABLE Output and plays it on the real speakers.
 */

/** VB-Audio's official driver pack. */
const CABLE_DOWNLOADS = ['https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack45.zip']
/** VB-Audio's page, offered if the automatic setup can't run. */
export const CABLE_PAGE = 'https://vb-audio.com/Cable/'

async function download(): Promise<Buffer> {
  let lastError: unknown = null
  for (const url of CABLE_DOWNLOADS) {
    try {
      const response = await net.fetch(url)
      if (!response.ok) throw new Error(`the server answered ${response.status}`)
      const data = Buffer.from(await response.arrayBuffer())
      // A zip file starts with "PK"; anything else is an error page.
      if (data.length < 100_000 || data[0] !== 0x50 || data[1] !== 0x4b) throw new Error('the download was not a zip file')
      return data
    } catch (error) {
      lastError = error
    }
  }
  throw new Error(`Couldn't download VB-CABLE (${lastError instanceof Error ? lastError.message : 'no connection'}).`)
}

/**
 * Downloads VB-CABLE and runs its setup as administrator. Windows asks for permission, then asks
 * to allow the driver. Resolves when the setup closes.
 */
export async function installCable(): Promise<void> {
  if (process.platform !== 'win32') throw new Error('VB-CABLE is for Windows.')
  const folder = path.join(app.getPath('temp'), 'music-overlayer-vbcable')
  await fs.rm(folder, { recursive: true, force: true })
  await fs.mkdir(folder, { recursive: true })
  try {
    const zip = path.join(folder, 'VBCABLE_Driver_Pack.zip')
    await fs.writeFile(zip, await download())
    const unpack = await runPowerShell('Expand-Archive -LiteralPath $env:MO_ZIP -DestinationPath $env:MO_DIR -Force', {
      MO_ZIP: zip,
      MO_DIR: folder
    })
    if (unpack.code !== 0) throw new Error(`Couldn't unpack VB-CABLE (${unpack.stderr.trim().split(/\r?\n/)[0] || unpack.code}).`)
    const setup = ['VBCABLE_Setup_x64.exe', 'VBCABLE_Setup.exe'].map((name) => path.join(folder, name)).find((file) => existsSync(file))
    if (!setup) throw new Error("VB-CABLE's download didn't contain its setup program.")
    // -i installs, -h keeps the setup window hidden. Windows still asks to allow the driver.
    await runElevated(setup, ['-i', '-h'])
  } finally {
    await fs.rm(folder, { recursive: true, force: true }).catch(() => undefined)
  }
}
