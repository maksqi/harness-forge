// The command hook runner (W11.1-T3): the shell runner's options, the output caps (a real `sh` process in a
// `realpath(mkdtemp())` folder, POSIX syntax), the timeout bounds and the start failure.
import type { RunShellOptions, ShellRunResult } from '../../workspace/shell.ts'
import { Buffer } from 'node:buffer'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { LIMITS } from '@harness-forge/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { HOOK_START_ERROR, hookTimeoutMs, runCommandHook, utf8Head } from './runner.ts'

const posix = process.platform !== 'win32'
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup()
})

async function folder(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'hf-')))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

function signal(): AbortSignal {
  return new AbortController().signal
}

describe('command hook runner', () => {
  it('passes the payload, the environment, the timeout and the stdout cap to the shell runner', async () => {
    let seen: RunShellOptions | null = null
    const run = async (options: RunShellOptions): Promise<ShellRunResult> => {
      seen = options
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stoppedBackground: false,
        durationMs: 7,
        stdout: { head: '{"continue":true}', tail: '', omittedBytes: 0, totalBytes: 17 },
        stderr: { head: '', tail: '', omittedBytes: 0, totalBytes: 0 },
        endCwd: null,
      }
    }
    const controller = new AbortController()
    const result = await runCommandHook(
      { command: 'sh hook.sh', cwd: '/srv/project', timeoutMs: 5000, payload: '{"a":1}', env: { HARNESS_PROJECT_DIR: '/srv/project' }, signal: controller.signal },
      { run, killGraceMs: 100 },
    )
    expect(seen).toMatchObject({
      command: 'sh hook.sh',
      cwd: '/srv/project',
      timeoutMs: 5000,
      input: '{"a":1}',
      env: { HARNESS_PROJECT_DIR: '/srv/project' },
      signal: controller.signal,
      headBytes: LIMITS.hookStdoutBytes,
      tailBytes: 0,
      killGraceMs: 100,
    })
    expect(result).toEqual({
      process: { exitCode: 0, timedOut: false, stdout: '{"continue":true}', stdoutTruncated: false, stderr: '' },
      durationMs: 7,
      startError: null,
    })
  })

  it.skipIf(!posix)('keeps the first 64 KiB of stdout and 16 KiB of stderr', async () => {
    const dir = await folder()
    await writeFile(join(dir, 'big.sh'), [
      'cat > /dev/null',
      'dd if=/dev/zero bs=1024 count=100 2>/dev/null | tr \'\\000\' \'a\'',
      'dd if=/dev/zero bs=1024 count=30 2>/dev/null | tr \'\\000\' \'b\' >&2',
      '',
    ].join('\n'))
    const result = await runCommandHook({ command: 'sh big.sh', cwd: dir, timeoutMs: 10_000, payload: '{}', env: {}, signal: signal() })
    expect(result.startError).toBeNull()
    expect(result.process.exitCode).toBe(0)
    expect(Buffer.byteLength(result.process.stdout)).toBe(LIMITS.hookStdoutBytes)
    expect(result.process.stdoutTruncated).toBe(true)
    expect(Buffer.byteLength(result.process.stderr)).toBe(LIMITS.hookStderrBytes)
    expect(result.process.stderr).toMatch(/^b+$/)
  })

  it.skipIf(!posix)('a hook that cannot start is a start error; an abort rejects', async () => {
    const dir = await folder()
    const missing = await runCommandHook({ command: 'true', cwd: join(dir, 'missing'), timeoutMs: 1000, payload: '{}', env: {}, signal: signal() })
    expect(missing).toMatchObject({ startError: HOOK_START_ERROR, process: { exitCode: null, timedOut: false, stdout: '', stderr: '' } })
    // A reserved variable is refused before anything is spawned.
    const reserved = await runCommandHook({ command: 'true', cwd: dir, timeoutMs: 1000, payload: '{}', env: { PATH: '/tmp' }, signal: signal() })
    expect(reserved.startError).toBe(HOOK_START_ERROR)
    const controller = new AbortController()
    controller.abort(new DOMException('Stopped.', 'AbortError'))
    await expect(runCommandHook({ command: 'true', cwd: dir, timeoutMs: 1000, payload: '{}', env: {}, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('timeouts: the hook\'s seconds, else 60 s, at most 600 s', () => {
    expect(hookTimeoutMs(null)).toBe(LIMITS.hookTimeoutDefaultMs)
    expect(hookTimeoutMs(undefined)).toBe(60_000)
    expect(hookTimeoutMs(5)).toBe(5000)
    expect(hookTimeoutMs(1.2)).toBe(2000)
    expect(hookTimeoutMs(10_000)).toBe(LIMITS.hookTimeoutMaxMs)
    expect(hookTimeoutMs(0)).toBe(60_000)
  })

  it('utf8Head never cuts a character', () => {
    expect(utf8Head('abc', 10)).toBe('abc')
    expect(utf8Head('aé', 2)).toBe('a')
    expect(utf8Head('a😀', 4)).toBe('a')
    expect(utf8Head('a😀', 5)).toBe('a😀')
  })
})
