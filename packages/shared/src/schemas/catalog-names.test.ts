// Phase 12 (ADR-053, ADR-057, ADR-058): qualified catalog names reach every schema that carries a command, skill, agent
// or style name; the new settings, the import result count, the `skill` file read and the new definition keys.
import { describe, expect, it } from 'vitest'
import { chatRequestBodySchema, commandInvocationSchema } from '../chat.ts'
import { LIMITS } from '../limits.ts'
import { AGENT_COLORS } from '../util/definitions.ts'
import { agentTypeInputSchema, skillInputSchema, skillOutputSchema, taskOutputSchema } from './agent.ts'
import { chatSettingsSchema, chatSettingsUpdateSchema } from './chats.ts'
import { agentColorSchema, agentDefinitionFieldsSchema, commandDefinitionFieldsSchema, customizationEntrySchema, skillDefinitionFieldsSchema } from './customizations.ts'
import { dataImportResultSchema } from './data.ts'
import { projectUpdateSchema } from './projects.ts'
import { shareMessageSchema } from './shares.ts'
import { DEFAULT_SETTINGS, MODEL_ALIAS_NAMES, modelAliasesSchema, settingsSchema, settingsUpdateSchema } from './system.ts'
import { commandSummarySchema } from './tools.ts'

const QUALIFIED = 'review-kit:db:migrate'

describe('qualified catalog names (ADR-053)', () => {
  it('reach slash commands, skills, agent types, styles and shares', () => {
    expect(commandInvocationSchema.parse({ name: QUALIFIED, input: 'up', type: 'prompt' }).name).toBe(QUALIFIED)
    expect(commandSummarySchema.parse({ name: QUALIFIED, description: 'Migrate', source: 'plugin', pluginId: 'review-kit' }).name).toBe(QUALIFIED)
    expect(agentTypeInputSchema.parse('  Review-Kit:Code-Reviewer ')).toBe('review-kit:code-reviewer')
    expect(skillInputSchema.parse({ name: 'review-kit:pdf' })).toEqual({ name: 'review-kit:pdf' })
    expect(chatSettingsSchema.parse({ outputStyle: 'review-kit:terse' })).toEqual({ outputStyle: 'review-kit:terse' })
    expect(chatSettingsUpdateSchema.parse({ outputStyle: 'review-kit:terse' })).toEqual({ outputStyle: 'review-kit:terse' })
    expect(projectUpdateSchema.parse({ outputStyle: 'review-kit:terse' })).toEqual({ outputStyle: 'review-kit:terse' })
    expect(settingsUpdateSchema.parse({ outputStyle: 'review-kit:terse' })).toEqual({ outputStyle: 'review-kit:terse' })
    expect(shareMessageSchema.parse({ role: 'user', command: { name: QUALIFIED }, parts: [] }).command?.name).toBe(QUALIFIED)
    const body = { chatId: '0199a8f0-0000-7000-8000-000000000001', message: { id: 'msg_A000000000000001', role: 'user', parts: [{ type: 'text', text: 'Hi' }] }, trigger: 'submit-message', modelRef: 'mock:echo', reasoningEffort: 'auto', toolMode: 'ask' }
    expect(chatRequestBodySchema.parse({ ...body, outputStyle: 'review-kit:terse' }).outputStyle).toBe('review-kit:terse')
    for (const name of ['review-kit:a:b:c:d', 'Review Kit:x', `${'p'.repeat(41)}:x`])
      expect(commandInvocationSchema.safeParse({ name, input: '', type: 'prompt' }).success, name).toBe(false)
    // Bare names keep working (v1.7 messages).
    expect(commandInvocationSchema.parse({ name: 'greet', input: 'Ada', type: 'prompt' }).name).toBe('greet')
  })

  it('reach task outputs and skill outputs', () => {
    const task = { status: 'completed', type: 'review-kit:code-reviewer', description: 'Review', modelRef: 'mock:agents', steps: [], stepsOmitted: 0, report: 'Done.', startedAt: 1 }
    expect(taskOutputSchema.parse(task).type).toBe('review-kit:code-reviewer')
    expect(taskOutputSchema.parse({ ...task, type: 'explore' }).type).toBe('explore')
  })
})

describe('the skill tool reads supporting files (ADR-053)', () => {
  it('takes a relative file inside the skill folder', () => {
    expect(skillInputSchema.parse({ name: 'pdf', file: 'reference.md' })).toEqual({ name: 'pdf', file: 'reference.md' })
    expect(skillInputSchema.parse({ name: 'pdf', file: ' scripts/fill.sh ' })).toEqual({ name: 'pdf', file: 'scripts/fill.sh' })
    for (const file of ['', '/etc/passwd', '../secret.md', 'a/../b', 'a//b', 'a\\b', 'x'.repeat(513)])
      expect(skillInputSchema.safeParse({ name: 'pdf', file }).success, file).toBe(false)
  })

  it('answers the file (or the body) and how files are read', () => {
    const output = { name: 'review-kit:pdf', description: 'PDFs', source: 'plugin', content: '', truncated: false, fileAccess: 'skill', files: ['reference.md'], file: { path: 'reference.md', content: '# Reference', truncated: false } }
    expect(skillOutputSchema.parse(output)).toEqual(output)
    expect(skillOutputSchema.safeParse({ ...output, fileAccess: 'disk' }).success).toBe(false)
    expect(skillOutputSchema.safeParse({ ...output, file: { ...output.file, content: 'x'.repeat(LIMITS.skillFileReadBytes + 1) } }).success).toBe(false)
    // A v1.7 output (no fileAccess, no file) still parses.
    const v17 = { name: 'pdf', description: 'PDFs', source: 'project', content: 'Read PDFs.', truncated: false, baseDir: '.harness/skills/pdf', files: ['reference.md'] }
    expect(skillOutputSchema.parse(v17)).toEqual(v17)
  })
})

