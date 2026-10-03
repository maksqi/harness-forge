// Workspace tool registry skeleton (docs/UI.md 7.19, 11.4; C15, P7-0b): every function answers null for a tool that
// is not a workspace tool, so ToolPart keeps its generic blocks. W7.11 adds the views.
import { describe, expect, it } from 'vitest'
import {
  workspaceApprovalView,
  workspaceRowArgument,
  workspaceRowSummary,
  workspaceToolIcon,
  workspaceToolView,
} from './workspace-tools'

describe('workspace tool registry', () => {
  it('returns null for a tool outside WORKSPACE_TOOL_NAMES', () => {
    expect(workspaceToolView('get_weather', { city: 'Paris' }, { temp: 20 })).toBeNull()
    expect(workspaceApprovalView('get_weather', { city: 'Paris' })).toBeNull()
    expect(workspaceRowArgument('get_weather', { city: 'Paris' })).toBeNull()
    expect(workspaceRowSummary('get_weather', { temp: 20 })).toBeNull()
    expect(workspaceToolIcon('get_weather')).toBeNull()
  })

  it('returns null for values that fail the shared schemas', () => {
    expect(workspaceToolView('read_file', { path: 'a.txt' }, '[truncated]')).toBeNull()
    expect(workspaceApprovalView('edit_file', 42)).toBeNull()
    expect(workspaceRowArgument('shell', null)).toBeNull()
    expect(workspaceRowSummary('shell', '[truncated]')).toBeNull()
  })
})
