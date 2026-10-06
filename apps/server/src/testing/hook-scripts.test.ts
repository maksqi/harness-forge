// Smoke tests of the Phase 12 hook scripts (C45-T5): each one written into a `realpath(mkdtemp())` project, run like the
// hook runner (through `runShellCommand`, the stdin payload, the project environment) with `sh` and, when present, dash
// and busybox, and read with the shared `readHookOutput`. The Phase 11 scripts are covered by `workspace/shell.test.ts`.
import type { HookEvent, HookPayloadInput } from '@harness-forge/shared'
import type { HookScriptName } from './hook-scripts.ts'
import { accessSync, constants } from 'node:fs'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import process from 'node:process'
import { buildHookPayload, execFormCommand, readHookOutput } from '@harness-forge/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { capturedText, liveShellGroups, runShellCommand } from '../workspace/shell.ts'
import {
  HOOK_ARGS_FILE,
  HOOK_SCRIPT_NAMES,
  HOOK_SCRIPT_TEXT,
  hookScriptCommand,
  hookScriptPath,
  hookScriptSource,
  readHookArgs,
  writeHookScript,
} from './hook-scripts.ts'

const posix = process.platform !== 'win32'
const PHASE_12_SCRIPTS = ['permission-allow', 'permission-deny', 'print-args', 'agent-context'] as const

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  }
  catch {
    return false
  }
}

/** `sh`, plus dash and busybox when they exist (the prefix runs the script file). */
const SHELLS: ReadonlyArray<readonly [label: string, prefix: string]> = posix
  ? [
      ['sh', 'sh'],
      ...(isExecutable('/bin/dash') ? [['dash', '/bin/dash'] as const] : []),
      ...((process.env.PATH ?? '').split(delimiter).filter(dir => dir.startsWith('/')).map(dir => join(dir, 'busybox')).filter(isExecutable).slice(0, 1).map(path => ['busybox', `${path} sh`] as const)),
    ]
  : []

let cwd: string

beforeEach(async () => {
  cwd = await realpath(await mkdtemp(join(tmpdir(), 'hf-')))
})

afterEach(async () => {
  expect(liveShellGroups()).toEqual([])
  await rm(cwd, { recursive: true, force: true })
})

function payloadInput(extra: Partial<HookPayloadInput> = {}): HookPayloadInput {
  return {
    chatId: '0199a8f0-0000-7000-8000-000000000001',
    projectId: 'prj_AAAAAAAAAAAAAAAA',
    modelRef: 'mock:hooks',
    origin: 'request',
    cwd,
    toolMode: 'ask',
    source: 'project',
    tool: { name: 'shell', callId: 'mock_call_1', input: { command: 'ls' } },
    ...extra,
  }
}

/** Runs a command like the hook runner: the payload on stdin, the project variables, the project folder. */
async function runHook(command: string, event: HookEvent, extra: Partial<HookPayloadInput> = {}) {
  const payload = buildHookPayload(event, payloadInput(extra))
  const result = await runShellCommand({ command, cwd, timeoutMs: 10_000, killGraceMs: 300, input: payload.json, env: { HARNESS_PROJECT_DIR: cwd, CLAUDE_PROJECT_DIR: cwd } })
  const outcome = readHookOutput(event, {
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    stdout: capturedText(result.stdout),
    stdoutTruncated: result.stdout.omittedBytes > 0,
    stderr: capturedText(result.stderr),
  })
  return { result, outcome }
}

function commandFor(name: HookScriptName, prefix: string): string {
  return prefix === 'sh' ? hookScriptCommand(name) : `${prefix} ${hookScriptPath(name)}`
}

