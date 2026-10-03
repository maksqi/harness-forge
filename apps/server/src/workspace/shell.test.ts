// Shell runner tests (POSIX `sh` syntax only: CI runs Linux, where `/bin/sh` may be dash). Every kill is proven with
// `process.kill(pid, 0)` throwing ESRCH; temp folders are canonical (`realpath(mkdtemp())`). The end folder report
// (`reportCwd`, ADR-038) runs under `/bin/sh`, `/bin/bash` and `/bin/dash`, whichever exist.
import type { ShellRunResult } from './shell.ts'
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
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
  parseCwdReport,
  pickShell,
  redactShellCommand,
  runShellCommand,
  SHELL_CWD_TRAP,
  shellBinary,
  shrinkCaptured,
  StreamCapture,
  withCwdReport,
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

/** The shells of this host the end folder report is checked under: `/bin/sh` (dash on Debian), bash, dash. */
const REPORT_SHELLS = posix ? ['/bin/sh', '/bin/bash', '/bin/dash'].filter(isExecutable) : []

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  }
  catch {
    return false
  }
}

describe.skipIf(!posix)('the end folder report (reportCwd)', () => {
  it('runs under every shell of this host', () => {
    expect(REPORT_SHELLS).toContain('/bin/sh')
  })

  describe.each(REPORT_SHELLS.map(shell => [shell] as const))('%s', (shell) => {
    function report(command: string, options: Partial<Parameters<typeof runShellCommand>[0]> = {}): Promise<ShellRunResult> {
      return run(command, { shell, reportCwd: true, ...options })
    }

    beforeEach(async () => {
      await mkdir(join(cwd, 'sub', 'deep'), { recursive: true })
    })

    it('reports the folder after a normal end, `exit N` and a `set -e` failure, keeping the exit status', async () => {
      await expect(report('cd sub')).resolves.toMatchObject({ exitCode: 0, endCwd: join(cwd, 'sub') })
      await expect(report('ls > /dev/null')).resolves.toMatchObject({ exitCode: 0, endCwd: cwd })
      await expect(report('cd sub; exit 3')).resolves.toMatchObject({ exitCode: 3, endCwd: join(cwd, 'sub') })
      const failed = await report('set -e; cd sub/deep; false; echo never')
      expect(failed).toMatchObject({ exitCode: 1, endCwd: join(cwd, 'sub', 'deep') })
      expect(out(failed)).toBe('')
      const output = await report('cd sub && pwd && echo err 1>&2')
      expect(out(output)).toBe(`${join(cwd, 'sub')}\n`)
      expect(err(output)).toBe('err\n')
    })

    it('reports the physical folder (links resolved)', async () => {
      await symlink(join(cwd, 'sub', 'deep'), join(cwd, 'link'))
      await expect(report('cd link')).resolves.toMatchObject({ endCwd: join(cwd, 'sub', 'deep') })
    })

    it('leaves the folder unchanged after a subshell or a cd in a pipeline', async () => {
      await expect(report('(cd sub)')).resolves.toMatchObject({ exitCode: 0, endCwd: cwd })
      await expect(report('cd sub | cat')).resolves.toMatchObject({ exitCode: 0, endCwd: cwd })
    })

    it('reports nothing after exec, the command\'s own EXIT trap or a syntax error', async () => {
      await expect(report('cd sub && exec true')).resolves.toMatchObject({ exitCode: 0, endCwd: null })
      const trapped = await report('trap \'echo mine\' EXIT; cd sub')
      expect(trapped).toMatchObject({ exitCode: 0, endCwd: null })
      expect(out(trapped)).toBe('mine\n')
      await expect(report('cd sub; if then')).resolves.toMatchObject({ endCwd: null })
    })

    it('reports nothing after a timeout kill (whether or not the trap ran)', async () => {
      const result = await report('cd sub; sleep 5', { timeoutMs: 300 })
      expect(result).toMatchObject({ timedOut: true, exitCode: null, endCwd: null })
    })

    it('rejects an aborted command as before', async () => {
      const controller = new AbortController()
      const pending = report('cd sub; sleep 30', { signal: controller.signal })
      await delay(100)
      controller.abort()
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
      expect(liveShellGroups()).toEqual([])
    })

    it('keeps the exit status and stays silent when the command closes fd 3', async () => {
      const result = await report('exec 3>&-; cd sub; exit 4')
      expect(result).toMatchObject({ exitCode: 4, endCwd: null })
      expect(err(result)).toBe('')
    })

    it('uses the last line on fd 3 (the trap writes last), from the last 4 KiB', async () => {
      await expect(report('echo /tmp >&3; cd sub')).resolves.toMatchObject({ endCwd: join(cwd, 'sub') })
      const flood = 'awk \'BEGIN { for (i = 0; i < 2000; i++) printf "xxxxx"; printf "\\n" }\' >&3'
      await expect(report(`${flood}; cd sub`)).resolves.toMatchObject({ endCwd: join(cwd, 'sub') })
      // Text without a final newline joins the trap's line: nothing usable, the folder stays.
      await expect(report('printf x >&3; cd sub')).resolves.toMatchObject({ exitCode: 0, endCwd: null })
    })

    it('keeps the error messages and line numbers of the command (the trap shares its first line)', async () => {
      const command = 'true\nhf_no_such_command_x\ncd sub'
      const plain = await run(command, { shell })
      const reported = await report(command)
      expect(err(plain)).toMatch(/hf_no_such_command_x/)
      expect(err(reported)).toBe(err(plain))
      expect(reported.exitCode).toBe(plain.exitCode)
      expect(reported.endCwd).toBe(join(cwd, 'sub'))
    })

    it('never resolves cd through CDPATH from the server environment', async () => {
      const elsewhere = await tempFolder()
      await mkdir(join(elsewhere, 'only-there'))
      const result = await report('cd only-there', { parentEnv: { PATH: process.env.PATH, CDPATH: elsewhere } })
      expect(result.exitCode).not.toBe(0)
      expect(result.endCwd).toBe(cwd)
      expect(out(result)).toBe('')
    })
  })

  it('without reportCwd: the command runs as given, fd 3 is not open and nothing is reported', async () => {
    await mkdir(join(cwd, 'sub'))
    const result = await run('cd sub; echo x >&3', { shell: '/bin/sh' })
    expect(result.endCwd).toBeNull()
    expect(result.exitCode).not.toBe(0)
    expect(withCwdReport('ls')).toBe(`${SHELL_CWD_TRAP}ls`)
    expect(SHELL_CWD_TRAP).toBe('trap \'pwd -P 2>/dev/null >&3\' EXIT; ')
  })

  it('never finds a program through an empty or relative PATH entry', async () => {
    await mkdir(join(cwd, 'bin'))
    for (const name of ['hf-probe-a', 'bin/hf-probe-b']) {
      await writeFile(join(cwd, name), '#!/bin/sh\necho planted\n')
      await chmod(join(cwd, name), 0o755)
    }
    const parentEnv = { PATH: `:.:bin:${process.env.PATH ?? ''}` }
    for (const command of ['hf-probe-a', 'hf-probe-b']) {
      const result = await run(command, { parentEnv, shell: '/bin/sh' })
      expect(result.exitCode, command).toBe(127)
      expect(out(result)).toBe('')
    }
  })
})

describe('parseCwdReport', () => {
  it.each([
    ['/a/b\n', '/a/b'],
    ['/a/b', '/a/b'],
    ['junk\n/a/b\n\n', '/a/b'],
    ['/x\n/a b/c\n', '/a b/c'],
    ['', null],
    ['\n', null],
    ['relative/path\n', null],
    ['/a\nb\n', null],
    ['/a\0b\n', null],
  ])('%j -> %j', (text, expected) => {
    expect(parseCwdReport(Buffer.from(text))).toBe(expected)
  })
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
