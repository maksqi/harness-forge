// Pure helpers of the project trust and project MCP dialogs (docs/UI.md 7.33, 15; W11.9-T2): groups, titles, states,
// the exact command text, details, warnings, the counts and notes, the selection rules, the variables and the server
// statuses.
import { describe, expect, it } from 'vitest'
import { projectMcpServer, projectTrustList, trustCommandItem, trustHookItem, trustMcpItem, trustSha } from '~/utils/testing/fixtures'
import {
  approvalBatches,
  approvalsOf,
  approvedText,
  approveLabel,
  canReconnect,
  changedCount,
  isPromptHookItem,
  keepSelection,
  mcpServerCommand,
  mcpStatusDot,
  mcpStatusText,
  orphanedText,
  pendingItems,
  revokedText,
  selectAllState,
  selectedText,
  shellQuote,
  showOrphaned,
  staleText,
  TRUST_GROUP_LABELS,
  trustCommandText,
  trustGroups,
  trustItemDetails,
  trustItemName,
  trustItemState,
  trustItemTitle,
  trustStateText,
  trustTextLabel,
  trustWarningText,
  variablePlaceholder,
  variableState,
  variableStateText,
} from './project-trust'

/** `${TOKEN}` and `${DOCS_HOST}` as `.mcp.json` writes them (kept unexpanded). */
const TOKEN_REF = ['$', '{TOKEN}'].join('')
const DOCS_URL = ['https://$', '{DOCS_HOST}/mcp'].join('')

