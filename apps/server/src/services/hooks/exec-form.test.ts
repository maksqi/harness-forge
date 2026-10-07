/* eslint-disable no-template-curly-in-string -- `${NAME}` placeholders of exec-form hooks are part of these fixtures */
// The handler fields of command hooks (W12.5-T2, ADR-057): the exec form (`args`, quoted word by word: no injection), the
// plugin environment, the `if` table, `async` hooks (detached, killed at their timeout and by `stop()`) and the activity
// label (`statusMessage`). W12.16: a plugin hook's `${user_config.KEY}` references are substituted at spawn from its
// extra environment only (never `process.env`), so the listing, the records, the run log and the log never hold a value.
// Real `sh` processes from `testing/hook-scripts.ts`; every spawned pid is dead at the end.
import type { HookSpec, PromptHookSpec } from '@harness-forge/shared'
import type { RegisteredHookCommands } from '../../registry/types.ts'
import type { HookHarness } from './testing.ts'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { HOOK_LIMITS } from '@harness-forge/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hooks as hooksTable } from '../../db/schema.ts'
import { HOOK_SCRIPT_TEXT, readHookArgs, readHookEnv, readHookLog, readSleepPids, writeHookScript } from '../../testing/hook-scripts.ts'
import { commandHookEnv, commandHookLine, commandHookLogLine, execFormVars, pluginHookEnv, substituteHookOptions } from './exec-form.ts'
import { NOTHING_RAN } from './index.ts'
import { alive, createHookTestKit, hookScope, testSignal, waitFor } from './testing.ts'

const posix = process.platform !== 'win32'
const kit = createHookTestKit()
afterEach(kit.cleanup)

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false)
}

/** Plugin hooks of `mock` (the registry's registration is W12.1's; spied here). */
function pluginHooks(h: HookHarness, root: string, specs: ReadonlyArray<Partial<HookSpec> & { command: string, event: HookSpec['event'] }>, extra: { env?: Record<string, string>, prompts?: PromptHookSpec[] } = {}): void {
  const registration: RegisteredHookCommands = {
    pluginId: 'mock',
    root,
    hooks: specs.map((spec, index) => ({ matcher: null, timeoutSec: null, position: [0, index] as const, ...spec })),
    diagnostics: [],
    env: extra.env ?? {},
    prompts: extra.prompts ?? [],
  }
  vi.spyOn(h.t.deps.registry.hookCommands, 'list').mockReturnValue([registration])
}

describe('exec form: the command line and the environment', () => {
  it('shell form runs the command as written; exec form quotes every word and substitutes the known placeholders', () => {
    expect(commandHookLine({ command: 'sh check.sh "$X"' }, '/p')).toBe('sh check.sh "$X"')
    expect(commandHookLine({ command: 'sh', args: ['${CLAUDE_PROJECT_DIR}/x.sh', 'a b', 'it\'s', '$(id)', '${HOME}'] }, '/p')).toBe(
      `'sh' '/p/x.sh' 'a b' 'it'\\''s' '$(id)' '\${HOME}'`,
    )
    expect(commandHookLine({ command: '${CLAUDE_PLUGIN_ROOT}/bin/run', args: ['${CLAUDE_PLUGIN_DATA}/state'], pluginRoot: '/plug', pluginEnv: { CLAUDE_PLUGIN_DATA: '/data/plug' } }, '/p')).toBe(`'/plug/bin/run' '/data/plug/state'`)
    expect(commandHookLine({ command: ' ', args: [] }, '/p')).toBeNull()
    expect(execFormVars({ command: 'x' }, '/p')).toEqual({ CLAUDE_PROJECT_DIR: '/p', HARNESS_PROJECT_DIR: '/p' })
  })

  it('the plugin environment: reserved, invalid and fixed names are dropped; the project and plugin folders win', () => {
    expect(pluginHookEnv({ 'CLAUDE_PLUGIN_DATA': '/d', 'CLAUDE_PLUGIN_OPTION_TOKEN': 't', 'PATH': '/evil', 'HOME': '/evil', 'SHELL': '/evil', 'BASH_ENV': '/evil', 'bad-name': 'x', 'NUL': 'a\0b', 'CLAUDE_PROJECT_DIR': '/evil' })).toEqual({ CLAUDE_PLUGIN_DATA: '/d', CLAUDE_PLUGIN_OPTION_TOKEN: 't' })
    expect(commandHookEnv({ command: 'x', pluginRoot: '/plug', pluginEnv: { CLAUDE_PLUGIN_ROOT: '/evil', CLAUDE_PLUGIN_DATA: '/d' } }, '/p')).toEqual({
      CLAUDE_PLUGIN_DATA: '/d',
      HARNESS_PROJECT_DIR: '/p',
      CLAUDE_PROJECT_DIR: '/p',
      HARNESS_PLUGIN_ROOT: '/plug',
      CLAUDE_PLUGIN_ROOT: '/plug',
    })
  })
})

