/* eslint-disable no-template-curly-in-string -- literal shell variables (`${CLAUDE_PLUGIN_ROOT}`) are test data */
import type { HookEvent, HookOutcome, HookPayloadInput, HookProcessResult, SourcedHookOutcome } from './hooks.ts'
import { describe, expect, it } from 'vitest'
import {
  buildHookPayload,
  claudeToolName,
  combineHookOutcomes,
  compileMatcher,
  HOOK_DIAGNOSTIC_CODES,
  HOOK_EVENTS,
  HOOK_LIMITS,
  HOOK_MATCHER_SUBJECTS,
  hookPermissionMode,
  hookTargetNames,
  readHookOutput,
  readHooksConfig,
  readSettingsHooks,
  TOOL_HOOK_EVENTS,
} from './hooks.ts'

// ---------------------------------------------------------------------------------------------------------------------
// Helpers

function prng(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6D2B79F5) | 0
    let value = Math.imul(state ^ (state >>> 15), state | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}

function utf8(text: string): number {
  return new TextEncoder().encode(text).length
}

function run(overrides: Partial<HookProcessResult> = {}): HookProcessResult {
  return { exitCode: 0, timedOut: false, stdout: '', stdoutTruncated: false, stderr: '', ...overrides }
}

function json(value: unknown): HookProcessResult {
  return run({ stdout: JSON.stringify(value) })
}

function codes(outcome: { diagnostics: readonly { level: string, code: string }[] }): string[] {
  return outcome.diagnostics.map(entry => `${entry.level}:${entry.code}`)
}

function outcome(overrides: Partial<HookOutcome> = {}): HookOutcome {
  return {
    status: 'ok',
    decision: null,
    reason: null,
    context: null,
    continue: true,
    stopReason: null,
    systemMessage: null,
    suppressOutput: false,
    error: null,
    diagnostics: [],
    ...overrides,
  }
}

/** A real Claude Code `.claude/settings.json` (hooks plus keys the harness ignores). */
const CLAUDE_SETTINGS = {
  $schema: 'https://json.schemastore.org/claude-code-settings.json',
  permissions: { allow: ['Bash(npm run lint)', 'Read(~/.zshrc)'], deny: ['Read(./.env)', 'Bash(curl:*)'] },
  env: { CLAUDE_CODE_ENABLE_TELEMETRY: '0', SECRET_TOKEN: 'do-not-read' },
  model: 'claude-sonnet-4-5',
  hooks: {
    PreToolUse: [
      { matcher: 'Bash', hooks: [{ type: 'command', command: '"$CLAUDE_PROJECT_DIR"/.claude/hooks/validate-bash.sh' }] },
      { matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'sh .claude/hooks/guard.sh', timeout: 30 }] },
    ],
    PostToolUse: [
      { matcher: 'Edit|MultiEdit|Write', hooks: [{ type: 'command', command: 'npx prettier --write "$(jq -r .tool_input.file_path)"' }] },
      { matcher: 'mcp__memory__.*', hooks: [{ type: 'command', command: 'echo memory >> .hook-log' }] },
      { matcher: 'Notebook*', hooks: [{ type: 'command', command: 'echo notebook' }] },
    ],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'python3 .claude/hooks/prompt_guard.py' }] }],
    Stop: [{ hooks: [{ type: 'prompt', prompt: 'Check that every task is done.' }, { type: 'command', command: 'sh .claude/hooks/stop.sh' }] }],
    SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'cat .claude/context.md' }] }],
    SessionEnd: [{ hooks: [{ type: 'command', command: 'echo bye' }] }],
  },
}

// ---------------------------------------------------------------------------------------------------------------------
// Constants

