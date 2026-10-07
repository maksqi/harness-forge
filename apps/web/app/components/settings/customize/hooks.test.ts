// Pure helpers of the Customize Hooks tab (docs/UI.md 9.13, 9.14, 11.8, 11.9, 15; W11.8-T3 … T5, W12.12-T1 … T3): the
// event copy, the row badge, matcher and meta line, the matcher preview, the draft, the Claude Code JSON of rows, the
// import of a Claude settings file and the editor's field rules; Phase 12: the 13 events, prompt hooks and the handler
// fields in drafts, bodies, rows, JSON and the import, the project section's file problems and the splice of a handler
// into a settings file's `hooks` key.
import { HOOK_EVENTS, hookCreateSchema, hookUpdateSchema } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { codeHookEntry, hookEntry, personalHook, trustSha } from '~/utils/testing/fixtures'
import {
  addHooksText,
  argsError,
  commandError,
  draftFromHook,
  draftFromPersonal,
  execFormText,
  foundHooksText,
  HOOK_COPY,
  HOOK_EVENT_INFO,
  hookCreateBody,
  hookDeleteCopy,
  hookDraftText,
  hookFileNotice,
  hookHandlerJson,
  hookJson,
  hookMatcherText,
  hookPatch,
  hookRowMeta,
  hookStateBadge,
  ifError,
  importHooks,
  isProjectHookFile,
  matcherError,
  matcherPreview,
  matchesEveryTool,
  parseHookArgs,
  parseHookTimeout,
  PROJECT_HOOK_FILES,
  projectEntryAt,
  projectSavedText,
  promptError,
  promptEventError,
  promptFirstLine,
  promptModelLine,
  rawHandlerMatches,
  sameHandler,
  sortHookEntries,
  spliceProjectHook,
  staleFileText,
  statusMessageError,
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
  it('describes the 13 events in order; only the tool events match tools', () => {
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

  it('imports a real Claude Code settings file: an invalid matcher unchecked, the prompt hook kept (Phase 12)', () => {
    const result = importHooks(CLAUDE_SETTINGS)
    expect(result.error).toBeNull()
    expect(result.items).toEqual([
      { draft: { event: 'PreToolUse', matcher: 'Bash', command: './scripts/guard.sh', timeout: 60, enabled: true }, valid: true, message: null },
      { draft: { event: 'PreToolUse', matcher: '^Bash.*$', command: './x.sh', timeout: null, enabled: true }, valid: false, message: 'Use tool names, | and * only.' },
      { draft: { event: 'Stop', matcher: '', command: 'pnpm lint', timeout: null, enabled: true }, valid: true, message: null },
      { draft: { event: 'UserPromptSubmit', matcher: '', command: '', timeout: null, enabled: true, type: 'prompt', prompt: 'Is this safe?', model: null, continueOnBlock: false }, valid: true, message: null },
    ])
    expect(result.notes).toEqual([])
    expect(foundHooksText(result.items.length)).toBe('Found 4 hooks')
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
    const http = importHooks(JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'http', url: 'https://example.invalid/hook' }] }] } }))
    expect(http).toEqual({ items: [], notes: ['Ignored: http hooks aren\'t supported.'], error: 'No hooks found.' })
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

