import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { systemExecutable } from './paths'

function powershellPath(): string {
  const bundled = systemExecutable('System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return existsSync(bundled) ? bundled : 'powershell.exe'
}

/**
 * Runs a Windows PowerShell command and resolves with its exit code. Values travel in
 * environment variables (named in the command as $env:NAME), so no quoting can break it.
 */
export function runPowerShell(command: string, env: Record<string, string> = {}): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(powershellPath(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
      windowsHide: true,
      env: { ...process.env, ...env }
    })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => (stderr = (stderr + chunk.toString('utf8')).slice(-4000)))
    child.on('error', reject)
    child.on('exit', (code) => resolve({ code: code ?? 1, stderr }))
  })
}

/** Runs a program as administrator (Windows asks first) and resolves with its exit code once it closes. */
export async function runElevated(file: string, args: string[] = []): Promise<number> {
  const command = [
    '$arguments = @()',
    'if ($env:MO_ARGS) { $arguments = $env:MO_ARGS -split "`n" }',
    'if ($arguments.Count -gt 0) { $p = Start-Process -FilePath $env:MO_FILE -ArgumentList $arguments -Verb RunAs -Wait -PassThru }',
    'else { $p = Start-Process -FilePath $env:MO_FILE -Verb RunAs -Wait -PassThru }',
    'exit $p.ExitCode'
  ].join('; ')
  const { code, stderr } = await runPowerShell(command, { MO_FILE: file, MO_ARGS: args.join('\n') })
  // Saying no to Windows' permission prompt ends Start-Process with an error ("canceled by the user").
  if (code !== 0 && /cancel|annul/i.test(stderr)) throw new Error('Installation was cancelled.')
  return code
}