describe('exec form: plugin options at spawn (W12.16)', () => {
  const ENV_CANARY = 'HF_CANARY-w1216-process-env'
  const pluginEnv = { CLAUDE_PLUGIN_DATA: '/d', CLAUDE_PLUGIN_OPTION_TOKEN: 's3cr3t value', CLAUDE_PLUGIN_OPTION_focus: 'lower' }

  it('${user_config.KEY} becomes CLAUDE_PLUGIN_OPTION_<KEY> (exact key); no value: as written; escaped: literal; never process.env', () => {
    vi.stubEnv('CLAUDE_PLUGIN_OPTION_MISSING', ENV_CANARY)
    vi.stubEnv('MISSING', ENV_CANARY)
    const spawn = {
      command: 'sh',
      args: ['x.sh', '${user_config.TOKEN}', '--t=${user_config.TOKEN}', '${user_config.MISSING}', '\\${user_config.TOKEN}', '${user_config.FOCUS}', '${user_config.focus}', '${CLAUDE_PLUGIN_DATA}/f'],
      pluginRoot: '/plug',
      pluginEnv,
    }
    expect(commandHookLine(spawn, '/p')).toBe(`'sh' 'x.sh' 's3cr3t value' '--t=s3cr3t value' '\${user_config.MISSING}' '\${user_config.TOKEN}' '\${user_config.FOCUS}' 'lower' '/d/f'`)
    expect(substituteHookOptions('${USER_CONFIG.TOKEN}|\\\\${user_config.TOKEN}|${user_config.}', pluginEnv)).toBe('s3cr3t value|\\${user_config.TOKEN}|${user_config.}')
    // The program word too; a value is read by the runner's own placeholders afterwards (as when the reader substituted it at load).
    expect(commandHookLine({ command: '${user_config.BIN}', args: ['${user_config.OUT}'], pluginEnv: { CLAUDE_PLUGIN_OPTION_BIN: '/usr/bin/tool', CLAUDE_PLUGIN_OPTION_OUT: '${CLAUDE_PROJECT_DIR}/out' } }, '/p')).toBe(`'/usr/bin/tool' '/p/out'`)
    // The debug log line keeps the references as written.
    expect(commandHookLogLine(spawn, '/p')).toBe(`'sh' 'x.sh' '\${user_config.TOKEN}' '--t=\${user_config.TOKEN}' '\${user_config.MISSING}' '\\\${user_config.TOKEN}' '\${user_config.FOCUS}' '\${user_config.focus}' '/d/f'`)
    expect(commandHookLogLine({ command: 'sh check.sh' }, '/p')).toBe('sh check.sh')
    for (const line of [commandHookLine(spawn, '/p'), commandHookLogLine(spawn, '/p')])
      expect(line).not.toContain(ENV_CANARY)
  })

  it('a hook without an extra environment (personal, project, harness plugin) is never touched, its escapes neither', () => {
    vi.stubEnv('CLAUDE_PLUGIN_OPTION_TOKEN', ENV_CANARY)
    expect(commandHookLine({ command: 'sh', args: ['${user_config.TOKEN}', '\\${user_config.TOKEN}'] }, '/p')).toBe(`'sh' '\${user_config.TOKEN}' '\\\${user_config.TOKEN}'`)
    expect(commandHookLine({ command: 'echo ${user_config.TOKEN}' }, '/p')).toBe('echo ${user_config.TOKEN}')
  })

  it('a value with a NUL or longer than the reader allows does not start the hook (as when the reader refused it at load)', () => {
    const line = (value: string): string | null => commandHookLine({ command: 'sh', args: ['${user_config.TOKEN}'], pluginEnv: { CLAUDE_PLUGIN_OPTION_TOKEN: value } }, '/p')
    expect(line('a\0b')).toBeNull()
    expect(line('x'.repeat(HOOK_LIMITS.commandMaxChars - 1))).toBeNull()
    expect(line('x'.repeat(HOOK_LIMITS.commandMaxChars - 2))).toBe(`'sh' '${'x'.repeat(HOOK_LIMITS.commandMaxChars - 2)}'`)
    expect(commandHookLogLine({ command: 'sh', args: ['a\0b'] }, '/p')).toBe('sh')
  })
})

