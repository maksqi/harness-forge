import type { HarnessUIMessage } from '../chat.ts'
import { validateUIMessages } from 'ai'
import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  activityDataSchema,
  chatRequestBodySchema,
  commandInvocationSchema,
  harnessDataSchemas,
  hookDataSchema,
  messageMetadataSchema,
  noticeCodeSchema,
} from '../chat.ts'
import {
  hookEventSchema,
  hookKindSchema,
  hookRecordOutcomeSchema,
  hookSourceSchema,
  hookStateSchema,
  invocationKindSchema,
  runOriginSchema,
} from '../enums.ts'
import { conflictDetailsSchema, conflictReasonSchema } from '../errors.ts'
import { createServerEvent, serverEventSchema } from '../events.ts'
import { LIMITS } from '../limits.ts'
import { HOOK_EVENTS, HOOK_SOURCES } from '../util/hooks.ts'
import { chatSettingsSchema, chatSettingsUpdateSchema } from './chats.ts'
import {
  countHookHandlers,
  hookCreateSchema,
  hookEntrySchema,
  hookListSchema,
  hookParamsSchema,
  hookRunListSchema,
  hooksChangedDataSchema,
  hooksConfigSchema,
  hooksQuerySchema,
  hookUpdateSchema,
  isHookTurnOff,
  personalHookSchema,
} from './hooks.ts'
import { declarativeOutputStyleSchema } from './plugin-data.ts'
import { declaresCommandHooks, manifestRequiresTrust, pluginManifestSchema } from './plugin-manifest.ts'
import { projectSummarySchema, projectUpdateSchema } from './projects.ts'
import { settingsSchema, settingsUpdateSchema } from './system.ts'
import { commandSummarySchema } from './tools.ts'

const CHAT_ID = '0199a8f0-0000-7000-8000-000000000001'
const MESSAGE_A = 'msg_A000000000000001'
const MESSAGE_B = 'msg_B000000000000001'
const HOOK_ID = 'hok_ABCdef0123456789'
const RECORD_ID = 'hev_ABCdef0123456789'
const PROJECT_ID = 'prj_ABCdef0123456789'
const SHA = 'a'.repeat(64)

async function validate(messages: unknown[]): Promise<HarnessUIMessage[]> {
  return validateUIMessages<HarnessUIMessage>({ messages, metadataSchema: messageMetadataSchema, dataSchemas: harnessDataSchemas })
}

const hook = {
  id: HOOK_ID,
  event: 'PreToolUse',
  matcher: 'Write|Edit',
  command: 'sh .claude/hooks/check.sh',
  timeout: 30,
  enabled: true,
  createdAt: 1,
  updatedAt: 2,
} as const

const record = {
  id: RECORD_ID,
  event: 'PreToolUse',
  outcome: 'denied',
  toolCallId: 'call_1',
  toolName: 'write_file',
  createdAt: 5,
  hooks: [{ source: 'personal', label: 'sh .claude/hooks/check.sh', exitCode: 2, durationMs: 12 }],
  reason: 'Writes to dist/ are not allowed.',
} as const

describe('enums and counts (Phase 11)', () => {
  it('declares the hook enums from the helper constants', () => {
    expect(hookEventSchema.options).toEqual([...HOOK_EVENTS])
    // Phase 12 (ADR-057) adds five events (13).
    expect(hookEventSchema.options).toEqual([
      'PreToolUse',
      'PostToolUse',
      'UserPromptSubmit',
      'Notification',
      'Stop',
      'SubagentStop',
      'PreCompact',
      'SessionStart',
      'PostToolUseFailure',
      'PermissionRequest',
      'SubagentStart',
      'PostCompact',
      'SessionEnd',
    ])
    expect(hookSourceSchema.options).toEqual([...HOOK_SOURCES])
    expect(hookKindSchema.options).toEqual(['command', 'code'])
    expect(hookStateSchema.options).toEqual(['active', 'pending', 'off', 'invalid', 'blocked'])
    expect(hookRecordOutcomeSchema.options).toEqual(['context', 'denied', 'asked', 'allowed', 'rewritten', 'blocked', 'continued', 'stopped', 'error'])
    expect(invocationKindSchema.options).toEqual(['command', 'skill'])
    expect(runOriginSchema.options.at(-1)).toBe('hook')
  })

  it('adds 3 notices, 2 conflict reasons and the hook data part', () => {
    expect(noticeCodeSchema.options.slice(8)).toEqual(['output-style-unavailable', 'hook-continuation-limit', 'project-mcp-unavailable'])
    // Phase 12 adds `offline` (15).
    expect(conflictReasonSchema.options).toHaveLength(15)
    expect(conflictReasonSchema.options.slice(12)).toEqual(['hook-blocked', 'untrusted', 'offline'])
    expect(Object.keys(harnessDataSchemas)).toHaveLength(6)
    expect(harnessDataSchemas.hook).toBe(hookDataSchema)
  })
})

