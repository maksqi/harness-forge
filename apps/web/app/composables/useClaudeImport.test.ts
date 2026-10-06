// useClaudeImport (Phase 12, ADR-055; docs/UI.md 11.9; C46 signature): the calls of the import dialog.
import type { MockApi } from '~/utils/testing/mock-api'
import { CLAUDE_IMPORT_UPLOAD_PARTS } from '@harness-forge/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { claudeImportApplyResult, claudeImportHome, claudeImportPlan, importPlanId } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { useClaudeImport } from './useClaudeImport'

const mock = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))
vi.mock('./useApi', () => ({ useApi: () => mock.api }))

let api: MockApi

beforeEach(() => {
  api = createMockApi()
  mock.api = api
})

describe('useClaudeImport', () => {
  it('asks for the server home and scans it', async () => {
    api.claudeImport.home.mockResolvedValue(claudeImportHome())
    api.claudeImport.scan.mockResolvedValue(claudeImportPlan({ source: 'scan' }))
    const claude = useClaudeImport()
    expect(await claude.serverHome()).toEqual(claudeImportHome())
    expect((await claude.scanServer()).source).toBe('scan')
  })

  it('uploads the picked files by their relative path and the .claude.json', async () => {
    api.claudeImport.upload.mockResolvedValue(claudeImportPlan())
    await useClaudeImport().planFromFiles([new File(['a'], 'agents/a.md'), new File(['s'], 'settings.json')], new File(['{}'], '.claude.json'))
    const form = api.claudeImport.upload.mock.calls[0]![0].form as FormData
    expect((form.getAll(CLAUDE_IMPORT_UPLOAD_PARTS.files) as File[]).map(file => file.name)).toEqual(['agents/a.md', 'settings.json'])
    expect((form.get(CLAUDE_IMPORT_UPLOAD_PARTS.claudeJson) as File).name).toBe('.claude.json')
  })

  it('uploads a zip as is', async () => {
    api.claudeImport.upload.mockResolvedValue(claudeImportPlan())
    await useClaudeImport().planFromZip(new File(['PK'], 'claude.zip'))
    const form = api.claudeImport.upload.mock.calls[0]![0].form as FormData
    expect((form.get(CLAUDE_IMPORT_UPLOAD_PARTS.zip) as File).name).toBe('claude.zip')
    expect(form.get('label')).toBe('claude.zip')
  })

  it('applies a selection by plan id and item keys', async () => {
    api.claudeImport.apply.mockResolvedValue(claudeImportApplyResult())
    await useClaudeImport().apply(importPlanId(1), { items: { 'agent:reviewer:agents/reviewer.md': { action: 'import' } }, instructions: 'append' })
    expect(api.claudeImport.apply).toHaveBeenCalledWith({
      body: { planId: importPlanId(1), items: [{ key: 'agent:reviewer:agents/reviewer.md', action: 'import' }], instructions: 'append' },
    })
  })
})
