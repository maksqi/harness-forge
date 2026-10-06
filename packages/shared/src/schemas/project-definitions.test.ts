import { describe, expect, it } from 'vitest'
import { workspaceChangedSourceSchema } from '../enums.ts'
import { LIMITS } from '../limits.ts'
import {
  isMarkdownDefinitionKind,
  PROJECT_DEFINITION_FILE_KINDS,
  projectDefinitionFileSchema,
  projectDefinitionPathKind,
  projectDefinitionQuerySchema,
  projectDefinitionRemoveQuerySchema,
  projectDefinitionWriteBodySchema,
  projectDefinitionWriteResultSchema,
} from './project-definitions.ts'

const SHA = 'c'.repeat(64)

describe('editable project paths (ADR-056)', () => {
  it('names the kind of every editable file', () => {
    expect(PROJECT_DEFINITION_FILE_KINDS).toEqual(['agent', 'command', 'skill', 'style', 'settings', 'mcp'])
    const kinds: Record<string, string> = {
      '.claude/agents/reviewer.md': 'agent',
      '.harness/agents/Reviewer.MD': 'agent',
      '.claude/commands/review.md': 'command',
      '.claude/commands/db/migrate.md': 'command',
      '.harness/commands/a/b/c/deep.md': 'command',
      '.claude/skills/pdf/SKILL.md': 'skill',
      '.harness/output-styles/terse.md': 'style',
      '.claude/settings.json': 'settings',
      '.harness/settings.local.json': 'settings',
      '.mcp.json': 'mcp',
    }
    for (const [path, kind] of Object.entries(kinds))
      expect(projectDefinitionPathKind(path), path).toBe(kind)
  })

  it('refuses everything else (other folders, depth, traversal, absolute paths, control characters)', () => {
    for (const path of [
      '',
      'AGENTS.md',
      'CLAUDE.md',
      '.claude',
      '.claude/agents',
      '.claude/agents/reviewer.txt',
      '.claude/agents/sub/reviewer.md',
      '.harness/commands/a/b/c/d/too-deep.md',
      '.claude/skills/pdf/reference.md',
      '.claude/skills/SKILL.md',
      '.claude/hooks/format.sh',
      '.claude/settings.yaml',
      '.claude/../.env',
      './.claude/agents/a.md',
      '/abs/.claude/agents/a.md',
      '.claude//agents/a.md',
      '.claude\\agents\\a.md',
      '.claude/agents/a\u0000.md',
      '.git/config',
      'src/.mcp.json',
      '.vscode/settings.json',
      `.claude/agents/${'a'.repeat(600)}.md`,
    ])
      expect(projectDefinitionPathKind(path), path).toBeNull()
    expect(isMarkdownDefinitionKind('skill')).toBe(true)
    expect(isMarkdownDefinitionKind('settings')).toBe(false)
    expect(isMarkdownDefinitionKind('mcp')).toBe(false)
  })
})