describe('personal hooks (ADR-048)', () => {
  it('parses the DTO and the params', () => {
    // A v1.7 answer (no `type`) is a command hook.
    expect(personalHookSchema.parse(hook)).toEqual({ ...hook, type: 'command' })
    expect(personalHookSchema.parse({ ...hook, matcher: null, timeout: null })).toMatchObject({ matcher: null, timeout: null })
    for (const change of [{ id: 'hok_short' }, { event: 'BeforeTool' }, { timeout: 0 }, { timeout: 601 }, { timeout: 1.5 }])
      expect(personalHookSchema.safeParse({ ...hook, ...change }).success, JSON.stringify(change)).toBe(false)
    expect(hookParamsSchema.safeParse({ id: HOOK_ID }).success).toBe(true)
    expect(hookParamsSchema.safeParse({ id: RECORD_ID }).success).toBe(false)
  })

  it('validates create bodies (strict; no matcher needed)', () => {
    expect(hookCreateSchema.parse({ event: 'Stop', command: 'sh .claude/hooks/stop.sh' })).toEqual({ event: 'Stop', command: 'sh .claude/hooks/stop.sh' })
    expect(hookCreateSchema.parse({ event: 'Stop', command: 'x', matcher: null, timeout: null, enabled: false }).enabled).toBe(false)
    for (const body of [
      { event: 'Stop' },
      { event: 'Stop', command: '' },
      { event: 'Stop', command: '   ' },
      { event: 'Stop', command: 'a\0b' },
      { event: 'Stop', command: 'x'.repeat(LIMITS.hookCommandMaxChars + 1) },
      { event: 'Stop', command: 'x', timeout: 601 },
      { event: 'stop', command: 'x' },
      { event: 'Stop', command: 'x', id: HOOK_ID },
    ])
      expect(hookCreateSchema.safeParse(body).success, JSON.stringify(body).slice(0, 80)).toBe(false)
  })

  it('validates matchers with compileMatcher (the safe subset, never a RegExp)', () => {
    for (const matcher of ['Write', 'Edit|Write', 'mcp__memory__.*', 'Notebook*', '*', ''])
      expect(hookCreateSchema.safeParse({ event: 'PreToolUse', matcher, command: 'x' }).success, matcher).toBe(true)
    for (const matcher of ['^Bash', 'Bash$', '[ab]', '(a|b)', 'a+', 'a?', 'a\\d', 'a{2}', 'x'.repeat(LIMITS.hookMatcherMaxChars + 1)])
      expect(hookCreateSchema.safeParse({ event: 'PreToolUse', matcher, command: 'x' }).success, matcher).toBe(false)
    expect(hookUpdateSchema.safeParse({ matcher: '^Bash' }).success).toBe(false)
  })

  it('validates update bodies (strict, partial, at least one key) and tells the turn-off body apart', () => {
    expect(hookUpdateSchema.parse({ enabled: false })).toEqual({ enabled: false })
    expect(hookUpdateSchema.parse({ command: 'sh x.sh', timeout: null })).toEqual({ command: 'sh x.sh', timeout: null })
    for (const body of [{}, { id: HOOK_ID }, { enabled: 'no' }, { createdAt: 1 }])
      expect(hookUpdateSchema.safeParse(body).success, JSON.stringify(body)).toBe(false)
    // Only `{ enabled: false }` skips the fresh-auth check.
    expect(isHookTurnOff({ enabled: false })).toBe(true)
    expect(isHookTurnOff({ enabled: true })).toBe(false)
    expect(isHookTurnOff({ enabled: false, command: 'x' })).toBe(false)
    expect(isHookTurnOff({ timeout: 5 })).toBe(false)
  })
})

