// Phase 9 contracts (ADR-040 … ADR-043): agent tools, the new data parts, the steer queue, file mentions, the
// `queue.changed` event, and the v1.4 shapes that must keep parsing.
import type { HarnessUIMessage } from '../chat.ts'
import type { QueueMessage } from './queue.ts'
import { validateUIMessages } from 'ai'
import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  activityDataSchema,
  chatStopResultSchema,
  commandInvocationSchema,
  compactionDataSchema,
  harnessDataSchemas,
  messageMetadataSchema,
  noticeCodeSchema,
  steerDataSchema,
} from '../chat.ts'
import { taskTypeSchema, todoStatusSchema, toolModeSchema } from '../enums.ts'
import { conflictReasonSchema, HARNESS_ERROR_CODES } from '../errors.ts'
import { createServerEvent, runStartedDataSchema, serverEventSchema } from '../events.ts'
import { LIMITS } from '../limits.ts'
import { MENTION_QUERY_MAX_CHARS } from '../util/mentions.ts'
import {
  AGENT_TOOL_NAMES,
  AGENT_TOOL_SCHEMAS,
  exitPlanModeInputSchema,
  exitPlanModeOutputSchema,
  taskInputSchema,
  taskOutputSchema,
  todoItemSchema,
  todoWriteInputSchema,
  todoWriteOutputSchema,
} from './agent.ts'
import { chatExportAnySchema } from './chats.ts'
import { chatQueueItemParamsSchema } from './params.ts'
import { projectFileAttachBodySchema, projectFileSearchSchema, projectFilesQuerySchema } from './project-files.ts'
import { queueAddBodySchema, queueChangedDataSchema, queueItemSchema, queueListSchema, queueRemovalSchema } from './queue.ts'
import { shellToolOutputSchema } from './workspace.ts'

const CHAT_ID = '0199a8f0-0000-7000-8000-000000000001'
const MESSAGE_A = 'msg_A000000000000001'
const MESSAGE_B = 'msg_B000000000000001'
const FILE_URL = '/api/files/file_ABCdef0123456789'
const TODO = { id: 't1', content: 'Run the tests', status: 'in_progress', activeForm: 'Running the tests' } as const

async function validate(messages: unknown[]): Promise<HarnessUIMessage[]> {
  return validateUIMessages<HarnessUIMessage>({ messages, metadataSchema: messageMetadataSchema, dataSchemas: harnessDataSchemas })
}

describe('enums (Phase 9)', () => {
  it('adds the plan mode in UI order, todo statuses and task types', () => {
    expect(toolModeSchema.options).toEqual(['off', 'ask', 'edits', 'plan', 'auto'])
    expect(todoStatusSchema.options).toEqual(['pending', 'in_progress', 'completed'])
    expect(taskTypeSchema.options).toEqual(['explore', 'general'])
    // Phase 10 adds `command-model-unavailable` (8 codes), Phase 11 three more (11).
    expect(noticeCodeSchema.options).toHaveLength(11)
    expect(noticeCodeSchema.options).toContain('compaction-failed')
    expect(commandInvocationSchema.parse({ name: 'compact', input: 'tests', type: 'compact' }).type).toBe('compact')
    // The error codes stay 16; the queue conflicts are reasons.
    expect(HARNESS_ERROR_CODES).toHaveLength(16)
    expect(conflictReasonSchema.options).toEqual(expect.arrayContaining(['run-idle', 'queue-full']))
    // Phase 11 adds `hook-blocked` and `untrusted` (14).
    expect(conflictReasonSchema.options).toHaveLength(14)
  })

  it('declares the Phase 9 limits', () => {
    expect(LIMITS).toMatchObject({
      compactionSummaryMaxChars: 60_000,
      compactFocusMaxChars: 1000,
      compactionsPerRunMax: 10,
      todoItemsMax: 50,
      planMaxChars: 50_000,
      approvalReasonMaxChars: 2000,
      taskPromptMaxChars: 20_000,
      taskReportMaxChars: 32_000,
      taskStepsShownMax: 50,
      subagentParallelMax: 3,
      subagentsPerRunMax: 20,
      subagentTimeoutMs: 570_000,
      queueItemsMax: 10,
      queueItemBytes: 262_144,
      mentionQueryMaxChars: 256,
      mentionResultsMax: 50,
      mentionFileMaxBytes: 5_242_880,
      mentionIndexFilesMax: 50_000,
      mentionIndexTtlMs: 30_000,
    })
  })
})