describe('phase 12 hook helpers (W12.12)', () => {
  const promptRow = hookEntry({ key: 'prompt', event: 'Stop', matcher: null, type: 'prompt', command: '', prompt: 'Did the tests pass?\nAnswer ok or not.', model: 'haiku', timeout: 20 })

  it('describes the five new events with their final copy', () => {
    expect(Object.keys(HOOK_EVENT_INFO)).toHaveLength(13)
    expect(HOOK_EVENT_INFO.PostToolUseFailure).toMatchObject({ toolMatcher: true, description: 'After a tool call failed. It can give the agent feedback.' })
    expect(HOOK_EVENT_INFO.PermissionRequest).toMatchObject({ toolMatcher: true, promptAllowed: true, description: 'When harness-forge is about to ask you to approve a tool call. It can allow or deny the call.' })
    expect(HOOK_EVENT_INFO.SubagentStart).toMatchObject({ toolMatcher: false, promptAllowed: false, matcher: 'agent', description: 'When a sub-agent starts. It can add context for the sub-agent.' })
    expect(HOOK_EVENT_INFO.PostCompact.description).toBe('After the conversation was compacted.')
    expect(HOOK_EVENT_INFO.SessionEnd.description).toBe('When you delete a chat.')
    expect(promptEventError('prompt', 'Notification')).toBe('Prompt hooks work only for PreToolUse, PostToolUse, PostToolUseFailure, UserPromptSubmit, Stop, SubagentStop and PermissionRequest.')
    expect(promptEventError('prompt', 'Stop')).toBeNull()
    expect(promptEventError('command', 'SessionEnd')).toBeNull()
  })

  it('reads the copy of the model line, a saved project file and a stale file', () => {
    expect(promptModelLine('Claude Haiku 4.5', true)).toBe('Runs with Claude Haiku 4.5 (Settings → General → Hook model). It answers ok, or not ok with a reason.')
    expect(promptModelLine('Claude Opus 5', false)).toBe('Runs with Claude Opus 5. It answers ok, or not ok with a reason.')
    expect(projectSavedText('.claude/settings.json', 0)).toBe('Saved .claude/settings.json.')
    expect(projectSavedText('.claude/settings.json', 1)).toBe('Saved .claude/settings.json. 1 item needs your approval.')
    expect(projectSavedText('.claude/settings.json', 3)).toBe('Saved .claude/settings.json. 3 items need your approval.')
    expect(staleFileText('.harness/settings.json')).toBe('.harness/settings.json changed on disk after you opened it.')
  })

  it('shows a prompt row\'s prompt and the handler fields in the meta line', () => {
    expect(promptFirstLine('\n  Did the tests pass?  \nmore')).toBe('Did the tests pass?')
    expect(execFormText('node', ['scripts/check.js', 'a b', ''])).toBe('node scripts/check.js "a b" ""')
    expect(hookDraftText(draftFromHook(promptRow))).toBe('Did the tests pass?')
    expect(hookDraftText({ event: 'Stop', matcher: '', command: 'sh', timeout: null, enabled: true, args: ['x.sh'] })).toBe('sh x.sh')
    expect(hookRowMeta(hookEntry({ event: 'PreToolUse', async: true, if: 'Bash(git *)' }), id => id)).toEqual(['Personal', 'In the background', 'Only when Bash(git *)'])
    expect(hookRowMeta(promptRow, id => id)).toEqual(['Personal', 'timeout 20s'])
    expect(hookDeleteCopy(hookEntry({ source: 'project', path: '.claude/settings.json' })).description).toBe('It\'s removed from .claude/settings.json.')
  })

  it('sorts prompt rows by their prompt', () => {
    const rows = sortHookEntries([
      hookEntry({ key: 'b', event: 'Stop', matcher: null, type: 'prompt', command: '', prompt: 'Zebra' }),
      hookEntry({ key: 'a', event: 'Stop', matcher: null, type: 'prompt', command: '', prompt: 'Apple' }),
    ])
    expect(rows.map(row => row.key)).toEqual(['a', 'b'])
  })

  it('reads the drafts of prompt rows, exec-form rows and personal hooks', () => {
    expect(draftFromHook(promptRow)).toEqual({ event: 'Stop', matcher: '', command: '', timeout: 20, enabled: true, type: 'prompt', prompt: 'Did the tests pass?\nAnswer ok or not.', model: 'haiku', continueOnBlock: false })
    expect(draftFromHook(hookEntry({ command: 'node', args: ['a.js'], async: true, if: 'Write', statusMessage: 'Formatting' }))).toEqual({
      event: 'PostToolUse',
      matcher: 'Write|Edit',
      command: 'node',
      timeout: null,
      enabled: true,
      args: ['a.js'],
      async: true,
      if: 'Write',
      statusMessage: 'Formatting',
    })
    expect(draftFromPersonal(personalHook())).toEqual({ event: 'PostToolUse', matcher: 'Write|Edit', command: 'sh .claude/hooks/format.sh', timeout: null, enabled: true })
    expect(draftFromPersonal({ ...personalHook(), type: 'prompt', prompt: 'Check', model: null, continueOnBlock: true } as never)).toMatchObject({ type: 'prompt', prompt: 'Check', model: null, continueOnBlock: true, command: '' })
  })

  it('builds the create bodies the server accepts', () => {
    const command = hookCreateBody({ event: 'PreToolUse', matcher: ' Bash ', command: ' node ', timeout: 10, enabled: true, args: ['check.js', 'two words'], async: true, if: ' Bash(git *) ', statusMessage: ' Checking ' })
    expect(command).toEqual({ event: 'PreToolUse', matcher: 'Bash', command: 'node', timeout: 10, enabled: true, args: ['check.js', 'two words'], async: true, if: 'Bash(git *)', statusMessage: 'Checking' })
    expect(hookCreateSchema.safeParse(command).success).toBe(true)
    const prompt = hookCreateBody({ event: 'PreToolUse', matcher: '', command: 'ignored', timeout: null, enabled: false, type: 'prompt', prompt: ' Is it safe? ', model: 'haiku', continueOnBlock: true, args: ['x'], async: true })
    expect(prompt).toEqual({ type: 'prompt', event: 'PreToolUse', matcher: null, prompt: 'Is it safe?', model: 'haiku', timeout: null, continueOnBlock: true, enabled: false })
    expect(hookCreateSchema.safeParse(prompt).success).toBe(true)
    // `if` only on tool events, continueOnBlock only on PreToolUse / PostToolUse.
    const stop = hookCreateBody({ event: 'Stop', matcher: '', command: '', timeout: null, enabled: true, type: 'prompt', prompt: 'Done?', model: null, continueOnBlock: true, if: 'Write' })
    expect(stop).toEqual({ type: 'prompt', event: 'Stop', matcher: null, prompt: 'Done?', timeout: null, enabled: true })
    expect(hookCreateSchema.safeParse(stop).success).toBe(true)
  })

  it('builds the smallest patch, switching types without mixing their fields', () => {
    const hook = personalHook({ event: 'PreToolUse', matcher: 'Bash', command: 'sh guard.sh', args: ['--strict'], if: 'Bash(git *)' })
    expect(hookPatch(hook, draftFromPersonal(hook))).toEqual({})
    expect(hookPatch(hook, { ...draftFromPersonal(hook), enabled: false })).toEqual({ enabled: false })
    expect(hookPatch(hook, { ...draftFromPersonal(hook), args: [], if: '', statusMessage: 'Guarding' })).toEqual({ args: null, if: null, statusMessage: 'Guarding' })
    const toPrompt = hookPatch(hook, { ...draftFromPersonal(hook), type: 'prompt', prompt: 'Is this safe?', model: null, continueOnBlock: true })
    expect(toPrompt).toEqual({ type: 'prompt', prompt: 'Is this safe?', model: null, continueOnBlock: true })
    expect(hookUpdateSchema.safeParse(toPrompt).success).toBe(true)
    const prompt = { ...personalHook({ event: 'Stop', matcher: null }), type: 'prompt', prompt: 'Done?', model: 'haiku' } as never
    const toCommand = hookPatch(prompt, { ...draftFromPersonal(prompt), type: 'command', command: 'pnpm test', async: true })
    expect(toCommand).toEqual({ type: 'command', command: 'pnpm test', async: true })
    expect(hookUpdateSchema.safeParse(toCommand).success).toBe(true)
    // Moving a hook with an `if` to an event without tools clears it.
    expect(hookPatch(hook, { ...draftFromPersonal(hook), event: 'Stop' })).toEqual({ event: 'Stop', if: null })
  })

  it('writes Claude Code handlers and the JSON of prompt and exec-form rows', () => {
    expect(hookHandlerJson({ event: 'PreToolUse', matcher: '', command: 'node', timeout: 5, enabled: true, args: ['a.js'], async: true, if: 'Write', statusMessage: 'Checking' }))
      .toEqual({ type: 'command', command: 'node', args: ['a.js'], timeout: 5, async: true, if: 'Write', statusMessage: 'Checking' })
    const json = JSON.parse(hookJson([promptRow, hookEntry({ event: 'Stop', matcher: null, command: 'node', args: ['done.js'] })]))
    expect(json).toEqual({ hooks: { Stop: [{ hooks: [{ type: 'prompt', prompt: 'Did the tests pass?\nAnswer ok or not.', model: 'haiku', timeout: 20 }, { type: 'command', command: 'node', args: ['done.js'] }] }] } })
  })

  it('imports the new events, the handler fields and notes the handler types it can\'t run', () => {
    const result = importHooks(JSON.stringify({
      hooks: {
        PermissionRequest: [{ matcher: 'Bash', hooks: [{ type: 'prompt', prompt: 'Allow?', model: 'haiku', continueOnBlock: true, statusMessage: 'Asking' }] }],
        PostToolUseFailure: [{ hooks: [{ type: 'command', command: 'node', args: ['report.js'], async: true, if: 'Write' }] }],
        SessionEnd: [{ hooks: [{ type: 'command', command: 'sh bye.sh' }, { type: 'mcp_tool', server: 'x', tool: 'y' }, { type: 'agent', prompt: 'x' }] }],
      },
    }))
    expect(result.error).toBeNull()
    expect(result.items.map(item => item.draft)).toEqual([
      { event: 'PermissionRequest', matcher: 'Bash', command: '', timeout: null, enabled: true, type: 'prompt', prompt: 'Allow?', model: 'haiku', continueOnBlock: true, statusMessage: 'Asking' },
      { event: 'PostToolUseFailure', matcher: '', command: 'node', timeout: null, enabled: true, args: ['report.js'], async: true, if: 'Write' },
      { event: 'SessionEnd', matcher: '', command: 'sh bye.sh', timeout: null, enabled: true },
    ])
    expect(result.notes).toEqual(['Ignored: mcp_tool hooks aren\'t supported.', 'Ignored: agent hooks aren\'t supported.'])
    expect(result.notes.join(' ')).not.toContain('prompt')
    // A prompt hook on an event that takes none is noted.
    const notification = importHooks(JSON.stringify({ Notification: [{ hooks: [{ type: 'prompt', prompt: 'x' }] }] }))
    expect(notification.items).toEqual([])
    expect(notification.notes).toEqual(['Ignored: Prompt hooks do not run for Notification hooks; use a command hook.'])
  })

  it('reads the project section\'s file problems, unknown events and unsupported types included', () => {
    expect(hookFileNotice({ level: 'info', code: 'unknown-event', message: 'The event "PreModelSwitch" is not supported; its hooks are ignored.', file: '.claude/settings.json' }))
      .toBe('.claude/settings.json: The hook event PreModelSwitch isn\'t supported.')
    expect(hookFileNotice({ level: 'warning', code: 'unsupported-type', message: 'HTTP hooks are not supported; this hook never runs.', file: '.claude/settings.json' }))
      .toBe('.claude/settings.json: http hooks aren\'t supported.')
    expect(hookFileNotice({ level: 'warning', code: 'unsupported-type', message: 'The hook type is not supported; use "command".' })).toBe('The hook type is not supported; use "command".')
    expect(hookFileNotice({ level: 'error', code: 'invalid-json', message: 'The settings file is not valid JSON.', file: '.harness/settings.json' })).toBe('.harness/settings.json: The settings file is not valid JSON.')
    expect(hookFileNotice({ level: 'info', code: 'ignored-field', message: 'The field "x" is ignored.' })).toBeNull()
  })

  it('checks the handler fields like the server', () => {
    expect(parseHookArgs('a\n\n b \r\nc\n')).toEqual(['a', ' b ', 'c'])
    expect(argsError(['a'], 'node')).toBeNull()
    expect(argsError(Array.from<string>({ length: 65 }).fill('x'), 'node')).toBe('Use at most 64 arguments.')
    expect(argsError(['a\0b'], 'node')).toBe('Arguments cannot contain NUL characters.')
    expect(argsError(['x'.repeat(4096)], 'node')).toBe('The command and its arguments are longer than 4,096 characters.')
    expect(ifError('')).toBeNull()
    expect(ifError('Bash(npm run *)')).toBeNull()
    expect(ifError('Write')).toBeNull()
    expect(ifError('Read(./x)')).toBe('Only Bash rules may have a pattern in parentheses.')
    expect(ifError('x'.repeat(513))).toBe('Use at most 512 characters.')
    expect(statusMessageError('')).toBeNull()
    expect(statusMessageError('Checking the format')).toBeNull()
    expect(statusMessageError('x'.repeat(201))).toBe('Use at most 200 characters.')
    expect(statusMessageError('a\u0007b')).toBe('Control characters are not allowed.')
  })

  it('knows the project settings files and finds a project row by its position', () => {
    expect(PROJECT_HOOK_FILES).toEqual(['.claude/settings.json', '.claude/settings.local.json', '.harness/settings.json', '.harness/settings.local.json'])
    expect(isProjectHookFile('.harness/settings.local.json')).toBe(true)
    expect(isProjectHookFile('.claude/agents/x.md')).toBe(false)
    const row = hookEntry({ source: 'project', id: undefined, event: 'PreToolUse', matcher: 'Bash', path: '.claude/settings.json', position: [1, 0] })
    const target = { path: '.claude/settings.json', event: 'PreToolUse' as const, groupIndex: 1, handlerIndex: 0 }
    expect(projectEntryAt([hookEntry(), row], target)).toBe(row)
    expect(projectEntryAt([row], { ...target, handlerIndex: 1 })).toBeNull()
    expect(projectEntryAt([row], { ...target, groupIndex: null, handlerIndex: null })).toBeNull()
    expect(sameHandler(draftFromHook(row), { ...draftFromHook(row), timeout: 5 })).toBe(true)
    expect(sameHandler(draftFromHook(row), { ...draftFromHook(row), command: 'other' })).toBe(false)
  })
})

