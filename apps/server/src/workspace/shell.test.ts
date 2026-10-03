// Shell runner tests (POSIX `sh` syntax only: CI runs Linux, where `/bin/sh` may be dash). Every kill is proven with
// `process.kill(pid, 0)` throwing ESRCH; temp folders are canonical (`realpath(mkdtemp())`).
import type { ShellRunResult } from './shell.ts'
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { WORKSPACE_LIMITS } from '@harness-forge/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  capturedText,
  killLiveShellGroups,
  killProcessGroup,
  liveShellGroups,
  normalizeTerminalText,
  omissionMarker,
  pickShell,
  redactShellCommand,
  runShellCommand,
  shellBinary,
  shrinkCaptured,
  StreamCapture,
} from './shell.ts'

const posix = process.platform !== 'win32'
const temps: string[] = []
let cwd: string

async function tempFolder(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'hf-')))
  temps.push(dir)
  return dir
}

beforeEach(async () => {
  cwd = await tempFolder()
})

afterEach(async () => {
  // A failed test must not leave `sleep 30` behind.
  killLiveShellGroups()
  for (const dir of temps.splice(0))
    await rm(dir, { recursive: true, force: true })
})

/** The error code of `process.kill(pid, 0)`, or null while the process exists. */
function probe(pid: number): string | null {
  try {
    process.kill(pid, 0)
    return null
  }
  catch (error) {
    return (error as NodeJS.ErrnoException).code ?? 'unknown'
  }
}

/** Waits until `process.kill(pid, 0)` throws ESRCH (an orphan is reaped by init a moment after it died). */
async function expectGone(pid: number, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms
  while (probe(pid) === null && Date.now() < deadline)
    await delay(20)
  expect(probe(pid)).toBe('ESRCH')
}

/** Polls `path` until it holds `count` pids (one per line). */
async function readPids(path: string, count = 1, ms = 3000): Promise<number[]> {
  const deadline = Date.now() + ms
  for (;;) {
    const text = await readFile(path, 'utf8').catch(() => '')
    const pids = text.split('\n').map(line => Number.parseInt(line, 10)).filter(pid => Number.isInteger(pid) && pid > 0)
    if (pids.length >= count)
      return pids
    if (Date.now() > deadline)
      throw new Error(`no pids in ${path}`)
    await delay(20)
  }
}

function run(command: string, options: Partial<Parameters<typeof runShellCommand>[0]> = {}): Promise<ShellRunResult> {
  return runShellCommand({ command, cwd, timeoutMs: 10_000, ...options })
}

function out(result: ShellRunResult): string {
  return capturedText(result.stdout)
}

function err(result: ShellRunResult): string {
  return capturedText(result.stderr)
}