describe('agent tools (ADR-041, ADR-043)', () => {
  it('names the core-agent tools and maps their schemas', () => {
    // Phase 10 (ADR-045) adds `skill`.
    expect(AGENT_TOOL_NAMES).toEqual(['todo_write', 'exit_plan_mode', 'task', 'skill'])
    expect(Object.keys(AGENT_TOOL_SCHEMAS)).toEqual([...AGENT_TOOL_NAMES])
  })

  it('validates todo_write lists: at most 50 items with unique ids', () => {
    expect(todoWriteInputSchema.parse({ todos: [TODO, { id: 't2', content: 'Fix', status: 'pending' }] }).todos).toHaveLength(2)
    expect(todoWriteInputSchema.parse({ todos: [] }).todos).toEqual([])
    const many = Array.from({ length: LIMITS.todoItemsMax + 1 }, (_, index) => ({ id: `t${index}`, content: 'x', status: 'pending' }))
    expect(todoWriteInputSchema.safeParse({ todos: many }).success).toBe(false)
    expect(todoWriteInputSchema.safeParse({ todos: many.slice(0, LIMITS.todoItemsMax) }).success).toBe(true)
    const duplicate = todoWriteInputSchema.safeParse({ todos: [TODO, { ...TODO, content: 'Again' }] })
    expect(duplicate.success).toBe(false)
    expect(duplicate.error?.issues[0]?.message).toBe('Todo ids must be unique.')
    for (const item of [
      { ...TODO, id: '' },
      { ...TODO, id: 'x'.repeat(65) },
      { ...TODO, content: '' },
      { ...TODO, content: 'x'.repeat(501) },
      { ...TODO, status: 'done' },
      { ...TODO, activeForm: 'x'.repeat(201) },
    ])
      expect(todoItemSchema.safeParse(item).success, JSON.stringify(item).slice(0, 80)).toBe(false)
    const output = { todos: [TODO], counts: { pending: 0, inProgress: 1, completed: 0, total: 1 } }
    expect(todoWriteOutputSchema.parse(output)).toEqual(output)
    expect(todoWriteOutputSchema.safeParse({ ...output, counts: { ...output.counts, total: -1 } }).success).toBe(false)
  })

  it('validates exit_plan_mode', () => {
    expect(exitPlanModeInputSchema.parse({ plan: '# Plan\n\n1. Read' }).plan).toContain('Plan')
    expect(exitPlanModeInputSchema.safeParse({ plan: '' }).success).toBe(false)
    expect(exitPlanModeInputSchema.safeParse({ plan: 'x'.repeat(LIMITS.planMaxChars + 1) }).success).toBe(false)
    expect(exitPlanModeOutputSchema.parse({ approved: true, mode: 'edits' })).toEqual({ approved: true, mode: 'edits' })
    for (const output of [{ approved: false, mode: 'edits' }, { approved: true, mode: 'auto' }, { approved: true, mode: 'plan' }])
      expect(exitPlanModeOutputSchema.safeParse(output).success, JSON.stringify(output)).toBe(false)
  })

  it('validates task inputs and outputs', () => {
    const input = { description: 'Map the repo', prompt: 'List the packages.', type: 'explore' }
    expect(taskInputSchema.parse(input)).toEqual(input)
    // Phase 10 (ADR-045): any agent name passes the schema (the runner checks the catalog); not a malformed one.
    for (const change of [{ description: 'ab' }, { description: 'x'.repeat(81) }, { prompt: '' }, { prompt: 'x'.repeat(LIMITS.taskPromptMaxChars + 1) }, { type: 'nested agent' }, { type: 'code_review' }, { type: undefined }])
      expect(taskInputSchema.safeParse({ ...input, ...change }).success, JSON.stringify(change).slice(0, 80)).toBe(false)
    const output = {
      status: 'completed',
      type: 'general',
      description: 'Check the time',
      modelRef: 'mock:subagent',
      steps: [{ toolCallId: 'call_1', toolName: 'current_time', summary: 'current_time', state: 'done', resultPreview: '12:00' }],
      stepsOmitted: 0,
      report: 'It is noon.',
      usage: { inputTokens: 10, outputTokens: 5 },
      costUsd: 0.001,
      startedAt: 1,
      finishedAt: 2,
    }
    expect(taskOutputSchema.parse(output)).toEqual(output)
    // A preliminary snapshot: still running, no report yet.
    expect(taskOutputSchema.parse({ ...output, status: 'queued', steps: [], report: '', usage: undefined, costUsd: undefined, finishedAt: undefined }).status).toBe('queued')
    const steps = Array.from({ length: LIMITS.taskStepsShownMax + 1 }, (_, index) => ({ ...output.steps[0], toolCallId: `call_${index}` }))
    for (const change of [
      { status: 'done' },
      { steps },
      { stepsOmitted: -1 },
      { report: 'x'.repeat(LIMITS.taskReportMaxChars + 1) },
      { modelRef: 'no-colon' },
      { steps: [{ ...output.steps[0], state: 'skipped' }] },
      { steps: [{ ...output.steps[0], summary: 'x'.repeat(201) }] },
      { steps: [{ ...output.steps[0], resultPreview: 'x'.repeat(301) }] },
    ])
      expect(taskOutputSchema.safeParse({ ...output, ...change }).success, Object.keys(change).join()).toBe(false)
  })
})