/** The `hooks` value of a successful splice (fails the test otherwise). */
function splicedHooks(result: ReturnType<typeof spliceProjectHook>): Record<string, { matcher?: string, hooks: Record<string, unknown>[] }[]> {
  if (!result.ok || result.hooks === null)
    throw new Error('Expected a hooks value.')
  return result.hooks as Record<string, { matcher?: string, hooks: Record<string, unknown>[] }[]>
}

describe('spliceProjectHook (W12.12-T5)', () => {
  const FILE_HOOKS = {
    PreToolUse: [
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'sh guard.sh', timeout: 30, once: true }, { type: 'command', command: 'sh log.sh' }] },
      { matcher: 'Write', hooks: [{ type: 'command', command: 'sh write.sh' }] },
    ],
    Stop: [{ hooks: [{ type: 'command', command: 'pnpm lint' }] }],
  }
  const draft = (overrides: Partial<Parameters<typeof hookCreateBody>[0]> = {}) => ({ event: 'PreToolUse' as const, matcher: 'Bash', command: 'sh guard.sh', timeout: 30, enabled: true, ...overrides })
  const at = (groupIndex: number | null, handlerIndex: number | null, event: 'PreToolUse' | 'Stop' = 'PreToolUse') => ({ event, groupIndex, handlerIndex })

  it('adds a new handler to a group of its matcher, a new group or a new event', () => {
    const joined = spliceProjectHook(FILE_HOOKS, at(null, null), draft({ command: 'sh third.sh', timeout: null }))
    expect(joined).toMatchObject({ ok: true })
    expect(splicedHooks(joined).PreToolUse![0]!.hooks).toHaveLength(3)
    const grouped = spliceProjectHook(FILE_HOOKS, at(null, null), draft({ matcher: 'Edit', command: 'sh edit.sh', timeout: null }))
    expect(splicedHooks(grouped).PreToolUse![2]).toEqual({ matcher: 'Edit', hooks: [{ type: 'command', command: 'sh edit.sh' }] })
    const fresh = spliceProjectHook(undefined, at(null, null), { event: 'Stop', matcher: '', command: '', timeout: null, enabled: true, type: 'prompt', prompt: 'Done?' })
    expect(fresh).toEqual({ ok: true, hooks: { Stop: [{ hooks: [{ type: 'prompt', prompt: 'Done?' }] }] } })
    // The input is never changed.
    expect(FILE_HOOKS.PreToolUse[0]!.hooks).toHaveLength(2)
  })

  it('replaces a handler in place and keeps the keys the editor does not write', () => {
    const result = spliceProjectHook(FILE_HOOKS, at(0, 0), draft({ command: 'sh guard.sh --strict', timeout: null, statusMessage: 'Guarding' }))
    expect(result).toEqual({
      ok: true,
      hooks: {
        ...FILE_HOOKS,
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'sh guard.sh --strict', statusMessage: 'Guarding', once: true }, { type: 'command', command: 'sh log.sh' }] },
          FILE_HOOKS.PreToolUse[1],
        ],
      },
    })
  })

  it('changes the matcher of a group it is alone in, and moves a handler out of a shared group', () => {
    const alone = spliceProjectHook(FILE_HOOKS, at(1, 0), draft({ matcher: 'Write|Edit', command: 'sh write.sh', timeout: null }))
    expect(splicedHooks(alone).PreToolUse![1]).toEqual({ matcher: 'Write|Edit', hooks: [{ type: 'command', command: 'sh write.sh' }] })
    const moved = spliceProjectHook(FILE_HOOKS, at(0, 1), draft({ matcher: 'Write', command: 'sh log.sh', timeout: null }))
    const hooks = splicedHooks(moved)
    expect(hooks.PreToolUse![0]!.hooks).toHaveLength(1)
    expect(hooks.PreToolUse![1]!.hooks.map(handler => handler.command)).toEqual(['sh write.sh', 'sh log.sh'])
    const toStop = spliceProjectHook(FILE_HOOKS, at(1, 0), draft({ event: 'Stop', matcher: '', command: 'sh write.sh', timeout: null }))
    const stopHooks = splicedHooks(toStop)
    expect(stopHooks.PreToolUse).toHaveLength(1)
    expect(stopHooks.Stop![0]!.hooks).toHaveLength(2)
  })

  it('removes a handler, then its empty group and event, and the key when nothing is left', () => {
    const removed = spliceProjectHook(FILE_HOOKS, at(0, 0, 'Stop'), null)
    expect(removed).toEqual({ ok: true, hooks: { PreToolUse: FILE_HOOKS.PreToolUse } })
    expect(spliceProjectHook({ Stop: [{ hooks: [{ type: 'command', command: 'x' }] }] }, at(0, 0, 'Stop'), null)).toEqual({ ok: true, hooks: null })
  })

  it('refuses a handler that is gone and a hooks value it can\'t edit', () => {
    expect(spliceProjectHook(FILE_HOOKS, at(5, 0), draft())).toMatchObject({ ok: false, reason: 'missing' })
    expect(spliceProjectHook(undefined, at(0, 0), null)).toMatchObject({ ok: false, reason: 'missing' })
    expect(spliceProjectHook([1, 2], at(null, null), draft())).toMatchObject({ ok: false, reason: 'invalid' })
    expect(spliceProjectHook({ PreToolUse: 'x' }, at(null, null), draft())).toMatchObject({ ok: false, reason: 'invalid' })
  })

  it('tells whether a file still holds the listed handler', () => {
    const listed = draft({ timeout: null })
    expect(rawHandlerMatches(FILE_HOOKS, at(0, 0), listed)).toBe(true)
    expect(rawHandlerMatches(FILE_HOOKS, at(0, 1), listed)).toBe(false)
    expect(rawHandlerMatches(FILE_HOOKS, at(3, 0), listed)).toBe(false)
    expect(rawHandlerMatches(undefined, at(0, 0), listed)).toBe(false)
  })
})