describe('the hook listing and the run log', () => {
  const commandEntry = {
    key: `project:${SHA}`,
    source: 'project',
    kind: 'command',
    event: 'PostToolUse',
    matcher: 'Write',
    command: 'sh .claude/hooks/format.sh',
    timeout: null,
    state: 'pending',
    path: '.claude/settings.json',
    sha256: SHA,
    diagnostics: [],
  } as const
  const codeEntry = { key: 'plugin:hook-pack:0', source: 'plugin', kind: 'code', event: 'prompt.submit', state: 'active', pluginId: 'hook-pack', diagnostics: [] } as const

  it('parses command and code entries (discriminated on kind)', () => {
    expect(hookEntrySchema.parse(commandEntry)).toEqual(commandEntry)
    expect(hookEntrySchema.parse(codeEntry)).toEqual(codeEntry)
    expect(hookEntrySchema.safeParse({ ...commandEntry, event: 'tool.after' }).success).toBe(false)
    expect(hookEntrySchema.safeParse({ ...commandEntry, state: 'changed' }).success).toBe(false)
    const invalid = { ...commandEntry, matcher: '^Bash', state: 'invalid', diagnostics: [{ level: 'error', code: 'invalid-matcher', message: 'Regular expressions are not supported.', position: [0, 0] }] }
    expect(hookEntrySchema.parse(invalid)).toEqual(invalid)
  })

  it('parses the list with the kill switches and the project scan', () => {
    const list = {
      items: [commandEntry, codeEntry],
      diagnostics: [],
      switches: { setting: true, shell: false, safeMode: false },
      project: { id: PROJECT_ID, available: true, files: ['.claude/settings.json'], pending: 1, scannedAt: 3 },
    }
    expect(hookListSchema.parse(list)).toEqual(list)
    const { project: _project, ...personal } = list
    expect(hookListSchema.parse(personal)).toEqual(personal)
    expect(hooksQuerySchema.parse({ projectId: PROJECT_ID })).toEqual({ projectId: PROJECT_ID })
    expect(hooksQuerySchema.safeParse({ projectId: 'prj_short' }).success).toBe(false)
  })

  it('parses the run log (null outcome = a silent success)', () => {
    const run = { id: RECORD_ID, at: 4, event: 'Stop', source: 'personal', label: 'sh stop.sh', chatId: CHAT_ID, exitCode: 0, timedOut: false, durationMs: 40, outcome: null }
    expect(hookRunListSchema.parse({ items: [run] }).items[0]).toEqual(run)
    expect(hookRunListSchema.safeParse({ items: [{ ...run, error: 'x'.repeat(LIMITS.hookRunErrorMaxChars + 1) }] }).success).toBe(false)
  })
})