describe('data parts (ADR-040, ADR-042)', () => {
  const compaction = {
    trigger: 'auto',
    keep: 'last-user',
    summary: '## Intent\nShip v1.5.',
    todos: [TODO],
    modelRef: 'mock:compact',
    messagesCompacted: 12,
    tokensBefore: 1800,
    tokensAfter: 300,
    createdAt: 5,
  } as const
  const steer = { id: MESSAGE_B, parts: [{ type: 'text', text: 'Also run lint.' }, { type: 'file', mediaType: 'text/plain', filename: 'a.txt', url: FILE_URL }], queuedAt: 3, deliveredAt: 4 }

  it('parses compaction, steer and activity data', () => {
    expect(compactionDataSchema.parse(compaction)).toEqual(compaction)
    expect(compactionDataSchema.parse({ ...compaction, trigger: 'manual', keep: 'none', focus: 'the tests', todos: undefined }).focus).toBe('the tests')
    for (const change of [
      { trigger: 'scheduled' },
      { keep: 'all' },
      { summary: 'x'.repeat(LIMITS.compactionSummaryMaxChars + 1) },
      { focus: 'x'.repeat(LIMITS.compactFocusMaxChars + 1) },
      { messagesCompacted: -1 },
      { tokensAfter: 1.5 },
      { createdAt: undefined },
      { modelRef: 'mock' },
    ])
      expect(compactionDataSchema.safeParse({ ...compaction, ...change }).success, Object.keys(change).join()).toBe(false)
    expect(steerDataSchema.parse(steer)).toEqual(steer)
    for (const change of [{ id: 'msg_short' }, { parts: [] }, { parts: [{ type: 'reasoning', text: 'x' }] }, { parts: [{ type: 'file', url: FILE_URL }] }, { deliveredAt: undefined }])
      expect(steerDataSchema.safeParse({ ...steer, ...change }).success, JSON.stringify(change)).toBe(false)
    expect(activityDataSchema.parse({ kind: 'compacting' })).toEqual({ kind: 'compacting' })
    expect(activityDataSchema.safeParse({ kind: 'thinking' }).success).toBe(false)
    // Phase 10 (ADR-046) adds `task-result`, Phase 11 (ADR-048) `hook`.
    expect(Object.keys(harnessDataSchemas)).toEqual(['notice', 'compaction', 'steer', 'activity', 'task-result', 'hook'])
  })

  it('validates the new parts with the AI SDK validateUIMessages', async () => {
    const reply = {
      id: MESSAGE_A,
      role: 'assistant',
      metadata: { modelRef: 'mock:compact', startedAt: 1 },
      parts: [
        { type: 'step-start' },
        { type: 'data-compaction', data: compaction },
        { type: 'text', text: 'Step 1 done.', state: 'done' },
        { type: 'data-steer', id: MESSAGE_B, data: steer },
        { type: 'step-start' },
        { type: 'data-notice', data: { level: 'warning', code: 'compaction-failed', message: 'Trimmed instead.' } },
      ],
    }
    await expect(validate([reply])).resolves.toHaveLength(1)
    await expect(validate([{ ...reply, parts: [{ type: 'data-compaction', data: { ...compaction, keep: 'all' } }] }])).rejects.toThrow()
    await expect(validate([{ ...reply, parts: [{ type: 'data-steer', data: { ...steer, parts: [] } }] }])).rejects.toThrow()
  })

  it('types the data parts of HarnessUIMessage', () => {
    type Part = HarnessUIMessage['parts'][number]
    expectTypeOf<Extract<Part, { type: 'data-compaction' }>['data']['keep']>().toEqualTypeOf<'none' | 'last-user'>()
    expectTypeOf<Extract<Part, { type: 'data-steer' }>['data']['id']>().toEqualTypeOf<string>()
    // Phase 11 (ADR-048) adds `hooks` ("Running hook…").
    expectTypeOf<Extract<Part, { type: 'data-activity' }>['data']['kind']>().toEqualTypeOf<'compacting' | 'idle' | 'hooks'>()
  })
})