describe.skipIf(!posix)('runShellCommand', () => {
  it('runs a command in cwd and returns exit code 0 with stdout', async () => {
    const result = await run('echo hello; pwd')
    expect(result).toMatchObject({ exitCode: 0, signal: null, timedOut: false, stoppedBackground: false })
    expect(out(result)).toBe(`hello\n${cwd}\n`)
    expect(err(result)).toBe('')
    expect(result.stdout.totalBytes).toBe(Buffer.byteLength(`hello\n${cwd}\n`))
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(liveShellGroups()).toEqual([])
  })

  it('keeps stderr and a non-zero exit code', async () => {
    const result = await run('echo out; echo oops 1>&2; exit 3')
    expect(result).toMatchObject({ exitCode: 3, signal: null, timedOut: false })
    expect(out(result)).toBe('out\n')
    expect(err(result)).toBe('oops\n')
    expect(result.stderr.totalBytes).toBe(5)
  })

  it('has no stdin', async () => {
    const result = await run('cat; echo done')
    expect(out(result)).toBe('done\n')
  })

  it('uses bash when it is executable, else sh', () => {
    expect(pickShell(() => true)).toBe('/bin/bash')
    expect(pickShell(() => false)).toBe('/bin/sh')
    expect(['/bin/bash', '/bin/sh']).toContain(shellBinary())
  })

  it('stops a command at the timeout and returns a normal result', async () => {
    let pid = 0
    const started = Date.now()
    const result = await run('sleep 5', {
      timeoutMs: 300,
      onSpawn: (value) => {
        pid = value
      },
    })
    expect(result.timedOut).toBe(true)
    expect(result.exitCode).toBeNull()
    expect(result.signal).toBe('SIGTERM')
    expect(Date.now() - started).toBeLessThan(4000)
    await expectGone(pid)
    expect(liveShellGroups()).toEqual([])
  })

  it('escalates to SIGKILL when the group ignores SIGTERM', async () => {
    const started = Date.now()
    const result = await run('trap "" TERM; sleep 30 & echo $! > pid; wait', { timeoutMs: 300, killGraceMs: 300 })
    expect(result.timedOut).toBe(true)
    expect(result.signal).toBe('SIGKILL')
    expect(Date.now() - started).toBeLessThan(5000)
    const [child] = await readPids(join(cwd, 'pid'))
    await expectGone(child!)
  })

  it('kills the whole group on abort and rejects with an AbortError', async () => {
    const controller = new AbortController()
    let pid = 0
    const pending = run('sleep 30 & echo $! > pid; sleep 30', {
      signal: controller.signal,
      onSpawn: (value) => {
        pid = value
      },
    })
    const [child] = await readPids(join(cwd, 'pid'))
    expect(probe(pid)).toBeNull()
    expect(probe(child!)).toBeNull()
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(probe(pid)).toBe('ESRCH')
    await expectGone(child!)
    expect(liveShellGroups()).toEqual([])
  })

  it('rejects at once for a signal that is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(run('echo never > ran', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    await expect(readFile(join(cwd, 'ran'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('returns quickly when a background process keeps the pipes open, and stops it', async () => {
    const started = Date.now()
    const result = await run('sleep 30 & echo $!')
    expect(Date.now() - started).toBeLessThan(4000)
    expect(result).toMatchObject({ exitCode: 0, timedOut: false, stoppedBackground: true })
    const pid = Number.parseInt(out(result), 10)
    expect(pid).toBeGreaterThan(0)
    await expectGone(pid)
  })

  it('stops a background process that does not hold the pipes', async () => {
    const result = await run('sleep 30 > /dev/null 2>&1 & echo $!')
    expect(result).toMatchObject({ exitCode: 0, stoppedBackground: true })
    await expectGone(Number.parseInt(out(result), 10))
  })

  it('kills every process of a group (several background children)', async () => {
    const result = await run('for i in 1 2 3; do sleep 30 & echo $! >> pids; done; wait', { timeoutMs: 500 })
    expect(result.timedOut).toBe(true)
    for (const pid of await readPids(join(cwd, 'pids'), 3))
      await expectGone(pid)
  })

  it('caps each stream at the first 4 KiB and the last 16 KiB', async () => {
    // 5000 lines of 11 bytes = 55000 bytes per stream.
    const script = 'awk \'BEGIN { for (i = 0; i < 5000; i++) printf "line %05d\\n", i }\''
    const result = await run(`${script}; ${script} 1>&2`)
    const omitted = 55_000 - WORKSPACE_LIMITS.shellStreamHeadBytes - WORKSPACE_LIMITS.shellStreamTailBytes
    expect(omitted).toBe(34_520)
    for (const [stream, text] of [[result.stdout, out(result)], [result.stderr, err(result)]] as const) {
      expect(stream.totalBytes).toBe(55_000)
      expect(stream.omittedBytes).toBe(omitted)
      expect(text.startsWith('line 00000\nline 00001\n')).toBe(true)
      expect(text.endsWith('line 04998\nline 04999\n')).toBe(true)
      expect(text).toContain(`\n${omissionMarker(omitted)}\n`)
      expect(text).toContain('[… 34520 bytes omitted …]')
      expect(Buffer.byteLength(text)).toBeLessThan(WORKSPACE_LIMITS.shellStreamHeadBytes + WORKSPACE_LIMITS.shellStreamTailBytes + 100)
    }
  })

  it('takes injected caps', async () => {
    const result = await run('printf "abcdefghijklmnopqrstuvwxyz"', { headBytes: 3, tailBytes: 4 })
    expect(out(result)).toBe('abc\n[… 19 bytes omitted …]\nwxyz')
  })

  it('passes only the allowlisted environment', async () => {
    const parentEnv = {
      HOME: '/home/someone',
      PATH: process.env.PATH,
      LANG: 'C.UTF-8',
      HF_PASSWORD: 'hunter2-secret',
      HF_MASTER_KEY: 'master-key-value',
      OPENAI_API_KEY: 'sk-test-0123456789',
      NODE_ENV: 'production',
      TERM: 'xterm-256color',
    }
    const result = await run('env', { parentEnv, shell: '/bin/sh' })
    const env = out(result)
    expect(env).not.toContain('HF_PASSWORD')
    expect(env).not.toContain('hunter2-secret')
    expect(env).not.toContain('HF_MASTER_KEY')
    expect(env).not.toContain('OPENAI_API_KEY')
    expect(env).not.toContain('sk-test-0123456789')
    expect(env).not.toContain('NODE_ENV')
    for (const line of ['HOME=/home/someone', 'LANG=C.UTF-8', 'SHELL=/bin/sh', 'TERM=dumb', 'NO_COLOR=1', 'PAGER=cat', 'GIT_PAGER=cat', 'GIT_TERMINAL_PROMPT=0'])
      expect(env.split('\n')).toContain(line)
  })

  it('never passes HF_* or provider keys from the real process environment', async () => {
    const saved = { HF_PASSWORD: process.env.HF_PASSWORD, OPENAI_API_KEY: process.env.OPENAI_API_KEY }
    process.env.HF_PASSWORD = 'injected-password-1'
    process.env.OPENAI_API_KEY = 'sk-injected-0123456789'
    try {
      const env = out(await run('env'))
      expect(env).not.toContain('injected-password-1')
      expect(env).not.toContain('sk-injected-0123456789')
      expect(env).not.toMatch(/^HF_/m)
    }
    finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined)
          delete process.env[key]
        else
          process.env[key] = value
      }
    }
  })

  it('strips ANSI codes and collapses carriage-return progress lines', async () => {
    const result = await run('printf "\\033[31mred\\033[0m\\n"; printf "10%%\\r50%%\\r100%%\\n"; printf "a\\r\\nb\\n"')
    expect(out(result)).toBe('red\n100%\na\nb\n')
  })

  it('rejects when the shell cannot start', async () => {
    await expect(run('echo hi', { cwd: join(cwd, 'missing') })).rejects.toThrow(/The shell could not be started/)
    expect(liveShellGroups()).toEqual([])
  })

  it('the process-exit handler SIGKILLs live groups', async () => {
    let pid = 0
    const pending = run('sleep 30', {
      onSpawn: (value) => {
        pid = value
      },
    })
    await delay(100)
    expect(liveShellGroups()).toContain(pid)
    expect(process.listeners('exit')).toContain(killLiveShellGroups)
    killLiveShellGroups()
    const result = await pending
    expect(result).toMatchObject({ exitCode: null, signal: 'SIGKILL', timedOut: false })
    await expectGone(pid)
    expect(liveShellGroups()).toEqual([])
  })

  it('kills the groups of a server process that exits', async () => {
    const shellUrl = pathToFileURL(fileURLToPath(new URL('./shell.ts', import.meta.url))).href
    const script = join(cwd, 'exit-script.mjs')
    await writeFile(script, [
      `import { existsSync } from 'node:fs'`,
      `import process from 'node:process'`,
      `import { runShellCommand } from ${JSON.stringify(shellUrl)}`,
      `void runShellCommand({ command: 'sleep 30 & echo $! > pid; sleep 30', cwd: process.argv[2], timeoutMs: 60000, onSpawn: pid => console.log('group ' + pid) }).catch(() => {})`,
      `const timer = setInterval(() => { if (existsSync(process.argv[2] + '/pid')) { clearInterval(timer); process.exit(0) } }, 20)`,
    ].join('\n'))
    const serverRoot = fileURLToPath(new URL('../..', import.meta.url))
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', script, cwd], { cwd: serverRoot, stdio: ['ignore', 'pipe', 'pipe'] })
      let text = ''
      const collect = (chunk: string): void => {
        text += chunk
      }
      child.stdout.setEncoding('utf8').on('data', collect)
      child.stderr.setEncoding('utf8').on('data', collect)
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error(`the script did not exit: ${text}`))
      }, 30_000)
      child.once('close', () => {
        clearTimeout(timer)
        resolve(text)
      })
    })
    const group = Number.parseInt(output.match(/group (\d+)/)?.[1] ?? '', 10)
    expect(group, output).toBeGreaterThan(0)
    const [child] = await readPids(join(cwd, 'pid'))
    await expectGone(group)
    await expectGone(child!)
  }, 40_000)
})