describe('settings (Phase 12): hookModelRef and modelAliases (32 keys)', () => {
  it('defaults to null and keeps v1.7 settings readable', () => {
    expect(MODEL_ALIAS_NAMES).toEqual(['sonnet', 'opus', 'haiku', 'fable'])
    expect(DEFAULT_SETTINGS.hookModelRef).toBeNull()
    expect(DEFAULT_SETTINGS.modelAliases).toEqual({ sonnet: null, opus: null, haiku: null, fable: null })
    const v17 = { ...DEFAULT_SETTINGS } as Record<string, unknown>
    delete v17.hookModelRef
    delete v17.modelAliases
    expect(settingsSchema.parse({ ...v17, outputStyle: 'learning' })).toEqual({ ...DEFAULT_SETTINGS, outputStyle: 'learning' })
  })

  it('updates the hook model and the aliases (sent whole)', () => {
    const aliases = { sonnet: 'anthropic:claude-sonnet-5', opus: null, haiku: 'openrouter:anthropic/claude-haiku-5', fable: null }
    expect(settingsUpdateSchema.parse({ hookModelRef: 'mock:hooks', modelAliases: aliases })).toEqual({ hookModelRef: 'mock:hooks', modelAliases: aliases })
    expect(modelAliasesSchema.parse(aliases)).toEqual(aliases)
    for (const value of [{ sonnet: 'x' }, { ...aliases, gpt: null }, { ...aliases, opus: 'not a ref' }])
      expect(settingsUpdateSchema.safeParse({ modelAliases: value }).success, JSON.stringify(value)).toBe(false)
    expect(settingsUpdateSchema.safeParse({ hookModelRef: 'haiku' }).success).toBe(false)
  })
})

describe('the data import result counts turned-off commands', () => {
  it('reads results with and without turnedOff', () => {
    const result = { kind: 'backup', counts: { imported: 1, copied: 0, skipped: 0, failed: 0, filesImported: 0, filesReused: 0, filesMissing: 0 }, settingsRestored: false, customizations: { imported: 3, skipped: 0, failed: 0, turnedOff: 1 }, items: [], warnings: [] }
    expect(dataImportResultSchema.parse(result).customizations?.turnedOff).toBe(1)
    expect(dataImportResultSchema.parse({ ...result, customizations: { imported: 3, skipped: 0, failed: 0 } }).customizations?.turnedOff).toBeUndefined()
  })
})

describe('the Claude Code frontmatter keys in the catalog (ADR-058)', () => {
  it('lists the new keys on entries and in the parsed fields', () => {
    expect(agentColorSchema.options).toEqual([...AGENT_COLORS])
    const entry = { kind: 'agent', name: 'review-kit:code-reviewer', description: 'Reviews', source: 'plugin', pluginId: 'review-kit', enabled: true, state: 'active', diagnostics: [], disallowedTools: ['shell'], maxTurns: 12, color: 'purple', skills: ['pdf'], modelAlias: 'sonnet' }
    expect(customizationEntrySchema.parse(entry)).toEqual(entry)
    const command = { kind: 'command', name: 'deploy', description: 'Deploys', source: 'project', path: '.claude/commands/deploy.md', enabled: true, state: 'active', diagnostics: [], whenToUse: 'Before a release', arguments: ['env', 'region'], context: 'fork', agent: 'general' }
    expect(customizationEntrySchema.parse(command)).toEqual(command)
    for (const change of [{ maxTurns: 0 }, { maxTurns: 201 }, { color: 'magenta' }, { context: 'inline' }, { skills: ['a', 'b', 'c', 'd', 'e', 'f'] }])
      expect(customizationEntrySchema.safeParse({ ...entry, ...change }).success, JSON.stringify(change)).toBe(false)
    expect(agentDefinitionFieldsSchema.parse({ name: 'r', description: 'd', tools: null, model: null, instructions: 'i', modelAlias: 'opus', maxTurns: 3 })).toMatchObject({ modelAlias: 'opus', maxTurns: 3 })
    expect(commandDefinitionFieldsSchema.parse({ name: 'c', description: 'd', argumentHint: null, model: null, allowedTools: null, body: 'b', arguments: ['a'], context: 'fork' })).toMatchObject({ arguments: ['a'], context: 'fork' })
    expect(skillDefinitionFieldsSchema.parse({ name: 's', description: 'd', content: 'c', allowedTools: ['read_file'], model: 'mock:echo' })).toMatchObject({ allowedTools: ['read_file'], model: 'mock:echo' })
    // A v1.7 entry (none of the new keys) still parses.
    const v17 = { kind: 'skill', name: 'pdf', description: 'PDFs', source: 'user', id: 'cus_ABCdef0123456789', enabled: true, state: 'active', diagnostics: [] }
    expect(customizationEntrySchema.parse(v17)).toEqual(v17)
  })
})