describe('steer queue (ADR-042)', () => {
  const message = { id: MESSAGE_A, role: 'user', parts: [{ type: 'text', text: 'Also check the docs.' }, { type: 'file', mediaType: 'image/png', url: FILE_URL }] } as const
  const body = { message, modelRef: 'mock:steer', reasoningEffort: 'auto', toolMode: 'plan' } as const
  const item = { id: MESSAGE_A, message, modelRef: 'mock:steer', reasoningEffort: 'auto', toolMode: 'plan', createdAt: 7, turnOnly: false } as const

  it('validates add bodies: strict, a user message of text and file parts, at most 256 KiB', () => {
    expect(queueAddBodySchema.parse(body)).toEqual(body)
    for (const change of [
      { extra: 1 },
      { message: { ...message, role: 'assistant' } },
      { message: { ...message, id: 'client-id' } },
      { message: { ...message, parts: [] } },
      { message: { ...message, parts: [{ type: 'tool-x', input: {} }] } },
      { message: { ...message, parts: [{ type: 'text', text: 'x'.repeat(LIMITS.queueItemBytes) }] } },
      { modelRef: 'mock' },
      { toolMode: 'yolo' },
      { reasoningEffort: undefined },
    ])
      expect(queueAddBodySchema.safeParse({ ...body, ...change }).success, Object.keys(change).join()).toBe(false)
    // Unknown fields of the message and its parts are dropped (the server normalizes the parts anyway).
    const loose = queueAddBodySchema.parse({ ...body, message: { ...message, metadata: { x: 1 }, parts: [{ type: 'text', text: 'hi', state: 'done' }] } })
    expect(loose.message).toEqual({ id: MESSAGE_A, role: 'user', parts: [{ type: 'text', text: 'hi' }] })
  })

  it('validates items, lists, removals and the stop result', () => {
    expect(queueItemSchema.parse(item)).toEqual(item)
    expect(queueItemSchema.safeParse({ ...item, id: MESSAGE_B }).success).toBe(false)
    expect(queueItemSchema.safeParse({ ...item, turnOnly: undefined }).success).toBe(false)
    expect(queueListSchema.parse({ items: [item] }).items).toHaveLength(1)
    expect(queueListSchema.safeParse({ items: Array.from({ length: LIMITS.queueItemsMax + 1 }).fill(item) }).success).toBe(false)
    expect(queueRemovalSchema.parse({ id: MESSAGE_A, reason: 'failed', error: 'The model is unavailable.' }).reason).toBe('failed')
    expect(queueRemovalSchema.safeParse({ id: MESSAGE_A, reason: 'expired' }).success).toBe(false)
    expect(chatQueueItemParamsSchema.parse({ id: CHAT_ID, itemId: MESSAGE_A })).toEqual({ id: CHAT_ID, itemId: MESSAGE_A })
    expect(chatQueueItemParamsSchema.safeParse({ id: CHAT_ID, itemId: 'q1' }).success).toBe(false)
    // `dropped` is optional: a v1.4 stop result still parses.
    expect(chatStopResultSchema.parse({ stopped: true })).toEqual({ stopped: true })
    expect(chatStopResultSchema.parse({ stopped: true, dropped: [item] }).dropped).toEqual([item])
    // A queued message is assignable to a harness UI message (the web restores it into the composer).
    expectTypeOf<QueueMessage>().toExtend<HarnessUIMessage>()
  })

  it('carries queue.changed and the origin of run.started', () => {
    const data = { chatId: CHAT_ID, items: [item], removed: [{ id: MESSAGE_B, reason: 'delivered' }] }
    expect(queueChangedDataSchema.parse(data)).toEqual(data)
    expect(serverEventSchema.parse(createServerEvent('queue.changed', { chatId: CHAT_ID, items: [] }, 3))).toEqual({ type: 'queue.changed', data: { chatId: CHAT_ID, items: [] }, at: 3 })
    expect(serverEventSchema.safeParse({ type: 'queue.changed', data: { chatId: CHAT_ID }, at: 3 }).success).toBe(false)
    const started = { chatId: CHAT_ID, messageId: MESSAGE_B, modelRef: 'mock:steer' }
    // A v1.4 `run.started` (no origin) still parses.
    expect(runStartedDataSchema.parse(started)).toEqual(started)
    expect(runStartedDataSchema.parse({ ...started, origin: 'queue', userMessageId: MESSAGE_A })).toMatchObject({ origin: 'queue', userMessageId: MESSAGE_A })
    expect(runStartedDataSchema.safeParse({ ...started, origin: 'timer' }).success).toBe(false)
    expect(runStartedDataSchema.safeParse({ ...started, userMessageId: 'msg_short' }).success).toBe(false)
  })
})