describe.skipIf(!posix)('killProcessGroup', () => {
  it('resolves true for a group that does not exist', async () => {
    // 2^22 + 1 is beyond the default pid range of Linux (2^22) and macOS (99998).
    await expect(killProcessGroup(4_194_305, { graceMs: 50 })).resolves.toBe(true)
  })
})

describe('normalizeTerminalText', () => {
  it.each([
    ['\u001B[1;32mgreen\u001B[0m', 'green'],
    ['\u001B]0;title\u0007text', 'text'],
    ['\u001B]8;;https://example.com\u001B\\link\u001B]8;;\u001B\\', 'link'],
    ['\u001B(Bplain\u001B=', 'plain'],
    ['\u009B2Kcleared', 'cleared'],
    ['a\r\nb\r\n', 'a\nb\n'],
    ['a\r\r\nb', 'a\nb'],
    ['10%\r20%\r100%\ndone', '100%\ndone'],
    ['progress\r', 'progress'],
    ['tab\tkept\u0007\u0000\u0008', 'tab\tkept'],
    ['unicode é ✓', 'unicode é ✓'],
  ])('%j -> %j', (input, expected) => {
    expect(normalizeTerminalText(input)).toBe(expected)
  })
})

describe('stream capture', () => {
  it('keeps everything below the caps', () => {
    const capture = new StreamCapture(4, 4)
    capture.push('abc')
    capture.push(Buffer.from('defgh'))
    expect(capture.finish()).toEqual({ head: 'abcdefgh', tail: '', omittedBytes: 0, totalBytes: 8 })
  })

  it('keeps the head and the tail across many chunks', () => {
    const capture = new StreamCapture(3, 5)
    for (const chunk of ['ab', 'cd', 'ef', 'gh', 'ij', 'kl'])
      capture.push(chunk)
    const output = capture.finish()
    expect(output).toEqual({ head: 'abc', tail: 'hijkl', omittedBytes: 4, totalBytes: 12 })
    expect(capturedText(output)).toBe('abc\n[… 4 bytes omitted …]\nhijkl')
  })

  it('cuts on UTF-8 boundaries (no replacement characters)', () => {
    const capture = new StreamCapture(4, 4)
    capture.push('ééééé') // 10 bytes: the head keeps 2 characters (4 bytes)
    capture.push('x') // the last 4 bytes start inside an "é": the tail keeps "éx" (3 bytes)
    const output = capture.finish()
    expect(output).toEqual({ head: 'éé', tail: 'éx', omittedBytes: 4, totalBytes: 11 })
    expect(capturedText(output)).not.toContain('�')
  })

  it('normalizes a CRLF split between chunks', () => {
    const capture = new StreamCapture()
    capture.push('a\r')
    capture.push('\nb')
    expect(capturedText(capture.finish())).toBe('a\nb')
  })
})