describe('the data-hook part', () => {
  it('parses records within their caps', () => {
    expect(hookDataSchema.parse(record)).toEqual(record)
    const context = { id: RECORD_ID, event: 'UserPromptSubmit', outcome: 'context', createdAt: 1, hooks: [], context: 'Branch: main' }
    expect(hookDataSchema.parse(context)).toEqual(context)
    const rewritten = { ...record, outcome: 'rewritten', updatedInput: { path: 'notes.txt', content: 'x' } }
    expect(hookDataSchema.parse(rewritten).updatedInput).toEqual({ path: 'notes.txt', content: 'x' })
    for (const change of [
      { id: HOOK_ID },
      { outcome: 'feedback' },
      { context: 'x'.repeat(LIMITS.hookContextMaxChars + 1) },
      { reason: 'x'.repeat(LIMITS.hookReasonMaxChars + 1) },
      { updatedInput: { content: 'x'.repeat(LIMITS.hookUpdatedInputBytes) } },
      { hooks: Array.from({ length: LIMITS.hooksPerEventMax + 1 }).fill(record.hooks[0]) },
      { hooks: [{ ...record.hooks[0], label: 'x'.repeat(LIMITS.hookLabelMaxChars + 1) }] },
      { hooks: [{ ...record.hooks[0], source: 'user' }] },
    ])
      expect(hookDataSchema.safeParse({ ...record, ...change }).success, Object.keys(change).join()).toBe(false)
  })

  it('validates replies, carriers and v1.6 histories with the AI SDK', async () => {
    const reply = {
      id: MESSAGE_A,
      role: 'assistant',
      metadata: { modelRef: 'mock:hooks', startedAt: 1 },
      parts: [
        { type: 'step-start' },
        { type: 'data-hook', id: RECORD_ID, data: record },
        { type: 'text', text: 'Blocked.', state: 'done' },
      ],
    }
    const carrier = {
      id: MESSAGE_B,
      role: 'user',
      metadata: { modelRef: 'mock:hooks', startedAt: 2 },
      parts: [{ type: 'data-hook', id: 'hev_B000000000000001', data: { id: 'hev_B000000000000001', event: 'Stop', outcome: 'continued', createdAt: 2, hooks: [{ source: 'project', label: 'sh .claude/hooks/stop.sh', exitCode: 2, durationMs: 9 }], reason: 'Run the tests first.' } }],
    }
    await expect(validate([reply, carrier])).resolves.toHaveLength(2)
    await expect(validate([{ ...reply, parts: [{ type: 'data-hook', data: { ...record, outcome: 'nope' } }] }])).rejects.toThrow()
    // A v1.6 history (no hook parts, a task carrier) still validates.
    const v16 = {
      id: MESSAGE_A,
      role: 'assistant',
      metadata: { modelRef: 'mock:echo', startedAt: 1, command: { name: 'greet', input: 'Ada', type: 'prompt', expansion: 'Greet Ada.', source: 'user' } },
      parts: [{ type: 'text', text: 'Hello Ada.', state: 'done' }],
    }
    await expect(validate([v16])).resolves.toHaveLength(1)
  })

  it('carries the running-hook activity (transient)', () => {
    expect(activityDataSchema.parse({ kind: 'hooks', event: 'PreToolUse', toolCallId: 'call_1' })).toEqual({ kind: 'hooks', event: 'PreToolUse', toolCallId: 'call_1' })
    expect(activityDataSchema.parse({ kind: 'compacting' })).toEqual({ kind: 'compacting' })
    expect(activityDataSchema.safeParse({ kind: 'hooks', event: 'BeforeTool' }).success).toBe(false)
    type Part = HarnessUIMessage['parts'][number]
    expectTypeOf<Extract<Part, { type: 'data-hook' }>['data']['outcome']>().toEqualTypeOf<'context' | 'denied' | 'asked' | 'allowed' | 'rewritten' | 'blocked' | 'continued' | 'stopped' | 'error'>()
  })
})

describe('commands, skills and output styles (ADR-051, ADR-052)', () => {
  it('invokes skills with 64-character names and records what a command inlined', () => {
    const skill = { name: `a${'b'.repeat(40)}`, input: 'prod', type: 'prompt', kind: 'skill', expansion: 'Deploy prod.' }
    expect(commandInvocationSchema.parse(skill)).toEqual(skill)
    const status = { name: 'status', input: '', type: 'prompt', expansion: 'M a.txt', source: 'project', inlined: { shell: 1, files: ['README.md'] } }
    expect(commandInvocationSchema.parse(status)).toEqual(status)
    // v1.6 invocations (no kind, no inlined) still parse.
    expect(commandInvocationSchema.parse({ name: 'greet', input: 'Ada', type: 'prompt', expansion: 'Greet Ada.', source: 'user' }).kind).toBeUndefined()
    for (const change of [{ inlined: { shell: 11, files: [] } }, { inlined: { shell: 0, files: Array.from({ length: 11 }, (_, index) => `f${index}.md`) } }, { kind: 'agent' }, { name: `a${'b'.repeat(64)}` }])
      expect(commandInvocationSchema.safeParse({ ...status, ...change }).success, JSON.stringify(change).slice(0, 60)).toBe(false)
  })

  it('lists skills among the commands', () => {
    const summary = { name: 'deploy', description: 'Deploys', source: 'project', kind: 'skill', argumentHint: '<env>' }
    expect(commandSummarySchema.parse(summary)).toEqual(summary)
    expect(commandSummarySchema.parse({ name: 'compact', description: 'Compact', source: 'harness' }).kind).toBeUndefined()
    expect(commandSummarySchema.safeParse({ ...summary, kind: 'style' }).success).toBe(false)
  })

  it('carries the output style in settings, chats, projects and the chat request', () => {
    expect(settingsSchema.parse({}).outputStyle).toBe('default')
    expect(settingsSchema.parse({}).hooksEnabled).toBe(true)
    expect(settingsUpdateSchema.parse({ outputStyle: 'explanatory', hooksEnabled: false })).toEqual({ outputStyle: 'explanatory', hooksEnabled: false })
    expect(settingsUpdateSchema.safeParse({ outputStyle: 'Explanatory' }).success).toBe(false)
    // A chat without a style (v1.6) is automatic; null in an update removes the chat's choice.
    expect(chatSettingsSchema.parse({ toolMode: 'ask' })).toEqual({ toolMode: 'ask' })
    expect(chatSettingsSchema.parse({ outputStyle: 'learning' })).toEqual({ outputStyle: 'learning' })
    expect(chatSettingsSchema.safeParse({ outputStyle: null }).success).toBe(false)
    expect(chatSettingsUpdateSchema.parse({ outputStyle: null })).toEqual({ outputStyle: null })
    expect(projectUpdateSchema.parse({ outputStyle: 'terse' })).toEqual({ outputStyle: 'terse' })
    expect(projectUpdateSchema.parse({ outputStyle: null })).toEqual({ outputStyle: null })
    const project = { id: PROJECT_ID, name: 'Site', path: '/w/site', instructions: null, available: true, issue: null, instructionsFile: null, chatCount: 0, outputStyle: null, createdAt: 1, updatedAt: 1 }
    expect(projectSummarySchema.parse(project)).toEqual(project)
    const body = { chatId: CHAT_ID, message: { id: MESSAGE_A, role: 'user', parts: [{ type: 'text', text: 'Hi' }] }, trigger: 'submit-message', modelRef: 'mock:echo', reasoningEffort: 'auto', toolMode: 'ask' }
    expect(chatRequestBodySchema.parse(body)).not.toHaveProperty('outputStyle')
    expect(chatRequestBodySchema.parse({ ...body, outputStyle: 'learning' }).outputStyle).toBe('learning')
    expect(chatRequestBodySchema.parse({ ...body, outputStyle: null }).outputStyle).toBeNull()
    expect(chatRequestBodySchema.safeParse({ ...body, outputStyle: 'Learning Mode' }).success).toBe(false)
  })
})

