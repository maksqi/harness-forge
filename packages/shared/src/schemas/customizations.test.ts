import type { z } from 'zod'
// Phase 10 contracts (ADR-044 … ADR-047): the catalog and personal definitions, custom and background sub-agents, the
// `skill` tool, plan files, Remember, the new data part and events, plugin API 1.4.0 manifests, backups, and the v1.5
// shapes that must keep parsing.
import type { HarnessUIMessage } from '../chat.ts'
import type { AgentDefinitionFields, CommandDefinitionFields, DefinitionDiagnostic, SkillDefinitionFields, StyleDefinitionFields } from '../util/definitions.ts'
import type { agentDefinitionFieldsSchema, commandDefinitionFieldsSchema, Customization, skillDefinitionFieldsSchema, styleDefinitionFieldsSchema } from './customizations.ts'
import { validateUIMessages } from 'ai'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { commandInvocationSchema, harnessDataSchemas, messageMetadataSchema, noticeCodeSchema } from '../chat.ts'
import {
  commandSourceSchema,
  customizationKindSchema,
  customizationSourceSchema,
  customizationStateSchema,
  definitionDiagnosticSchema,
  rememberTargetSchema,
  runOriginSchema,
  taskTypeSchema,
} from '../enums.ts'
import { HARNESS_ERROR_CODES } from '../errors.ts'
import { createServerEvent, runStartedDataSchema, serverEventSchema } from '../events.ts'
import { CLIENT_COMMANDS } from '../ids.ts'
import { LIMITS } from '../limits.ts'
import { CUSTOMIZATION_KINDS, CUSTOMIZATION_SOURCES, DEFINITION_DIAGNOSTIC_CODES, DEFINITION_DIAGNOSTIC_LEVELS, DEFINITION_LIMITS } from '../util/definitions.ts'
import {
  agentTypeInputSchema,
  exitPlanModeOutputSchema,
  skillInputSchema,
  skillOutputSchema,
  taskInputSchema,
  taskOutputSchema,
  taskStatusSchema,
} from './agent.ts'
import {
  backgroundTaskListSchema,
  backgroundTaskSchema,
  backgroundTaskStatusSchema,
  chatTaskParamsSchema,
  taskChangedDataSchema,
  taskResultDataSchema,
} from './background-tasks.ts'
import {
  backupCustomizationsSchema,
  customizationChangedDataSchema,
  customizationCreateSchema,
  customizationEntrySchema,
  customizationListSchema,
  customizationParamsSchema,
  customizationSchema,
  customizationSourceQuerySchema,
  customizationSourceResultSchema,
  customizationsQuerySchema,
  customizationUpdateSchema,
  rememberBodySchema,
  rememberResultSchema,
} from './customizations.ts'
import { backupManifestSchema, dataExportQuerySchema, dataImportFormSchema, dataImportResultSchema } from './data.ts'
import { declarativeAgentSchema, declarativeCommandSchema, declarativeSkillSchema } from './plugin-data.ts'
import { pluginManifestSchema } from './plugin-manifest.ts'
import { pluginContributionsSchema } from './plugins.ts'
import { DEFAULT_SETTINGS } from './system.ts'
import { commandsQuerySchema, commandSummarySchema } from './tools.ts'

const CHAT_ID = '0199a8f0-0000-7000-8000-000000000001'
const PROJECT_ID = 'prj_ABCdef0123456789'
const CUSTOMIZATION_ID = 'cus_ABCdef0123456789'
const TASK_ID = 'bgt_ABCdef0123456789'
const MESSAGE_A = 'msg_A000000000000001'
const MESSAGE_B = 'msg_B000000000000001'
const AGENT_MD = '---\nname: reviewer\ndescription: Reviews diffs\ntools: Read, Grep\n---\nReview the diff.\n'

async function validate(messages: unknown[]): Promise<HarnessUIMessage[]> {
  return validateUIMessages<HarnessUIMessage>({ messages, metadataSchema: messageMetadataSchema, dataSchemas: harnessDataSchemas })
}

const output = {
  status: 'completed',
  type: 'reviewer',
  description: 'Review the parser',
  modelRef: 'mock:agents',
  steps: [{ toolCallId: 'child_1', toolName: 'read_file', summary: 'src/parser.ts', state: 'done' }],
  stepsOmitted: 0,
  report: 'Looks good.',
  startedAt: 1,
  finishedAt: 2,
  agent: { source: 'project', description: 'Reviews diffs', path: '.harness/agents/reviewer.md' },
} as const

