import { describe, expect, it } from 'vitest'
import { logEntry, pluginDetail } from '~/utils/testing/fixtures'
import {
  canEditInWizard,
  canExport,
  canUninstall,
  hasSourceTab,
  logMatchesLevel,
  logsAsText,
  mcpStatusDot,
  mcpStatusText,
  permissionLabel,
  pluginTabs,
  resolvePluginTab,
} from './plugin-detail'

describe('plugin detail rules', () => {
  it('shows Configuration only with settings and Source for code plugins and editable declarative ones', () => {
    expect(pluginTabs(pluginDetail({ kind: 'code', source: 'created', editable: true, hasSettings: true }))).toEqual(['overview', 'configuration', 'source', 'logs'])
    expect(pluginTabs(pluginDetail({ kind: 'code', source: 'npm', editable: false, hasSettings: false }))).toEqual(['overview', 'source', 'logs'])
    expect(pluginTabs(pluginDetail({ kind: 'declarative', source: 'zip', editable: false }))).toEqual(['overview', 'logs'])
    expect(pluginTabs(pluginDetail({ kind: 'declarative', source: 'created', editable: true }))).toEqual(['overview', 'source', 'logs'])
    expect(hasSourceTab(pluginDetail({ kind: 'code', source: 'builtin', builtin: true, editable: false }))).toBe(false)
  })

  it('falls back to Overview for missing, unknown or hidden tabs', () => {
    const tabs = pluginTabs(pluginDetail({ kind: 'declarative', source: 'zip', editable: false }))
    expect(resolvePluginTab('logs', tabs)).toBe('logs')
    expect(resolvePluginTab(['logs', 'overview'], tabs)).toBe('logs')
    expect(resolvePluginTab('source', tabs)).toBe('overview')
    expect(resolvePluginTab('nope', tabs)).toBe('overview')
    expect(resolvePluginTab(undefined, tabs)).toBe('overview')
  })

  it('offers header actions by source', () => {
    expect(canEditInWizard(pluginDetail({ source: 'created', kind: 'declarative' }))).toBe(true)
    expect(canEditInWizard(pluginDetail({ source: 'created', kind: 'code' }))).toBe(false)
    expect(canEditInWizard(pluginDetail({ source: 'zip', kind: 'declarative' }))).toBe(false)
    const builtin = pluginDetail({ source: 'builtin', builtin: true, removable: false })
    expect([canExport(builtin), canUninstall(builtin)]).toEqual([false, false])
    expect([canExport(pluginDetail()), canUninstall(pluginDetail())]).toEqual([true, true])
  })

  it('words permissions and MCP states', () => {
    expect(permissionLabel('hooks')).toBe('Reads and changes conversations')
    expect(permissionLabel('custom')).toBe('custom')
    expect(mcpStatusDot('connected')).toBe('ok')
    expect(mcpStatusDot('connecting')).toBe('running')
    expect(mcpStatusText({ status: 'connected', tools: ['a', 'b'], error: null })).toBe('Connected · 2 tools')
    expect(mcpStatusText({ status: 'connected', tools: ['a'], error: null })).toBe('Connected · 1 tool')
    expect(mcpStatusText({ status: 'error', tools: [], error: { code: 'provider_unreachable', message: 'ECONNREFUSED' } })).toBe('Error: ECONNREFUSED')
  })

  it('filters logs by minimum level and formats them for copying', () => {
    const entries = [
      logEntry(1, { level: 'debug', message: 'a' }),
      logEntry(2, { level: 'info', message: 'b' }),
      logEntry(3, { level: 'warn', message: 'c' }),
      logEntry(4, { level: 'error', message: 'd', data: { status: 502 } }),
    ]
    expect(entries.filter(entry => logMatchesLevel(entry, 'all')).map(entry => entry.seq)).toEqual([1, 2, 3, 4])
    expect(entries.filter(entry => logMatchesLevel(entry, 'info')).map(entry => entry.seq)).toEqual([2, 3, 4])
    expect(entries.filter(entry => logMatchesLevel(entry, 'warn')).map(entry => entry.seq)).toEqual([3, 4])
    expect(entries.filter(entry => logMatchesLevel(entry, 'error')).map(entry => entry.seq)).toEqual([4])
    const text = logsAsText(entries.slice(2)).split('\n')
    expect(text[0]).toMatch(/^\d{4}-\d\d-\d\dT.+Z WARN {2}c$/)
    expect(text[1]).toMatch(/ERROR d \{"status":502\}$/)
  })
})