describe('plugin API 1.5.0 manifests', () => {
  const base = { manifestVersion: 1, id: 'hook-pack', name: 'Hook pack', version: '1.0.0', engines: { harness: '^1.5.0' } } as const
  const style = { name: 'terse', description: 'Short answers', content: 'Answer in at most three sentences.' }

  it('contributes output styles (at most 20, unique, builtin names reserved)', () => {
    const manifest = { ...base, contributes: { outputStyles: [style, { ...style, name: 'teacher', keepCodingInstructions: true }] } }
    expect(pluginManifestSchema.parse(manifest)).toEqual(manifest)
    expect(manifestRequiresTrust(pluginManifestSchema.parse(manifest))).toBe(false)
    for (const name of ['default', 'explanatory', 'learning', 'Terse'])
      expect(declarativeOutputStyleSchema.safeParse({ ...style, name }).success, name).toBe(false)
    expect(declarativeOutputStyleSchema.safeParse({ ...style, content: '' }).success).toBe(false)
    const duplicates = pluginManifestSchema.safeParse({ ...base, contributes: { outputStyles: [style, style] } })
    expect(duplicates.error?.issues.map(issue => issue.path.join('.'))).toEqual(['contributes.outputStyles.1.name'])
    const many = { ...base, contributes: { outputStyles: Array.from({ length: LIMITS.pluginOutputStylesMax + 1 }, (_, index) => ({ ...style, name: `s${index}` })) } }
    expect(pluginManifestSchema.safeParse(many).success).toBe(false)
  })

  it('still parses ^1.4.0 manifests (no hooks, no styles)', () => {
    const v14 = { ...base, id: 'agent-pack', engines: { harness: '^1.4.0' }, contributes: { skills: [{ name: 'pdf', description: 'PDFs', content: 'Read PDFs.' }], commands: [{ name: 'tldr', description: 'Summarize', template: 'Summarize: {{input}}' }] } }
    expect(pluginManifestSchema.parse(v14)).toEqual(v14)
    expect(manifestRequiresTrust(pluginManifestSchema.parse(v14))).toBe(false)
    expect(declaresCommandHooks(pluginManifestSchema.parse(v14))).toBe(false)
  })

  it('refuses the client command output-style as a plugin command', () => {
    const manifest = { ...base, contributes: { commands: [{ name: 'output-style', description: 'Style', template: 'x' }] } }
    expect(pluginManifestSchema.safeParse(manifest).success).toBe(false)
  })

  it('contributes command hooks in the Claude Code format (at most 50 handlers; requires trust)', () => {
    const hooks = {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'sh "$HARNESS_PLUGIN_ROOT/scripts/guard.sh"' }] }],
      PostToolUse: [{ matcher: 'Write|Edit|MultiEdit', hooks: [{ type: 'command', command: 'sh after.sh', timeout: 30 }] }],
    }
    const manifest = { ...base, contributes: { hooks } }
    const parsed = pluginManifestSchema.parse(manifest)
    expect(parsed).toEqual(manifest)
    expect(countHookHandlers(parsed.contributes?.hooks)).toBe(2)
    expect(declaresCommandHooks(parsed)).toBe(true)
    expect(manifestRequiresTrust(parsed)).toBe(true)
    expect(declaresCommandHooks(pluginManifestSchema.parse({ ...base, contributes: { hooks: {} } }))).toBe(false)
    for (const bad of [
      { BeforeTool: [] },
      { Stop: [{ hooks: [] }] },
      // Plugin API 1.6.0: prompt handlers only on the prompt events.
      { SessionStart: [{ hooks: [{ type: 'prompt', prompt: 'x' }] }] },
      { Stop: [{ hooks: [{ type: 'agent', prompt: 'x' }] }] },
      { Stop: [{ hooks: [{ type: 'command', command: 'x', timeout: 0 }] }] },
      { Stop: [{ hooks: [{ type: 'command', command: 'x' }], extra: true }] },
      { PreToolUse: [{ matcher: '^Bash', hooks: [{ type: 'command', command: 'x' }] }] },
      { Stop: Array.from({ length: 26 }, () => ({ hooks: [{ type: 'command', command: 'a' }, { type: 'command', command: 'b' }] })) },
    ])
      expect(hooksConfigSchema.safeParse(bad).success, JSON.stringify(bad).slice(0, 80)).toBe(false)
  })

  it('requires trust for a command template with a !`cmd` span', () => {
    const spans = { ...base, contributes: { commands: [{ name: 'status', description: 'Status', template: 'Status:\n!`git status --short`\n{{input}}' }] } }
    expect(manifestRequiresTrust(pluginManifestSchema.parse(spans))).toBe(true)
    const plain = { ...base, contributes: { commands: [{ name: 'shout', description: 'Shout', template: 'Say it loud! `{{input}}`' }] } }
    expect(manifestRequiresTrust(pluginManifestSchema.parse(plain))).toBe(false)
  })
})

