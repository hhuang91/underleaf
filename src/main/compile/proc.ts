import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'

export interface RunOptions {
  cwd: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  /** Called for every complete line written to stdout or stderr. */
  onLine?: (line: string) => void
  /** Receives a function that terminates the whole process tree. */
  onSpawn?: (kill: () => void) => void
  maxOutputBytes?: number
}

export interface RunResult {
  /** Exit code, or null when the process was killed or could not start. */
  code: number | null
  /** stdout and stderr, interleaved in arrival order. */
  output: string
  timedOut: boolean
  spawnError: string | null
}

/** Kills a process together with its children (latexmk spawns the TeX engine). */
export function killTree(child: ChildProcess): void {
  if (child.pid == null || child.exitCode != null) return
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } catch {
      child.kill()
    }
    return
  }
  try {
    // The child was started detached, so its pid is also its process group id.
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      /* already gone */
    }
  }
}

export function runProcess(cmd: string, args: string[], opts: RunOptions): Promise<RunResult> {
  return new Promise((resolve) => {
    const maxBytes = opts.maxOutputBytes ?? 4 * 1024 * 1024
    let output = ''
    let timedOut = false
    let settled = false
    let timer: NodeJS.Timeout | null = null

    const finish = (code: number | null, spawnError: string | null): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve({ code, output, timedOut, spawnError })
    }

    // A JavaScript file can stand in for an executable: it is run with this
    // process's own runtime. The test-suite uses this for its fake TeX engine,
    // and it lets users wrap an engine in a script (UNDERLEAF_TECTONIC=wrapper.js).
    let env = opts.env
    if (/\.[cm]?js$/i.test(cmd)) {
      args = [cmd, ...args]
      cmd = process.execPath
      env = { ...(opts.env ?? process.env), ELECTRON_RUN_AS_NODE: '1' }
    }

    let child: ChildProcess
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        env,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (err) {
      finish(null, err instanceof Error ? err.message : String(err))
      return
    }

    opts.onSpawn?.(() => killTree(child))

    const attach = (stream: NodeJS.ReadableStream | null): void => {
      if (!stream) return
      const decoder = new TextDecoder('utf-8')
      let pending = ''
      stream.on('data', (chunk: Buffer) => {
        const text = decoder.decode(chunk, { stream: true })
        if (output.length < maxBytes) output += text
        if (!opts.onLine) return
        pending += text
        const lines = pending.split(/\r?\n|\r/)
        pending = lines.pop() ?? ''
        for (const line of lines) if (line.trim()) opts.onLine(line)
      })
      stream.on('end', () => {
        if (opts.onLine && pending.trim()) opts.onLine(pending)
      })
    }
    attach(child.stdout)
    attach(child.stderr)

    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true
        killTree(child)
      }, opts.timeoutMs)
    }

    child.once('error', (err) => finish(null, err.message))
    child.once('close', (code) => finish(code, null))
  })
}

/**
 * Returns a copy of the environment with `dir` prepended to PATH. On Windows
 * the variable may be spelled "Path"; a second "PATH" key would be ambiguous.
 */
export function envWithPath(base: NodeJS.ProcessEnv, dir: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  if (!dir) return env
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  env[key] = env[key] ? `${dir}${path.delimiter}${env[key]}` : dir
  return env
}
