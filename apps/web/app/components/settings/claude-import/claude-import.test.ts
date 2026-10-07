// Pure helpers of the Import from Claude Code dialog (Phase 12, ADR-055; docs/UI.md 9.14, 11.9): `pickClaudeFiles` guards
// the upload (complete from P12-0b, C46); the preview, selection, result and error helpers (W12.10).
import { CLAUDE_HOME_LIMITS, HarnessError } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { claudeImportApplyResult, claudeImportItem, claudeImportPlan, importPlanId } from '~/utils/testing/fixtures'
import {
  applyBody,
  canEnable,
  claudeRelativePath,
  defaultSelection,
  executableCount,
  executablesText,
  groupsOf,
  groupState,
  importedServers,
  importErrorText,
  isPromptHook,
  needsFreshAuth,
  pickClaudeFiles,
  resultLines,
  resultTab,
  STATUS_TEXT,
  submitText,
  syncInstructions,
  turnedOffLines,
  turnedOffNote,
} from './claude-import'

/** A picked file of the folder `.claude` (`webkitRelativePath` starts with the picked folder's name). */
function picked(path: string, size = 10): File {
  const file = new File([new Uint8Array(size)], path.split('/').at(-1)!, { type: 'text/markdown' })
  Object.defineProperty(file, 'webkitRelativePath', { value: `.claude/${path}` })
  return file
}

describe('pickClaudeFiles', () => {
  it.each([
    ['agents/reviewer.md', true],
    ['commands/deploy.md', true],
    ['commands/db/migrate.md', true],
    ['commands/a/b/c/deep.md', true],
    ['commands/a/b/c/d/too-deep.md', false],
    ['skills/pdf/SKILL.md', true],
    ['skills/pdf/helper.py', false],
    ['output-styles/terse.md', true],
    ['settings.json', true],
    ['CLAUDE.md', true],
    ['settings.local.json', false],
    ['.credentials.json', false],
    ['projects/abc/session.jsonl', false],
    ['history.jsonl', false],
    ['todos/x.json', false],
    ['shell-snapshots/s.sh', false],
    ['statsig/x', false],
    ['plugins/installed_plugins.json', false],
    ['.claude.json', false],
    ['agents/.hidden.md', false],
    ['agents/notes.txt', false],
  ])('keeps %s: %s', (path, kept) => {
    const result = pickClaudeFiles([picked(path)])
    expect(result.files.map(file => file.name)).toEqual(kept ? [path] : [])
    expect(result.skipped).toBe(kept ? 0 : 1)
    expect(result.tooLarge).toEqual([])
  })

  it('renames kept files to their relative path, sorts them and never keeps a file twice', () => {
    const result = pickClaudeFiles([picked('settings.json'), picked('agents/b.md'), picked('agents/a.md'), picked('agents/a.md')])
    expect(result.files.map(file => file.name)).toEqual(['agents/a.md', 'agents/b.md', 'settings.json'])
    expect(result.skipped).toBe(1)
  })

  it('lists files over their byte cap as too large', () => {
    const result = pickClaudeFiles([
      picked('agents/huge.md', CLAUDE_HOME_LIMITS.definitionBytes + 1),
      picked('settings.json', CLAUDE_HOME_LIMITS.settingsBytes + 1),
      picked('CLAUDE.md', CLAUDE_HOME_LIMITS.definitionBytes + 1),
    ])
    expect(result.files.map(file => file.name)).toEqual(['CLAUDE.md'])
    expect(result.tooLarge).toEqual(['agents/huge.md', 'settings.json'])
  })

  it('keeps at most the per-kind count of definitions', () => {
    const files = Array.from({ length: CLAUDE_HOME_LIMITS.definitionsPerKindMax + 3 }, (_, index) => picked(`agents/a${String(index).padStart(4, '0')}.md`))
    const result = pickClaudeFiles(files)
    expect(result.files).toHaveLength(CLAUDE_HOME_LIMITS.definitionsPerKindMax)
    expect(result.skipped).toBe(3)
  })

  it('uses the file name without a relative path', () => {
    expect(claudeRelativePath(new File(['x'], 'CLAUDE.md'))).toBe('CLAUDE.md')
    expect(claudeRelativePath(picked('agents/x.md'))).toBe('agents/x.md')
  })
})