describe('the hooks.changed event', () => {
  it('names the scope (null = personal or plugin hooks)', () => {
    expect(hooksChangedDataSchema.parse({ projectId: null })).toEqual({ projectId: null })
    expect(serverEventSchema.parse(createServerEvent('hooks.changed', { projectId: PROJECT_ID }, 1))).toEqual({ type: 'hooks.changed', data: { projectId: PROJECT_ID }, at: 1 })
    expect(serverEventSchema.safeParse({ type: 'hooks.changed', data: {}, at: 1 }).success).toBe(false)
  })
})

describe('the hook-blocked conflict', () => {
  it('carries the record of the blocking event (details.hook)', () => {
    const blocked = { id: RECORD_ID, event: 'UserPromptSubmit', outcome: 'blocked', createdAt: 1, hooks: [{ source: 'project', label: 'sh check.sh', exitCode: 2, durationMs: 3 }], reason: 'No secrets in prompts.' } as const
    expect(conflictDetailsSchema.parse({ reason: 'hook-blocked', hook: blocked })).toEqual({ reason: 'hook-blocked', hook: blocked })
    expect(hookDataSchema.parse(conflictDetailsSchema.parse({ reason: 'hook-blocked', hook: blocked }).hook)).toEqual(blocked)
    expect(conflictDetailsSchema.parse({ reason: 'untrusted' })).toEqual({ reason: 'untrusted' })
    expect(conflictDetailsSchema.safeParse({ reason: 'hook-blocked', hook: 'denied' }).success).toBe(false)
  })
})

