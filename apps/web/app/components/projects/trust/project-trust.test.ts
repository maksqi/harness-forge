import { describe, expect, it } from 'vitest'
import { projectMcpServer, projectTrustList, trustCommandItem, trustHookItem, trustMcpItem } from '~/utils/testing/fixtures'
import {
  approveLabel,
  mcpStatusText,
  orphanedText,
  staleText,
  trustGroups,
  trustItemState,
  trustItemTitle,
  trustStateText,
  trustWarningText,
  variableStateText,
} from './project-trust'

describe('project trust helpers (P11-0b first versions)', () => {
  it('groups the items in order and filters the pending ones', () => {
    const list = projectTrustList()
    expect(trustGroups(list, 'all').map(group => [group.kind, group.items.length])).toEqual([['hook', 1], ['mcp', 1], ['command', 1]])
    expect(trustGroups(list, 'pending').map(group => group.kind)).toEqual(['hook', 'mcp'])
    expect(trustGroups({ ...list, items: [] }, 'all')).toEqual([])
  })

  it('reads the title and the state of an item', () => {
    expect(trustItemTitle(trustHookItem())).toBe('PreToolUse · Bash')
    expect(trustItemTitle(trustMcpItem())).toBe('memory')
    expect(trustItemTitle(trustCommandItem())).toBe('/status')
    expect(trustItemState(trustHookItem())).toBe('new')
    expect(trustItemState(trustHookItem({ changed: true }))).toBe('changed')
    expect(trustItemState(trustCommandItem())).toBe('approved')
    expect(trustStateText(trustHookItem({ changed: true }))).toBe('Changed')
    expect(trustWarningText('private-network')).toBe('Connects to a private network address.')
  })

  it('words the counts, the variables and the server states', () => {
    expect(approveLabel(1)).toBe('Approve 1 item')
    expect(approveLabel(3)).toBe('Approve 3 items')
    expect(staleText(2)).toBe('2 items changed while you were reviewing. Check them again.')
    expect(orphanedText(2)).toContain('2 earlier approvals')
    expect(variableStateText({ name: 'TOKEN', set: true, hint: null, usedBy: [] })).toBe('Stored')
    expect(variableStateText({ name: 'HOST', set: false, hint: 'localhost', usedBy: [] })).toBe('Default: localhost')
    expect(mcpStatusText(projectMcpServer())).toBe('Set 1 variable')
    expect(mcpStatusText(projectMcpServer({ state: 'connected', tools: ['mcp__memory__get', 'mcp__memory__set'], missingVariables: [] }))).toBe('Connected · 2 tools')
  })
})