describe('the preview helpers', () => {
  const plan = claudeImportPlan({
    items: [
      claudeImportItem(),
      claudeImportItem({ key: 'hook:1', kind: 'hook', name: 'PostToolUse', executable: true }),
      claudeImportItem({ key: 'agent:2', name: 'planner', status: 'update', actions: ['skip', 'overwrite', 'rename'], defaultAction: 'skip', renameTo: 'planner-2' }),
      claudeImportItem({ key: 'agent:3', name: 'same', status: 'unchanged', actions: [], defaultAction: 'skip' }),
      claudeImportItem({ key: 'permission:1', kind: 'permission', name: 'Read(./secrets/**)', status: 'unsupported', actions: [], defaultAction: 'skip' }),
      claudeImportItem({ key: 'instructions:1', kind: 'instructions', name: 'CLAUDE.md', actions: ['append', 'replace', 'skip'], defaultAction: 'append' }),
    ],
  })

  it('groups the plan in the preview order, unsupported last', () => {
    expect(groupsOf(plan).map(group => [group.kind, group.title, group.items.length, group.executable])).toEqual([
      ['agent', 'Agents', 3, false],
      ['hook', 'Hooks', 1, true],
      ['instructions', 'Instructions', 1, false],
      ['unsupported', 'Unsupported', 1, false],
    ])
  })

  it('picks new items by default and tells the group state', () => {
    const selection = defaultSelection(plan)
    expect(Object.keys(selection.items)).toEqual(['agent:reviewer:agents/reviewer.md', 'hook:1', 'instructions:1'])
    expect(selection.instructions).toBe('append')
    const [agents, hooks] = groupsOf(plan)
    expect(groupState(agents!, selection)).toBe('indeterminate')
    expect(groupState(hooks!, selection)).toBe(true)
    expect(groupState(hooks!, { ...selection, items: {} })).toBe(false)
  })

  it('knows which password prompt the apply needs', () => {
    const selection = defaultSelection(plan)
    expect(needsFreshAuth(plan, selection)).toBe('executables')
    expect(needsFreshAuth(plan, { ...selection, items: { 'agent:reviewer:agents/reviewer.md': { action: 'import' } } })).toBe('import')
    expect(needsFreshAuth(plan, { ...selection, items: {} })).toBeNull()
  })

  it('builds the apply body with the instructions mode, enable flags, renames and variables', () => {
    const body = applyBody(importPlanId(1), {
      items: {
        'agent:2': { action: 'rename', renameTo: 'planner-2' },
        'hook:1': { action: 'import', enable: true },
        'instructions:1': { action: 'append' },
        'mcp:1': { action: 'import', variables: { TOKEN: 'abc', EMPTY: '' } },
      },
      instructions: 'replace',
    })
    expect(body).toEqual({
      planId: importPlanId(1),
      items: [
        { key: 'agent:2', action: 'rename', renameTo: 'planner-2' },
        { key: 'hook:1', action: 'import', enable: true },
        { key: 'instructions:1', action: 'replace' },
        { key: 'mcp:1', action: 'import' },
      ],
      instructions: 'replace',
      variables: { 'mcp:1': { TOKEN: 'abc' } },
    })
    expect(applyBody(importPlanId(1), { items: { 'instructions:1': { action: 'append' } }, instructions: 'skip' }).items).toEqual([])
  })

  it('writes the result lines and the status words', () => {
    expect(resultLines(claudeImportApplyResult())).toEqual(['Imported 2 items'])
    expect(resultLines(claudeImportApplyResult({
      results: [{ key: 'agent:x', outcome: 'failed', message: 'The name is taken.' }],
      counts: { created: 1, updated: 0, unchanged: 0, skipped: 2, failed: 1 },
      warnings: ['1 command turned off (it runs shell lines)'],
    }))).toEqual(['Imported 1 item · 2 skipped · 1 failed', 'agent:x: The name is taken.', '1 command turned off (it runs shell lines)'])
    expect(STATUS_TEXT).toEqual({ new: 'New', update: 'Replaces yours', unchanged: 'Unchanged', conflict: 'Conflict', unsupported: 'Unsupported', invalid: 'Invalid' })
  })
})

describe('the instructions mode', () => {
  const md = claudeImportItem({ key: 'instructions:1', kind: 'instructions', name: 'CLAUDE.md', status: 'update', actions: ['append', 'replace', 'skip'], defaultAction: 'append' })

  it('follows the instructions item', () => {
    const plan = claudeImportPlan({ items: [md] })
    expect(defaultSelection(plan).instructions).toBe('append')
    expect(syncInstructions(plan, { items: { 'instructions:1': { action: 'replace' } }, instructions: 'append' }).instructions).toBe('replace')
    expect(syncInstructions(plan, { items: {}, instructions: 'append' }).instructions).toBe('skip')
    const tooLong = claudeImportPlan({ items: [{ ...md, actions: ['replace', 'skip'], defaultAction: 'skip' }] })
    expect(defaultSelection(tooLong)).toEqual({ items: {}, instructions: 'skip' })
  })

  it('leaves the mode alone without a selectable instructions item', () => {
    const plan = claudeImportPlan({ items: [{ ...md, status: 'unchanged', actions: [] }] })
    const selection = { items: {}, instructions: 'replace' as const }
    expect(syncInstructions(plan, selection)).toBe(selection)
    expect(defaultSelection(claudeImportPlan()).instructions).toBe('append')
  })
})