describe('project trust helpers', () => {
  it('groups the items in order and filters the pending ones', () => {
    const list = projectTrustList()
    expect(trustGroups(list, 'all').map(group => [group.kind, group.items.length])).toEqual([['hook', 1], ['mcp', 1], ['command', 1]])
    expect(trustGroups(list, 'pending').map(group => group.kind)).toEqual(['hook', 'mcp'])
    expect(trustGroups({ ...list, items: [] }, 'all')).toEqual([])
    expect(pendingItems(list).map(item => item.sha256)).toEqual([trustSha(1), trustSha(3)])
    expect(pendingItems(null)).toEqual([])
    expect(TRUST_GROUP_LABELS).toEqual({ hook: 'Hooks', mcp: 'MCP servers', command: 'Commands with shell lines' })
  })

  it('reads the title, the state and the name of an item', () => {
    expect(trustItemTitle(trustHookItem())).toBe('PreToolUse · Bash')
    expect(trustItemTitle(trustHookItem({ detail: { event: 'SessionStart', matcher: null, command: 'cat x', timeout: null } }))).toBe('SessionStart')
    expect(trustItemTitle(trustMcpItem())).toBe('memory')
    expect(trustItemTitle(trustCommandItem())).toBe('/status')
    expect(trustItemState(trustHookItem())).toBe('new')
    expect(trustItemState(trustHookItem({ changed: true }))).toBe('changed')
    expect(trustItemState(trustCommandItem())).toBe('approved')
    expect(trustItemState(trustCommandItem({ changed: true }))).toBe('approved')
    expect(trustStateText(trustHookItem())).toBe('New')
    expect(trustStateText(trustHookItem({ changed: true }))).toBe('Changed')
    expect(trustStateText(trustCommandItem())).toBe('Approved')
    expect(trustItemName(trustHookItem({ changed: true }))).toBe('Hook sh .claude/hooks/guard.sh, Changed')
    expect(trustItemName(trustMcpItem())).toBe('MCP server memory, New')
    expect(trustItemName(trustCommandItem())).toBe('Command /status, Approved')
  })

  it('words the warnings', () => {
    expect(trustWarningText('private-network')).toBe('Connects to a private network address.')
    expect(trustWarningText('referenced-file-missing')).toBe('A file this command runs is missing.')
    expect(trustWarningText('runs-repository-code')).toBe('Runs code from this repository that isn\'t pinned (like npm test): later changes to that code run without a new approval.')
  })

  it('shows the exact command text of every kind', () => {
    expect(trustCommandText(trustHookItem())).toBe('sh .claude/hooks/guard.sh')
    expect(trustCommandText(trustMcpItem())).toBe('node tools/mcp-memory.mjs')
    expect(trustCommandText(trustMcpItem({
      detail: { name: 'x', id: 'x', transport: 'stdio', command: 'npx', args: ['-y', '@scope/server', 'two words', 'it\'s', TOKEN_REF, ''], envNames: [], headerNames: [], variables: [] },
    }))).toBe(`npx -y @scope/server 'two words' 'it'\\''s' '${TOKEN_REF}' ''`)
    expect(trustCommandText(trustMcpItem({
      detail: { name: 'docs', id: 'docs', transport: 'http', url: DOCS_URL, envNames: [], headerNames: ['Authorization'], variables: ['DOCS_HOST'] },
    }))).toBe(DOCS_URL)
    expect(trustCommandText(trustCommandItem({ detail: { name: 'status', spans: ['git status --short', 'git log -1'] } }))).toBe('git status --short\ngit log -1')
    expect(shellQuote('plain-arg_1.txt')).toBe('plain-arg_1.txt')
    expect(shellQuote('a b')).toBe('\'a b\'')
  })

  it('lists the details: timeout, referenced files, names and variables with their state', () => {
    expect(trustItemDetails(trustHookItem())).toEqual(['Runs .claude/hooks/guard.sh'])
    expect(trustItemDetails(trustHookItem({
      detail: { event: 'PreToolUse', matcher: '*', command: 'node a.js', timeout: 30 },
      refs: [{ path: 'a.js', sha256: null }],
    }))).toEqual(['timeout 30s', 'Runs a.js (not found)'])
    const mcp = trustMcpItem({
      detail: { name: 'gh', id: 'gh', transport: 'stdio', command: 'gh-mcp', args: [], envNames: ['GITHUB_TOKEN', 'LOG'], headerNames: [], variables: ['GITHUB_TOKEN', 'LOG'] },
    })
    expect(trustItemDetails(mcp)).toEqual(['Environment: GITHUB_TOKEN, LOG', 'Variables: GITHUB_TOKEN, LOG'])
    expect(trustItemDetails(mcp, [
      { name: 'GITHUB_TOKEN', set: false, hint: null, usedBy: ['gh'] },
      { name: 'LOG', set: true, hint: null, usedBy: ['gh'] },
    ])).toEqual(['Environment: GITHUB_TOKEN, LOG', 'Variables: GITHUB_TOKEN (not set), LOG (set)'])
    expect(trustItemDetails(trustMcpItem({
      detail: { name: 'docs', id: 'docs', transport: 'sse', url: 'http://127.0.0.1:9000/sse', envNames: [], headerNames: ['Authorization'], variables: [] },
    }))).toEqual(['Headers: Authorization'])
  })

  it('words the counts, the toasts and the notes', () => {
    expect(approveLabel(1)).toBe('Approve 1 item')
    expect(approveLabel(3)).toBe('Approve 3 items')
    expect(selectedText(2)).toBe('2 selected')
    expect(approvedText(1, 'Website')).toBe('Approved 1 item in Website')
    expect(approvedText(4, 'Website')).toBe('Approved 4 items in Website')
    expect(revokedText('/status')).toBe('Revoked /status. It won\'t run until you approve it again.')
    expect(staleText(2)).toBe('2 items changed while you were reviewing. Check them again.')
    expect(staleText(1)).toBe('1 item changed while you were reviewing. Check it again.')
    expect(orphanedText(2)).toBe('2 earlier approvals no longer match: an approved item was removed or renamed.')
    expect(orphanedText(1)).toBe('1 earlier approval no longer matches: an approved item was removed or renamed.')
    expect(showOrphaned(projectTrustList({ orphaned: 1 }))).toBe(true)
    expect(showOrphaned(projectTrustList({ orphaned: 0 }))).toBe(false)
    expect(showOrphaned(projectTrustList({ orphaned: 1, items: [trustHookItem({ changed: true })] }))).toBe(false)
  })

  it('keeps the selection of pending items, counts the changed ones and builds the approvals', () => {
    const selected = new Set([trustSha(1), trustSha(3), trustSha(4)])
    const list = projectTrustList()
    expect([...keepSelection(selected, list)]).toEqual([trustSha(1), trustSha(3)])
    expect(changedCount(selected, list)).toBe(1)
    expect(keepSelection(selected, null).size).toBe(0)
    expect(approvalsOf(selected, list)).toEqual([{ kind: 'hook', sha256: trustSha(1) }, { kind: 'mcp', sha256: trustSha(3) }])
    const many = Array.from({ length: 5 }, (_, index) => ({ kind: 'hook' as const, sha256: trustSha(index + 1) }))
    expect(approvalBatches(many, 2).map(batch => batch.length)).toEqual([2, 2, 1])
    expect(approvalBatches([], 50)).toEqual([])
  })

  it('reads the variables', () => {
    const stored = { name: 'TOKEN', set: true, hint: null, usedBy: [] }
    const withDefault = { name: 'HOST', set: false, hint: 'localhost', usedBy: [] }
    const missing = { name: 'KEY', set: false, hint: null, usedBy: [] }
    expect(variableStateText(stored)).toBe('Stored')
    expect(variableStateText(withDefault)).toBe('Default: localhost')
    expect(variableStateText(missing)).toBe('Not set')
    expect([stored, withDefault, missing].map(variableState)).toEqual(['set', 'default', 'missing'])
    expect(variablePlaceholder(stored, false)).toBe('•••• · stored')
    expect(variablePlaceholder(stored, true)).toBe('')
    expect(variablePlaceholder({ ...stored, hint: 'x' }, true)).toBe('Default: x')
    expect(variablePlaceholder(withDefault, false)).toBe('Default: localhost')
    expect(variablePlaceholder(missing, false)).toBe('')
  })

  it('words the server states, their dots and when Reconnect shows', () => {
    expect(mcpStatusText(projectMcpServer())).toBe('Set 1 variable')
    expect(mcpStatusText(projectMcpServer({ missingVariables: ['A', 'B'] }))).toBe('Set 2 variables')
    expect(mcpStatusText(projectMcpServer({ state: 'connected', tools: ['mcp__memory__get', 'mcp__memory__set'], missingVariables: [] }))).toBe('Connected · 2 tools')
    expect(mcpStatusText(projectMcpServer({ state: 'connected', tools: ['mcp__memory__get'], missingVariables: [] }))).toBe('Connected · 1 tool')
    expect(mcpStatusText(projectMcpServer({ state: 'pending' }))).toBe('Needs approval')
    expect(mcpStatusText(projectMcpServer({ state: 'idle' }))).toBe('Starts with the first chat')
    expect(mcpStatusText(projectMcpServer({ state: 'connecting' }))).toBe('Connecting…')
    expect(mcpStatusText(projectMcpServer({ state: 'error', error: { code: 'internal_error', message: 'spawn ENOENT' } }))).toBe('Error: spawn ENOENT')
    expect(mcpStatusText(projectMcpServer({ state: 'disabled' }))).toBe('Off on this server (safe mode)')
    expect(mcpStatusText(projectMcpServer({ state: 'disabled', error: { code: 'not_found', message: 'The project folder is unavailable.' } }))).toBe('The project folder is unavailable.')
    expect(mcpStatusDot(projectMcpServer({ state: 'connected' }))).toEqual({ status: 'ok', label: 'Connected' })
    expect(mcpStatusDot(projectMcpServer({ state: 'pending' }))).toEqual({ status: 'approval', label: 'Needs approval' })
    expect(['pending', 'needs-variables', 'idle', 'connecting', 'connected', 'error', 'disabled'].filter(state => canReconnect(projectMcpServer({ state: state as 'idle' }))))
      .toEqual(['idle', 'connected', 'error'])
    expect(mcpServerCommand(trustMcpItem())).toBe('node tools/mcp-memory.mjs')
    expect(mcpServerCommand(trustHookItem())).toBeNull()
    expect(mcpServerCommand(null)).toBeNull()
  })
})