const task = {
  id: TASK_ID,
  chatId: CHAT_ID,
  messageId: MESSAGE_A,
  toolCallId: 'call_task_1',
  origin: 'request',
  status: 'completed',
  output: { ...output, taskId: TASK_ID },
  createdAt: 1,
  finishedAt: 2,
  deliveredAt: null,
  deliveredMessageId: null,
} as const

describe('enums and limits (Phase 10)', () => {
  it('declares the customization enums from the definition constants', () => {
    expect(customizationKindSchema.options).toEqual([...CUSTOMIZATION_KINDS])
    // Phase 11 (ADR-051) adds `style`.
    expect(customizationKindSchema.options).toEqual(['agent', 'command', 'skill', 'style'])
    expect(customizationSourceSchema.options).toEqual([...CUSTOMIZATION_SOURCES])
    expect(customizationSourceSchema.options).toEqual(['builtin', 'plugin', 'user', 'project'])
    expect(customizationStateSchema.options).toEqual(['active', 'shadowed', 'invalid', 'off'])
    expect(commandSourceSchema.options).toEqual(['harness', 'plugin', 'user', 'project'])
    expect(rememberTargetSchema.options).toEqual(['project-file', 'project-instructions', 'global'])
    // Phase 11 (ADR-048) adds `hook`.
    expect(runOriginSchema.options).toEqual(['request', 'queue', 'task', 'hook'])
    // The builtin task type enum stays (the web picks the builtin icons with it); task statuses gain `background`.
    expect(taskTypeSchema.options).toEqual(['explore', 'general'])
    expect(taskStatusSchema.options).toEqual(['queued', 'running', 'completed', 'failed', 'aborted', 'limit', 'background'])
    expect(backgroundTaskStatusSchema.options).toEqual(['running', 'completed', 'failed', 'aborted', 'limit'])
    // Phase 11 adds three notices after `command-model-unavailable` (11).
    expect(noticeCodeSchema.options).toHaveLength(11)
    expect(noticeCodeSchema.options[7]).toBe('command-model-unavailable')
    expect(HARNESS_ERROR_CODES).toHaveLength(16)
    expect(CLIENT_COMMANDS).toContain('remember')
  })

  it('declares the Phase 10 limits (the definition caps mirror DEFINITION_LIMITS)', () => {
    expect(LIMITS).toMatchObject({
      customizationContentBytes: 65_536,
      customizationFrontmatterBytes: 8192,
      customizationFilesPerFolderMax: 200,
      customizationDescriptionMaxChars: 1024,
      customizationsPerKindMax: 200,
      customizationIndexTtlMs: 10_000,
      agentTypesListedMax: 30,
      skillsListedMax: 50,
      listedDescriptionMaxChars: 250,
      skillFilesListedMax: 50,
      rememberTextMaxChars: 2000,
      rememberFileMaxBytes: 1_048_576,
      backgroundTasksPerChatMax: 3,
      backgroundTasksMax: 10,
      backgroundTaskTimeoutMs: 1_800_000,
      backgroundTasksKeptPerChat: 100,
    })
    expect(LIMITS.customizationContentBytes).toBe(DEFINITION_LIMITS.contentBytes)
    expect(LIMITS.customizationFrontmatterBytes).toBe(DEFINITION_LIMITS.frontmatterBytes)
    expect(LIMITS.customizationDescriptionMaxChars).toBe(DEFINITION_LIMITS.descriptionMaxChars)
  })

  it('mirrors DefinitionDiagnostic with definitionDiagnosticSchema', () => {
    expect(definitionDiagnosticSchema.shape.level.options).toEqual([...DEFINITION_DIAGNOSTIC_LEVELS])
    expect(definitionDiagnosticSchema.shape.code.options).toEqual([...DEFINITION_DIAGNOSTIC_CODES])
    const diagnostic: DefinitionDiagnostic = { level: 'warning', code: 'unknown-tool', message: 'Line 3: The tool "Task" is unknown.', line: 3, path: '.claude/agents/a.md', kind: 'agent', name: 'a' }
    expect(definitionDiagnosticSchema.parse(diagnostic)).toEqual(diagnostic)
    expect(definitionDiagnosticSchema.parse({ level: 'info', code: 'ignored-key', message: 'Ignored "color".' })).toEqual({ level: 'info', code: 'ignored-key', message: 'Ignored "color".' })
    for (const change of [{ level: 'fatal' }, { code: 'oops' }, { line: 0 }, { line: 1.5 }, { kind: 'hook' }, { message: undefined }])
      expect(definitionDiagnosticSchema.safeParse({ ...diagnostic, ...change }).success, JSON.stringify(change)).toBe(false)
    expectTypeOf<Readonly<z.infer<typeof definitionDiagnosticSchema>>>().toEqualTypeOf<DefinitionDiagnostic>()
  })
})