describe('the executable items', () => {
  const command = claudeImportItem({ key: 'command:1', kind: 'command', name: 'deploy', warnings: ['runs-commands'], executable: true })
  const stdio = claudeImportItem({ key: 'mcp:1', kind: 'mcp-server', name: 'github', warnings: ['runs-commands'], executable: true })
  const project = claudeImportItem({ key: 'mcp:2', kind: 'mcp-server', name: 'docs', source: { file: '.claude.json', project: '/work/app' }, warnings: ['project-server'] })
  const prompt = claudeImportItem({ key: 'hook:1', kind: 'hook', name: 'Stop' })

  it('says why an item arrives turned off and whether it can be turned on', () => {
    expect(turnedOffNote(command)).toBe('Imported turned off: it runs shell lines.')
    expect(turnedOffNote(stdio)).toBe('Imported turned off: it starts a program.')
    expect(turnedOffNote(project)).toBe('From the project /work/app: imported turned off.')
    expect(turnedOffNote(prompt)).toBeNull()
    expect([command, stdio, project, prompt].map(canEnable)).toEqual([true, true, false, false])
    expect(isPromptHook(prompt)).toBe(true)
    expect(isPromptHook({ ...prompt, executable: true })).toBe(false)
  })

  it('counts the picked items that run commands', () => {
    const plan = claudeImportPlan({ items: [command, stdio, project, prompt] })
    expect(executableCount(plan, { items: { 'command:1': { action: 'import' }, 'mcp:2': { action: 'import' } }, instructions: 'skip' })).toBe(1)
    expect(executablesText(1)).toBe('Includes 1 item that runs commands on this server.')
    expect(executablesText(3)).toBe('Includes 3 items that run commands on this server.')
    expect(submitText(1)).toBe('Import 1 item')
    expect(submitText(19)).toBe('Import 19 items')
  })

  it('writes the turned-off lines of the imported items left off', () => {
    const hook = claudeImportItem({ key: 'hook:2', kind: 'hook', name: 'PreToolUse', warnings: ['runs-commands'], executable: true })
    const plan = claudeImportPlan({ items: [command, hook, stdio, project, prompt] })
    const created = (keys: string[]) => claudeImportApplyResult({
      results: keys.map(key => ({ key, outcome: 'created' as const })),
      counts: { created: keys.length, updated: 0, unchanged: 0, skipped: 0, failed: 0 },
      warnings: [],
    })
    const all = { items: { 'command:1': { action: 'import' as const }, 'hook:2': { action: 'import' as const }, 'mcp:1': { action: 'import' as const }, 'mcp:2': { action: 'import' as const }, 'hook:1': { action: 'import' as const } }, instructions: 'skip' as const }
    expect(turnedOffLines(plan, all, created(['command:1', 'hook:2', 'mcp:1', 'mcp:2', 'hook:1']))).toEqual(['2 commands turned off (they run shell lines)', '2 MCP servers turned off'])
    const enabled = { ...all, items: { ...all.items, 'command:1': { action: 'import' as const, enable: true }, 'mcp:1': { action: 'import' as const, enable: true } } }
    expect(turnedOffLines(plan, enabled, created(['command:1', 'hook:2', 'mcp:1', 'mcp:2']))).toEqual(['1 command turned off (it runs shell lines)', '1 MCP server turned off'])
    expect(turnedOffLines(plan, all, created(['hook:1']))).toEqual([])
  })
})

describe('the result actions', () => {
  const plan = claudeImportPlan({
    items: [
      claudeImportItem({ key: 'mcp:1', kind: 'mcp-server', name: 'github' }),
      claudeImportItem({ key: 'hook:1', kind: 'hook', name: 'Stop' }),
      claudeImportItem({ key: 'command:1', kind: 'command', name: 'deploy' }),
    ],
  })
  const result = (outcomes: Record<string, 'created' | 'updated' | 'skipped' | 'failed'>) => claudeImportApplyResult({
    results: Object.entries(outcomes).map(([key, outcome]) => ({ key, outcome })),
  })

  it('opens the tab of the first imported kind and the MCP servers when any were imported', () => {
    expect(resultTab(plan, result({ 'hook:1': 'created', 'command:1': 'updated' }))).toBe('commands')
    expect(resultTab(plan, result({ 'hook:1': 'created', 'command:1': 'failed' }))).toBe('hooks')
    expect(resultTab(plan, result({ 'mcp:1': 'created' }))).toBeNull()
    expect(importedServers(plan, result({ 'mcp:1': 'created' }))).toBe(true)
    expect(importedServers(plan, result({ 'mcp:1': 'skipped' }))).toBe(false)
  })
})

describe('importErrorText', () => {
  it('uses the fixed copy for 413, a turned-off scan and an expired preview', () => {
    expect(importErrorText(new HarnessError({ code: 'payload_too_large', message: 'Too large.' }), 'source')).toBe('The upload is larger than 32 MiB.')
    expect(importErrorText(new HarnessError({ code: 'conflict', message: 'Off.', details: { reason: 'disabled' } }), 'source')).toBe('Scanning is turned off on this server (HF_CLAUDE_HOME=0).')
    expect(importErrorText(new HarnessError({ code: 'not_found', message: 'The import plan expired. Read the folder again.' }), 'preview')).toBe('This preview expired. Start again.')
    expect(importErrorText(new HarnessError({ code: 'not_found', message: 'There is no .claude folder.' }), 'source')).toBe('There is no .claude folder.')
    expect(importErrorText(new HarnessError({ code: 'validation_error', message: 'The zip could not be read.' }), 'source')).toBe('The zip could not be read.')
  })
})
