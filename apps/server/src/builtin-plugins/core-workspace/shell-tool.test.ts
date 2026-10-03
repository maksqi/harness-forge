import type { LanguageModelV4ToolResultOutput } from '@ai-sdk/provider'
import type { Logger, ToolCallContext, ToolResultOutput } from '@harness-forge/plugin-sdk'
import type { HarnessError, ShellToolInput, ShellToolOutput } from '@harness-forge/shared'
import type { CapturedOutput } from '../../workspace/shell.ts'
import { Buffer } from 'node:buffer'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { shellToolInputSchema, shellToolOutputSchema, WORKSPACE_LIMITS } from '@harness-forge/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OUTSIDE_PROJECT_MESSAGE } from '../../workspace/paths.ts'
import { killLiveShellGroups, liveShellGroups } from '../../workspace/shell.ts'
import { MOCK_WORKSPACE_COMMAND, MOCK_WORKSPACE_FILE, mockShellStdout } from '../mock/workspace.ts'
import { NO_WORKSPACE_MESSAGE, SHELL_TOOL_TIMEOUT_MS } from './common.ts'
import {
  createShellTool,
  fitShellOutput,
  resolveShellCwd,
  SHELL_EMPTY_STDOUT,
  SHELL_TOOL_NAME,
  shellModelText,
  shellStatusLine,
  shellTimeoutMs,
} from './shell-tool.ts'

const posix = process.platform !== 'win32'
const temps: string[] = []

interface LogEntry {
  level: 'debug' | 'info' | 'warn' | 'error'
  message: string
  data: unknown
}

function recordingLogger(): { logger: Logger, entries: LogEntry[] } {
  const entries: LogEntry[] = []
  const record = (level: LogEntry['level']) => (message: string, data?: unknown) => {
    entries.push({ level, message, data })
  }
  return { logger: { debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error') }, entries }
}

async function tempFolder(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'hf-')))
  temps.push(dir)
  return dir
}

let root: string
let outside: string

beforeEach(async () => {
  root = await tempFolder()
  outside = await tempFolder()
  await mkdir(join(root, 'sub', 'deep'), { recursive: true })
  await writeFile(join(root, 'file.txt'), 'text\n')
})

afterEach(async () => {
  killLiveShellGroups()
  for (const dir of temps.splice(0))
    await rm(dir, { recursive: true, force: true })
})

function callContext(workspaceRoot: string | null, signal: AbortSignal = new AbortController().signal): ToolCallContext {
  const base: ToolCallContext = { chatId: '0199a8f0-0000-7000-8000-000000000001', modelRef: 'mock:workspace', toolCallId: 'mock_call_3', messages: [], signal }
  return workspaceRoot === null ? base : { ...base, workspace: { projectId: 'prj_AAAAAAAAAAAAAAAA', name: 'Demo', root: workspaceRoot } }
}

async function rejection(promise: Promise<unknown>): Promise<HarnessError> {
  try {
    await promise
  }
  catch (error) {
    return error as HarnessError
  }
  throw new Error('expected a rejection')
}

function output(overrides: Partial<ShellToolOutput> = {}): ShellToolOutput {
  return {
    command: 'echo hi',
    cwd: '.',
    exitCode: 0,
    signal: null,
    timedOut: false,
    durationMs: 12,
    stdout: 'hi\n',
    stderr: '',
    stdoutBytes: 3,
    stderrBytes: 0,
    ...overrides,
  }
}

function modelText(tool: ReturnType<typeof createShellTool>, value: unknown, input: ShellToolInput = { command: 'x' }): ToolResultOutput {
  return tool.toModelOutput!(value as ShellToolOutput, { toolCallId: 'mock_call_3', input }) as ToolResultOutput
}

describe('the shell tool definition', () => {
  it('is `shell`: policy ask, access execute, guard timeout 600 s, the shared input schema', () => {
    const tool = createShellTool({ logger: recordingLogger().logger })
    expect(tool.name).toBe(SHELL_TOOL_NAME)
    expect(tool.policy).toBe('ask')
    expect(tool.workspace).toBe('execute')
    expect(tool.timeoutMs).toBe(SHELL_TOOL_TIMEOUT_MS)
    expect(tool.inputSchema).toBe(shellToolInputSchema)
    expect(tool.description).toMatch(/new process/)
    expect(tool.description).toMatch(/no stdin/)
    expect(tool.description).toMatch(/background processes are stopped/)
  })

  it('timeout_ms defaults to 120 s and stays inside 1..590 s, below the guard timeout', () => {
    expect(shellTimeoutMs(undefined)).toBe(120_000)
    expect(shellTimeoutMs(5000)).toBe(5000)
    expect(shellTimeoutMs(10)).toBe(WORKSPACE_LIMITS.shellTimeoutMinMs)
    expect(shellTimeoutMs(10_000_000)).toBe(WORKSPACE_LIMITS.shellTimeoutMaxMs)
    expect(shellTimeoutMs(Number.NaN)).toBe(120_000)
    expect(WORKSPACE_LIMITS.shellTimeoutMaxMs).toBeLessThan(SHELL_TOOL_TIMEOUT_MS)
  })
})

