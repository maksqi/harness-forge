// Pure helpers of the Customize Hooks tab (docs/UI.md 9.13, 11.8, 15; W11.8-T3 … T5): the event copy, the row badge,
// matcher and meta line, the matcher preview, the draft, the Claude Code JSON of rows, the import of a Claude settings
// file and the editor's field rules.
import { HOOK_EVENTS } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { codeHookEntry, hookEntry, trustSha } from '~/utils/testing/fixtures'
import {
  addHooksText,
  commandError,
  draftFromHook,
  foundHooksText,
  HOOK_COPY,
  HOOK_EVENT_INFO,
  hookDeleteCopy,
  hookJson,
  hookMatcherText,
  hookRowMeta,
  hookStateBadge,
  importHooks,
  matcherError,
  matcherPreview,
  matchesEveryTool,
  parseHookTimeout,
  promptError,
  sortHookEntries,
} from './hooks'

const TOOLS = ['shell', 'read_file', 'write_file', 'edit_file', 'search_files', 'find_files', 'web_fetch', 'task', 'mcp__docs__search']

/** A Claude Code settings file: permissions (ignored), a valid and a regex matcher group, a Stop hook, a prompt hook. */
const CLAUDE_SETTINGS = JSON.stringify({
  permissions: { allow: ['Bash(npm run lint)'], deny: [] },
  env: { FOO: '1' },
  hooks: {
    PreToolUse: [
      { matcher: 'Bash', hooks: [{ type: 'command', command: './scripts/guard.sh', timeout: 60 }] },
      { matcher: '^Bash.*$', hooks: [{ type: 'command', command: './x.sh' }] },
    ],
    Stop: [{ hooks: [{ type: 'command', command: 'pnpm lint' }] }],
    UserPromptSubmit: [{ hooks: [{ type: 'prompt', prompt: 'Is this safe?' }] }],
  },
}, null, 2)