describe.skipIf(!posix)('exec form, if, async and statusMessage in the hook service', () => {
  it('print-args sees every argument verbatim: no injection through ;, $( ), quotes or newlines', async () => {
    const h = await kit.open()
    await writeHookScript(h.root, 'print-args')
    const args = ['.harness/hooks/print-args.sh', 'a;touch injected-1', '$(touch injected-2)', '`touch injected-3`', 'it\'s "quoted"', 'line one\nline two', '${CLAUDE_PROJECT_DIR}/file.txt', '${HOME}']
    const hook = await h.hooks.create({ event: 'Stop', command: 'sh', args })
    expect(hook).toMatchObject({ type: 'command', command: 'sh', args })
    const result = await (await h.hooks.snapshot(hookScope(h))).run('Stop', { stopHookActive: false }, { signal: testSignal() })
    expect(result).toEqual({ ...NOTHING_RAN, ran: true })
    expect(await readHookArgs(h.root)).toEqual(['a;touch injected-1', '$(touch injected-2)', '`touch injected-3`', 'it\'s "quoted"', 'line one', 'line two', `${h.root}/file.txt`, '${HOME}'])
    for (const name of ['injected-1', 'injected-2', 'injected-3'])
      expect(await exists(join(h.root, name))).toBe(false)
    // The record / run log label shows the program and its arguments (redacted, cut), never more.
    expect(h.hooks.runs()[0]?.label.startsWith('sh .harness/hooks/print-args.sh')).toBe(true)
  })

  it('a plugin hook gets its extra environment (never a reserved name) and its exec-form placeholders', async () => {
    const h = await kit.open()
    const env = await writeHookScript(h.root, 'env')
    pluginHooks(h, '/opt/plugins/mock', [{ event: 'Stop', command: env }], { env: { CLAUDE_PLUGIN_DATA: '/var/plugin-data', CLAUDE_PLUGIN_OPTION_REGION: 'eu', PATH: '/evil/bin' } })
    await (await h.hooks.snapshot(hookScope(h))).run('Stop', { stopHookActive: false }, { signal: testSignal() })
    const seen = await readHookEnv(h.root)
    expect(seen).toMatchObject({ CLAUDE_PLUGIN_DATA: '/var/plugin-data', CLAUDE_PLUGIN_OPTION_REGION: 'eu', CLAUDE_PLUGIN_ROOT: '/opt/plugins/mock', CLAUDE_PROJECT_DIR: h.root })
    expect(seen.PATH).not.toBe('/evil/bin')
  })

  it('w12.16: a plugin hook gets its option values as arguments; the listing, the record, the run log and the log never hold one', async () => {
    const h = await kit.open()
    const secret = 'HF_CANARY-w1216-exec-9c4e2a'
    await writeHookScript(h.root, 'print-args')
    await writeHookScript(h.root, 'context')
    const args = ['.harness/hooks/print-args.sh', 'first', '${user_config.TOKEN}', '--region=${user_config.REGION}', '${user_config.MISSING}', '\\${user_config.TOKEN}']
    pluginHooks(h, '/opt/plugins/mock', [
      { event: 'PostToolUse', command: 'sh', args },
      { event: 'PostToolUse', command: 'sh', args: ['.harness/hooks/context.sh', '${user_config.TOKEN}'] },
    ], { env: { CLAUDE_PLUGIN_DATA: '/var/plugin-data', CLAUDE_PLUGIN_OPTION_TOKEN: secret, CLAUDE_PLUGIN_OPTION_REGION: 'eu-west' } })
    const tool = { name: 'write_file', callId: 'call-w1216', input: { path: 'a.txt', content: 'x' }, output: 'ok' }
    const result = await (await h.hooks.snapshot(hookScope(h))).run('PostToolUse', { tool }, { signal: testSignal(), target: 'write_file' })
    // The process got every value (a non-sensitive one as before); a missing option stays as written; the escape is literal.
    expect(await readHookArgs(h.root)).toEqual(['first', secret, '--region=eu-west', '${user_config.MISSING}', '${user_config.TOKEN}'])
    expect(result.context).toContain(HOOK_SCRIPT_TEXT.context)
    expect(result.record?.hooks.map(entry => entry.label)).toEqual([
      'sh .harness/hooks/print-args.sh first ${user_config.TOKEN} --region=${user_config.REGION} ${user_config.MISSING} \\${user_config.TOKEN}',
      'sh .harness/hooks/context.sh ${user_config.TOKEN}',
    ])
    const listed = (await h.hooks.list({})).items.filter(item => item.source === 'plugin' && item.kind === 'command')
    expect(listed.map(item => item.kind === 'command' ? item.args : null)).toEqual([args, ['.harness/hooks/context.sh', '${user_config.TOKEN}']])
    expect(h.t.logs.text()).toContain('hooks: running a command hook')
    for (const text of [JSON.stringify(result), JSON.stringify(h.hooks.runs()), JSON.stringify(listed), h.t.logs.text()]) {
      expect(text).not.toContain(secret)
      expect(text).not.toContain('eu-west')
    }
  })

  it('the if table: tool names, Bash prefixes, an exact Bash rule, MCP tools; an unreadable command matches; an invalid rule never runs', async () => {
    const h = await kit.open()
    const rules: Array<[string, string]> = [['Write', 'W'], ['Bash(git:*)', 'G'], ['Bash(npm test)', 'N'], ['mcp__github__*', 'M'], ['Bash(npm *)', 'P']]
    for (const [rule, text] of rules)
      await h.hooks.create({ event: 'PreToolUse', if: rule, command: await writeHookScript(h.root, 'allow', { file: `allow-${text}`, text }) })
    // Written directly (never validated): an invalid rule.
    await h.t.db.insert(hooksTable).values({ id: 'hok_IIIIIIIIIIIIIIII', event: 'PreToolUse', command: await writeHookScript(h.root, 'deny'), options: { if: 'Read(*.env)' }, createdAt: 1, updatedAt: 1 })
    const snapshot = await h.hooks.snapshot(hookScope(h))
    const ran = async (tool: string, input: unknown, aliases?: string[]): Promise<string[]> => {
      const result = await snapshot.run('PreToolUse', { tool: { name: tool, callId: `c-${tool}`, input } }, { signal: testSignal(), target: tool, ...(aliases === undefined ? {} : { aliases }) })
      return (result.reason ?? '').split('\n').filter(text => text !== '').sort()
    }
    expect(await ran('write_file', { path: 'a.txt', content: 'x' })).toEqual(['W'])
    expect(await ran('shell', { command: 'git status' })).toEqual(['G'])
    expect(await ran('shell', { command: 'cd sub && git push' })).toEqual(['G'])
    expect(await ran('shell', { command: 'npm test' })).toEqual(['N', 'P'])
    expect(await ran('shell', { command: 'npm test --watch' })).toEqual(['P'])
    expect(await ran('shell', { command: 'ls' })).toEqual([])
    // The shell parser cannot split `$(…)`: every Bash rule counts as a match (a guard still runs).
    expect(await ran('shell', { command: 'echo $(cat x)' })).toEqual(['G', 'N', 'P'])
    expect(await ran('mcp__gh__create_issue', {}, ['mcp__gh__create_issue', 'mcp__github__create_issue'])).toEqual(['M'])
    expect(await ran('read_file', { path: '.env' })).toEqual([])
    // The invalid rule's deny never ran.
    expect(h.hooks.runs().some(entry => entry.outcome === 'denied')).toBe(false)
  })

  it('an async hook runs detached: no effect on the result, killed at its timeout, its outcome only in the run log', async () => {
    const h = await kit.open()
    await h.hooks.create({ event: 'Stop', command: await writeHookScript(h.root, 'sleep'), async: true, timeout: 1 })
    await h.hooks.create({ event: 'Stop', command: await writeHookScript(h.root, 'record') })
    const started = Date.now()
    const result = await (await h.hooks.snapshot(hookScope(h))).run('Stop', { stopHookActive: false }, { signal: testSignal() })
    expect(Date.now() - started).toBeLessThan(900)
    expect(result).toEqual({ ...NOTHING_RAN, ran: true })
    expect(await readHookLog(h.root)).toHaveLength(1)
    await waitFor(async () => (await readSleepPids(h.root)).length === 2)
    const sleepers = await readSleepPids(h.root)
    kit.pids.push(...sleepers)
    await waitFor(() => sleepers.every(pid => !alive(pid)), 4000)
    await waitFor(() => h.hooks.runs().some(entry => entry.timedOut))
    expect(h.hooks.runs().find(entry => entry.timedOut)).toMatchObject({ event: 'Stop', source: 'personal', outcome: 'error', exitCode: null })
  })

  it('an async hook is killed by stop() (never by the run), and stop() waits for it', async () => {
    const h = await kit.open()
    await h.hooks.create({ event: 'PostToolUse', command: await writeHookScript(h.root, 'sleep'), async: true })
    const run = new AbortController()
    const result = await (await h.hooks.snapshot(hookScope(h))).run('PostToolUse', { tool: { name: 'shell', callId: 'c1', input: {}, output: 'ok' } }, { signal: run.signal, target: 'shell' })
    expect(result.ran).toBe(false)
    await waitFor(async () => (await readSleepPids(h.root)).length === 2)
    const sleepers = await readSleepPids(h.root)
    kit.pids.push(...sleepers)
    // The run ends: the detached hook goes on.
    run.abort(new Error('the run was stopped'))
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(sleepers.every(pid => alive(pid))).toBe(true)
    await h.hooks.stop()
    await waitFor(() => sleepers.every(pid => !alive(pid)))
    expect(h.spawned.every(pid => !alive(pid))).toBe(true)
  })

  it('statusMessage: the first matching handler with a label, in source and declaration order; if rules on a tool target', async () => {
    const h = await kit.open()
    await h.hooks.create({ event: 'PreToolUse', matcher: 'Write', command: 'sh none.sh' })
    await h.hooks.create({ event: 'PreToolUse', matcher: 'Bash', if: 'Bash(git:*)', command: 'sh git.sh', statusMessage: 'Checking git…' })
    await h.hooks.create({ event: 'PreToolUse', matcher: 'Write|Edit', command: 'sh write.sh', statusMessage: 'Checking the write…' })
    await h.hooks.create({ event: 'Stop', command: 'sh stop.sh', statusMessage: 'Wrapping up…' })
    pluginHooks(h, '/opt/plugins/mock', [{ event: 'PreToolUse', command: 'sh plugin.sh', statusMessage: 'Plugin check…' }], {
      prompts: [{ event: 'Stop', matcher: null, prompt: 'Done?', model: null, timeoutSec: null, continueOnBlock: false, position: [1, 0], statusMessage: 'Asking the model…' }],
    })
    const snapshot = await h.hooks.snapshot(hookScope(h))
    expect(snapshot.statusMessage('PreToolUse', 'write_file')).toBe('Checking the write…')
    expect(snapshot.statusMessage('PreToolUse', 'shell')).toBe('Checking git…')
    expect(snapshot.statusMessage('PreToolUse', 'read_file')).toBe('Plugin check…')
    expect(snapshot.statusMessage('PreToolUse')).toBe('Plugin check…')
    expect(snapshot.statusMessage('Stop')).toBe('Wrapping up…')
    expect(snapshot.statusMessage('UserPromptSubmit')).toBeNull()
    expect((await h.hooks.list({})).items.filter(item => item.kind === 'command' && item.statusMessage !== undefined).map(item => item.kind === 'command' ? item.statusMessage : null)).toEqual(['Checking git…', 'Checking the write…', 'Wrapping up…', 'Plugin check…', 'Asking the model…'])
  })
})
