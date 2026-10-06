import { describe, expect, it } from 'vitest'
import { createImportPlanId, IMPORT_PLAN_ID_PATTERN, importPlanIdSchema } from '../ids.ts'
import { LIMITS } from '../limits.ts'
import { CLAUDE_IMPORT_ACTIONS, CLAUDE_IMPORT_KINDS, CLAUDE_IMPORT_STATUSES, CLAUDE_IMPORT_WARNINGS } from '../util/claude-import.ts'
import {
  CLAUDE_IMPORT_UPLOAD_PARTS,
  claudeImportActionSchema,
  claudeImportApplyBodySchema,
  claudeImportApplyResultSchema,
  claudeImportHomeSchema,
  claudeImportKindSchema,
  claudeImportPlanItemSchema,
  claudeImportPlanSchema,
  claudeImportStatusSchema,
  claudeImportUploadFormSchema,
  claudeImportWarningSchema,
} from './claude-import.ts'

const PLAN_ID = 'cip_ABCdef0123456789'

const item = {
  key: 'mcp-server:github:.claude.json',
  kind: 'mcp-server',
  name: 'github',
  source: { file: '.claude.json' },
  status: 'new',
  actions: ['import', 'skip'],
  defaultAction: 'import',
  summary: 'stdio: npx -y @modelcontextprotocol/server-github (env GITHUB_TOKEN)',
  warnings: ['runs-commands', 'needs-variables'],
  diagnostics: [],
  variables: ['GITHUB_TOKEN'],
  executable: true,
} as const

describe('import plan ids (ADR-055)', () => {
  it('creates and validates cip_ ids', () => {
    const id = createImportPlanId()
    expect(id).toMatch(IMPORT_PLAN_ID_PATTERN)
    expect(importPlanIdSchema.parse(id)).toBe(id)
    expect(importPlanIdSchema.safeParse('cip_short').success).toBe(false)
    expect(importPlanIdSchema.safeParse('mkt_ABCdef0123456789').success).toBe(false)
  })
})

describe('the import DTOs (ADR-055)', () => {
  it('mirrors the enums of util/claude-import.ts', () => {
    expect(claudeImportKindSchema.options).toEqual([...CLAUDE_IMPORT_KINDS])
    expect(claudeImportStatusSchema.options).toEqual([...CLAUDE_IMPORT_STATUSES])
    expect(claudeImportActionSchema.options).toEqual([...CLAUDE_IMPORT_ACTIONS])
    expect(claudeImportWarningSchema.options).toEqual([...CLAUDE_IMPORT_WARNINGS])
    expect(CLAUDE_IMPORT_UPLOAD_PARTS).toEqual({ zip: 'file', files: 'files', claudeJson: 'claudeJson' })
  })

  it('parses the home status', () => {
    expect(claudeImportHomeSchema.parse({ available: true, path: '/home/ada/.claude' })).toEqual({ available: true, path: '/home/ada/.claude' })
    expect(claudeImportHomeSchema.parse({ available: false, reason: 'disabled', path: null })).toEqual({ available: false, reason: 'disabled', path: null })
    expect(claudeImportHomeSchema.safeParse({ available: false, reason: 'locked', path: null }).success).toBe(false)
  })

  it('parses plans without payloads (names, never values)', () => {
    expect(claudeImportPlanItemSchema.parse(item)).toEqual(item)
    // A payload field is not part of the DTO: it is stripped.
    expect(claudeImportPlanItemSchema.parse({ ...item, payload: { kind: 'none' } })).not.toHaveProperty('payload')
    for (const change of [{ kind: 'credential' }, { status: 'pending' }, { actions: ['delete'] }, { warnings: ['secret'] }, { variables: ['not a name'] }, { summary: 'x'.repeat(LIMITS.claudeImportSummaryMaxChars + 1) }])
      expect(claudeImportPlanItemSchema.safeParse({ ...item, ...change }).success, JSON.stringify(change).slice(0, 60)).toBe(false)
    const plan = { id: PLAN_ID, source: 'upload', root: '.claude', createdAt: 1, expiresAt: 600_001, items: [item], skipped: [{ path: 'projects/x.jsonl', reason: 'Not part of an import.' }], diagnostics: [] }
    expect(claudeImportPlanSchema.parse(plan)).toEqual(plan)
    expect(claudeImportPlanSchema.safeParse({ ...plan, source: 'home' }).success).toBe(false)
    expect(claudeImportPlanSchema.safeParse({ ...plan, items: Array.from({ length: LIMITS.claudeImportItemsMax + 1 }).fill(item) }).success).toBe(false)
  })

  it('validates the upload form fields', () => {
    expect(claudeImportUploadFormSchema.parse({})).toEqual({})
    expect(claudeImportUploadFormSchema.parse({ label: ' .claude ' })).toEqual({ label: '.claude' })
    expect(claudeImportUploadFormSchema.safeParse({ label: 'a\u0000b' }).success).toBe(false)
  })

  it('validates apply bodies (strict; keys once; rename needs a name; variables by item)', () => {
    const body = {
      planId: PLAN_ID,
      items: [{ key: item.key, action: 'import', enable: true }, { key: 'agent:reviewer:agents/reviewer.md', action: 'rename', renameTo: 'reviewer-2' }],
      instructions: 'append',
      variables: { [item.key]: { GITHUB_TOKEN: 'value' } },
    }
    expect(claudeImportApplyBodySchema.parse(body)).toEqual(body)
    for (const change of [
      { planId: 'cip_short' },
      { items: [] },
      { items: [{ key: item.key, action: 'import' }, { key: item.key, action: 'skip' }] },
      { items: [{ key: item.key, action: 'rename' }] },
      { items: [{ key: item.key, action: 'import', extra: 1 }] },
      { instructions: 'prepend' },
      { variables: { [item.key]: { 'NOT A NAME': 'x' } } },
      { source: 'scan' },
    ])
      expect(claudeImportApplyBodySchema.safeParse({ ...body, ...change }).success, JSON.stringify(change).slice(0, 60)).toBe(false)
  })

  it('parses apply results', () => {
    const result = {
      results: [{ key: item.key, outcome: 'created', id: 'github' }, { key: 'instructions:CLAUDE.md:CLAUDE.md', outcome: 'failed', message: 'The instructions would be longer than 20000 characters.' }],
      counts: { created: 1, updated: 0, unchanged: 0, skipped: 0, failed: 1 },
      warnings: [],
    }
    expect(claudeImportApplyResultSchema.parse(result)).toEqual(result)
    expect(claudeImportApplyResultSchema.safeParse({ ...result, results: [{ key: item.key, outcome: 'imported' }] }).success).toBe(false)
  })
})