describe('task and skill tools (ADR-045, ADR-046, ADR-047)', () => {
  const input = { description: 'Review the parser', prompt: 'Review src/parser.ts.', type: 'reviewer' }

  it('takes any agent name as task type, normalized, and the background flag', () => {
    expect(taskInputSchema.parse(input)).toEqual(input)
    expect(taskInputSchema.parse({ ...input, type: '  General-Purpose ' }).type).toBe('general-purpose')
    expect(taskInputSchema.parse({ ...input, type: 'Explore' }).type).toBe('explore')
    expect(taskInputSchema.parse({ ...input, background: true })).toEqual({ ...input, background: true })
    for (const change of [{ type: '' }, { type: 'code review' }, { type: '1st' }, { type: 'a'.repeat(65) }, { background: 'yes' }])
      expect(taskInputSchema.safeParse({ ...input, ...change }).success, JSON.stringify(change)).toBe(false)
    expect(agentTypeInputSchema.parse(' Reviewer')).toBe('reviewer')
  })

  it('carries the background task id and the agent snapshot in task outputs', () => {
    expect(taskOutputSchema.parse(output)).toEqual(output)
    const launched = { ...output, status: 'background', steps: [], report: '', finishedAt: undefined, agent: undefined, taskId: TASK_ID }
    expect(taskOutputSchema.parse(launched).taskId).toBe(TASK_ID)
    for (const change of [
      { type: 'Reviewer' },
      { taskId: 'bgt_short' },
      { agent: { source: 'home', description: 'x' } },
      { agent: { source: 'user', description: 'x'.repeat(201) } },
    ])
      expect(taskOutputSchema.safeParse({ ...output, ...change }).success, JSON.stringify(change).slice(0, 60)).toBe(false)
  })

  it('validates skill inputs and outputs', () => {
    expect(skillInputSchema.parse({ name: ' Release-Notes ' })).toEqual({ name: 'release-notes' })
    expect(skillInputSchema.safeParse({ name: 'release notes' }).success).toBe(false)
    const skill = { name: 'release-notes', description: 'Write release notes', source: 'project', content: '# Steps', truncated: false, baseDir: '.harness/skills/release-notes', files: ['template.md'] }
    expect(skillOutputSchema.parse(skill)).toEqual(skill)
    expect(skillOutputSchema.parse({ name: 'pdf', description: 'PDFs', source: 'plugin', content: '', truncated: false })).toMatchObject({ name: 'pdf' })
    for (const change of [
      { content: 'x'.repeat(LIMITS.customizationContentBytes + 1) },
      { files: Array.from({ length: LIMITS.skillFilesListedMax + 1 }, (_, index) => `f${index}.md`) },
      { source: 'disk' },
      { truncated: undefined },
    ])
      expect(skillOutputSchema.safeParse({ ...skill, ...change }).success, Object.keys(change).join()).toBe(false)
  })

  it('reports plan files in exit_plan_mode outputs (optional: v1.5 outputs parse)', () => {
    expect(exitPlanModeOutputSchema.parse({ approved: true, mode: 'edits' })).toEqual({ approved: true, mode: 'edits' })
    const saved = { approved: true, mode: 'ask', planPath: '.harness/plans/2026-10-04-auth.md' }
    expect(exitPlanModeOutputSchema.parse(saved)).toEqual(saved)
    const failed = { approved: true, mode: 'edits', planError: 'The plan folder is not writable.' }
    expect(exitPlanModeOutputSchema.parse(failed)).toEqual(failed)
    expect(exitPlanModeOutputSchema.safeParse({ ...saved, planPath: '' }).success).toBe(false)
  })
})