describe.skipIf(!posix)('shell execute', () => {
  it('runs in the project folder by default', async () => {
    const tool = createShellTool({ logger: recordingLogger().logger })
    const result = await tool.execute({ command: 'pwd; echo hi; echo warn 1>&2' }, callContext(root))
    expect(shellToolOutputSchema.parse(result)).toEqual(result)
    expect(result).toMatchObject({
      command: 'pwd; echo hi; echo warn 1>&2',
      cwd: '.',
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: `${root}\nhi\n`,
      stderr: 'warn\n',
      stdoutBytes: Buffer.byteLength(`${root}\nhi\n`),
      stderrBytes: 5,
    })
    expect(Object.keys(result)).toEqual(['command', 'cwd', 'exitCode', 'signal', 'timedOut', 'durationMs', 'stdout', 'stderr', 'stdoutBytes', 'stderrBytes'])
    expect(liveShellGroups()).toEqual([])
  })

  it.each([
    ['sub', 'sub'],
    ['sub/deep', 'sub/deep'],
    ['./sub/../sub/deep/', 'sub/deep'],
    ['.', '.'],
  ])('runs in cwd %j inside the project', async (cwd, rel) => {
    const tool = createShellTool({ logger: recordingLogger().logger })
    const result = await tool.execute({ command: 'pwd', cwd }, callContext(root))
    expect(result.cwd).toBe(rel)
    expect(result.stdout).toBe(`${rel === '.' ? root : join(root, rel)}\n`)
  })

  it('accepts an absolute cwd inside the project', async () => {
    const result = await createShellTool({ logger: recordingLogger().logger }).execute({ command: 'pwd', cwd: join(root, 'sub') }, callContext(root))
    expect(result).toMatchObject({ cwd: 'sub', stdout: `${join(root, 'sub')}\n` })
  })

  it.each([
    ['..', OUTSIDE_PROJECT_MESSAGE],
    ['../..', OUTSIDE_PROJECT_MESSAGE],
    ['sub/../../x', OUTSIDE_PROJECT_MESSAGE],
  ])('refuses cwd %j outside the project', async (cwd, message) => {
    const error = await rejection(createShellTool({ logger: recordingLogger().logger }).execute({ command: 'echo never > ran', cwd }, callContext(root)))
    expect(error).toMatchObject({ code: 'validation_error', message, details: { issues: [{ path: ['cwd'] }] } })
  })

  it('refuses an absolute cwd outside the project and a link that leaves it', async () => {
    const tool = createShellTool({ logger: recordingLogger().logger })
    await expect(tool.execute({ command: 'pwd', cwd: outside }, callContext(root))).rejects.toMatchObject({ code: 'validation_error', message: OUTSIDE_PROJECT_MESSAGE })
    await symlink(outside, join(root, 'escape'))
    await expect(tool.execute({ command: 'pwd', cwd: 'escape' }, callContext(root))).rejects.toMatchObject({ code: 'validation_error', message: expect.stringContaining('resolves outside the project folder') })
  })

  it('refuses a cwd that is a file or does not exist', async () => {
    const tool = createShellTool({ logger: recordingLogger().logger })
    await expect(tool.execute({ command: 'pwd', cwd: 'file.txt' }, callContext(root))).rejects.toMatchObject({ code: 'validation_error', message: '"file.txt" is not a folder.' })
    await expect(tool.execute({ command: 'pwd', cwd: 'missing' }, callContext(root))).rejects.toMatchObject({ code: 'not_found' })
  })

  it('refuses a call without a project folder', async () => {
    await expect(createShellTool({ logger: recordingLogger().logger }).execute({ command: 'pwd' }, callContext(null))).rejects.toMatchObject({ code: 'validation_error', message: NO_WORKSPACE_MESSAGE })
  })

  it('returns a timeout as a normal result', async () => {
    const tool = createShellTool({ logger: recordingLogger().logger })
    const input = { command: 'echo started; sleep 5', timeout_ms: 1000 }
    const result = await tool.execute(input, callContext(root))
    expect(result).toMatchObject({ timedOut: true, exitCode: null, stdout: 'started\n' })
    expect(modelText(tool, result, input)).toEqual({ type: 'text', value: 'Stopped after 1 s (timeout)\nstdout:\nstarted' })
  })

  it('rejects with an AbortError when the run stops, and logs one info line', async () => {
    const { logger, entries } = recordingLogger()
    const controller = new AbortController()
    const pending = createShellTool({ logger }).execute({ command: 'sleep 30' }, callContext(root, controller.signal))
    await delay(100)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(entries.filter(entry => entry.level === 'info')).toEqual([
      { level: 'info', message: 'shell command stopped', data: expect.objectContaining({ chatId: '0199a8f0-0000-7000-8000-000000000001', aborted: true }) },
    ])
    expect(liveShellGroups()).toEqual([])
  })

  it('logs the exit code, duration and byte counts at info, the command only at debug and redacted', async () => {
    const { logger, entries } = recordingLogger()
    await createShellTool({ logger }).execute({ command: 'echo sk-abcdefghijklmnop1234; echo e 1>&2; exit 2' }, callContext(root))
    const info = entries.filter(entry => entry.level === 'info')
    expect(info).toHaveLength(1)
    expect(info[0]).toMatchObject({
      message: 'shell command finished',
      data: { chatId: '0199a8f0-0000-7000-8000-000000000001', toolCallId: 'mock_call_3', exitCode: 2, signal: null, timedOut: false, stdoutBytes: 24, stderrBytes: 2 },
    })
    expect((info[0]!.data as { durationMs: number }).durationMs).toBeGreaterThanOrEqual(0)
    expect(JSON.stringify(info)).not.toContain('echo')
    expect(JSON.stringify(info)).not.toContain('abcdefghijklmnop')
    const debug = entries.filter(entry => entry.level === 'debug')
    expect(debug).toHaveLength(1)
    expect(debug[0]!.data).toMatchObject({ cwd: '.', timeoutMs: 120_000, command: expect.stringContaining('[redacted]') })
    expect(JSON.stringify(entries)).not.toContain('sk-abcdefghijklmnop1234')
  })

  it('gives the mock model the stdout of `cat mock-workspace.txt`', async () => {
    await writeFile(join(root, MOCK_WORKSPACE_FILE), 'Hello from the workspace agent.\n')
    const tool = createShellTool({ logger: recordingLogger().logger })
    const input = { command: MOCK_WORKSPACE_COMMAND }
    const result = await tool.execute(input, callContext(root))
    const text = modelText(tool, result, input)
    expect(text).toEqual({ type: 'text', value: 'Exit code: 0\nstdout:\nHello from the workspace agent.' })
    expect(mockShellStdout(text as LanguageModelV4ToolResultOutput)).toBe('Hello from the workspace agent.')
  })

  it('resolveShellCwd returns the resolved folder', async () => {
    await expect(resolveShellCwd(root, undefined)).resolves.toMatchObject({ absolute: root, rel: '.', exists: true })
    await expect(resolveShellCwd(root, 'sub')).resolves.toMatchObject({ absolute: join(root, 'sub'), rel: 'sub' })
  })
})