describe('constants', () => {
  it('lists the eight events and the tool events', () => {
    expect(HOOK_EVENTS).toEqual(['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Notification', 'Stop', 'SubagentStop', 'PreCompact', 'SessionStart'])
    expect(TOOL_HOOK_EVENTS).toEqual(['PreToolUse', 'PostToolUse'])
    expect(Object.keys(HOOK_MATCHER_SUBJECTS).sort()).toEqual([...HOOK_EVENTS].sort())
    for (const event of TOOL_HOOK_EVENTS)
      expect(HOOK_MATCHER_SUBJECTS[event]).toBe('tool')
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// Configurations

describe('readSettingsHooks', () => {
  it('reads a real Claude Code settings file and only its hooks key', () => {
    const result = readSettingsHooks(JSON.stringify(CLAUDE_SETTINGS, null, 2), { file: '.claude/settings.json' })
    expect(result.items).toEqual([
      { event: 'PreToolUse', matcher: 'Bash', command: '"$CLAUDE_PROJECT_DIR"/.claude/hooks/validate-bash.sh', timeoutSec: null, position: [0, 0], file: '.claude/settings.json' },
      { event: 'PreToolUse', matcher: 'Edit|Write', command: 'sh .claude/hooks/guard.sh', timeoutSec: 30, position: [1, 0], file: '.claude/settings.json' },
      { event: 'PostToolUse', matcher: 'Edit|MultiEdit|Write', command: 'npx prettier --write "$(jq -r .tool_input.file_path)"', timeoutSec: null, position: [0, 0], file: '.claude/settings.json' },
      { event: 'PostToolUse', matcher: 'mcp__memory__.*', command: 'echo memory >> .hook-log', timeoutSec: null, position: [1, 0], file: '.claude/settings.json' },
      { event: 'PostToolUse', matcher: 'Notebook*', command: 'echo notebook', timeoutSec: null, position: [2, 0], file: '.claude/settings.json' },
      { event: 'UserPromptSubmit', matcher: null, command: 'python3 .claude/hooks/prompt_guard.py', timeoutSec: null, position: [0, 0], file: '.claude/settings.json' },
      { event: 'Stop', matcher: null, command: 'sh .claude/hooks/stop.sh', timeoutSec: null, position: [0, 1], file: '.claude/settings.json' },
      { event: 'SessionStart', matcher: 'startup', command: 'cat .claude/context.md', timeoutSec: null, position: [0, 0], file: '.claude/settings.json' },
    ])
    expect(result.diagnostics.map(entry => [entry.level, entry.code, entry.event ?? null, entry.position ?? null, entry.file])).toEqual([
      ['warning', 'unsupported-type', 'Stop', [0, 0], '.claude/settings.json'],
      ['info', 'unknown-event', null, null, '.claude/settings.json'],
    ])
    const text = JSON.stringify(result)
    for (const secret of ['do-not-read', 'Bash(curl:*)', 'claude-sonnet'])
      expect(text).not.toContain(secret)
  })

  it('returns nothing for a settings file without hooks and accepts a BOM', () => {
    expect(readSettingsHooks('{"permissions":{"allow":[]}}', { file: 'a' })).toEqual({ items: [], diagnostics: [] })
    expect(readSettingsHooks('\uFEFF{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"x"}]}]}}', { file: 'a' }).items).toHaveLength(1)
    expect(readSettingsHooks('{"hooks":null}', { file: 'a' })).toEqual({ items: [], diagnostics: [] })
  })

  it('applies the byte cap before parsing', () => {
    const big = `{"hooks":{},"pad":"${'x'.repeat(HOOK_LIMITS.configBytes)}"`
    expect(readSettingsHooks(big, { file: '.harness/settings.json' }).diagnostics).toEqual([
      { level: 'error', code: 'too-large', message: 'The settings file is larger than 256 KiB.', file: '.harness/settings.json' },
    ])
    expect(codes(readSettingsHooks('{"hooks":{}}', { file: 'a', maxBytes: 5 }))).toEqual(['error:too-large'])
    expect(codes(readSettingsHooks('{"hooks":{}}', { file: 'a', maxBytes: 1e9 }))).toEqual([])
    // Multi-byte characters count in UTF-8 bytes.
    expect(codes(readSettingsHooks(`{"a":"${'é'.repeat(10)}"}`, { file: 'a', maxBytes: 25 }))).toEqual(['error:too-large'])
  })

  it('reports invalid JSON and non-objects', () => {
    expect(codes(readSettingsHooks('{"hooks": {', { file: 'a' }))).toEqual(['error:invalid-json'])
    expect(codes(readSettingsHooks('', { file: 'a' }))).toEqual(['error:invalid-json'])
    expect(codes(readSettingsHooks('[1]', { file: 'a' }))).toEqual(['error:not-an-object'])
    expect(codes(readSettingsHooks('{"hooks":[1]}', { file: 'a' }))).toEqual(['error:not-an-object'])
    expect(codes(readSettingsHooks(42 as unknown as string, { file: 'a' }))).toEqual(['error:invalid-json'])
  })
})

describe('readHooksConfig', () => {
  it('reads plugin hooks without a file', () => {
    const result = readHooksConfig({ PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: '  sh "${CLAUDE_PLUGIN_ROOT}/fmt.sh"  ' }] }] }, { source: 'plugin' })
    expect(result).toEqual({ items: [{ event: 'PostToolUse', matcher: 'Write', command: 'sh "${CLAUDE_PLUGIN_ROOT}/fmt.sh"', timeoutSec: null, position: [0, 0] }], diagnostics: [] })
    expect(readHooksConfig(undefined, { source: 'personal' })).toEqual({ items: [], diagnostics: [] })
  })

  it('never runs a group with an invalid matcher and reports every handler', () => {
    const result = readHooksConfig({
      PreToolUse: [
        { matcher: '^Bash', hooks: [{ type: 'command', command: 'a' }, { type: 'command', command: 'b' }] },
        { matcher: 'Bash(git:*)', hooks: [{ type: 'command', command: 'c' }] },
        { matcher: 7, hooks: [{ type: 'command', command: 'd' }] },
        { matcher: 'x'.repeat(201), hooks: [{ type: 'command', command: 'e' }] },
        { matcher: '  ', hooks: [{ type: 'command', command: 'f' }] },
      ],
    }, { source: 'project', file: '.claude/settings.local.json' })
    expect(result.items.map(item => [item.command, item.matcher])).toEqual([['f', null]])
    expect(result.diagnostics.map(entry => [entry.code, entry.position])).toEqual([
      ['invalid-matcher', [0, 0]],
      ['invalid-matcher', [0, 1]],
      ['invalid-matcher', [1, 0]],
      ['invalid-matcher', [2, 0]],
      ['too-long', [3, 0]],
    ])
    for (const entry of result.diagnostics)
      expect(entry).toMatchObject({ level: 'error', event: 'PreToolUse', file: '.claude/settings.local.json' })
  })

  it('checks commands, types and timeouts', () => {
    const result = readHooksConfig({
      Stop: [{
        hooks: [
          { type: 'command', command: 'ok', timeout: 30 },
          { type: 'command', command: 'fraction', timeout: 1.5 },
          { type: 'command', command: 'zero', timeout: 0 },
          { type: 'command', command: 'long', timeout: 900 },
          { type: 'command', command: 'text', timeout: '5' },
          { type: 'command', command: '   ' },
          { type: 'command' },
          { type: 'command', command: 'a\0b' },
          { type: 'command', command: 'x'.repeat(HOOK_LIMITS.commandMaxChars + 1) },
          { type: 'prompt', prompt: 'p' },
          { command: 'no type' },
          'text',
          { type: 'command', command: 'extra', async: true },
        ],
      }],
    }, { source: 'personal' })
    expect(result.items.map(item => [item.command, item.timeoutSec])).toEqual([['ok', 30], ['fraction', 2], ['zero', null], ['long', 600], ['text', null], ['extra', null]])
    expect(result.diagnostics.map(entry => `${entry.level}:${entry.code}@${entry.position?.join(',')}`)).toEqual([
      'warning:invalid-timeout@0,2',
      'warning:invalid-timeout@0,3',
      'warning:invalid-timeout@0,4',
      'error:invalid-command@0,5',
      'error:invalid-command@0,6',
      'error:invalid-command@0,7',
      'error:too-long@0,8',
      'warning:unsupported-type@0,9',
      'warning:unsupported-type@0,10',
      'error:not-an-object@0,11',
      'info:ignored-field@0,12',
    ])
  })

  it('reports malformed shapes', () => {
    expect(codes(readHooksConfig([], { source: 'plugin' }))).toEqual(['error:not-an-object'])
    expect(codes(readHooksConfig('x', { source: 'plugin' }))).toEqual(['error:not-an-object'])
    expect(codes(readHooksConfig({ Stop: {} }, { source: 'plugin' }))).toEqual(['error:not-an-object'])
    expect(codes(readHooksConfig({ Stop: [null, { matcher: 'x' }, { hooks: 'x' }] }, { source: 'plugin' }))).toEqual(['error:not-an-object', 'error:not-an-object', 'error:not-an-object'])
    expect(codes(readHooksConfig({ Stop: [{ hooks: [], once: true }] }, { source: 'plugin' }))).toEqual(['info:ignored-field'])
    expect(codes(readHooksConfig({ stop: [], __proto__x: [], PermissionRequest: [] }, { source: 'plugin' }))).toEqual(['info:unknown-event', 'info:unknown-event', 'info:unknown-event'])
  })

  it('keeps at most 100 handlers', () => {
    const hooks = Array.from({ length: 130 }, (_, index) => ({ type: 'command', command: `echo ${index}` }))
    const result = readHooksConfig({ PostToolUse: [{ hooks }] }, { source: 'personal' })
    expect(result.items).toHaveLength(HOOK_LIMITS.itemsMax)
    expect(result.items.at(-1)?.command).toBe('echo 99')
    expect(codes(result)).toEqual(['warning:too-many'])
  })

  it('never quotes commands or matchers in messages', () => {
    const secret = 'SecretToken'
    const result = readHooksConfig({
      [`${secret}Event`]: [],
      PreToolUse: [{ matcher: `^${secret}`, hooks: [{ type: 'command', command: `${secret}\0` }] }, { hooks: [{ type: 'command', command: secret, [`${secret}Key`]: 1, timeout: secret }] }],
    }, { source: 'project', file: 'f' })
    for (const entry of result.diagnostics) {
      if (entry.code !== 'unknown-event' && entry.code !== 'ignored-field')
        expect(entry.message).not.toContain(secret)
    }
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// Matchers

describe('compileMatcher', () => {
  const cases: Array<[string | null | undefined, string[], string[]]> = [
    [null, ['Bash', 'anything'], []],
    [undefined, ['x'], []],
    ['', ['x'], []],
    ['*', ['x', 'mcp__a__b'], []],
    ['.*', ['x'], []],
    ['Bash', ['Bash'], ['bash', 'Bashful', 'MyBash', 'shell']],
    ['Edit|Write', ['Edit', 'Write'], ['MultiEdit', 'Edit|Write', 'Read']],
    ['Edit|MultiEdit|Write', ['MultiEdit'], ['Multi']],
    [' Edit | Write ', ['Edit', 'Write'], [' Edit']],
    ['Write|', ['Write'], ['']],
    ['mcp__memory__.*', ['mcp__memory__create_entities', 'mcp__memory__'], ['mcp__memoryx__a', 'mcp__memor']],
    ['mcp__github__*', ['mcp__github__create_issue'], ['mcp__gitlab__x']],
    ['mcp__.*__search', ['mcp__a__search', 'mcp__a__b__search'], ['mcp__a__searcher']],
    ['Notebook*', ['Notebook', 'NotebookEdit', 'NotebookRead'], ['Note', 'MyNotebook']],
    ['Notebook.*', ['NotebookEdit'], ['notebookEdit']],
    ['a.b', ['a.b'], ['axb', 'a.bc']],
    ['*Edit', ['Edit', 'MultiEdit', 'NotebookEdit'], ['Edits']],
    ['a*b*c', ['abc', 'aXbYc', 'abbc', 'acbc'], ['ab', 'acb', 'abcd']],
    ['write_file|edit-file', ['write_file', 'edit-file'], ['write-file']],
  ]

  it.each(cases)('%j matches the right names', (matcher, matching, other) => {
    const compiled = compileMatcher(matcher)
    expect(compiled.ok).toBe(true)
    if (!compiled.ok)
      return
    for (const name of matching)
      expect(compiled.test(name), name).toBe(true)
    for (const name of other)
      expect(compiled.test(name), name).toBe(false)
  })

  it.each([
    '^Bash',
    'Bash$',
    '[A-Z]rite',
    '(Edit|Write)',
    'Edit+',
    'Edit?',
    'Edit\\|Write',
    'Bash{1}',
    'Bash(git:*)',
    'Read(./src/**)',
    'Edit Write',
    'a/b',
    'a,b',
    '|',
    ' | ',
    'x'.repeat(201),
    'é',
  ])('%j is invalid', (matcher) => {
    const compiled = compileMatcher(matcher)
    expect(compiled.ok).toBe(false)
    if (!compiled.ok)
      expect(compiled.reason.length).toBeGreaterThan(0)
  })

  it('refuses non-text and accepts a 200-character matcher', () => {
    expect(compileMatcher(42 as unknown as string).ok).toBe(false)
    const long = compileMatcher('x'.repeat(200))
    expect(long.ok && long.test('x'.repeat(200))).toBe(true)
    const compiled = compileMatcher('Bash')
    expect(compiled.ok && compiled.test(7 as unknown as string)).toBe(false)
  })

  it('matches harness tools under their Claude Code names', () => {
    const editOrWrite = compileMatcher('Edit|Write')
    const bash = compileMatcher('Bash')
    const memory = compileMatcher('mcp__memory__.*')
    if (!editOrWrite.ok || !bash.ok || !memory.ok)
      throw new Error('matchers must compile')
    const matches = (test: (name: string) => boolean, tool: string, mcpServerName?: string): boolean =>
      hookTargetNames(tool, mcpServerName === undefined ? undefined : { mcpServerName }).some(test)
    expect(matches(editOrWrite.test, 'edit_file')).toBe(true)
    expect(matches(editOrWrite.test, 'write_file')).toBe(true)
    expect(matches(editOrWrite.test, 'read_file')).toBe(false)
    expect(matches(bash.test, 'shell')).toBe(true)
    expect(matches(memory.test, 'mcp__memory__create')).toBe(true)
    expect(matches(memory.test, 'mcp__my-memory__create', 'memory')).toBe(true)
    expect(matches(memory.test, 'mcp__my-memory__create')).toBe(false)
  })

  it('never builds a RegExp from its input', () => {
    const original = globalThis.RegExp
    let constructed = 0
    globalThis.RegExp = new Proxy(original, {
      construct(target, args) {
        constructed++
        return Reflect.construct(target, args) as object
      },
      apply(target, self, args) {
        constructed++
        return Reflect.apply(target, self, args) as unknown
      },
    })
    try {
      for (const matcher of ['Edit|Write', 'mcp__memory__.*', 'Notebook*', '^Bash', 'a*b*c']) {
        const compiled = compileMatcher(matcher)
        if (compiled.ok)
          compiled.test('NotebookEdit')
      }
      readHooksConfig({ PreToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'x' }] }] }, { source: 'personal' })
    }
    finally {
      globalThis.RegExp = original
    }
    expect(constructed).toBe(0)
  })
})