describe('customize hooks helpers', () => {
  it('describes the eight events in order; only the tool events match tools', () => {
    expect(Object.keys(HOOK_EVENT_INFO)).toEqual([...HOOK_EVENTS])
    expect(HOOK_EVENT_INFO.PreToolUse).toMatchObject({ label: 'PreToolUse', toolMatcher: true, description: 'Before a tool runs. It can block the call, allow it without asking or change its input.' })
    expect(HOOK_EVENT_INFO.Stop).toMatchObject({ label: 'Stop', toolMatcher: false, description: 'When the agent finishes a reply. It can make it continue.' })
    expect(HOOK_EVENT_INFO.SessionStart.description).toBe('When a chat\'s first reply starts, and again after a compaction. It can add context.')
    expect(HOOK_COPY.runHooks).toBe('Run hooks')
  })

  it('reads the state badge of every state', () => {
    expect(hookStateBadge(hookEntry())).toBeNull()
    expect(hookStateBadge(hookEntry({ source: 'project', state: 'active', sha256: trustSha(1) }))).toEqual({ label: 'Approved', tone: 'success' })
    expect(hookStateBadge(hookEntry({ source: 'project', state: 'pending', sha256: trustSha(1) }))).toEqual({ label: 'Needs approval', tone: 'warning' })
    expect(hookStateBadge(hookEntry({ source: 'plugin', state: 'pending', pluginId: 'hook-pack' }))).toEqual({ label: 'Plugin not trusted', tone: 'warning' })
    expect(hookStateBadge(hookEntry({ state: 'off' }))).toEqual({ label: 'Off', tone: 'muted' })
    expect(hookStateBadge(hookEntry({ state: 'invalid' }))).toEqual({ label: 'Invalid', tone: 'destructive' })
    expect(hookStateBadge(hookEntry({ state: 'blocked' }))).toEqual({ label: 'Off on this server', tone: 'muted' })
  })

  it('reads the meta line and the matcher of a row', () => {
    expect(hookRowMeta(hookEntry({ timeout: 30 }), id => id)).toEqual(['Personal', 'timeout 30s'])
    expect(hookRowMeta(hookEntry({ source: 'project', path: '.claude/settings.json' }), id => id)).toEqual(['Project', '.claude/settings.json'])
    expect(hookRowMeta(hookEntry({ source: 'plugin', pluginId: 'hook-pack' }), () => 'Hook pack')).toEqual(['Hook pack'])
    expect(hookRowMeta(codeHookEntry(), () => 'Hook pack')).toEqual(['Hook pack', 'Code hook'])
    expect(hookMatcherText(hookEntry())).toBe('Write|Edit')
    expect(hookMatcherText(hookEntry({ event: 'PreToolUse', matcher: null }))).toBe('All tools')
    expect(hookMatcherText(hookEntry({ event: 'PreToolUse', matcher: '*' }))).toBe('All tools')
    expect(hookMatcherText(hookEntry({ event: 'Stop', matcher: null }))).toBeNull()
    expect(hookMatcherText(hookEntry({ event: 'SessionStart', matcher: 'startup' }))).toBe('startup')
    expect(hookMatcherText(codeHookEntry())).toBeNull()
    expect(matchesEveryTool('.*')).toBe(true)
    expect(matchesEveryTool('Bash|*')).toBe(true)
    expect(matchesEveryTool('mcp__*')).toBe(false)
  })

  it('previews a matcher with the Claude names in brackets, unknown names and invalid matchers', () => {
    expect(matcherPreview('Bash|Edit', TOOLS)).toEqual({ ok: true, matches: ['shell', 'edit_file'], text: 'Matches shell (Bash), edit_file (Edit)' })
    expect(matcherPreview('write_file', TOOLS)).toEqual({ ok: true, matches: ['write_file'], text: 'Matches write_file (Write)' })
    expect(matcherPreview('mcp__docs__*', TOOLS).text).toBe('Matches mcp__docs__search')
    expect(matcherPreview('Bash|Deploy', TOOLS)).toEqual({ ok: true, matches: ['shell'], text: 'Matches shell (Bash). No tool is named Deploy now.' })
    expect(matcherPreview('Deploy', TOOLS)).toEqual({ ok: true, matches: [], text: 'No tool is named Deploy now.' })
    expect(matcherPreview('^Bash.*$', TOOLS)).toEqual({ ok: false, matches: [], text: 'Use tool names, | and * only.' })
    expect(matcherPreview('', TOOLS)).toEqual({ ok: true, matches: TOOLS, text: '' })
    expect(matcherPreview('*', TOOLS).matches).toHaveLength(TOOLS.length)
    const many = Array.from({ length: 12 }, (_, index) => `tool_${index}`)
    expect(matcherPreview('tool_*', many).text).toBe('Matches tool_0, tool_1, tool_2, tool_3, tool_4, tool_5, tool_6, tool_7 and 4 more')
  })

  it('reads the draft of a row', () => {
    expect(draftFromHook(hookEntry({ state: 'off' }))).toEqual({ event: 'PostToolUse', matcher: 'Write|Edit', command: 'sh .claude/hooks/format.sh', timeout: null, enabled: false })
    expect(draftFromHook(hookEntry({ matcher: null, timeout: 30, source: 'project', state: 'pending' }))).toEqual({ event: 'PostToolUse', matcher: '', command: 'sh .claude/hooks/format.sh', timeout: 30, enabled: true })
    expect(draftFromHook(codeHookEntry())).toEqual({ event: 'PreToolUse', matcher: '', command: '', timeout: null, enabled: true })
  })

  it('writes the Claude Code hooks object of command rows, grouping rows of the same event and matcher', () => {
    const json = JSON.parse(hookJson([
      hookEntry({ event: 'Stop', matcher: null, command: 'pnpm lint' }),
      hookEntry({ timeout: 30 }),
      hookEntry({ command: 'sh other.sh' }),
      codeHookEntry(),
    ]))
    expect(json).toEqual({
      hooks: {
        PostToolUse: [{ matcher: 'Write|Edit', hooks: [{ type: 'command', command: 'sh .claude/hooks/format.sh', timeout: 30 }, { type: 'command', command: 'sh other.sh' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'pnpm lint' }] }],
      },
    })
    expect(Object.keys(json.hooks)).toEqual(['PostToolUse', 'Stop'])
  })

  it('imports a real Claude Code settings file: an invalid matcher unchecked, the prompt hook noted', () => {
    const result = importHooks(CLAUDE_SETTINGS)
    expect(result.error).toBeNull()
    expect(result.items).toEqual([
      { draft: { event: 'PreToolUse', matcher: 'Bash', command: './scripts/guard.sh', timeout: 60, enabled: true }, valid: true, message: null },
      { draft: { event: 'PreToolUse', matcher: '^Bash.*$', command: './x.sh', timeout: null, enabled: true }, valid: false, message: 'Use tool names, | and * only.' },
      { draft: { event: 'Stop', matcher: '', command: 'pnpm lint', timeout: null, enabled: true }, valid: true, message: null },
    ])
    expect(result.notes).toEqual(['Ignored: "prompt" hooks aren\'t supported.'])
    expect(foundHooksText(result.items.length)).toBe('Found 3 hooks')
    expect(addHooksText(2)).toBe('Add 2 hooks')
    expect(addHooksText(1)).toBe('Add 1 hook')
  })

  it('imports a bare hooks object and reports unknown events', () => {
    // Phase 12: PermissionRequest is an event now; PermissionDenied is not.
    const result = importHooks(`\uFEFF${JSON.stringify({ PostToolUse: [{ matcher: 'Write|Edit', hooks: [{ type: 'command', command: 'prettier --write .' }] }], PermissionDenied: [] })}`)
    expect(result.items.map(item => item.draft.command)).toEqual(['prettier --write .'])
    expect(result.notes).toEqual(['The event "PermissionDenied" is not supported; its hooks are ignored.'])
  })

  it('reports invalid JSON, empty texts and files without hooks', () => {
    expect(importHooks('')).toEqual({ items: [], notes: [], error: null })
    expect(importHooks('{ "hooks": ')).toEqual({ items: [], notes: [], error: 'This isn\'t valid JSON.' })
    expect(importHooks('{"permissions": {"allow": []}}').error).toBe('No hooks found.')
    expect(importHooks('[1, 2]').error).toBe('No hooks found.')
    const prompts = importHooks(JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'prompt', prompt: 'x' }] }] } }))
    expect(prompts).toEqual({ items: [], notes: ['Ignored: "prompt" hooks aren\'t supported.'], error: 'No hooks found.' })
  })

  it('checks the editor fields like the server', () => {
    expect(matcherError('Bash|Edit')).toBeNull()
    expect(matcherError('')).toBeNull()
    expect(matcherError('^Bash')).toBe('Use tool names, | and * only.')
    expect(matcherError('a'.repeat(201))).toBe('Use at most 200 characters.')
    expect(commandError('  ')).toBe('Add the command.')
    expect(commandError('x'.repeat(4097))).toBe('Use at most 4,096 characters.')
    expect(commandError('pnpm lint')).toBeNull()
    // The runner prefers bash and falls back to sh.
    expect(HOOK_COPY.commandHelp).toMatch(/^Runs with bash \(or sh when bash is missing\) in the project folder /)
    expect(parseHookTimeout('')).toEqual({ value: null })
    expect(parseHookTimeout(' 30 ')).toEqual({ value: 30 })
    expect(parseHookTimeout('0')).toEqual({ error: 'Enter a whole number from 1 to 600.' })
    expect(parseHookTimeout('601')).toEqual({ error: 'Enter a whole number from 1 to 600.' })
    expect(parseHookTimeout('1.5')).toEqual({ error: 'Enter a whole number from 1 to 600.' })
    expect(hookDeleteCopy(hookEntry())).toEqual({ title: 'Delete this hook?', description: 'It stops running at once.', confirm: 'Delete hook' })
  })

  it('sorts rows in event order, then by matcher; code hooks last', () => {
    const rows = sortHookEntries([
      codeHookEntry(),
      hookEntry({ key: 'b', event: 'Stop', matcher: null }),
      hookEntry({ key: 'c', event: 'PreToolUse', matcher: 'Write' }),
      hookEntry({ key: 'd', event: 'PreToolUse', matcher: 'Bash' }),
    ])
    expect(rows.map(row => row.key)).toEqual(['d', 'c', 'b', 'plugin:hook-pack:0'])
  })
})

describe('phase 12 hook helpers (C46)', () => {
  it('knows the matcher subject of every event and where prompt hooks run', () => {
    expect(HOOK_EVENT_INFO.PostToolUseFailure).toMatchObject({ toolMatcher: true, promptAllowed: true, matcher: 'tool' })
    expect(HOOK_EVENT_INFO.SessionEnd).toMatchObject({ toolMatcher: false, promptAllowed: false, matcher: 'reason' })
    expect(HOOK_EVENT_INFO.Stop).toMatchObject({ promptAllowed: true, matcher: null })
    expect(HOOK_EVENT_INFO.SubagentStart.matcher).toBe('agent')
  })

  it('checks a prompt', () => {
    expect(promptError('')).toBe('Add the prompt.')
    expect(promptError('x'.repeat(16_385))).toBe('Use at most 16,384 characters.')
    expect(promptError('a\0b')).toBe('The prompt cannot contain NUL characters.')
    expect(promptError('Did the tests pass? $ARGUMENTS')).toBeNull()
  })
})