describe('background tasks and their results (ADR-046)', () => {
  it('validates tasks, lists, params and task.changed', () => {
    expect(backgroundTaskSchema.parse(task)).toEqual(task)
    expect(backgroundTaskSchema.parse({ ...task, status: 'running', finishedAt: null, origin: 'task' }).origin).toBe('task')
    for (const change of [{ status: 'background' }, { status: 'queued' }, { id: 'bgt_short' }, { deliveredAt: undefined }, { origin: 'timer' }])
      expect(backgroundTaskSchema.safeParse({ ...task, ...change }).success, JSON.stringify(change)).toBe(false)
    expect(backgroundTaskListSchema.parse({ items: [task] }).items).toHaveLength(1)
    expect(backgroundTaskListSchema.safeParse({ items: Array.from({ length: LIMITS.backgroundTasksKeptPerChat + 1 }).fill(task) }).success).toBe(false)
    expect(chatTaskParamsSchema.parse({ id: CHAT_ID, taskId: TASK_ID })).toEqual({ id: CHAT_ID, taskId: TASK_ID })
    expect(chatTaskParamsSchema.safeParse({ id: CHAT_ID, taskId: 'x' }).success).toBe(false)
    const changed = { chatId: CHAT_ID, task }
    expect(taskChangedDataSchema.parse(changed)).toEqual(changed)
    expect(serverEventSchema.parse(createServerEvent('task.changed', taskChangedDataSchema.parse(changed), 4))).toEqual({ type: 'task.changed', data: changed, at: 4 })
  })

  it('validates data-task-result parts with the AI SDK, inside a reply and in a carrier message', async () => {
    const result = { taskId: TASK_ID, toolCallId: 'call_task_1', messageId: MESSAGE_A, output: { ...output, taskId: TASK_ID }, deliveredAt: 5 }
    expect(taskResultDataSchema.parse(result)).toEqual(result)
    const reply = {
      id: MESSAGE_B,
      role: 'assistant',
      metadata: { modelRef: 'mock:background', startedAt: 1 },
      parts: [{ type: 'step-start' }, { type: 'data-task-result', id: TASK_ID, data: result }, { type: 'text', text: 'Done.', state: 'done' }],
    }
    const carrier = { id: MESSAGE_A, role: 'user', metadata: { modelRef: 'mock:background', startedAt: 6 }, parts: [{ type: 'data-task-result', data: result }] }
    await expect(validate([carrier, reply])).resolves.toHaveLength(2)
    await expect(validate([{ ...carrier, parts: [{ type: 'data-task-result', data: { ...result, taskId: 'x' } }] }])).rejects.toThrow()
    type Part = HarnessUIMessage['parts'][number]
    expectTypeOf<Extract<Part, { type: 'data-task-result' }>['data']['taskId']>().toEqualTypeOf<string>()
  })

  it('carries the task origin of server-started turns', () => {
    const started = { chatId: CHAT_ID, messageId: MESSAGE_B, modelRef: 'mock:background', origin: 'task', userMessageId: MESSAGE_A }
    expect(runStartedDataSchema.parse(started)).toEqual(started)
  })
})

