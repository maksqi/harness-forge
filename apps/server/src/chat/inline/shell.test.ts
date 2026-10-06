// `runCommandSpans` (W11.5-T2): spans run one after another in the project root with the project-dir variables, each
// within its timeout and all within the total budget (later spans skipped), outputs capped, the group killed on a
// timeout and on the run's abort. Real shells use POSIX `sh` syntax only, in `realpath(mkdtemp())` folders; every pid a
// test starts is asserted dead. Skipped on Windows (no process groups).
import type { RunShellOptions, ShellRunResult } from '../../workspace/shell.ts'
import { Buffer } from 'node:buffer'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { formatShellSpanOutput, LIMITS } from '@harness-forge/shared'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { killLiveShellGroups, runShellCommand } from '../../workspace/shell.ts'
import { runCommandSpans, SPAN_START_FAILED, spanEnvironment, spanResultOf } from './shell.ts'

const posix = process.platform !== 'win32'

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

async function expectGone(pid: number, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms
  while (probe(pid) === null && Date.now() < deadline)
    await delay(20)
  expect(probe(pid)).toBe('ESRCH')
}

async function readPids(path: string, count: number, ms = 3000): Promise<number[]> {
  const deadline = Date.now() + ms
  for (;;) {
    const text = await readFile(path, 'utf8').catch(() => '')
    const pids = text.split('\n').map(line => Number.parseInt(line, 10)).filter(pid => Number.isInteger(pid) && pid > 0)
    if (pids.length >= count)
      return pids
    if (Date.now() > deadline)
      throw new Error('no pids written')
    await delay(20)
  }
}

/** A finished shell result with the given streams. */
function shellResult(fields: Partial<ShellRunResult> & { out?: string, err?: string } = {}): ShellRunResult {
  const stream = (text: string) => ({ head: text, tail: '', omittedBytes: 0, totalBytes: Buffer.byteLength(text) })
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    stoppedBackground: false,
    durationMs: 1,
    stdout: stream(fields.out ?? ''),
    stderr: stream(fields.err ?? ''),
    endCwd: null,
    ...fields,
  }
}