describe('the model text', () => {
  const tool = createShellTool({ logger: recordingLogger().logger })

  it.each([
    ['exit code and stdout', output(), undefined, 'Exit code: 0\nstdout:\nhi'],
    ['stderr when not empty', output({ exitCode: 3, stdout: 'out\n', stderr: 'oops\nmore\n' }), undefined, 'Exit code: 3\nstdout:\nout\nstderr:\noops\nmore'],
    ['empty stdout', output({ stdout: '', stdoutBytes: 0 }), undefined, `Exit code: 0\nstdout:\n${SHELL_EMPTY_STDOUT}`],
    ['empty stdout with stderr', output({ exitCode: 1, stdout: '', stderr: 'boom\n' }), undefined, `Exit code: 1\nstdout:\n${SHELL_EMPTY_STDOUT}\nstderr:\nboom`],
    ['the default timeout', output({ timedOut: true, exitCode: null, signal: 'SIGTERM', stdout: '' }), undefined, `Stopped after 120 s (timeout)\nstdout:\n${SHELL_EMPTY_STDOUT}`],
    ['a fractional timeout', output({ timedOut: true, exitCode: null, signal: 'SIGKILL' }), 1500, 'Stopped after 1.5 s (timeout)\nstdout:\nhi'],
    ['a signal', output({ exitCode: null, signal: 'SIGKILL' }), undefined, 'Terminated by signal SIGKILL\nstdout:\nhi'],
  ])('%s', (_name, value, timeoutMs, expected) => {
    expect(shellModelText(value, { timeout_ms: timeoutMs })).toBe(expected)
    expect(modelText(tool, value, { command: 'x', timeout_ms: timeoutMs })).toEqual({ type: 'text', value: expected })
  })

  it('agrees with the mock model parser', () => {
    for (const value of [
      output({ stdout: 'Hello from the workspace agent.\n' }),
      output({ exitCode: 2, stdout: 'line 1\nline 2\n', stderr: 'warning\n' }),
      output({ timedOut: true, exitCode: null, signal: 'SIGTERM', stdout: 'partial\n' }),
      output({ exitCode: null, signal: 'SIGKILL', stdout: 'killed\n', stderr: 'x' }),
    ]) {
      const text = modelText(tool, value)
      expect(mockShellStdout(text as LanguageModelV4ToolResultOutput)).toBe(value.stdout.trim())
    }
  })

  it('sends an output that does not parse as JSON', () => {
    const marker = { truncated: true, originalBytes: 70_000, preview: '{"command"' }
    expect(modelText(tool, marker)).toEqual({ type: 'json', value: marker })
  })

  it('the status line', () => {
    expect(shellStatusLine(output({ exitCode: 127 }))).toBe('Exit code: 127')
    expect(shellStatusLine(output({ timedOut: true, exitCode: null }), 590_000)).toBe('Stopped after 590 s (timeout)')
    expect(shellStatusLine(output({ exitCode: null, signal: null }))).toBe('Exit code: unknown')
  })
})