describe('catalog and personal definitions (ADR-044)', () => {
  const entry = {
    kind: 'agent',
    name: 'reviewer',
    description: 'Reviews diffs',
    source: 'project',
    path: '.harness/agents/reviewer.md',
    modelRef: 'inherit',
    tools: ['read_file', 'search_files'],
    enabled: true,
    state: 'active',
    diagnostics: [],
  } as const

  it('validates catalog entries, lists and queries', () => {
    expect(customizationEntrySchema.parse(entry)).toEqual(entry)
    const shadowed = { ...entry, path: '.claude/agents/reviewer.md', state: 'shadowed', shadowedBy: { source: 'project', path: '.harness/agents/reviewer.md' } }
    expect(customizationEntrySchema.parse(shadowed)).toEqual(shadowed)
    const command = { kind: 'command', name: 'greet', description: 'Greets', source: 'user', id: CUSTOMIZATION_ID, namespace: 'team', argumentHint: '<name>', modelRef: 'mock:echo', enabled: false, state: 'off', diagnostics: [] }
    expect(customizationEntrySchema.parse(command)).toEqual(command)
    const invalid = { ...entry, name: 'Bad Name', description: '', state: 'invalid', diagnostics: [{ level: 'error', code: 'invalid-name', message: 'Use a-z, 0-9 and "-".' }] }
    expect(customizationEntrySchema.parse(invalid).state).toBe('invalid')
    for (const change of [{ state: 'hidden' }, { modelRef: 'sonnet' }, { id: 'cus_short' }, { description: 'x'.repeat(1025) }, { argumentHint: 'x'.repeat(101) }, { tools: Array.from({ length: 65 }).fill('read_file') }])
      expect(customizationEntrySchema.safeParse({ ...entry, ...change }).success, JSON.stringify(change).slice(0, 60)).toBe(false)
    const list = {
      items: [entry],
      diagnostics: [{ level: 'warning', code: 'link', message: 'Skipped a link.', path: '.claude/agents/link.md' }],
      project: { id: PROJECT_ID, available: true, folders: ['.claude/agents', '.harness/agents'], scannedAt: 3 },
      builtAt: 3,
    }
    expect(customizationListSchema.parse(list)).toEqual(list)
    expect(customizationListSchema.parse({ ...list, project: null }).project).toBeNull()
    expect(customizationsQuerySchema.parse({ projectId: PROJECT_ID, kind: 'skill', refresh: '1' })).toEqual({ projectId: PROJECT_ID, kind: 'skill', refresh: true })
    expect(customizationsQuerySchema.parse({})).toEqual({})
    for (const query of [{ projectId: 'prj_short' }, { kind: 'hook' }, { refresh: 'yes' }])
      expect(customizationsQuerySchema.safeParse(query).success, JSON.stringify(query)).toBe(false)
  })

  it('lists output styles and user-invocable skills with their Phase 11 fields (ADR-051, ADR-052)', () => {
    const style = { kind: 'style', name: 'terse-reviews', label: 'Terse Reviews', description: 'Short', source: 'project', path: '.harness/output-styles/terse.md', keepCodingInstructions: false, enabled: true, state: 'active', diagnostics: [] }
    expect(customizationEntrySchema.parse(style)).toEqual(style)
    const skill = { kind: 'skill', name: 'deploy', description: 'Deploys', source: 'project', argumentHint: '<env>', userInvocable: true, modelInvocable: false, enabled: true, state: 'active', diagnostics: [] }
    expect(customizationEntrySchema.parse(skill)).toEqual(skill)
    // Eight definition folders now (`output-styles` in both folders).
    const folders = ['agents', 'commands', 'skills', 'output-styles'].flatMap(name => [`.claude/${name}`, `.harness/${name}`])
    const scan = { id: PROJECT_ID, available: true, folders, scannedAt: 3 }
    expect(customizationListSchema.parse({ items: [style], diagnostics: [], project: scan, builtAt: 3 }).project?.folders).toHaveLength(8)
    expect(customizationListSchema.safeParse({ items: [], diagnostics: [], project: { ...scan, folders: [...folders, '.x'] }, builtAt: 3 }).success).toBe(false)
  })

  it('validates the source query and answer', () => {
    const query = { projectId: PROJECT_ID, kind: 'agent', name: 'reviewer', source: 'project', path: '.claude/agents/reviewer.md' }
    expect(customizationSourceQuerySchema.parse(query)).toEqual(query)
    expect(customizationSourceQuerySchema.parse({ kind: 'agent', name: 'explore', source: 'builtin' })).toMatchObject({ source: 'builtin' })
    for (const change of [{ kind: undefined }, { name: '' }, { source: 'home' }])
      expect(customizationSourceQuerySchema.safeParse({ ...query, ...change }).success, JSON.stringify(change)).toBe(false)
    expect(customizationSourceResultSchema.parse({ content: AGENT_MD, path: '.harness/agents/reviewer.md' })).toMatchObject({ content: AGENT_MD })
  })

  it('validates personal definitions, discriminated on kind', () => {
    const base = { id: CUSTOMIZATION_ID, name: 'reviewer', description: 'Reviews diffs', content: AGENT_MD, enabled: true, diagnostics: [], createdAt: 1, updatedAt: 2 }
    const agent = { ...base, kind: 'agent', fields: { name: 'reviewer', description: 'Reviews diffs', tools: ['read_file', 'search_files'], model: null, instructions: 'Review the diff.\n' } }
    expect(customizationSchema.parse(agent)).toEqual(agent)
    const command = { ...base, kind: 'command', name: 'greet', fields: { name: 'greet', description: 'Greets', argumentHint: '<name>', model: 'mock:echo', allowedTools: null, body: 'Say hi to $ARGUMENTS' } }
    expect(customizationSchema.parse(command)).toEqual(command)
    const skill = { ...base, kind: 'skill', name: 'pdf', fields: null }
    expect(customizationSchema.parse(skill)).toEqual(skill)
    // Phase 11: skill keys and the style kind.
    const deploy = { ...base, kind: 'skill', name: 'deploy', fields: { name: 'deploy', description: 'Deploys', content: 'Deploy $ARGUMENTS.', userInvocable: true, modelInvocable: false, argumentHint: '<env>' } }
    expect(customizationSchema.parse(deploy)).toEqual(deploy)
    const style = { ...base, kind: 'style', name: 'terse', fields: { name: 'terse', label: 'Terse', description: 'Short', keepCodingInstructions: false, content: 'Be brief.' } }
    expect(customizationSchema.parse(style)).toEqual(style)
    expect(customizationSchema.safeParse({ ...style, fields: deploy.fields }).success).toBe(false)
    // The fields must fit the kind.
    expect(customizationSchema.safeParse({ ...command, kind: 'agent' }).success).toBe(false)
    expect(customizationSchema.safeParse({ ...agent, id: 'cus_short' }).success).toBe(false)
    expectTypeOf<Extract<Customization, { kind: 'command' }>['fields']>().toEqualTypeOf<z.infer<typeof commandDefinitionFieldsSchema> | null>()
  })

  it('mirrors the parsed field interfaces of util/definitions.ts', () => {
    expectTypeOf<Readonly<z.infer<typeof agentDefinitionFieldsSchema>>>().toEqualTypeOf<AgentDefinitionFields>()
    expectTypeOf<Readonly<z.infer<typeof commandDefinitionFieldsSchema>>>().toEqualTypeOf<CommandDefinitionFields>()
    expectTypeOf<Readonly<z.infer<typeof skillDefinitionFieldsSchema>>>().toEqualTypeOf<SkillDefinitionFields>()
    // Phase 11 (ADR-051): output styles.
    expectTypeOf<Readonly<z.infer<typeof styleDefinitionFieldsSchema>>>().toEqualTypeOf<StyleDefinitionFields>()
    // The parsed fields of `parseDefinition` can be sent as they are.
    expectTypeOf<AgentDefinitionFields>().toExtend<z.infer<typeof agentDefinitionFieldsSchema>>()
    expectTypeOf<CommandDefinitionFields>().toExtend<z.infer<typeof commandDefinitionFieldsSchema>>()
  })

  it('validates create and update bodies (strict, at most 64 KiB of UTF-8)', () => {
    expect(customizationCreateSchema.parse({ kind: 'agent', content: AGENT_MD })).toEqual({ kind: 'agent', content: AGENT_MD })
    expect(customizationCreateSchema.parse({ kind: 'skill', content: 'x'.repeat(DEFINITION_LIMITS.contentBytes), enabled: false }).enabled).toBe(false)
    for (const body of [
      { kind: 'agent', content: '' },
      { kind: 'agent', content: 'é'.repeat(DEFINITION_LIMITS.contentBytes / 2 + 1) },
      { kind: 'hook', content: AGENT_MD },
      { kind: 'agent', content: AGENT_MD, name: 'reviewer' },
      { content: AGENT_MD },
    ])
      expect(customizationCreateSchema.safeParse(body).success, JSON.stringify(body).slice(0, 60)).toBe(false)
    expect(customizationUpdateSchema.parse({ enabled: false })).toEqual({ enabled: false })
    expect(customizationUpdateSchema.parse({ content: AGENT_MD })).toEqual({ content: AGENT_MD })
    for (const body of [{}, { kind: 'agent' }, { enabled: 'no' }, { content: '' }])
      expect(customizationUpdateSchema.safeParse(body).success, JSON.stringify(body)).toBe(false)
    expect(customizationParamsSchema.parse({ id: CUSTOMIZATION_ID })).toEqual({ id: CUSTOMIZATION_ID })
    expect(customizationParamsSchema.safeParse({ id: 'source' }).success).toBe(false)
  })

  it('carries customization.changed', () => {
    for (const data of [{}, { kind: 'agent', id: CUSTOMIZATION_ID }, { projectId: PROJECT_ID }])
      expect(serverEventSchema.parse(createServerEvent('customization.changed', customizationChangedDataSchema.parse(data), 2))).toEqual({ type: 'customization.changed', data, at: 2 })
    expect(customizationChangedDataSchema.safeParse({ id: 'x' }).success).toBe(false)
  })
})