describe('phase 12 hook scripts: names and sources', () => {
  it('appends the four Phase 12 scripts to the list', () => {
    expect(HOOK_SCRIPT_NAMES.slice(-4)).toEqual([...PHASE_12_SCRIPTS])
    expect(HOOK_ARGS_FILE).toBe('.hook-args')
    expect(hookScriptCommand('print-args')).toBe('sh .harness/hooks/print-args.sh')
  })

  it.each(PHASE_12_SCRIPTS.map(name => [name] as const))('%s: POSIX sh only, reads stdin first, no jq or bash syntax', (name) => {
    const lines = hookScriptSource(name).split('\n')
    expect(lines[0]).toBe('#!/bin/sh')
    expect(lines[2]).toBe('cat > /dev/null')
    expect(lines.join('\n')).not.toMatch(/\bjq\b|\[\[|\$'|\bsource\b|\bfunction\b|<<<|\bdeclare\b|\blocal\b|sh -c/)
  })
})

describe.skipIf(!posix)('phase 12 hook scripts: a smoke test per script', () => {
  describe.each(SHELLS.map(([label, prefix]) => [label, prefix] as const))('with %s', (_label, prefix) => {
    it('permission-allow: PermissionRequest decision.behavior allow', async () => {
      await writeHookScript(cwd, 'permission-allow')
      const { outcome } = await runHook(commandFor('permission-allow', prefix), 'PermissionRequest')
      expect(outcome).toMatchObject({ status: 'ok', decision: 'allow', diagnostics: [] })
    })

    it('permission-deny: PermissionRequest decision.behavior deny with its message (and a replaced text)', async () => {
      await writeHookScript(cwd, 'permission-deny')
      const { outcome } = await runHook(commandFor('permission-deny', prefix), 'PermissionRequest')
      expect(outcome).toMatchObject({ status: 'blocked', decision: 'deny', reason: HOOK_SCRIPT_TEXT.permissionDeny, diagnostics: [] })
      await writeHookScript(cwd, 'permission-deny', { file: 'deny-custom', text: 'Not now, it\'s $HOME' })
      const custom = await runHook(prefix === 'sh' ? hookScriptCommand('permission-deny', { file: 'deny-custom' }) : `${prefix} ${hookScriptPath('permission-deny', { file: 'deny-custom' })}`, 'PermissionRequest')
      expect(custom.outcome).toMatchObject({ status: 'blocked', reason: 'Not now, it\'s $HOME' })
    })

    it('agent-context: SubagentStart additionalContext', async () => {
      await writeHookScript(cwd, 'agent-context')
      const { outcome } = await runHook(commandFor('agent-context', prefix), 'SubagentStart', { tool: undefined, agent: { id: 'task_1', type: 'general' } })
      expect(outcome).toMatchObject({ status: 'ok', context: HOOK_SCRIPT_TEXT.agentContext, diagnostics: [] })
    })
  })

  it('print-args: the exec form passes every argument verbatim (no shell parsing, no injection)', async () => {
    await writeHookScript(cwd, 'print-args')
    // eslint-disable-next-line no-template-curly-in-string -- a literal `${PATH}` must reach the script unexpanded
    const args = ['plain', 'two words', 'a; touch injected', '$(touch injected)', '`touch injected`', '"double" \'single\'', '$HOME ${PATH}', 'line one\nline two', '', '*']
    const command = execFormCommand('sh', [hookScriptPath('print-args'), ...args])
    expect(command).not.toBeNull()
    const { result, outcome } = await runHook(command!, 'PreToolUse')
    expect(result.exitCode).toBe(0)
    expect(outcome).toMatchObject({ status: 'ok', decision: null })
    expect(await readFile(join(cwd, HOOK_ARGS_FILE), 'utf8')).toBe(args.map(arg => `${arg}\n`).join(''))
    expect(await readHookArgs(cwd)).toEqual(args.join('\n').split('\n'))
    await expect(readFile(join(cwd, 'injected'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('print-args: replaces the file on every run; no arguments leave it empty', async () => {
    await writeHookScript(cwd, 'print-args')
    await runHook(execFormCommand('sh', [hookScriptPath('print-args'), 'first'])!, 'PreToolUse')
    expect(await readHookArgs(cwd)).toEqual(['first'])
    await runHook(hookScriptCommand('print-args'), 'PreToolUse')
    expect(await readFile(join(cwd, HOOK_ARGS_FILE), 'utf8')).toBe('')
    expect(await readHookArgs(cwd)).toEqual([])
  })
})