describe('selectAllState (Phase 12, C46)', () => {
  it('is false for none, true for every pending item and indeterminate for some', () => {
    const items = [trustHookItem({ sha256: trustSha(1) }), trustMcpItem({ sha256: trustSha(2) }), trustHookItem({ sha256: trustSha(3), state: 'approved' })]
    expect(selectAllState(items, new Set())).toBe(false)
    expect(selectAllState(items, new Set([trustSha(1)]))).toBe('indeterminate')
    expect(selectAllState(items, new Set([trustSha(1), trustSha(2)]))).toBe(true)
  })
})

describe('prompt hooks and handler fields in trust items (Phase 12, W12.13-T1)', () => {
  const prompt = trustHookItem({ refs: [], detail: { event: 'Stop', matcher: null, command: '', timeout: null, type: 'prompt', prompt: 'Check it.', model: 'mock:prompt-hook' } })

  it('reads a prompt hook: its prompt, "Prompt" and the model line', () => {
    expect(isPromptHookItem(prompt)).toBe(true)
    expect(isPromptHookItem(trustHookItem())).toBe(false)
    expect(isPromptHookItem(trustMcpItem())).toBe(false)
    expect(trustTextLabel(prompt)).toBe('Prompt')
    expect(trustTextLabel(trustHookItem())).toBe('Command')
    expect(trustTextLabel(trustCommandItem())).toBe('Command')
    expect(trustCommandText(prompt)).toBe('Check it.')
    expect(trustItemDetails(prompt)).toEqual(['Model: mock:prompt-hook'])
    expect(trustItemDetails(trustHookItem({ refs: [], detail: { event: 'Stop', matcher: null, command: '', timeout: 5, type: 'prompt', prompt: 'x', model: '  ' } }))).toEqual(['Model: Hook model', 'timeout 5s'])
  })

  it('quotes every word of an exec-form hook and lists if / async after the timeout', () => {
    const exec = trustHookItem({ refs: [], detail: { event: 'PostToolUse', matcher: null, command: 'sh', args: ['x.sh', 'it\'s'], timeout: 9, if: ' Write ', async: true } })
    expect(trustCommandText(exec)).toBe('\'sh\' \'x.sh\' \'it\'\\\'\'s\'')
    expect(trustItemDetails(exec)).toEqual(['timeout 9s', 'Only when Write', 'In the background'])
    // A v1.7 item keeps its text and details.
    expect(trustCommandText(trustHookItem())).toBe('sh .claude/hooks/guard.sh')
    expect(trustItemDetails(trustHookItem())).toEqual(['Runs .claude/hooks/guard.sh'])
  })
})