describe('commands (ADR-045)', () => {
  it('lists commands with their source; pluginId is optional', () => {
    const plugin = { name: 'tldr', description: 'Summarize', source: 'plugin', pluginId: 'acme' }
    expect(commandSummarySchema.parse(plugin)).toEqual(plugin)
    const file = { name: 'greet', description: 'Greets', source: 'project', namespace: 'team', argumentHint: '<name>', modelRef: 'mock:echo' }
    expect(commandSummarySchema.parse(file)).toEqual(file)
    expect(commandSummarySchema.parse({ name: 'compact', description: 'Summarize', source: 'harness', pluginId: 'core-agent' }).source).toBe('harness')
    for (const change of [{ source: undefined }, { source: 'builtin' }, { modelRef: 'sonnet' }, { argumentHint: 'x'.repeat(101) }])
      expect(commandSummarySchema.safeParse({ ...file, ...change }).success, JSON.stringify(change)).toBe(false)
    expect(commandsQuerySchema.parse({ projectId: PROJECT_ID })).toEqual({ projectId: PROJECT_ID })
    expect(commandsQuerySchema.parse({})).toEqual({})
    expect(commandsQuerySchema.safeParse({ projectId: 'none' }).success).toBe(false)
  })

  it('stores the source, model and allowed tools of a command invocation (v1.5 invocations parse)', () => {
    const v15 = { name: 'review', input: 'x', type: 'prompt', expansion: 'Review x' }
    expect(commandInvocationSchema.parse(v15)).toEqual(v15)
    const v16 = { ...v15, source: 'project', modelRef: 'mock:agents', allowedTools: ['read_file', 'mcp__github__*'] }
    expect(commandInvocationSchema.parse(v16)).toEqual(v16)
    for (const change of [{ source: 'builtin' }, { modelRef: 'opus' }, { allowedTools: Array.from({ length: 65 }).fill('read_file') }, { allowedTools: [''] }])
      expect(commandInvocationSchema.safeParse({ ...v16, ...change }).success, JSON.stringify(change).slice(0, 60)).toBe(false)
  })

  it('refuses /remember as a plugin command name', () => {
    expect(declarativeCommandSchema.safeParse({ name: 'remember', description: 'Remember', template: '{{input}}' }).success).toBe(false)
    expect(declarativeCommandSchema.safeParse({ name: 'recall', description: 'Recall', template: '{{input}}' }).success).toBe(true)
  })
})