describe.skipIf(!posix)('runCommandSpans', () => {
  let root: string

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'hf-')))
  })

  afterEach(() => {
    killLiveShellGroups()
  })

  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('runs the spans one after another in the project root with the project-dir variables; stdout then stderr', async () => {
    const spans = [
      'printf \'a\\n\' >> order.txt; pwd -P',
      'printf \'b\\n\' >> order.txt; echo "$HARNESS_PROJECT_DIR|$CLAUDE_PROJECT_DIR"',
      'echo out; echo err 1>&2; exit 3',
    ]
    const run = await runCommandSpans(spans, { root, signal: new AbortController().signal })
    expect(run.ran).toBe(3)
    expect(run.failed).toBe(1)
    expect(run.results.map(result => result.output)).toEqual([root, `${root}|${root}`, 'out\nerr'])
    expect(run.results[2]).toMatchObject({ exitCode: 3, timedOut: false, truncated: false })
    expect(formatShellSpanOutput(run.results[2]!)).toBe('out\nerr\n[exit code 3]')
    expect(await readFile(join(root, 'order.txt'), 'utf8')).toBe('a\nb\n')
    expect(spanEnvironment(root)).toEqual({ HARNESS_PROJECT_DIR: root, CLAUDE_PROJECT_DIR: root })
  })

  it('gives each span at most its timeout and what is left of the total; later spans are skipped', async () => {
    let clock = 0
    const timeouts: number[] = []
    const run = async (options: RunShellOptions): Promise<ShellRunResult> => {
      timeouts.push(options.timeoutMs)
      clock += 10_000
      return shellResult({ out: 'x' })
    }
    const spans = Array.from({ length: 8 }, (_, index) => `echo ${index}`)
    const result = await runCommandSpans(spans, { root, signal: new AbortController().signal, run, now: () => clock })
    // 60 s in total: six spans of 10 s; the timeout of each is the smaller of 30 s and what is left.
    expect(timeouts).toEqual([30_000, 30_000, 30_000, 30_000, 20_000, 10_000])
    expect(result.ran).toBe(6)
    expect(result.results.slice(6)).toEqual([
      { exitCode: null, timedOut: false, output: '', truncated: false, skipped: 'time-limit' },
      { exitCode: null, timedOut: false, output: '', truncated: false, skipped: 'time-limit' },
    ])
    expect(formatShellSpanOutput(result.results[7]!)).toBe('[skipped: time limit]')
    expect(LIMITS.commandShellTimeoutMs).toBe(30_000)
    expect(LIMITS.commandShellTotalMs).toBe(60_000)
  })

  it('considers at most 10 spans and reports a shell that cannot start as a failed span', async () => {
    const commands: string[] = []
    const run = async (options: RunShellOptions): Promise<ShellRunResult> => {
      commands.push(options.command)
      if (options.command === 'echo 1')
        throw new Error('spawn failed')
      return shellResult({ out: options.command })
    }
    const result = await runCommandSpans(Array.from({ length: 12 }, (_, index) => `echo ${index}`), { root, signal: new AbortController().signal, run })
    expect(commands).toHaveLength(10)
    expect(result.results).toHaveLength(10)
    expect(result.ran).toBe(9)
    expect(result.failed).toBe(1)
    expect(result.results[1]).toEqual({ exitCode: null, timedOut: false, output: SPAN_START_FAILED, truncated: false })
    expect(formatShellSpanOutput(result.results[1]!)).toBe(`${SPAN_START_FAILED}\n[did not finish]`)
  })

  it('kills a timed-out span with its background children', async () => {
    const pids: number[] = []
    const run = (options: RunShellOptions) => runShellCommand({ ...options, onSpawn: pid => pids.push(pid) })
    const result = await runCommandSpans(['sleep 30 & echo $! > timeout-pids.txt; sleep 30'], { root, signal: new AbortController().signal, run, spanTimeoutMs: 400, killGraceMs: 200 })
    expect(result.results[0]).toMatchObject({ timedOut: true })
    expect(formatShellSpanOutput(result.results[0]!)).toBe('[timed out]')
    const [child] = await readPids(join(root, 'timeout-pids.txt'), 1)
    await expectGone(pids[0]!)
    await expectGone(child!)
  })

  it('rejects with the abort of the run, kills the running span and starts no later span', async () => {
    const controller = new AbortController()
    const pids: number[] = []
    const commands: string[] = []
    const run = (options: RunShellOptions) => {
      commands.push(options.command)
      return runShellCommand({ ...options, killGraceMs: 200, onSpawn: (pid) => {
        pids.push(pid)
        setTimeout(() => controller.abort(new DOMException('stopped', 'AbortError')), 100)
      } })
    }
    await expect(runCommandSpans(['sleep 30', 'echo never'], { root, signal: controller.signal, run })).rejects.toMatchObject({ name: 'AbortError' })
    expect(commands).toEqual(['sleep 30'])
    await expectGone(pids[0]!)
  })

  it('keeps at most 16 KiB of a stream (its start and its end) and marks the output truncated', async () => {
    const result = await runCommandSpans(['i=0; while [ $i -lt 2000 ]; do echo "line $i of a long output that goes on"; i=$((i+1)); done'], { root, signal: new AbortController().signal })
    const span = result.results[0]!
    expect(span.truncated).toBe(true)
    expect(span.output).toContain('line 0 of')
    expect(span.output).toContain('line 1999 of')
    const text = formatShellSpanOutput(span)
    expect(text.endsWith('[output truncated]')).toBe(true)
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(LIMITS.commandShellOutputBytes + 100)
  })

  it('spanResultOf joins stdout and stderr without trailing newlines and flags omitted bytes', () => {
    expect(spanResultOf(shellResult({ out: 'a\n\n', err: '' }))).toEqual({ exitCode: 0, timedOut: false, output: 'a', truncated: false })
    expect(spanResultOf(shellResult({ out: '', err: 'e\n' }))).toMatchObject({ output: 'e' })
    const cut = shellResult({ out: 'a' })
    expect(spanResultOf({ ...cut, stderr: { head: 'h', tail: 't', omittedBytes: 5, totalBytes: 7 } }).truncated).toBe(true)
  })
})