describe('hookTargetNames and claudeToolName', () => {
  it('adds the Claude Code aliases', () => {
    expect(hookTargetNames('shell')).toEqual(['shell', 'Bash'])
    expect(hookTargetNames('edit_file')).toEqual(['edit_file', 'Edit', 'MultiEdit'])
    expect(hookTargetNames('read_file')).toEqual(['read_file', 'Read'])
    expect(hookTargetNames('write_file')).toEqual(['write_file', 'Write'])
    expect(hookTargetNames('search_files')).toEqual(['search_files', 'Grep'])
    expect(hookTargetNames('find_files')).toEqual(['find_files', 'Glob'])
    expect(hookTargetNames('list_directory')).toEqual(['list_directory', 'LS'])
    expect(hookTargetNames('web_fetch')).toEqual(['web_fetch', 'WebFetch'])
    expect(hookTargetNames('task')).toEqual(['task', 'Task'])
    expect(hookTargetNames('todo_write')).toEqual(['todo_write', 'TodoWrite'])
    expect(hookTargetNames('my_tool')).toEqual(['my_tool'])
    expect(hookTargetNames('')).toEqual([])
    expect(hookTargetNames(null as unknown as string)).toEqual([])
  })

  it('adds the Claude Code name of a project MCP tool', () => {
    expect(hookTargetNames('mcp__my-server-v2__search', { mcpServerName: 'My_Server.v2' })).toEqual(['mcp__my-server-v2__search', 'mcp__My_Server.v2__search'])
    expect(hookTargetNames('mcp__memory__create', { mcpServerName: 'memory' })).toEqual(['mcp__memory__create'])
    expect(hookTargetNames('mcp__x', { mcpServerName: 'y' })).toEqual(['mcp__x'])
    expect(hookTargetNames('shell', { mcpServerName: 'y' })).toEqual(['shell', 'Bash'])
  })

  it('names the Claude Code tool', () => {
    expect(claudeToolName('shell')).toBe('Bash')
    expect(claudeToolName('edit_file')).toBe('Edit')
    expect(claudeToolName('exit_plan_mode')).toBe('ExitPlanMode')
    expect(claudeToolName('mcp__a__b')).toBeNull()
    expect(claudeToolName('Bash')).toBeNull()
    expect(claudeToolName(5 as unknown as string)).toBeNull()
  })

  it('maps the tool mode to the permission mode', () => {
    expect(['ask', 'off', 'plan', 'edits', 'auto', 'other'].map(hookPermissionMode)).toEqual(['default', 'default', 'plan', 'acceptEdits', 'bypassPermissions', 'default'])
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// Payload

const BASE: HookPayloadInput = {
  chatId: '0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee',
  projectId: 'prj_0000000000000001',
  messageId: 'msg_0000000000000002',
  modelRef: 'mock:hooks',
  origin: 'request',
  cwd: '/work/project',
  toolMode: 'edits',
  source: 'project',
}

describe('buildHookPayload', () => {
  it('writes the Claude Code fields of each event and a harness object', () => {
    const tool = { name: 'shell', callId: 'call_1', input: { command: 'ls' }, output: { exitCode: 0, stdout: 'a' } }
    const parse = (event: HookEvent, input: Partial<HookPayloadInput> = {}): Record<string, unknown> => {
      const payload = buildHookPayload(event, { ...BASE, ...input })
      expect(payload.truncated).toBe(false)
      return JSON.parse(payload.json) as Record<string, unknown>
    }
    const common = { session_id: BASE.chatId, cwd: '/work/project', permission_mode: 'acceptEdits' }
    const harness = { version: 1, chatId: BASE.chatId, projectId: BASE.projectId, messageId: BASE.messageId, modelRef: 'mock:hooks', origin: 'request', source: 'project' }
    expect(parse('PreToolUse', { tool })).toEqual({ ...common, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'call_1', harness: { ...harness, tool: 'shell' } })
    expect(parse('PostToolUse', { tool })).toEqual({ ...common, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { exitCode: 0, stdout: 'a' }, tool_use_id: 'call_1', harness: { ...harness, tool: 'shell' } })
    expect(parse('UserPromptSubmit', { prompt: 'Fix it', tool })).toEqual({ ...common, hook_event_name: 'UserPromptSubmit', prompt: 'Fix it', harness })
    expect(parse('Notification', { message: 'Approve shell?', notificationType: 'permission_prompt' })).toEqual({ ...common, hook_event_name: 'Notification', message: 'Approve shell?', notification_type: 'permission_prompt', harness })
    expect(parse('Stop', { stopHookActive: true, origin: 'hook' })).toEqual({ ...common, hook_event_name: 'Stop', stop_hook_active: true, harness: { ...harness, origin: 'hook' } })
    expect(parse('SubagentStop')).toEqual({ ...common, hook_event_name: 'SubagentStop', stop_hook_active: false, harness })
    expect(parse('PreCompact', { trigger: 'manual', customInstructions: 'focus on tests' })).toEqual({ ...common, hook_event_name: 'PreCompact', trigger: 'manual', custom_instructions: 'focus on tests', harness })
    expect(parse('PreCompact', { customInstructions: null })).toEqual({ ...common, hook_event_name: 'PreCompact', trigger: 'auto', custom_instructions: '', harness })
    expect(parse('SessionStart', { sessionSource: 'compact' })).toEqual({ ...common, hook_event_name: 'SessionStart', source: 'compact', harness })
    expect(parse('SessionStart', { projectId: null, messageId: null, toolMode: 'auto', source: 'personal' })).toEqual({
      ...common,
      permission_mode: 'bypassPermissions',
      hook_event_name: 'SessionStart',
      source: 'startup',
      harness: { version: 1, chatId: BASE.chatId, projectId: null, modelRef: 'mock:hooks', origin: 'request', source: 'personal' },
    })
    expect(parse('PreToolUse', { tool: { name: 'mcp__a__b', callId: 'c', input: {} } })).toMatchObject({ tool_name: 'mcp__a__b' })
    expect(buildHookPayload('Stop', BASE).json).not.toContain('transcript_path')
  })

  it('fits exactly at the cap and cuts tool_response first, then tool_input', () => {
    const tool = { name: 'write_file', callId: 'call_9', input: { path: 'src/a.ts', content: 'x'.repeat(3000) }, output: { ok: true, text: 'y'.repeat(5000) } }
    const full = buildHookPayload('PostToolUse', { ...BASE, tool })
    const size = utf8(full.json)
    expect(buildHookPayload('PostToolUse', { ...BASE, tool }, { maxBytes: size })).toEqual({ json: full.json, truncated: false })

    const cut = buildHookPayload('PostToolUse', { ...BASE, tool }, { maxBytes: size - 1 })
    expect(cut.truncated).toBe(true)
    expect(utf8(cut.json)).toBeLessThanOrEqual(size - 1)
    const parsed = JSON.parse(cut.json) as { tool_input: { path: string, content: string }, tool_response: { ok: boolean, text: string }, harness: { truncated?: boolean } }
    expect(parsed.harness.truncated).toBe(true)
    expect(parsed.tool_input).toEqual(tool.input)
    expect(parsed.tool_response.ok).toBe(true)
    expect(parsed.tool_response.text.length).toBeLessThan(5000)
    expect(parsed.tool_response.text.length).toBeGreaterThan(4900)

    const small = buildHookPayload('PostToolUse', { ...BASE, tool }, { maxBytes: 2000 })
    const smaller = JSON.parse(small.json) as { tool_input: { path: string, content: string }, tool_response: { text: string } }
    expect(utf8(small.json)).toBeLessThanOrEqual(2000)
    expect(smaller.tool_response.text).toBe('')
    expect(smaller.tool_input.path).toBe('src/a.ts')
    expect(smaller.tool_input.content.length).toBeLessThan(3000)
  })

  it('cuts a huge prompt and never exceeds tiny caps', () => {
    const prompt = `${'é'.repeat(200_000)}end`
    const payload = buildHookPayload('UserPromptSubmit', { ...BASE, prompt })
    expect(payload.truncated).toBe(true)
    expect(utf8(payload.json)).toBeLessThanOrEqual(HOOK_LIMITS.payloadBytes)
    expect((JSON.parse(payload.json) as { prompt: string }).prompt.startsWith('éé')).toBe(true)
    for (const maxBytes of [0, 2, 10, 60, 200, 400]) {
      const tiny = buildHookPayload('PostToolUse', { ...BASE, tool: { name: 'shell', callId: 'c', input: { command: 'x'.repeat(500) }, output: 'y'.repeat(500) } }, { maxBytes })
      expect(tiny.truncated).toBe(true)
      expect(utf8(tiny.json)).toBeLessThanOrEqual(Math.max(maxBytes, 2))
      expect(() => JSON.parse(tiny.json) as unknown).not.toThrow()
    }
  })

  it('serializes unusual tool values without throwing', () => {
    const cyclic: Record<string, unknown> = { a: 1 }
    cyclic.self = cyclic
    const payload = buildHookPayload('PostToolUse', { ...BASE, tool: { name: 't', callId: 'c', input: { big: 10n, fn: () => 1 }, output: cyclic } })
    const parsed = JSON.parse(payload.json) as { tool_input: unknown, tool_response: unknown }
    expect(parsed.tool_input).toEqual({ big: '10' })
    expect(parsed.tool_response).toBeNull()
    expect(() => buildHookPayload('Stop', null as unknown as HookPayloadInput)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// Output

describe('readHookOutput: exit codes', () => {
  const blocking: HookEvent[] = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SubagentStop']
  const observing: HookEvent[] = ['Notification', 'PreCompact', 'SessionStart']

  it.each(HOOK_EVENTS.map(event => [event]))('%s: a timeout, a kill and a failing exit are non-blocking errors', (event) => {
    expect(readHookOutput(event, run({ timedOut: true, exitCode: 2, stderr: 'secret' }))).toEqual(outcome({ status: 'error', error: 'The hook timed out.' }))
    expect(readHookOutput(event, run({ exitCode: null, stderr: 'secret' }))).toEqual(outcome({ status: 'error', error: 'The hook did not exit normally.' }))
    expect(readHookOutput(event, run({ exitCode: 1, stdout: '{"decision":"block"}', stderr: 'secret' }))).toEqual(outcome({ status: 'error', error: 'The hook failed with exit code 1.' }))
    expect(readHookOutput(event, run({ exitCode: 127 })).error).toBe('The hook failed with exit code 127.')
  })

  it.each(blocking.map(event => [event]))('%s: exit 2 blocks with stderr as the reason', (event) => {
    const result = readHookOutput(event, run({ exitCode: 2, stderr: '  Use rg instead of grep.\n', stdout: '{"decision":"approve"}' }))
    expect(result).toEqual(outcome({ status: 'blocked', reason: 'Use rg instead of grep.', decision: event === 'PreToolUse' ? 'deny' : null }))
    expect(readHookOutput(event, run({ exitCode: 2 })).reason).toBeNull()
  })

  it.each(observing.map(event => [event]))('%s: exit 2 is a non-blocking error shown to the user', (event) => {
    expect(readHookOutput(event, run({ exitCode: 2, stderr: 'oops' }))).toEqual(outcome({ status: 'error', reason: 'oops', error: `The hook exited with code 2, but ${event} hooks cannot block.` }))
  })

  it('reads plain stdout as context only for UserPromptSubmit and SessionStart', () => {
    for (const event of HOOK_EVENTS) {
      const result = readHookOutput(event, run({ stdout: '  Current branch: main\n' }))
      expect(result.context).toBe(event === 'UserPromptSubmit' || event === 'SessionStart' ? 'Current branch: main' : null)
      expect(result.status).toBe('ok')
    }
    expect(readHookOutput('SessionStart', run({ stdout: '   ' })).context).toBeNull()
    const cut = readHookOutput('UserPromptSubmit', run({ stdout: 'x'.repeat(HOOK_LIMITS.contextMaxChars + 50), stdoutTruncated: true }))
    expect(cut.context?.length).toBe(HOOK_LIMITS.contextMaxChars)
    expect(codes(cut)).toEqual(['info:too-large'])
  })

  it('reads text that only starts like JSON as text', () => {
    const result = readHookOutput('UserPromptSubmit', run({ stdout: '{not json' }))
    expect(result.context).toBe('{not json')
    expect(codes(result)).toEqual(['warning:invalid-output'])
    expect(readHookOutput('PostToolUse', run({ stdout: '[1,2]' })).context).toBeNull()
    expect(readHookOutput('SessionStart', run({ stdout: '"text"' })).context).toBe('"text"')
  })

  it('never puts stderr into the error', () => {
    for (const event of HOOK_EVENTS) {
      for (const exitCode of [1, 2, 3, null]) {
        const result = readHookOutput(event, run({ exitCode, stderr: 'SecretStderr' }))
        expect(result.error ?? '').not.toContain('SecretStderr')
      }
    }
  })
})

describe('readHookOutput: JSON fields', () => {
  it('reads PreToolUse permission decisions', () => {
    const specific = (fields: Record<string, unknown>): HookProcessResult => json({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...fields } })
    expect(readHookOutput('PreToolUse', specific({ permissionDecision: 'deny', permissionDecisionReason: 'No rm.' }))).toEqual(outcome({ status: 'blocked', decision: 'deny', reason: 'No rm.' }))
    expect(readHookOutput('PreToolUse', specific({ permissionDecision: 'ask', permissionDecisionReason: 'Check it.' }))).toEqual(outcome({ decision: 'ask', reason: 'Check it.' }))
    expect(readHookOutput('PreToolUse', specific({ permissionDecision: 'allow' }))).toEqual(outcome({ decision: 'allow' }))
    expect(readHookOutput('PreToolUse', specific({ permissionDecision: 'allow', updatedInput: { command: 'ls -la' } }))).toEqual(outcome({ decision: 'allow', updatedInput: { command: 'ls -la' } }))
    expect(readHookOutput('PreToolUse', specific({ updatedInput: { b: 1, a: { d: 2, c: 3 } } })).updatedInput).toEqual({ a: { c: 3, d: 2 }, b: 1 })
    const denied = readHookOutput('PreToolUse', specific({ permissionDecision: 'deny', updatedInput: { a: 1 } }))
    expect(denied.updatedInput).toBeUndefined()
    expect(codes(denied)).toEqual(['info:ignored-field'])
    expect(codes(readHookOutput('PreToolUse', specific({ permissionDecision: 'maybe' })))).toEqual(['warning:invalid-output'])
    expect(codes(readHookOutput('PreToolUse', specific({ updatedInput: 'ls' })))).toEqual(['warning:invalid-output'])
    expect(codes(readHookOutput('PreToolUse', specific({ updatedInput: { content: 'x'.repeat(HOOK_LIMITS.updatedInputBytes) } })))).toEqual(['warning:too-large'])
    expect(codes(readHookOutput('PreToolUse', specific({ permissionDecisionReason: 5 })))).toEqual(['warning:invalid-output'])
    expect(codes(readHookOutput('PreToolUse', specific({ additionalContext: 'x' })))).toEqual(['info:ignored-field'])
  })

  it('reads the legacy PreToolUse decision; permissionDecision wins', () => {
    expect(readHookOutput('PreToolUse', json({ decision: 'approve', reason: 'Safe.' }))).toEqual(outcome({ decision: 'allow', reason: 'Safe.' }))
    expect(readHookOutput('PreToolUse', json({ decision: 'block', reason: 'No.' }))).toEqual(outcome({ status: 'blocked', decision: 'deny', reason: 'No.' }))
    expect(readHookOutput('PreToolUse', json({ decision: 'block', reason: 'legacy', hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' } })))
      .toEqual(outcome({ decision: 'ask', reason: 'legacy' }))
    expect(readHookOutput('PreToolUse', json({ reason: 'alone' }))).toEqual(outcome())
  })

  it('reads blocks and contexts of the other events', () => {
    expect(readHookOutput('PostToolUse', json({ decision: 'block', reason: 'Lint failed.' }))).toEqual(outcome({ status: 'blocked', reason: 'Lint failed.' }))
    expect(readHookOutput('PostToolUse', json({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: '  3 warnings  ' } }))).toEqual(outcome({ context: '3 warnings' }))
    expect(readHookOutput('UserPromptSubmit', json({ decision: 'block', reason: 'No secrets.' }))).toEqual(outcome({ status: 'blocked', reason: 'No secrets.' }))
    expect(readHookOutput('UserPromptSubmit', json({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'Time: 10:00' } }))).toEqual(outcome({ context: 'Time: 10:00' }))
    expect(readHookOutput('SessionStart', json({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'Open issues: 3' } }))).toEqual(outcome({ context: 'Open issues: 3' }))
    expect(readHookOutput('Stop', json({ decision: 'block', reason: 'Run the tests first.' }))).toEqual(outcome({ status: 'blocked', reason: 'Run the tests first.' }))
    expect(readHookOutput('SubagentStop', json({ decision: 'block', reason: 'Check the docs too.' }))).toEqual(outcome({ status: 'blocked', reason: 'Check the docs too.' }))
    const noReason = readHookOutput('Stop', json({ decision: 'block' }))
    expect(noReason).toMatchObject({ status: 'blocked', reason: null })
    expect(codes(noReason)).toEqual(['warning:invalid-output'])
  })

  it('reports fields an event does not use', () => {
    expect(codes(readHookOutput('SessionStart', json({ decision: 'block', reason: 'x' })))).toEqual(['info:ignored-field'])
    expect(readHookOutput('SessionStart', json({ decision: 'block' })).status).toBe('ok')
    expect(codes(readHookOutput('Stop', json({ decision: 'approve' })))).toEqual(['info:ignored-field'])
    expect(codes(readHookOutput('Stop', json({ decision: 'continue' })))).toEqual(['warning:invalid-output'])
    expect(codes(readHookOutput('Stop', json({ hookSpecificOutput: { hookEventName: 'Stop', additionalContext: 'x' } })))).toEqual(['info:ignored-field'])
    expect(codes(readHookOutput('PostToolUse', json({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'x' } })))).toEqual(['warning:invalid-output'])
    expect(codes(readHookOutput('PostToolUse', json({ hookSpecificOutput: { additionalContext: 'x' } })))).toEqual(['warning:invalid-output'])
    expect(codes(readHookOutput('PostToolUse', json({ hookSpecificOutput: 'x' })))).toEqual(['warning:invalid-output'])
    expect(codes(readHookOutput('PostToolUse', json({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 4 } })))).toEqual(['warning:invalid-output'])
    expect(codes(readHookOutput('PostToolUse', json({ extra: 1 })))).toEqual(['info:ignored-field'])
  })

  it('reads continue, stopReason, systemMessage and suppressOutput', () => {
    expect(readHookOutput('PreToolUse', json({ continue: false, stopReason: 'Build broken.', systemMessage: 'Stopped by the build hook.', suppressOutput: true })))
      .toEqual(outcome({ continue: false, stopReason: 'Build broken.', systemMessage: 'Stopped by the build hook.', suppressOutput: true }))
    expect(readHookOutput('SessionStart', json({ continue: false }))).toEqual(outcome({ continue: false }))
    expect(readHookOutput('Stop', json({ continue: true, stopReason: 'ignored' }))).toEqual(outcome())
    for (const event of ['PreCompact', 'Notification'] as const) {
      const result = readHookOutput(event, json({ continue: false, stopReason: 'x' }))
      expect(result.continue).toBe(true)
      expect(codes(result)).toEqual(['info:ignored-field'])
    }
    expect(codes(readHookOutput('Stop', json({ continue: 'no', systemMessage: 3, suppressOutput: 'yes', reason: 1 })))).toEqual(['warning:invalid-output', 'warning:invalid-output', 'warning:invalid-output', 'warning:invalid-output'])
  })

  it('caps reasons, contexts and system messages', () => {
    const long = readHookOutput('PostToolUse', json({ decision: 'block', reason: 'r'.repeat(5000), systemMessage: 's'.repeat(5000), hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'c'.repeat(20_000) } }))
    expect(long.reason?.length).toBe(HOOK_LIMITS.reasonMaxChars)
    expect(long.systemMessage?.length).toBe(HOOK_LIMITS.systemMessageMaxChars)
    expect(long.context?.length).toBe(HOOK_LIMITS.contextMaxChars)
    expect(readHookOutput('Stop', run({ exitCode: 2, stderr: 'e'.repeat(3000) })).reason?.length).toBe(HOOK_LIMITS.reasonMaxChars)
  })

  it('tags diagnostics with the event and survives malformed results', () => {
    for (const entry of readHookOutput('PostToolUse', json({ extra: 1 })).diagnostics)
      expect(entry.event).toBe('PostToolUse')
    expect(readHookOutput('Stop', null as unknown as HookProcessResult).status).toBe('error')
    expect(readHookOutput('Bogus' as HookEvent, run()).diagnostics.map(entry => entry.code)).toEqual(['unknown-event'])
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// Combination

describe('combineHookOutcomes', () => {
  const sourced = (source: SourcedHookOutcome['source'], overrides: Partial<HookOutcome>): SourcedHookOutcome => ({ source, outcome: outcome(overrides) })

  it('decides deny > ask > allow', () => {
    const allow = sourced('personal', { decision: 'allow', reason: 'fine' })
    const ask = sourced('plugin', { decision: 'ask', reason: 'check' })
    const deny = sourced('project', { status: 'blocked', decision: 'deny', reason: 'no' })
    expect(combineHookOutcomes('PreToolUse', [allow, ask, deny])).toMatchObject({ decision: 'deny', block: true, reason: 'no' })
    expect(combineHookOutcomes('PreToolUse', [allow, ask])).toMatchObject({ decision: 'ask', block: false, reason: 'check' })
    expect(combineHookOutcomes('PreToolUse', [allow, sourced('project', { decision: 'allow', reason: 'ok' })])).toMatchObject({ decision: 'allow', reason: 'fine\nok' })
    expect(combineHookOutcomes('PreToolUse', [])).toEqual({ decision: null, reason: null, context: null, block: false, continue: true, stopReason: null, systemMessages: [], diagnostics: [] })
  })

  it('takes the first updatedInput in source order and reports a conflict', () => {
    const project = sourced('project', { decision: 'allow', updatedInput: { command: 'project' } })
    const plugin = sourced('plugin', { updatedInput: { command: 'plugin' } })
    const personal = sourced('personal', { updatedInput: { command: 'personal' } })
    const combined = combineHookOutcomes('PreToolUse', [project, plugin, personal])
    expect(combined.updatedInput).toEqual({ command: 'personal' })
    expect(combined.diagnostics).toEqual([{ level: 'warning', code: 'conflict', message: expect.stringContaining('source order') as unknown as string, event: 'PreToolUse' }])
    expect(combineHookOutcomes('PreToolUse', [project, plugin]).updatedInput).toEqual({ command: 'plugin' })
    const same = combineHookOutcomes('PreToolUse', [sourced('project', { updatedInput: { a: 1, b: 2 } }), sourced('plugin', { updatedInput: { b: 2, a: 1 } })])
    expect(same.diagnostics).toEqual([])
    expect('updatedInput' in combineHookOutcomes('PreToolUse', [project, sourced('plugin', { status: 'blocked', decision: 'deny' })])).toBe(false)
  })

  it('joins contexts and reasons in source order, deduplicated and capped', () => {
    const combined = combineHookOutcomes('PostToolUse', [
      sourced('project', { context: 'from project' }),
      sourced('personal', { context: 'from personal', systemMessage: 'note 1' }),
      sourced('plugin', { context: 'from personal', systemMessage: 'note 2' }),
    ])
    expect(combined.context).toBe('from personal\n\nfrom project')
    expect(combined.systemMessages).toEqual(['note 1', 'note 2'])
    const big = combineHookOutcomes('PostToolUse', Array.from({ length: 5 }, (_, index) => sourced('personal', { context: `${index}${'c'.repeat(3000)}` })))
    expect(big.context?.length).toBe(HOOK_LIMITS.contextMaxChars)
    const reasons = combineHookOutcomes('Stop', [sourced('personal', { status: 'blocked', reason: 'tests fail' }), sourced('plugin', { reason: 'ignored, not blocking' }), sourced('project', { status: 'blocked', reason: 'lint fails' })])
    expect(reasons).toMatchObject({ block: true, reason: 'tests fail\nlint fails' })
    expect(combineHookOutcomes('SessionStart', [sourced('personal', { status: 'error', reason: 'stderr text' })]).reason).toBe('stderr text')
  })

  it('aNDs continue and keeps the first stop reason', () => {
    const combined = combineHookOutcomes('PostToolUse', [sourced('plugin', { continue: false, stopReason: 'second' }), sourced('personal', { continue: false, stopReason: 'first' }), sourced('project', {})])
    expect(combined).toMatchObject({ continue: false, stopReason: 'first' })
    expect(combineHookOutcomes('PostToolUse', [sourced('plugin', {})]).continue).toBe(true)
    expect(combineHookOutcomes('PostToolUse', [sourced('plugin', { continue: false })])).toMatchObject({ continue: false, stopReason: null })
  })

  it('keeps every outcome diagnostic and ignores malformed entries', () => {
    const diagnostic = { level: 'info' as const, code: 'ignored-field' as const, message: 'x', event: 'PostToolUse' as const }
    const combined = combineHookOutcomes('PostToolUse', [sourced('plugin', { diagnostics: [diagnostic] }), null as unknown as SourcedHookOutcome, { source: 'personal' } as SourcedHookOutcome])
    expect(combined.diagnostics).toEqual([diagnostic])
    expect(combineHookOutcomes('PostToolUse', null as unknown as SourcedHookOutcome[]).decision).toBeNull()
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// Fuzzing

describe('fuzzing', () => {
  const random = prng(0xC35)
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T
  const leaves: unknown[] = [null, true, false, 0, -1, 1.5, 700, '', 'x', 'command', 'prompt', 'Bash', '^Bash', 'Edit|Write', '*', 'mcp__a__.*', 'é', '\0', 'block', 'approve', 'allow', 'deny', 'ask']
  const keys = ['hooks', 'matcher', 'type', 'command', 'timeout', ...HOOK_EVENTS, 'decision', 'reason', 'continue', 'stopReason', 'systemMessage', 'hookSpecificOutput', 'hookEventName', 'permissionDecision', 'updatedInput', 'additionalContext', '__proto__', 'constructor', 'x']

  function value(depth: number): unknown {
    const roll = random()
    if (depth > 4 || roll < 0.35)
      return pick(leaves)
    if (roll < 0.65)
      return Array.from({ length: Math.floor(random() * 4) }, () => value(depth + 1))
    const object: Record<string, unknown> = {}
    for (let index = Math.floor(random() * 5); index > 0; index--)
      Object.defineProperty(object, pick(keys), { value: value(depth + 1), enumerable: true, configurable: true, writable: true })
    return object
  }

  it('reads random configurations without throwing and keeps its invariants', () => {
    const started = Date.now()
    for (let iteration = 0; iteration < 3000; iteration++) {
      const input = value(0)
      const result = readHooksConfig(input, { source: pick(['personal', 'project', 'plugin'] as const), file: 'f' })
      expect(result.items.length).toBeLessThanOrEqual(HOOK_LIMITS.itemsMax)
      for (const item of result.items) {
        expect(HOOK_EVENTS).toContain(item.event)
        expect(item.command.trim()).toBe(item.command)
        expect(item.command.length).toBeGreaterThan(0)
        expect(compileMatcher(item.matcher).ok).toBe(true)
        if (item.timeoutSec !== null)
          expect(item.timeoutSec >= 1 && item.timeoutSec <= HOOK_LIMITS.timeoutMaxSec).toBe(true)
      }
      for (const entry of result.diagnostics)
        expect(HOOK_DIAGNOSTIC_CODES).toContain(entry.code)
      const text = JSON.stringify(input) ?? ''
      expect(() => readSettingsHooks(text, { file: 'f' })).not.toThrow()
      expect(() => readSettingsHooks(text.slice(0, Math.floor(random() * text.length)), { file: 'f' })).not.toThrow()
    }
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  it('reads random outputs without throwing', () => {
    for (let iteration = 0; iteration < 3000; iteration++) {
      const event = pick(HOOK_EVENTS)
      const stdout = random() < 0.7 ? JSON.stringify(value(0)) ?? '' : pick(['', 'text', '{', '{"a":', '  {}  ', '\0'])
      const result = readHookOutput(event, run({ exitCode: pick([0, 0, 0, 1, 2, null]), timedOut: random() < 0.05, stdout, stderr: pick(['', 'err']) }))
      expect(['ok', 'blocked', 'error']).toContain(result.status)
      if (result.decision !== null)
        expect(event).toBe('PreToolUse')
      if (result.status === 'blocked')
        expect(['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SubagentStop']).toContain(event)
      expect((result.reason ?? '').length).toBeLessThanOrEqual(HOOK_LIMITS.reasonMaxChars)
      expect((result.context ?? '').length).toBeLessThanOrEqual(HOOK_LIMITS.contextMaxChars)
      const combined = combineHookOutcomes(event, [{ source: pick(['personal', 'project', 'plugin'] as const), outcome: result }])
      expect(combined.block).toBe(result.status === 'blocked')
    }
  })

  it('compiles random matchers in bounded time without throwing', () => {
    const units = ['a', 'B', '_', '-', '.', '*', '|', ' ', '^', '(', '\\', '$', '[', '.*', 'Edit', 'mcp__']
    const started = Date.now()
    for (let iteration = 0; iteration < 3000; iteration++) {
      const matcher = Array.from({ length: Math.floor(random() * 40) }, () => pick(units)).join('')
      const compiled = compileMatcher(matcher)
      if (compiled.ok) {
        compiled.test(Array.from({ length: Math.floor(random() * 30) }, () => pick(['a', 'B', '_', 'Edit', 'x'])).join(''))
      }
    }
    // A pathological wildcard pattern against a long name stays fast.
    const slow = compileMatcher(`${'a*'.repeat(60)}b`)
    expect(slow.ok && slow.test('a'.repeat(5000))).toBe(false)
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('builds random payloads under the cap', () => {
    for (let iteration = 0; iteration < 300; iteration++) {
      const maxBytes = Math.floor(random() * 4000)
      const payload = buildHookPayload(pick(HOOK_EVENTS), { ...BASE, prompt: 'p'.repeat(Math.floor(random() * 3000)), tool: { name: pick(['shell', 'x']), callId: 'c', input: value(0), output: value(0) } }, { maxBytes })
      expect(utf8(payload.json)).toBeLessThanOrEqual(Math.max(maxBytes, 2))
      expect(() => JSON.parse(payload.json) as unknown).not.toThrow()
    }
  })
})