describe('plugin API 1.4.0 manifests (ADR-045)', () => {
  const base = { manifestVersion: 1, id: 'agent-pack', name: 'Agent pack', version: '1.0.0', engines: { harness: '^1.4.0' } } as const
  const agent = { name: 'reviewer', description: 'Reviews diffs', instructions: 'Review the diff.', tools: ['read_file', 'mcp__github__*'], model: 'inherit' }
  const skill = { name: 'release-notes', description: 'Write release notes', content: '# Steps' }

  it('declares agents and skills', () => {
    const manifest = { ...base, contributes: { agents: [agent], skills: [skill] } }
    expect(pluginManifestSchema.parse(manifest)).toEqual(manifest)
    expect(declarativeAgentSchema.parse({ name: 'tester', description: 'Tests', instructions: 'Run the tests.' })).toMatchObject({ name: 'tester' })
    expect(declarativeSkillSchema.parse(skill)).toEqual(skill)
  })

  it('refuses reserved, malformed and duplicate agents and skills', () => {
    for (const change of [
      { name: 'explore' },
      { name: 'general' },
      { name: 'general-purpose' },
      { name: 'Reviewer' },
      { description: '' },
      { description: 'x'.repeat(1025) },
      { instructions: '' },
      { instructions: 'x'.repeat(LIMITS.customizationContentBytes + 1) },
      { tools: ['read file'] },
      { tools: ['read_*'] },
      { tools: ['read_file', 'read_file'] },
      { model: 'sonnet' },
      { color: 'red' },
    ])
      expect(declarativeAgentSchema.safeParse({ ...agent, ...change }).success, JSON.stringify(change).slice(0, 60)).toBe(false)
    for (const change of [{ name: 'Release Notes' }, { content: '' }, { content: 'x'.repeat(LIMITS.customizationContentBytes + 1) }])
      expect(declarativeSkillSchema.safeParse({ ...skill, ...change }).success, JSON.stringify(change).slice(0, 60)).toBe(false)
    const duplicates = pluginManifestSchema.safeParse({ ...base, contributes: { agents: [agent, agent], skills: [skill, skill] } })
    expect(duplicates.error?.issues.map(issue => issue.path.join('.'))).toEqual(['contributes.agents.1.name', 'contributes.skills.1.name'])
    const many = pluginManifestSchema.safeParse({ ...base, contributes: { agents: Array.from({ length: 51 }, (_, index) => ({ ...agent, name: `a${index}` })) } })
    expect(many.success).toBe(false)
  })

  it('still parses 1.3.0 manifests and summarizes agents and skills in contributions', () => {
    const v13 = { ...base, id: 'old-pack', engines: { harness: '^1.3.0' }, contributes: { commands: [{ name: 'tldr', description: 'Summarize', template: 'Summarize: {{input}}' }] } }
    expect(pluginManifestSchema.parse(v13)).toEqual(v13)
    const contributions = { providers: [], models: 0, tools: [], mcpServers: [], commands: ['tldr'], hooks: [], agents: ['reviewer'], skills: ['release-notes'], commandHooks: 0, outputStyles: [] }
    expect(pluginContributionsSchema.parse(contributions)).toEqual(contributions)
    expect(pluginContributionsSchema.safeParse({ ...contributions, agents: ['Bad'] }).success).toBe(false)
  })
})