describe('prompt hooks and the Phase 12 handler fields (ADR-057)', () => {
  const promptHook = { id: HOOK_ID, type: 'prompt', event: 'PreToolUse', matcher: 'Write', prompt: 'Refuse writes to dist/. $ARGUMENTS', model: 'haiku', timeout: null, continueOnBlock: true, enabled: true, createdAt: 1, updatedAt: 2 } as const

  it('parses command and prompt hook DTOs (discriminated on type)', () => {
    expect(personalHookSchema.parse(promptHook)).toEqual(promptHook)
    const command = { ...hook, type: 'command', args: ['--fix'], async: true, if: 'Bash(npm test:*)', statusMessage: 'Formatting' } as const
    expect(personalHookSchema.parse(command)).toEqual(command)
    // The fields of the other type are not part of a variant.
    expect(personalHookSchema.parse({ ...promptHook, command: 'x' })).not.toHaveProperty('command')
    expect(personalHookSchema.safeParse({ ...promptHook, type: 'http' }).success).toBe(false)
  })

  it('creates prompt hooks on the prompt events only, and command hooks with the new fields', () => {
    const body = { type: 'prompt', event: 'Stop', prompt: 'Did the agent run the tests? $ARGUMENTS', model: 'anthropic:claude-haiku-5', continueOnBlock: false } as const
    expect(hookCreateSchema.parse(body)).toEqual(body)
    expect(hookCreateSchema.parse({ type: 'prompt', event: 'PermissionRequest', prompt: 'x', model: 'claude-haiku-4-5[1m]' }).type).toBe('prompt')
    for (const event of ['SessionStart', 'Notification', 'PreCompact', 'PostCompact', 'SubagentStart', 'SessionEnd'])
      expect(hookCreateSchema.safeParse({ ...body, event }).success, event).toBe(false)
    for (const change of [{ prompt: '' }, { prompt: '   ' }, { prompt: 'x'.repeat(LIMITS.promptHookPromptMaxChars + 1) }, { model: 'gpt' }, { command: 'sh x.sh' }, { args: ['x'] }])
      expect(hookCreateSchema.safeParse({ ...body, ...change }).success, JSON.stringify(change).slice(0, 60)).toBe(false)
    const command = { event: 'PreToolUse', matcher: 'Bash', command: 'node', args: ['scripts/check.mjs', '--strict'], async: false, if: 'Bash(git push:*)', statusMessage: 'Checking the push' } as const
    expect(hookCreateSchema.parse(command)).toEqual(command)
    expect(hookCreateSchema.parse({ ...command, type: 'command' }).type).toBe('command')
    for (const change of [{ if: 'Bash(' }, { if: '1Bash' }, { statusMessage: '' }, { args: ['a\0b'] }, { prompt: 'x' }, { continueOnBlock: true }])
      expect(hookCreateSchema.safeParse({ ...command, ...change }).success, JSON.stringify(change)).toBe(false)
    // The new events take command hooks.
    for (const event of ['PostToolUseFailure', 'PermissionRequest', 'SubagentStart', 'PostCompact', 'SessionEnd'])
      expect(hookCreateSchema.safeParse({ event, command: 'sh x.sh' }).success, event).toBe(true)
  })

  it('updates keep command and prompt fields apart', () => {
    expect(hookUpdateSchema.parse({ prompt: 'New prompt' })).toEqual({ prompt: 'New prompt' })
    expect(hookUpdateSchema.parse({ type: 'prompt', prompt: 'x', model: null })).toEqual({ type: 'prompt', prompt: 'x', model: null })
    expect(hookUpdateSchema.parse({ args: null, if: 'Write' })).toEqual({ args: null, if: 'Write' })
    for (const body of [{ command: 'x', prompt: 'y' }, { type: 'prompt', command: 'x' }, { type: 'command', model: 'haiku' }, { type: 'prompt', event: 'SessionStart' }, { type: 'agent' }])
      expect(hookUpdateSchema.safeParse(body).success, JSON.stringify(body)).toBe(false)
    expect(isHookTurnOff({ enabled: false, prompt: 'x' })).toBe(false)
  })

  it('lists prompt hooks and untrusted plugin hooks', () => {
    const entry = { key: 'plugin:review-kit:0', source: 'plugin', kind: 'command', type: 'prompt', event: 'Stop', matcher: null, command: '', prompt: 'Check $ARGUMENTS', model: 'haiku', continueOnBlock: false, timeout: null, state: 'pending', pluginId: 'review-kit', diagnostics: [] } as const
    expect(hookEntrySchema.parse(entry)).toEqual(entry)
    const command = { key: 'personal:x', source: 'personal', kind: 'command', event: 'SessionEnd', matcher: null, command: 'sh end.sh', args: ['--quiet'], async: true, if: 'Bash', statusMessage: 'Saying goodbye', timeout: 5, state: 'active', diagnostics: [] } as const
    expect(hookEntrySchema.parse(command)).toEqual(command)
  })

  it('records prompt hooks and harness-asked allows in data-hook parts', () => {
    const prompted = { ...record, hooks: [{ source: 'personal', label: 'Refuse writes to dist/', exitCode: null, durationMs: 300, kind: 'prompt', model: 'anthropic:claude-haiku-5' }] } as const
    expect(hookDataSchema.parse(prompted)).toEqual(prompted)
    const allowed = { ...record, outcome: 'allowed', reason: undefined, harnessAsked: true } as const
    expect(hookDataSchema.parse(allowed).harnessAsked).toBe(true)
    expect(hookDataSchema.safeParse({ ...record, harnessAsked: false }).success).toBe(false)
    expect(hookDataSchema.safeParse({ ...record, hooks: [{ ...record.hooks[0], kind: 'http' }] }).success).toBe(false)
    // A v1.7 record (no kind, no harnessAsked) still parses.
    expect(hookDataSchema.parse(record)).toEqual(record)
  })

  it('plugin API 1.6.0 manifests: 13 events, prompt handlers without trust, unknown events still refused', () => {
    const base = { manifestVersion: 1, id: 'judge-pack', name: 'Judge pack', version: '1.0.0', engines: { harness: '^1.6.0' } } as const
    const prompts = { ...base, contributes: { hooks: { Stop: [{ hooks: [{ type: 'prompt', prompt: 'Is the task done? $ARGUMENTS', model: 'haiku' }] }], PostToolUseFailure: [{ matcher: 'Bash', hooks: [{ type: 'prompt', prompt: 'Explain', continueOnBlock: true }] }] } } }
    const parsed = pluginManifestSchema.parse(prompts)
    expect(parsed).toEqual(prompts)
    expect(countHookHandlers(parsed.contributes?.hooks)).toBe(2)
    expect(declaresCommandHooks(parsed)).toBe(false)
    expect(manifestRequiresTrust(parsed)).toBe(false)
    const mixed = { ...base, contributes: { hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'sh end.sh', args: ['--quiet'], async: true }] }], Stop: [{ hooks: [{ type: 'prompt', prompt: 'Done?' }] }] } } }
    expect(manifestRequiresTrust(pluginManifestSchema.parse(mixed))).toBe(true)
    expect(pluginManifestSchema.safeParse({ ...base, contributes: { hooks: { Elicitation: [{ hooks: [{ type: 'command', command: 'x' }] }] } } }).success).toBe(false)
  })
})