describe('shrinkCaptured', () => {
  it('drops bytes from the middle of a whole stream', () => {
    const shrunk = shrinkCaptured({ head: '0123456789', tail: '', omittedBytes: 0, totalBytes: 10 }, 5)
    expect(shrunk).toEqual({ head: '0', tail: '6789', omittedBytes: 5, totalBytes: 10 })
  })

  it('grows the omitted count of a cut stream', () => {
    const shrunk = shrinkCaptured({ head: 'abcde', tail: '0123456789', omittedBytes: 100, totalBytes: 115 }, 5)
    expect(shrunk.head.length + shrunk.tail.length).toBe(10)
    expect(shrunk.omittedBytes).toBe(105)
    expect('abcde'.startsWith(shrunk.head)).toBe(true)
    expect('0123456789'.endsWith(shrunk.tail)).toBe(true)
  })

  it('can empty a stream', () => {
    const shrunk = shrinkCaptured({ head: 'abc', tail: '', omittedBytes: 0, totalBytes: 3 }, 50)
    expect(shrunk).toEqual({ head: '', tail: '', omittedBytes: 3, totalBytes: 3 })
    expect(capturedText(shrunk)).toBe('[… 3 bytes omitted …]\n')
  })
})

describe('redactShellCommand', () => {
  it('masks secrets and cuts long commands', () => {
    expect(redactShellCommand('OPENAI_API_KEY=sk-abc123456789xyz curl -H "Authorization: Bearer abcdefgh12345678" x')).not.toMatch(/sk-abc|abcdefgh12345678/)
    expect(redactShellCommand('ls -la')).toBe('ls -la')
    expect(redactShellCommand('x'.repeat(5000))).toHaveLength(1003)
  })
})
