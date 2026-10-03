import type { LanguageModelV4ToolResultOutput } from '@ai-sdk/provider'
import type { Logger, ToolCallContext, ToolResultOutput } from '@harness-forge/plugin-sdk'
import type { HarnessError, ShellToolInput, ShellToolOutput } from '@harness-forge/shared'
import type { WorkspaceRunScope } from '../../workspace/run-scope.ts'
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
import { bindRunScope } from '../../workspace/run-scope.ts'
import { SHELL_CWD_OUTSIDE_NOTE } from '../../workspace/shell-cwd.ts'
import { killLiveShellGroups, liveShellGroups } from '../../workspace/shell.ts'
import { MOCK_WORKSPACE_COMMAND, MOCK_WORKSPACE_FILE, mockShellStdout } from '../mock/workspace.ts'
import { NO_WORKSPACE_MESSAGE, SHELL_TOOL_TIMEOUT_MS } from './common.ts'
import {
  createShellTool,
  evaluateShellRules,
  fitShellOutput,
  resolveShellCwd,
  SHELL_EMPTY_STDOUT,
  SHELL_TOOL_DESCRIPTION,
  SHELL_TOOL_NAME,
  shellFolderLine,
  shellModelText,
  shellPolicy,
  shellStartFolder,
  shellStatusLine,
  shellTimeoutMs,
} from './shell-tool.ts'
import { promiseTool } from './test-helpers.ts'

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
  it('is `shell`: policy shellPolicy, access execute, guard timeout 600 s, the shared input schema', () => {
    const tool = createShellTool({ logger: recordingLogger().logger })
    expect(tool.name).toBe(SHELL_TOOL_NAME)
    expect(tool.policy).toBe(shellPolicy)
    expect(tool.workspace).toBe('execute')
    expect(tool.timeoutMs).toBe(SHELL_TOOL_TIMEOUT_MS)
    expect(tool.inputSchema).toBe(shellToolInputSchema)
    expect(tool.description).toBe(SHELL_TOOL_DESCRIPTION)
    expect(tool.description).toMatch(/new process/)
    expect(tool.description).toMatch(/no stdin/)
    expect(tool.description).toMatch(/background processes are stopped/)
  })

  it('says the working folder carries over and environment variables do not', () => {
    expect(SHELL_TOOL_DESCRIPTION).toMatch(/the working folder carries over to the next call \(cd persists inside the project folder/)
    expect(SHELL_TOOL_DESCRIPTION).toMatch(/environment variables do not/)
    expect(SHELL_TOOL_DESCRIPTION).not.toMatch(/cd does not persist/)
    expect(SHELL_TOOL_DESCRIPTION.length).toBeLessThanOrEqual(1024)
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
    const tool = promiseTool(createShellTool({ logger: recordingLogger().logger }))
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
    expect(Object.keys(result)).toEqual(['command', 'cwd', 'exitCode', 'signal', 'timedOut', 'durationMs', 'stdout', 'stderr', 'stdoutBytes', 'stderrBytes', 'endCwd'])
    expect(result.endCwd).toBe('.')
    expect(liveShellGroups()).toEqual([])
  })

  it.each([
    ['sub', 'sub'],
    ['sub/deep', 'sub/deep'],
    ['./sub/../sub/deep/', 'sub/deep'],
    ['.', '.'],
  ])('runs in cwd %j inside the project', async (cwd, rel) => {
    const tool = promiseTool(createShellTool({ logger: recordingLogger().logger }))
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
    const error = await rejection(promiseTool(createShellTool({ logger: recordingLogger().logger })).execute({ command: 'echo never > ran', cwd }, callContext(root)))
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

// ---------- Phase 8: the sticky working folder and the shell rules (ADR-038) ----------

const PROJECT_ID = 'prj_AAAAAAAAAAAAAAAA'

/** A run scope as the chat pipeline binds it (W8.5): the rules of the run and the shared folder object. */
function runScope(options: { prefixes?: string[], current?: string, projectId?: string } = {}): WorkspaceRunScope {
  return {
    chatId: '0199a8f0-0000-7000-8000-000000000001',
    messageId: 'msg_assistant',
    projectId: options.projectId ?? PROJECT_ID,
    toolCallId: 'mock_call_3',
    journal: null,
    shellRules: { projectId: options.projectId ?? PROJECT_ID, prefixes: options.prefixes ?? [] },
    shellCwd: { current: options.current ?? '.' },
  }
}

/** A call context of `root` with `scope` bound to it (a new object per call, as the host creates them). */
function scopedContext(scope: WorkspaceRunScope | null, signal?: AbortSignal): ToolCallContext {
  const c = callContext(root, signal)
  if (scope !== null)
    bindRunScope(c, scope)
  return c
}

describe.skipIf(!posix)('the sticky working folder', () => {
  it('starts the next call where the previous one ended (cd sub, then pwd)', async () => {
    const { logger } = recordingLogger()
    const tool = createShellTool({ logger })
    const scope = runScope()
    const first = await tool.execute({ command: 'cd sub' }, scopedContext(scope))
    expect(first).toMatchObject({ cwd: '.', endCwd: 'sub', exitCode: 0 })
    expect(first).not.toHaveProperty('cwdNote')
    expect(scope.shellCwd.current).toBe('sub')
    const second = await tool.execute({ command: 'pwd; cd deep' }, scopedContext(scope))
    expect(second).toMatchObject({ cwd: 'sub', stdout: `${join(root, 'sub')}\n`, endCwd: 'sub/deep' })
    expect(scope.shellCwd.current).toBe('sub/deep')
    const third = await tool.execute({ command: 'cd ../..' }, scopedContext(scope))
    expect(third).toMatchObject({ cwd: 'sub/deep', endCwd: '.' })
    expect(scope.shellCwd.current).toBe('.')
    expect(shellToolOutputSchema.parse(second)).toEqual(second)
  })

  it('clamps `cd /` to the project folder with a note', async () => {
    const tool = createShellTool({ logger: recordingLogger().logger })
    const scope = runScope({ current: 'sub' })
    const result = await tool.execute({ command: 'cd /' }, scopedContext(scope))
    expect(result).toMatchObject({ cwd: 'sub', endCwd: '.', cwdNote: SHELL_CWD_OUTSIDE_NOTE })
    expect(scope.shellCwd.current).toBe('.')
    const next = await tool.execute({ command: 'pwd' }, scopedContext(scope))
    expect(next).toMatchObject({ cwd: '.', stdout: `${root}\n`, endCwd: '.' })
    expect(next).not.toHaveProperty('cwdNote')
  })

  it('clamps a symbolic link out of the project', async () => {
    await symlink(outside, join(root, 'escape'))
    const scope = runScope()
    const result = await createShellTool({ logger: recordingLogger().logger }).execute({ command: 'cd escape' }, scopedContext(scope))
    expect(result).toMatchObject({ exitCode: 0, endCwd: '.', cwdNote: SHELL_CWD_OUTSIDE_NOTE })
    expect(scope.shellCwd.current).toBe('.')
  })

  it('runs in the project folder with a note when the remembered folder is gone', async () => {
    const tool = createShellTool({ logger: recordingLogger().logger })
    const scope = runScope({ current: 'sub/deep' })
    await rm(join(root, 'sub', 'deep'), { recursive: true })
    const result = await tool.execute({ command: 'pwd' }, scopedContext(scope))
    expect(result).toMatchObject({
      cwd: '.',
      stdout: `${root}\n`,
      endCwd: '.',
      cwdNote: 'The working folder sub/deep no longer exists, so the command ran in the project folder.',
    })
    expect(scope.shellCwd.current).toBe('.')
    expect(modelText(tool, result, { command: 'pwd' })).toEqual({
      type: 'text',
      value: `Exit code: 0\nThe working folder sub/deep no longer exists, so the command ran in the project folder.\nThe working folder is now the project folder (the next call starts there).\nstdout:\n${root}`,
    })
  })

  it('does not use a remembered folder that became a file or a link out of the project', async () => {
    const tool = createShellTool({ logger: recordingLogger().logger })
    await symlink(outside, join(root, 'escape'))
    for (const current of ['file.txt', 'escape', '../x', outside]) {
      const result = await tool.execute({ command: 'pwd' }, scopedContext(runScope({ current })))
      expect(result).toMatchObject({ cwd: '.', stdout: `${root}\n`, cwdNote: expect.stringContaining('can no longer be used') })
    }
  })

  it('an explicit cwd overrides the remembered folder for the call, and its end folder is remembered', async () => {
    const tool = createShellTool({ logger: recordingLogger().logger })
    const scope = runScope({ current: 'sub' })
    const result = await tool.execute({ command: 'pwd', cwd: 'sub/deep' }, scopedContext(scope))
    expect(result).toMatchObject({ cwd: 'sub/deep', stdout: `${join(root, 'sub', 'deep')}\n`, endCwd: 'sub/deep' })
    expect(scope.shellCwd.current).toBe('sub/deep')
    expect(modelText(tool, result, { command: 'pwd', cwd: 'sub/deep' })).toEqual({
      type: 'text',
      value: `Exit code: 0\nThe working folder is now sub/deep (the next call starts there).\nstdout:\n${join(root, 'sub', 'deep')}`,
    })
    // A refused explicit cwd still fails the call and leaves the folder alone.
    await expect(tool.execute({ command: 'pwd', cwd: 'missing' }, scopedContext(scope))).rejects.toMatchObject({ code: 'not_found' })
    expect(scope.shellCwd.current).toBe('sub/deep')
  })

  it('keeps the folder when nothing is reported: exec, the command\'s own EXIT trap, a timeout, a stop', async () => {
    const tool = promiseTool(createShellTool({ logger: recordingLogger().logger }))
    const scope = runScope({ current: 'sub' })
    for (const input of [{ command: 'cd deep && exec true' }, { command: 'trap "true" EXIT; cd deep' }, { command: 'cd deep; sleep 5', timeout_ms: 1000 }]) {
      const result = await tool.execute(input, scopedContext(scope))
      expect(result, input.command).not.toHaveProperty('endCwd')
      expect(result).not.toHaveProperty('cwdNote')
      expect(scope.shellCwd.current).toBe('sub')
      expect(shellModelText(result, input)).not.toContain('working folder')
    }
    const controller = new AbortController()
    const pending = tool.execute({ command: 'cd deep; sleep 30' }, scopedContext(scope, controller.signal))
    await delay(100)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(scope.shellCwd.current).toBe('sub')
  })

  it('never carries environment variables over', async () => {
    const tool = createShellTool({ logger: recordingLogger().logger })
    const scope = runScope()
    await tool.execute({ command: 'export X=1; cd sub' }, scopedContext(scope))
    const result = await tool.execute({ command: 'echo "[$X]"' }, scopedContext(scope))
    expect(result).toMatchObject({ cwd: 'sub', stdout: '[]\n' })
  })

  it('reports the end folder without a run scope too (nothing is remembered)', async () => {
    const result = await createShellTool({ logger: recordingLogger().logger }).execute({ command: 'cd sub/deep' }, callContext(root))
    expect(result).toMatchObject({ cwd: '.', endCwd: 'sub/deep' })
    expect(result).not.toHaveProperty('allowedBy')
  })

  it('the last call to finish wins', async () => {
    const tool = createShellTool({ logger: recordingLogger().logger })
    const scope = runScope()
    await Promise.all([
      tool.execute({ command: 'sleep 0.4; cd sub' }, scopedContext(scope)),
      tool.execute({ command: 'cd packages' }, scopedContext(scope)),
    ])
    expect(scope.shellCwd.current).toBe('sub')
  })

  it('shellStartFolder: explicit, remembered, gone', async () => {
    await expect(shellStartFolder(root, undefined, undefined)).resolves.toMatchObject({ folder: { rel: '.' }, note: null })
    await expect(shellStartFolder(root, undefined, 'sub')).resolves.toMatchObject({ folder: { rel: 'sub' }, note: null })
    await expect(shellStartFolder(root, 'sub/deep', 'sub')).resolves.toMatchObject({ folder: { rel: 'sub/deep' }, note: null })
    await expect(shellStartFolder(root, undefined, 'gone')).resolves.toMatchObject({ folder: { rel: '.' }, note: expect.stringContaining('no longer exists') })
    await expect(shellStartFolder(root, 'gone', undefined)).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe.skipIf(!posix)('shellPolicy', () => {
  beforeEach(async () => {
    await symlink(outside, join(root, 'escape'))
  })

  async function policy(command: string, options: { prefixes?: string[], current?: string, cwd?: string } = {}): Promise<string> {
    const scope = runScope({ prefixes: options.prefixes, current: options.current })
    return shellPolicy({ command, ...(options.cwd === undefined ? {} : { cwd: options.cwd }) }, scopedContext(scope))
  }

  it.each([
    // [command, prefixes, expected]
    ['ls', ['ls'], 'safe'],
    ['ls -la sub', ['ls'], 'safe'],
    ['pnpm test --run x', ['pnpm test'], 'safe'],
    ['ls && git status', ['ls', 'git status'], 'safe'],
    ['ls | wc -l', ['ls', 'wc'], 'safe'],
    ['ls 2>/dev/null', ['ls'], 'safe'],
    ['ls && rm x', ['ls'], 'ask'],
    ['ls; rm -rf sub', ['ls'], 'ask'],
    ['ls $(whoami)', ['ls'], 'ask'],
    ['ls `whoami`', ['ls'], 'ask'],
    ['echo a > f', ['echo'], 'ask'],
    ['echo a &>/dev/null', ['echo'], 'ask'],
    ['ls *.txt', ['ls'], 'ask'],
    ['(ls)', ['ls'], 'ask'],
    ['X=1 ls', ['ls'], 'ask'],
    ['pnpm -C x test', ['pnpm test'], 'ask'],
    ['ls', [], 'ask'],
    ['git status', ['git'], 'safe'],
  ])('%j with rules %j -> %s', async (command, prefixes, expected) => {
    await expect(policy(command, { prefixes })).resolves.toBe(expected)
  })

  it.each([
    ['cd sub && ls', 'safe'],
    ['cd sub/deep && ls', 'safe'],
    ['cd sub && cd deep && ls', 'safe'],
    ['cd sub', 'safe'],
    ['cd / && ls', 'ask'],
    ['cd .. && ls', 'ask'],
    ['cd sub && cd ../.. && ls', 'ask'],
    ['cd escape && ls', 'ask'],
    ['cd missing && ls', 'ask'],
    ['cd file.txt && ls', 'ask'],
    ['cd sub && cd sub && ls', 'ask'],
    ['cd && ls', 'ask'],
    ['cd - && ls', 'ask'],
    ['pushd sub && ls', 'ask'],
  ])('a cd: %j -> %s', async (command, expected) => {
    await expect(policy(command, { prefixes: ['ls'] })).resolves.toBe(expected)
  })

  it('checks cd targets from the call\'s start folder: the remembered one, or the explicit cwd', async () => {
    await expect(policy('cd deep && ls', { prefixes: ['ls'] })).resolves.toBe('ask')
    await expect(policy('cd deep && ls', { prefixes: ['ls'], current: 'sub' })).resolves.toBe('safe')
    await expect(policy('cd deep && ls', { prefixes: ['ls'], current: '.', cwd: 'sub' })).resolves.toBe('safe')
    await expect(policy('cd deep && ls', { prefixes: ['ls'], current: 'sub', cwd: '.' })).resolves.toBe('ask')
    // A remembered folder that is gone: the call starts in the project folder.
    await expect(policy('cd deep && ls', { prefixes: ['ls'], current: 'gone' })).resolves.toBe('ask')
    await expect(policy('cd sub && ls', { prefixes: ['ls'], current: 'gone' })).resolves.toBe('safe')
  })

  it('asks without a run scope, without a workspace, for another project\'s scope and for an invalid input', async () => {
    await expect(shellPolicy({ command: 'ls' }, callContext(root))).resolves.toBe('ask')
    const noWorkspace = callContext(null)
    bindRunScope(noWorkspace, runScope({ prefixes: ['ls'] }))
    await expect(shellPolicy({ command: 'ls' }, noWorkspace)).resolves.toBe('ask')
    await expect(shellPolicy({ command: 'ls' }, scopedContext(runScope({ prefixes: ['ls'], projectId: 'prj_BBBBBBBBBBBBBBBB' })))).resolves.toBe('ask')
    for (const input of [null, 'ls', {}, { command: '' }, { command: 42 }, { command: 'ls', cwd: '' }, { command: 'ls', timeout_ms: 5 }])
      await expect(shellPolicy(input, scopedContext(runScope({ prefixes: ['ls'] }))), JSON.stringify(input)).resolves.toBe('ask')
  })

  it('asks (never throws) when the start folder is refused or the project folder is gone', async () => {
    await expect(policy('ls', { prefixes: ['ls'], cwd: '..' })).resolves.toBe('ask')
    await expect(policy('ls', { prefixes: ['ls'], cwd: 'missing' })).resolves.toBe('ask')
    await rm(root, { recursive: true, force: true })
    await expect(policy('ls', { prefixes: ['ls'] })).resolves.toBe('ask')
  })

  it('evaluateShellRules reports the matched prefixes in first-match order', async () => {
    await expect(evaluateShellRules('git status && ls -la && git status -s', ['ls', 'git status', 'git'], root, root)).resolves.toEqual({ allowed: true, matched: ['git status', 'ls'] })
    await expect(evaluateShellRules('ls && rm x', ['ls'], root, root)).resolves.toEqual({ allowed: false, matched: [] })
    await expect(evaluateShellRules('cd sub', [], root, root)).resolves.toEqual({ allowed: true, matched: [] })
  })
})

describe.skipIf(!posix)('allowedBy in the output', () => {
  it('lists the matched prefixes when the whole command matched, and logs allowedByRule', async () => {
    const { logger, entries } = recordingLogger()
    const tool = createShellTool({ logger })
    const scope = runScope({ prefixes: ['pwd', 'ls'] })
    const result = await tool.execute({ command: 'cd sub && pwd && ls > /dev/null' }, scopedContext(scope))
    expect(result).toMatchObject({ allowedBy: ['pwd', 'ls'], cwd: '.', endCwd: 'sub' })
    expect(shellToolOutputSchema.parse(result)).toEqual(result)
    const info = entries.filter(entry => entry.level === 'info')
    expect(info).toEqual([{ level: 'info', message: 'shell command finished', data: expect.objectContaining({ allowedByRule: true }) }])
    expect(JSON.stringify(info)).not.toContain('pwd')
  })

  it('has no allowedBy when a segment did not match, a cd left the project, only cd ran, or there is no scope', async () => {
    const { logger, entries } = recordingLogger()
    const tool = createShellTool({ logger })
    for (const command of ['pwd && echo x', 'cd / && pwd', 'cd sub', 'pwd $(echo)']) {
      const result = await tool.execute({ command }, scopedContext(runScope({ prefixes: ['pwd'] })))
      expect(result, command).not.toHaveProperty('allowedBy')
    }
    expect(await tool.execute({ command: 'pwd' }, callContext(root))).not.toHaveProperty('allowedBy')
    for (const entry of entries.filter(item => item.level === 'info'))
      expect(entry.data).not.toHaveProperty('allowedByRule')
  })

  it('checks the cd targets from the folder the call really started in', async () => {
    const tool = createShellTool({ logger: recordingLogger().logger })
    const scope = runScope({ prefixes: ['pwd'], current: 'sub' })
    await expect(tool.execute({ command: 'cd deep && pwd' }, scopedContext(scope))).resolves.toMatchObject({ allowedBy: ['pwd'], cwd: 'sub', endCwd: 'sub/deep' })
  })
})

describe('the model text of the working folder', () => {
  it.each([
    ['unchanged', output({ endCwd: '.' }), undefined, 'Exit code: 0\nstdout:\nhi'],
    ['unchanged in a sub folder', output({ cwd: 'sub', endCwd: 'sub' }), undefined, 'Exit code: 0\nstdout:\nhi'],
    ['changed', output({ endCwd: 'packages/web' }), undefined, 'Exit code: 0\nThe working folder is now packages/web (the next call starts there).\nstdout:\nhi'],
    ['back to the project folder', output({ cwd: 'sub', endCwd: '.' }), undefined, 'Exit code: 0\nThe working folder is now the project folder (the next call starts there).\nstdout:\nhi'],
    ['an explicit cwd', output({ cwd: 'sub', endCwd: 'sub' }), 'sub', 'Exit code: 0\nThe working folder is now sub (the next call starts there).\nstdout:\nhi'],
    ['clamped', output({ cwd: 'sub', endCwd: '.', cwdNote: SHELL_CWD_OUTSIDE_NOTE }), undefined, `Exit code: 0\n${SHELL_CWD_OUTSIDE_NOTE}\nstdout:\nhi`],
    ['not reported', output({ cwd: 'sub' }), undefined, 'Exit code: 0\nstdout:\nhi'],
    ['not reported after a gone folder', output({ exitCode: 3, cwdNote: 'The working folder x no longer exists, so the command ran in the project folder.' }), undefined, 'Exit code: 3\nThe working folder x no longer exists, so the command ran in the project folder.\nstdout:\nhi'],
  ])('%s', (_name, value, cwd, expected) => {
    const text = shellModelText(value, cwd === undefined ? {} : { cwd })
    expect(text).toBe(expected)
    expect(mockShellStdout({ type: 'text', value: text })).toBe('hi')
  })

  it('the folder line', () => {
    expect(shellFolderLine('packages/web')).toBe('The working folder is now packages/web (the next call starts there).')
    expect(shellFolderLine('.')).toBe('The working folder is now the project folder (the next call starts there).')
  })

  it('a timeout or a signal adds no folder line (nothing was reported)', () => {
    expect(shellModelText(output({ cwd: 'sub', timedOut: true, exitCode: null, signal: 'SIGTERM' }))).toBe('Stopped after 120 s (timeout)\nstdout:\nhi')
  })
})