describe('project definition DTOs (ADR-056)', () => {
  it('reads files (a missing file is exists: false)', () => {
    const file = { path: '.claude/agents/reviewer.md', kind: 'agent', exists: true, content: '---\nname: reviewer\n---\nx', sha256: SHA, diagnostics: [{ level: 'warning', code: 'unknown-key', message: 'Line 3: "colour" is not a known key.', line: 3 }] }
    expect(projectDefinitionFileSchema.parse(file)).toEqual(file)
    const missing = { path: '.mcp.json', kind: 'mcp', exists: false, content: null, sha256: null, diagnostics: [] }
    expect(projectDefinitionFileSchema.parse(missing)).toEqual(missing)
    expect(projectDefinitionQuerySchema.parse({ path: '.claude/settings.json' })).toEqual({ path: '.claude/settings.json' })
    expect(projectDefinitionQuerySchema.safeParse({ path: 'README.md' }).success).toBe(false)
  })

  it('writes by path kind: content, hooks or mcpServers', () => {
    for (const body of [
      { path: '.claude/agents/reviewer.md', expectedSha256: null, content: '---\nname: reviewer\ndescription: Reviews\n---\nReview.\n' },
      { path: '.harness/skills/pdf/SKILL.md', expectedSha256: SHA, content: '---\nname: pdf\ndescription: PDFs\n---\nRead PDFs.\n' },
      { path: '.claude/settings.json', expectedSha256: SHA, hooks: { PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'sh x.sh' }] }] } },
      { path: '.claude/settings.local.json', expectedSha256: null, hooks: null },
      { path: '.mcp.json', expectedSha256: SHA, mcpServers: { memory: { command: 'node', args: ['memory.mjs'] } } },
      { path: '.mcp.json', expectedSha256: SHA, mcpServers: null },
    ])
      expect(projectDefinitionWriteBodySchema.parse(body), body.path).toEqual(body)
    for (const body of [
      { path: '.claude/settings.json', expectedSha256: null, content: 'x' },
      { path: '.claude/agents/a.md', expectedSha256: null, hooks: {} },
      { path: '.mcp.json', expectedSha256: null, content: '{}' },
      { path: '.mcp.json', expectedSha256: null, hooks: {} },
      { path: '.claude/settings.json', expectedSha256: null, mcpServers: {} },
      { path: '.claude/agents/a.md', content: 'x' },
      { path: '.claude/agents/a.md', expectedSha256: 'abc', content: 'x' },
      { path: '.claude/agents/a.md', expectedSha256: null, content: '' },
      { path: '.claude/agents/a.md', expectedSha256: null, content: 'x'.repeat(LIMITS.customizationContentBytes + 1) },
      { path: '.claude/agents/a.md', expectedSha256: null, content: 'x', hooks: null },
      { path: 'src/a.md', expectedSha256: null, content: 'x' },
    ])
      expect(projectDefinitionWriteBodySchema.safeParse(body).success, JSON.stringify(body).slice(0, 80)).toBe(false)
  })

  it('deletes markdown definitions only, with the loaded sha256', () => {
    expect(projectDefinitionRemoveQuerySchema.parse({ path: '.claude/commands/db/migrate.md', expectedSha256: SHA })).toEqual({ path: '.claude/commands/db/migrate.md', expectedSha256: SHA })
    for (const query of [{ path: '.claude/settings.json', expectedSha256: SHA }, { path: '.mcp.json', expectedSha256: SHA }, { path: '.claude/agents/a.md' }])
      expect(projectDefinitionRemoveQuerySchema.safeParse(query).success, JSON.stringify(query)).toBe(false)
  })

  it('answers the new sha256 and the pending trust count (saving never approves)', () => {
    const result = { path: '.claude/settings.json', sha256: SHA, created: false, diagnostics: [], trust: { pending: 2 } }
    expect(projectDefinitionWriteResultSchema.parse(result)).toEqual(result)
    expect(projectDefinitionWriteResultSchema.safeParse({ ...result, trust: { pending: -1 } }).success).toBe(false)
    // A UI save is reported as `workspace.changed { source: 'user' }`.
    expect(workspaceChangedSourceSchema.options).toContain('user')
  })
})

describe('trust items of prompt hooks (ADR-057)', () => {
  it('shows the prompt and the handler fields; v1.7 hook items still parse', async () => {
    const { trustItemSchema } = await import('./project-trust.ts')
    const v17 = { kind: 'hook', sha256: SHA, state: 'approved', label: 'sh .claude/hooks/format.sh', path: '.claude/settings.json', refs: [], warnings: [], detail: { event: 'PostToolUse', matcher: 'Write', command: 'sh .claude/hooks/format.sh', timeout: null } }
    expect(trustItemSchema.parse(v17)).toEqual(v17)
    const prompt = { ...v17, state: 'pending', label: 'Stop prompt', detail: { event: 'Stop', matcher: null, command: '', timeout: null, type: 'prompt', prompt: 'Done? $ARGUMENTS', model: 'haiku', continueOnBlock: false } }
    expect(trustItemSchema.parse(prompt)).toEqual(prompt)
    expect(trustItemSchema.safeParse({ ...prompt, detail: { ...prompt.detail, type: 'agent' } }).success).toBe(false)
  })
})