describe('project files (ADR-042)', () => {
  it('validates the search query with defaults and coercion', () => {
    expect(projectFilesQuerySchema.parse({})).toEqual({ q: '', limit: 50 })
    expect(projectFilesQuerySchema.parse({ q: 'pars', limit: '10' })).toEqual({ q: 'pars', limit: 10 })
    // Every query the composer's `@` token can produce is accepted.
    expect(LIMITS.mentionQueryMaxChars).toBe(MENTION_QUERY_MAX_CHARS)
    expect(projectFilesQuerySchema.parse({ q: 'x'.repeat(LIMITS.mentionQueryMaxChars) }).q).toHaveLength(256)
    for (const query of [{ q: 'x'.repeat(LIMITS.mentionQueryMaxChars + 1) }, { limit: '0' }, { limit: '51' }, { limit: 'ten' }, { limit: 2.5 }])
      expect(projectFilesQuerySchema.safeParse(query).success, JSON.stringify(query)).toBe(false)
  })

  it('validates search results and attach bodies', () => {
    const result = { items: [{ path: 'src', kind: 'dir' }, { path: 'src/parser.ts', kind: 'file' }], truncated: false, indexedAt: 9 }
    expect(projectFileSearchSchema.parse(result)).toEqual(result)
    expect(projectFileSearchSchema.safeParse({ ...result, items: [{ path: 'a', kind: 'symlink' }] }).success).toBe(false)
    expect(projectFileSearchSchema.safeParse({ ...result, items: Array.from({ length: 51 }).fill(result.items[1]) }).success).toBe(false)
    expect(projectFileAttachBodySchema.parse({ path: 'src/parser.ts' })).toEqual({ path: 'src/parser.ts' })
    for (const body of [{}, { path: '' }, { path: 'a\u0000b' }, { path: 'a.ts', extra: 1 }])
      expect(projectFileAttachBodySchema.safeParse(body).success, JSON.stringify(body)).toBe(false)
  })
})

describe('v1.4 data keeps parsing', () => {
  const v14Reply = {
    id: MESSAGE_B,
    role: 'assistant',
    metadata: { modelRef: 'mock:checkpoint', startedAt: 2, finishedAt: 3, usage: { inputTokens: 5, outputTokens: 2, contextTokens: 7 }, finishReason: 'stop' },
    parts: [
      { type: 'step-start' },
      { type: 'data-notice', data: { level: 'info', code: 'context-trimmed', message: 'Older messages were left out.' } },
      { type: 'tool-write_file', toolCallId: 'call_1', state: 'output-available', input: { path: 'checkpoint.txt', content: 'Turn 1' }, output: { path: 'checkpoint.txt', created: true } },
      { type: 'text', text: 'Checkpoint done.', state: 'done' },
    ],
  }
  const v14User = { id: MESSAGE_A, role: 'user', metadata: { modelRef: 'mock:checkpoint', startedAt: 1, command: { name: 'review', input: 'x', type: 'prompt', expansion: 'Review x' } }, parts: [{ type: 'text', text: '/review x' }] }

  it('a v1.4 message (old parts and metadata)', async () => {
    await expect(validate([v14User, v14Reply])).resolves.toHaveLength(2)
  })

  it('a v1.4 shell output (with and without the Phase 8 fields)', () => {
    const output = { command: 'ls', cwd: '.', exitCode: 0, signal: null, timedOut: false, durationMs: 12, stdout: 'a\n', stderr: '', stdoutBytes: 2, stderrBytes: 0 }
    expect(shellToolOutputSchema.parse(output)).toEqual(output)
    const v14 = { ...output, endCwd: 'mock-dir', allowedBy: ['ls'] }
    expect(shellToolOutputSchema.parse(v14)).toEqual(v14)
  })

  it('a v1.4 chat export (version 2)', () => {
    const chat = {
      id: CHAT_ID,
      title: 'Checkpoints',
      titleSource: 'auto',
      modelRef: 'mock:checkpoint',
      pinned: false,
      archived: false,
      running: false,
      pendingApproval: false,
      createdAt: 1,
      updatedAt: 3,
      settings: { toolMode: 'edits' },
      totals: { inputTokens: 5, outputTokens: 2, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null },
      messages: [v14User, v14Reply],
      parentIds: [null, MESSAGE_A],
      activeLeafId: MESSAGE_B,
    }
    const exported = { format: 'harness-forge.chat', version: 2, exportedAt: 4, chat }
    expect(chatExportAnySchema.parse(exported)).toEqual(exported)
  })
})