describe('the if rule and the model of a hook (ADR-057, checked with the util/hooks.ts helpers)', () => {
  it('accepts what checkHookIf accepts, on tool events only', () => {
    for (const rule of ['Write', 'mcp__github__*', 'Bash(npm test:*)', 'Bash(npm test *)', 'Bash(git status)'])
      expect(hookCreateSchema.safeParse({ event: 'PreToolUse', command: 'sh x.sh', if: rule }).success, rule).toBe(true)
    for (const rule of ['Bash(*)', 'Bash(npm * test)', 'Read(./.env)', ''])
      expect(hookCreateSchema.safeParse({ event: 'PreToolUse', command: 'sh x.sh', if: rule }).success, rule).toBe(false)
    expect(hookCreateSchema.safeParse({ event: 'Stop', command: 'sh x.sh', if: 'Write' }).error?.issues[0]?.path).toEqual(['if'])
    expect(hookCreateSchema.safeParse({ type: 'prompt', event: 'PostToolUse', prompt: 'x', if: 'Bash(npm test:*)' }).success).toBe(true)
    const manifestHooks = { Stop: [{ hooks: [{ type: 'command', command: 'sh x.sh', if: 'Write' }] }] }
    expect(hooksConfigSchema.safeParse(manifestHooks).success).toBe(false)
    expect(hooksConfigSchema.safeParse({ PreToolUse: [{ hooks: [{ type: 'prompt', prompt: 'x', if: 'Write' }] }] }).success).toBe(true)
  })

  it('takes a model ref or a Claude model name', () => {
    for (const model of ['anthropic:claude-haiku-5', 'haiku', 'Sonnet', 'opusplan', 'claude-sonnet-4-5[1m]'])
      expect(hookCreateSchema.safeParse({ type: 'prompt', event: 'Stop', prompt: 'x', model }).success, model).toBe(true)
    for (const model of ['gpt-6', 'inherit', ''])
      expect(hookCreateSchema.safeParse({ type: 'prompt', event: 'Stop', prompt: 'x', model }).success, model).toBe(false)
  })
})