describe('fitShellOutput', () => {
  const base = { command: 'cmd', cwd: '.', exitCode: 0, signal: null, timedOut: false, durationMs: 5, stdoutBytes: 0, stderrBytes: 0 }

  function captured(head: string, tail = '', omittedBytes = 0): CapturedOutput {
    return { head, tail, omittedBytes, totalBytes: Buffer.byteLength(head + tail) + omittedBytes }
  }

  it('keeps an output that fits', () => {
    const fitted = fitShellOutput(base, captured('a\n'), captured('b\n'))
    expect(fitted).toEqual({ ...base, stdout: 'a\n', stderr: 'b\n' })
  })

  it('trims streams that grow past the cap once escaped as JSON', () => {
    // Quotes double in JSON: 2 x (4 KiB + 16 KiB) of them is about 80 KiB of JSON.
    const quotes = (n: number): string => '"'.repeat(n)
    const stdout = captured(quotes(4096), quotes(16_384), 1000)
    const stderr = captured(quotes(4096), quotes(16_384), 2000)
    const fitted = fitShellOutput({ ...base, command: '\\'.repeat(16_384) }, stdout, stderr)
    expect(Buffer.byteLength(JSON.stringify(fitted))).toBeLessThanOrEqual(WORKSPACE_LIMITS.outputMaxBytes)
    expect(shellToolOutputSchema.parse(fitted)).toEqual(fitted)
    expect(fitted.command).toBe('\\'.repeat(16_384))
    for (const text of [fitted.stdout, fitted.stderr])
      expect(text.match(/\[… \d+ bytes omitted …\]/g)).toHaveLength(1)
    expect(fitted.stdout.startsWith('"')).toBe(true)
    expect(fitted.stdout.endsWith('"')).toBe(true)
  })

  it('cuts the command only when both streams are empty', () => {
    const fitted = fitShellOutput(base, captured('x'.repeat(30_000)), captured('y'.repeat(30_000)), 1000)
    expect(Buffer.byteLength(JSON.stringify(fitted))).toBeLessThanOrEqual(1000)
    expect(fitted.command).toBe('cmd')
    const tiny = fitShellOutput({ ...base, command: 'z'.repeat(5000) }, captured(''), captured(''), 1000)
    expect(Buffer.byteLength(JSON.stringify(tiny))).toBeLessThanOrEqual(1000)
    expect(tiny.command.startsWith('zzz')).toBe(true)
    expect(tiny.command.endsWith('...')).toBe(true)
  })
})