describe('backups (ADR-024 amendment) and Remember (ADR-047)', () => {
  it('carries customizations.json in backups (older manifests parse)', () => {
    const v15 = { format: 'harness-forge.backup', version: 1, exportedAt: 1, appVersion: '1.5.0', chatExportVersion: 2, includes: { files: true, settings: true }, counts: { chats: 1, messages: 2, files: 0, fileBytes: 0 } }
    expect(backupManifestSchema.parse(v15)).toEqual(v15)
    const v16 = { ...v15, appVersion: '1.6.0', includes: { ...v15.includes, customizations: true }, counts: { ...v15.counts, customizations: 2 } }
    expect(backupManifestSchema.parse(v16)).toEqual(v16)
    const items = [{ kind: 'agent', name: 'reviewer', content: AGENT_MD, enabled: true }, { kind: 'command', name: 'greet', content: '---\ndescription: Greets\n---\nHi $ARGUMENTS', enabled: false }]
    expect(backupCustomizationsSchema.parse({ items })).toEqual({ items })
    expect(backupCustomizationsSchema.safeParse({ items: [{ ...items[0], kind: 'hook' }] }).success).toBe(false)
    // Phase 11: personal output styles travel here too (4 kinds x 200).
    const style = { kind: 'style', name: 'terse', content: '---\ndescription: Short\n---\nBe brief.', enabled: true }
    expect(backupCustomizationsSchema.parse({ items: [style] })).toEqual({ items: [style] })
    expect(backupCustomizationsSchema.safeParse({ items: Array.from({ length: 801 }).fill(items[0]) }).success).toBe(false)
    expect(dataExportQuerySchema.parse({ customizations: 'false' })).toEqual({ customizations: false })
    expect(dataImportFormSchema.parse({ restoreSettings: 'true', restoreCustomizations: '1' })).toEqual({ restoreSettings: true, restoreCustomizations: true })
    const result = { kind: 'backup', counts: { imported: 1, copied: 0, skipped: 0, failed: 0, filesImported: 0, filesReused: 0, filesMissing: 0 }, settingsRestored: false, items: [], warnings: [] }
    expect(dataImportResultSchema.parse(result)).toEqual(result)
    expect(dataImportResultSchema.parse({ ...result, customizations: { imported: 1, skipped: 1, failed: 0 } }).customizations).toEqual({ imported: 1, skipped: 1, failed: 0 })
  })

  it('validates Remember bodies: strict, trimmed, project targets need the chat', () => {
    expect(rememberBodySchema.parse({ target: 'global', text: '  Use pnpm.  ' })).toEqual({ target: 'global', text: 'Use pnpm.' })
    expect(rememberBodySchema.parse({ target: 'project-file', text: 'Use pnpm.', chatId: CHAT_ID })).toMatchObject({ chatId: CHAT_ID })
    for (const body of [
      { target: 'project-file', text: 'x' },
      { target: 'project-instructions', text: 'x' },
      { target: 'global', text: '   ' },
      { target: 'global', text: 'x'.repeat(LIMITS.rememberTextMaxChars + 1) },
      { target: 'project', text: 'x', chatId: CHAT_ID },
      { target: 'global', text: 'x', projectId: PROJECT_ID },
    ])
      expect(rememberBodySchema.safeParse(body).success, JSON.stringify(body).slice(0, 60)).toBe(false)
    expect(rememberBodySchema.safeParse({ target: 'project-file', text: 'x' }).error?.issues[0]?.path).toEqual(['chatId'])
  })

  it('validates Remember results', () => {
    expect(rememberResultSchema.parse({ target: 'project-file', file: 'AGENTS.md', created: true })).toEqual({ target: 'project-file', file: 'AGENTS.md', created: true })
    expect(rememberResultSchema.parse({ target: 'global', settings: DEFAULT_SETTINGS }).settings).toEqual(DEFAULT_SETTINGS)
    expect(rememberResultSchema.safeParse({ target: 'project-file', file: 'README.md' }).success).toBe(false)
  })
})

describe('v1.5 data keeps parsing', () => {
  it('a v1.5 task part (type explore / general, no new fields)', async () => {
    const v15Output = { status: 'completed', type: 'explore', description: 'Map the repo', modelRef: 'mock:subagent', steps: [], stepsOmitted: 0, report: 'Done.', startedAt: 1, finishedAt: 2 }
    expect(taskOutputSchema.parse(v15Output)).toEqual(v15Output)
    expect(taskOutputSchema.parse({ ...v15Output, type: 'general', status: 'limit' }).type).toBe('general')
    const reply = {
      id: MESSAGE_B,
      role: 'assistant',
      metadata: { modelRef: 'mock:subagent', startedAt: 1 },
      parts: [
        { type: 'step-start' },
        { type: 'tool-task', toolCallId: 'call_task_1', state: 'output-available', input: { description: 'Map the repo', prompt: 'List the packages.', type: 'explore' }, output: v15Output },
        { type: 'text', text: 'Mapped.', state: 'done' },
      ],
    }
    await expect(validate([reply])).resolves.toHaveLength(1)
    expect(taskInputSchema.parse({ description: 'Map the repo', prompt: 'List the packages.', type: 'general' })).toEqual({ description: 'Map the repo', prompt: 'List the packages.', type: 'general' })
  })
})
