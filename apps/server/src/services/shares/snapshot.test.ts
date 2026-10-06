import type { HarnessUIMessage, ShareOptions } from '@harness-forge/shared'
import type { RenderContext } from './snapshot.ts'
import { Buffer } from 'node:buffer'
import { LIMITS, shareMessageSchema, shareSnapshotSchema } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import {
  capToolValue,
  clipText,
  rasterDataUrlType,
  renderShareMessages,
  sanitizeSnapshot,
  SHARE_TRUNCATION_MARKER,
  shareableMessageCount,
  snapshotBytes,
  snapshotTitle,
} from './snapshot.ts'

const FILE_A = 'file_AAAAAAAAAAAAAAA1'
const FILE_B = 'file_BBBBBBBBBBBBBBB2'
const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgo='
const SVG_DATA_URL = 'data:image/svg+xml;base64,PHN2Zz48c2NyaXB0Lz48L3N2Zz4='
const APP_FILE_URL = /^\/api\/files\/(file_[\dA-Z]{16})$/i

/** `FilesService.idFromUrl`. */
function fileIdOf(url: string): string | null {
  return url.match(APP_FILE_URL)?.[1] ?? null
}

function message(id: number, role: HarnessUIMessage['role'], parts: unknown[], metadata?: unknown): HarnessUIMessage {
  return { id: `msg_${String(id).padStart(16, '0')}`, role, ...(metadata === undefined ? {} : { metadata }), parts } as HarnessUIMessage
}

/** A path with every kind of part and metadata the sanitizer must keep or drop. */
function kitchenSink(): HarnessUIMessage[] {
  return [
    message(1, 'system', [{ type: 'text', text: 'SYSTEM PROMPT: be terse' }]),
    message(2, 'user', [
      { type: 'text', text: 'Please review this', providerMetadata: { openai: { itemId: 'PROVIDER-ITEM' } } },
      { type: 'file', mediaType: 'image/png', filename: 'dot\u202E\u0007.png', url: `/api/files/${FILE_A}`, providerReference: { openai: 'PROVIDER-REF' } },
      { type: 'file', mediaType: 'image/png', filename: 'remote.png', url: 'https://evil.example/pixel.png' },
      { type: 'file', mediaType: 'image/svg+xml', url: SVG_DATA_URL },
      { type: 'file', mediaType: 'application/pdf', url: 'data:application/pdf;base64,JVBERi0=' },
      { type: 'file', mediaType: 'image/png', url: PNG_DATA_URL },
      { type: 'file', mediaType: 'image/png', url: `/api/files/${FILE_A}` },
    ], {
      modelRef: 'mock:echo',
      startedAt: 1,
      command: { name: 'review', input: 'COMMAND-INPUT', type: 'prompt', expansion: 'SECRET EXPANSION TEXT' },
    }),
    message(3, 'assistant', [
      { type: 'step-start' },
      { type: 'reasoning', text: 'Let me think', state: 'done', providerMetadata: { anthropic: { signature: 'PROVIDER-SIGNATURE' } } },
      { type: 'reasoning', text: '', providerMetadata: { openai: { encrypted: 'ENCRYPTED-REASONING' } } },
      { type: 'text', text: 'Here is my review', state: 'done' },
      {
        type: 'tool-web_fetch',
        toolCallId: 'call_1',
        title: 'TOOL-TITLE',
        state: 'output-available',
        input: { url: 'https://nuxt.com/docs' },
        output: { status: 200, body: 'docs' },
        callProviderMetadata: { openai: { id: 'CALL-METADATA' } },
        resultProviderMetadata: { openai: { id: 'RESULT-METADATA' } },
        approval: { id: 'appr_1', approved: true, reason: 'APPROVAL-REASON', signature: 'APPROVAL-SIGNATURE' },
      },
      { type: 'dynamic-tool', toolName: 'mcp__docs__search', toolCallId: 'call_2', state: 'output-error', input: { q: 'nuxt' }, errorText: 'The server failed' },
      { type: 'tool-current_time', toolCallId: 'call_3', state: 'output-denied', input: {}, approval: { id: 'appr_3', approved: false, reason: 'DENIAL-REASON' } },
      { type: 'tool-shell', toolCallId: 'call_4', state: 'approval-requested', input: { command: 'ls' }, approval: { id: 'appr_4' } },
      { type: 'tool-', toolCallId: 'call_5', state: 'output-available', input: {}, output: 'nameless' },
      { type: 'dynamic-tool', toolName: 'bad name!', toolCallId: 'call_6', state: 'output-available', input: {}, output: 1 },
      { type: 'source-url', sourceId: 'src_1', url: 'https://nuxt.com/docs', title: 'Nuxt docs', providerMetadata: { x: 'SOURCE-METADATA' } },
      { type: 'source-url', sourceId: 'src_2', url: 'javascript:alert(1)' },
      { type: 'source-url', sourceId: 'src_3', url: `https://example.com/${'a'.repeat(2100)}` },
      { type: 'source-document', sourceId: 'doc_1', mediaType: 'application/pdf', title: 'Spec', filename: 'spec.pdf' },
      { type: 'reasoning-file', mediaType: 'image/png', url: PNG_DATA_URL },
      { type: 'data-notice', data: { level: 'info', code: 'context-trimmed', message: 'NOTICE-TEXT' } },
      { type: 'custom', kind: 'openai.thing', providerMetadata: { x: 'CUSTOM-PART' } },
      { type: 'future-part', text: 'FUTURE-PART' },
      42,
      null,
    ], {
      modelRef: 'openai:gpt-5',
      startedAt: 2,
      finishedAt: 3,
      durationMs: 1,
      usage: { inputTokens: 1234567, outputTokens: 7654321 },
      costUsd: 98.7654,
      finishReason: 'stop',
    }),
    message(4, 'assistant', [{ type: 'text', text: 'Partial answer' }], {
      modelRef: 'mock:echo',
      startedAt: 4,
      error: { code: 'provider_error', message: 'upstream said ERROR-DETAILS', providerId: 'openai' },
    }),
    message(5, 'user', [{ type: 'text', text: 'Try again' }], { modelRef: 'mock:echo', startedAt: 5, command: { name: 'Bad Name', input: '', type: 'reply' } }),
    message(6, 'assistant', [
      { type: 'tool-slow', toolCallId: 'call_7', state: 'input-available', input: { seconds: 5 } },
      { type: 'tool-ask', toolCallId: 'call_8', state: 'approval-requested', input: {}, approval: { id: 'appr_8' } },
      { type: 'tool-refused', toolCallId: 'call_9', state: 'approval-responded', input: {}, approval: { id: 'appr_9', approved: false } },
      { type: 'tool-granted', toolCallId: 'call_10', state: 'approval-responded', input: {}, approval: { id: 'appr_10', approved: true } },
    ], { modelRef: 'not a model ref', startedAt: 6, aborted: true }),
  ]
}

const ALL_OPTIONS: ShareOptions = { reasoning: true, toolDetails: true, attachments: true }
const NO_OPTIONS: ShareOptions = { reasoning: false, toolDetails: false, attachments: false }

function renderContext(options: ShareOptions, fileIds: string[] = [FILE_A]): RenderContext {
  return { options, fileIdOf, fileIds: new Set(fileIds), fileUrl: id => `/api/share/TOKEN/files/${id}` }
}

describe('sanitizeSnapshot (allowlist)', () => {
  it('keeps only the allowlisted fields of user and assistant messages', () => {
    const { snapshot, fileIds } = sanitizeSnapshot('Review chat', kitchenSink(), fileIdOf)
    expect(shareSnapshotSchema.parse(snapshot)).toEqual(snapshot)
    expect(fileIds).toEqual([FILE_A])
    expect(snapshot).toEqual({
      title: 'Review chat',
      messages: [
        {
          role: 'user',
          command: { name: 'review' },
          parts: [
            { type: 'text', text: 'Please review this' },
            { type: 'file', mediaType: 'image/png', filename: 'dot.png', url: `/api/files/${FILE_A}` },
            { type: 'file', mediaType: 'image/png', url: PNG_DATA_URL },
            { type: 'file', mediaType: 'image/png', url: `/api/files/${FILE_A}` },
          ],
        },
        {
          role: 'assistant',
          modelRef: 'openai:gpt-5',
          parts: [
            { type: 'reasoning', text: 'Let me think' },
            { type: 'text', text: 'Here is my review' },
            { type: 'tool', toolName: 'web_fetch', status: 'done', input: { url: 'https://nuxt.com/docs' }, output: { status: 200, body: 'docs' } },
            { type: 'tool', toolName: 'mcp__docs__search', status: 'error', input: { q: 'nuxt' }, errorText: 'The server failed' },
            { type: 'tool', toolName: 'current_time', status: 'denied', input: {} },
            // A pending approval followed by later messages was never granted.
            { type: 'tool', toolName: 'shell', status: 'denied', input: { command: 'ls' } },
            { type: 'source-url', sourceId: 'src_1', url: 'https://nuxt.com/docs', title: 'Nuxt docs' },
            { type: 'source-document', sourceId: 'doc_1', title: 'Spec', mediaType: 'application/pdf', filename: 'spec.pdf' },
          ],
        },
        { role: 'assistant', modelRef: 'mock:echo', status: 'failed', parts: [{ type: 'text', text: 'Partial answer' }] },
        { role: 'user', parts: [{ type: 'text', text: 'Try again' }] },
        {
          role: 'assistant',
          status: 'stopped',
          parts: [
            { type: 'tool', toolName: 'slow', status: 'stopped', input: { seconds: 5 } },
            { type: 'tool', toolName: 'ask', status: 'stopped', input: {} },
            { type: 'tool', toolName: 'refused', status: 'denied', input: {} },
            { type: 'tool', toolName: 'granted', status: 'stopped', input: {} },
          ],
        },
      ],
    })
  })

  it('never copies metadata, instructions, approvals, provider data or dropped parts', () => {
    const json = JSON.stringify(sanitizeSnapshot('Review chat', kitchenSink(), fileIdOf))
    for (const leaked of [
      'SYSTEM PROMPT',
      'SECRET EXPANSION TEXT',
      'COMMAND-INPUT',
      'PROVIDER-ITEM',
      'PROVIDER-REF',
      'PROVIDER-SIGNATURE',
      'ENCRYPTED-REASONING',
      'TOOL-TITLE',
      'CALL-METADATA',
      'RESULT-METADATA',
      'APPROVAL-REASON',
      'APPROVAL-SIGNATURE',
      'DENIAL-REASON',
      'SOURCE-METADATA',
      'NOTICE-TEXT',
      'CUSTOM-PART',
      'FUTURE-PART',
      'ERROR-DETAILS',
      'provider_error',
      'nameless',
      'evil.example',
      'svg',
      'application/pdf;base64',
      'javascript:',
      'call_1',
      'appr_',
      'msg_',
      '1234567',
      '98.7654',
      'startedAt',
      'finishReason',
      'reasoning-file',
      'step-start',
      'providerMetadata',
      'not a model ref',
      'Bad Name',
    ])
      expect(json, leaked).not.toContain(leaked)
  })

  it('counts user and assistant messages only (the message count of a share)', () => {
    const path = kitchenSink()
    const { snapshot } = sanitizeSnapshot(null, path, fileIdOf)
    expect(shareableMessageCount(path)).toBe(5)
    expect(snapshot.messages).toHaveLength(5)
    expect(sanitizeSnapshot(null, [], fileIdOf)).toEqual({ snapshot: { title: null, messages: [] }, fileIds: [] })
  })

  it('collects each app file once, in first-use order', () => {
    const path = [
      message(1, 'user', [
        { type: 'file', mediaType: 'text/plain', url: `/api/files/${FILE_B}` },
        { type: 'file', mediaType: 'image/png', url: `/api/files/${FILE_A}` },
        { type: 'file', mediaType: 'text/plain', url: `/api/files/${FILE_B}` },
        { type: 'file', mediaType: 'text/plain', url: `/api/files/${FILE_B}?download=1` },
      ]),
    ]
    const { snapshot, fileIds } = sanitizeSnapshot(null, path, fileIdOf)
    expect(fileIds).toEqual([FILE_B, FILE_A])
    expect(snapshot.messages[0]?.parts).toHaveLength(3)
  })

  it('caps tool values and error texts, and never keeps more than the part limit', () => {
    const big = 'x'.repeat(LIMITS.shareToolValueChars + 10)
    const path = [message(1, 'assistant', [
      { type: 'tool-echo', toolCallId: 'c', state: 'output-available', input: big, output: { text: big } },
      { type: 'tool-fail', toolCallId: 'd', state: 'output-error', input: {}, errorText: 'e'.repeat(5000) },
      ...Array.from({ length: LIMITS.messagePartsMax + 5 }, (_value, index) => ({ type: 'text', text: `part ${index}` })),
    ])]
    const { snapshot } = sanitizeSnapshot(null, path, fileIdOf)
    const [echo, fail] = snapshot.messages[0]!.parts as Array<{ input?: unknown, output?: unknown, errorText?: string }>
    expect(echo?.input).toHaveLength(LIMITS.shareToolValueChars)
    expect(String(echo?.input).endsWith(SHARE_TRUNCATION_MARKER)).toBe(true)
    expect(typeof echo?.output).toBe('string')
    expect(String(echo?.output).startsWith('{"text":"xxx')).toBe(true)
    expect(String(echo?.output)).toHaveLength(LIMITS.shareToolValueChars)
    expect(fail?.errorText).toHaveLength(4096)
    expect(snapshot.messages[0]?.parts).toHaveLength(LIMITS.messagePartsMax)
    expect(shareMessageSchema.safeParse(snapshot.messages[0]).success).toBe(true)
  })
})

/** A path with the Phase 9 parts: a steer inside a stopped reply, compaction markers, an activity part. */
function agentPath(): HarnessUIMessage[] {
  const compaction = { modelRef: 'mock:compact', messagesCompacted: 3, tokensBefore: 900, tokensAfter: 90, createdAt: 9 }
  return [
    message(1, 'user', [{ type: 'text', text: 'Fix the tests' }], { modelRef: 'mock:steer', startedAt: 1 }),
    message(2, 'assistant', [
      { type: 'step-start' },
      { type: 'text', text: 'Running them' },
      { type: 'tool-current_time', toolCallId: 'call_1', state: 'output-available', input: {}, output: { now: 'noon' } },
      {
        type: 'data-steer',
        id: 'steer_part_1',
        data: {
          id: 'msg_QUEUEDQUEUED0001',
          parts: [
            { type: 'text', text: 'Also check the docs' },
            { type: 'file', mediaType: 'text/plain', filename: 'docs.txt', url: `/api/files/${FILE_B}` },
            { type: 'file', mediaType: 'image/png', url: PNG_DATA_URL },
          ],
          queuedAt: 3,
          deliveredAt: 4,
        },
      },
      { type: 'step-start' },
      { type: 'data-activity', data: { kind: 'compacting' } },
      { type: 'data-compaction', data: { ...compaction, trigger: 'auto', keep: 'last-user', summary: 'SUMMARY-IN-RUN', focus: 'FOCUS-TEXT' } },
      { type: 'text', text: 'Docs checked too' },
    ], { modelRef: 'mock:steer', startedAt: 2, aborted: true }),
    message(3, 'user', [{ type: 'text', text: '/compact' }], { modelRef: 'mock:steer', startedAt: 5, command: { name: 'compact', input: '', type: 'compact' } }),
    message(4, 'assistant', [
      { type: 'step-start' },
      { type: 'data-compaction', data: { ...compaction, trigger: 'manual', keep: 'none', summary: 'SUMMARY-MANUAL' } },
    ], { modelRef: 'mock:compact', startedAt: 6 }),
  ]
}

describe('sanitizeSnapshot: agent parts (Phase 9)', () => {
  it('splits a reply at its steers into user share messages and drops compaction and activity parts', () => {
    const path = agentPath()
    const { snapshot, fileIds } = sanitizeSnapshot('Agent chat', path, fileIdOf)
    expect(shareSnapshotSchema.parse(snapshot)).toEqual(snapshot)
    expect(snapshot.messages).toEqual([
      { role: 'user', parts: [{ type: 'text', text: 'Fix the tests' }] },
      {
        role: 'assistant',
        modelRef: 'mock:steer',
        parts: [
          { type: 'text', text: 'Running them' },
          { type: 'tool', toolName: 'current_time', status: 'done', input: {}, output: { now: 'noon' } },
        ],
      },
      {
        role: 'user',
        parts: [
          { type: 'text', text: 'Also check the docs' },
          { type: 'file', mediaType: 'text/plain', filename: 'docs.txt', url: `/api/files/${FILE_B}` },
          { type: 'file', mediaType: 'image/png', url: PNG_DATA_URL },
        ],
      },
      // The reply's status stays on its last part.
      { role: 'assistant', modelRef: 'mock:steer', status: 'stopped', parts: [{ type: 'text', text: 'Docs checked too' }] },
      // The /compact exchange (the command and its marker-only reply) is left out.
    ])
    expect(fileIds).toEqual([FILE_B])
    expect(shareableMessageCount(path)).toBe(snapshot.messages.length)
    const json = JSON.stringify(snapshot)
    for (const leaked of ['SUMMARY-IN-RUN', 'SUMMARY-MANUAL', 'FOCUS-TEXT', 'compacting', 'data-', 'queuedAt', 'msg_', 'steer_part_1'])
      expect(json, leaked).not.toContain(leaked)
  })

  it('the steer files follow the attachments option; the steer text always shows', () => {
    const { snapshot, fileIds } = sanitizeSnapshot(null, agentPath(), fileIdOf)
    const shown = renderShareMessages(snapshot, renderContext(ALL_OPTIONS, fileIds))
    expect(shown[2]).toEqual({
      role: 'user',
      parts: [
        { type: 'text', text: 'Also check the docs' },
        { type: 'file', mediaType: 'text/plain', filename: 'docs.txt', url: `/api/share/TOKEN/files/${FILE_B}` },
        { type: 'file', mediaType: 'image/png', url: PNG_DATA_URL },
      ],
    })
    expect(renderShareMessages(snapshot, renderContext(NO_OPTIONS, fileIds))[2]).toEqual({ role: 'user', parts: [{ type: 'text', text: 'Also check the docs' }] })
  })

  it('a failed reply that ends with a steer keeps the status on its part before the steer', () => {
    const [, reply] = agentPath()
    const failed = { ...reply!, parts: reply!.parts.slice(0, 5), metadata: { modelRef: 'mock:steer', startedAt: 2, error: { code: 'provider_error', message: 'ERROR-DETAILS' } } } as HarnessUIMessage
    const { snapshot } = sanitizeSnapshot(null, [failed], fileIdOf)
    expect(snapshot.messages.map(shown => [shown.role, shown.status])).toEqual([['assistant', 'failed'], ['user', undefined]])
    expect(shareableMessageCount([failed])).toBe(2)
    expect(JSON.stringify(snapshot)).not.toContain('ERROR-DETAILS')
  })

  it('a pending approval before a later share message counts as denied; invalid steers and user steers are dropped', () => {
    const path = [
      message(1, 'assistant', [
        { type: 'tool-shell', toolCallId: 'call_1', state: 'approval-requested', input: { command: 'ls' }, approval: { id: 'appr_1' } },
        { type: 'data-steer', data: { id: 'msg_QUEUEDQUEUED0002', parts: [{ type: 'text', text: 'Go on' }], queuedAt: 1, deliveredAt: 2 } },
        { type: 'data-steer', data: { id: 'bad', parts: [{ type: 'text', text: 'INVALID-STEER' }], queuedAt: 1, deliveredAt: 2 } },
      ]),
      message(2, 'user', [{ type: 'text', text: 'Hi' }, { type: 'data-steer', data: { id: 'msg_QUEUEDQUEUED0003', parts: [{ type: 'text', text: 'USER-STEER' }], queuedAt: 1, deliveredAt: 2 } }]),
    ]
    const { snapshot } = sanitizeSnapshot(null, path, fileIdOf)
    expect(snapshot.messages).toEqual([
      { role: 'assistant', parts: [{ type: 'tool', toolName: 'shell', status: 'denied', input: { command: 'ls' } }] },
      { role: 'user', parts: [{ type: 'text', text: 'Go on' }] },
      { role: 'user', parts: [{ type: 'text', text: 'Hi' }] },
    ])
    expect(shareableMessageCount(path)).toBe(3)
    expect(JSON.stringify(snapshot)).not.toMatch(/INVALID-STEER|USER-STEER/)
  })
})

// ---------- Phase 10: background task results (W10.6-T4) ----------

function taskResult(n: number): unknown {
  return {
    type: 'data-task-result',
    data: {
      taskId: `bgt_000000000000000${n}`,
      toolCallId: `call_bg${n}`,
      messageId: 'msg_0000000000000002',
      output: { status: 'completed', type: 'explore', description: 'Scan', modelRef: 'mock:background', steps: [], stepsOmitted: 0, report: `TASK-REPORT-${n}`, startedAt: 1, finishedAt: 2 },
      deliveredAt: 3,
    },
  }
}

describe('sanitizeSnapshot: background task results (Phase 10)', () => {
  it('drops result parts, and a carrier user message that holds only results', () => {
    const path = [
      message(1, 'user', [{ type: 'text', text: 'Scan in the background' }]),
      message(2, 'assistant', [{ type: 'step-start' }, { type: 'text', text: 'Started' }, taskResult(1), { type: 'step-start' }, { type: 'text', text: 'One is in' }], { modelRef: 'mock:background' }),
      // The carrier of a turn the server started (results and parts that are no content).
      message(3, 'user', [taskResult(2), { type: 'step-start' }]),
      message(4, 'assistant', [{ type: 'step-start' }, { type: 'text', text: 'Both are in' }], { modelRef: 'mock:background' }),
      // A user message with text besides a result stays (only the result is dropped).
      message(5, 'user', [taskResult(3), { type: 'text', text: 'Thanks' }]),
      // A reply that holds only a result stays, with no parts (it is still a reply of the chat).
      message(6, 'assistant', [{ type: 'step-start' }, taskResult(4)], { modelRef: 'mock:background' }),
    ]
    const { snapshot } = sanitizeSnapshot('Background', path, fileIdOf)
    expect(shareSnapshotSchema.parse(snapshot)).toEqual(snapshot)
    expect(snapshot.messages).toEqual([
      { role: 'user', parts: [{ type: 'text', text: 'Scan in the background' }] },
      { role: 'assistant', modelRef: 'mock:background', parts: [{ type: 'text', text: 'Started' }, { type: 'text', text: 'One is in' }] },
      { role: 'assistant', modelRef: 'mock:background', parts: [{ type: 'text', text: 'Both are in' }] },
      { role: 'user', parts: [{ type: 'text', text: 'Thanks' }] },
      { role: 'assistant', modelRef: 'mock:background', parts: [] },
    ])
    expect(shareableMessageCount(path)).toBe(snapshot.messages.length)
    const json = JSON.stringify(snapshot)
    for (const leaked of ['TASK-REPORT', 'bgt_', 'data-', 'call_bg'])
      expect(json, leaked).not.toContain(leaked)
  })
})

/** A `data-hook` part (ADR-048) whose texts must never reach a share. */
function hookRecord(n: number, event: string, outcome: string, extra: Record<string, unknown> = {}): unknown {
  return {
    type: 'data-hook',
    data: {
      id: `hev_000000000000000${n}`,
      event,
      outcome,
      createdAt: 1,
      hooks: [{ source: 'project', label: 'sh HOOK-LABEL.sh', exitCode: 2, durationMs: 4, error: 'HOOK-ERROR', systemMessage: 'HOOK-SYSTEM-MESSAGE' }],
      ...extra,
    },
  }
}

describe('sanitizeSnapshot: hook records (Phase 11)', () => {
  it('drops hook parts and a Stop carrier; a hook-denied tool reads "denied" without the reason', () => {
    const path = [
      // A UserPromptSubmit context on the user message: the text stays, the record goes.
      message(1, 'user', [{ type: 'text', text: 'Write the file' }, hookRecord(1, 'UserPromptSubmit', 'context', { context: 'HOOK-CONTEXT' })]),
      message(2, 'assistant', [
        { type: 'step-start' },
        // PreToolUse deny: the SDK stores a denied approval with the "Blocked by hook" reason.
        { type: 'tool-write_file', toolCallId: 'call_h1', state: 'output-denied', input: { path: 'a.txt' }, approval: { id: 'appr_h1', approved: false, reason: 'Blocked by hook: HOOK-REASON' } },
        hookRecord(2, 'PreToolUse', 'denied', { toolCallId: 'call_h1', toolName: 'write_file', reason: 'HOOK-REASON' }),
        { type: 'tool-edit_file', toolCallId: 'call_h2', state: 'output-available', input: { path: 'b.txt' }, output: { ok: true } },
        hookRecord(3, 'PreToolUse', 'rewritten', { toolCallId: 'call_h2', toolName: 'edit_file', updatedInput: { path: 'HOOK-UPDATED-INPUT' } }),
        hookRecord(4, 'PostToolUse', 'context', { toolCallId: 'call_h2', toolName: 'edit_file', context: 'HOOK-CONTEXT' }),
        { type: 'text', text: 'Could not write a.txt' },
      ], { modelRef: 'mock:hooks' }),
      // The carrier of a Stop continuation (records and parts that are no content).
      message(3, 'user', [hookRecord(5, 'Stop', 'continued', { reason: 'HOOK-STOP-REASON' }), { type: 'step-start' }]),
      message(4, 'assistant', [{ type: 'step-start' }, { type: 'text', text: 'Continued' }], { modelRef: 'mock:hooks' }),
    ]
    const { snapshot } = sanitizeSnapshot('Hooks', path, fileIdOf)
    expect(shareSnapshotSchema.parse(snapshot)).toEqual(snapshot)
    expect(snapshot.messages).toEqual([
      { role: 'user', parts: [{ type: 'text', text: 'Write the file' }] },
      {
        role: 'assistant',
        modelRef: 'mock:hooks',
        parts: [
          { type: 'tool', toolName: 'write_file', status: 'denied', input: { path: 'a.txt' } },
          { type: 'tool', toolName: 'edit_file', status: 'done', input: { path: 'b.txt' }, output: { ok: true } },
          { type: 'text', text: 'Could not write a.txt' },
        ],
      },
      { role: 'assistant', modelRef: 'mock:hooks', parts: [{ type: 'text', text: 'Continued' }] },
    ])
    expect(shareableMessageCount(path)).toBe(snapshot.messages.length)
    const json = JSON.stringify(snapshot)
    for (const leaked of ['HOOK-', 'hev_', 'data-', 'Blocked by hook'])
      expect(json, leaked).not.toContain(leaked)
    // Served with every option: still nothing of the hooks.
    const rendered = JSON.stringify(renderShareMessages(snapshot, renderContext(ALL_OPTIONS)))
    expect(rendered).not.toContain('HOOK-')
  })
})

describe('sanitizeSnapshot: commands and user-invocable skills (Phase 11)', () => {
  it('keeps the slash name (up to 64 characters) and the invocation kind, never the input, expansion or inlined lines', () => {
    const skill = 'deploy-to-the-staging-environment-and-run-the-smoke-tests-please'
    expect(skill).toHaveLength(64)
    const path = [
      message(1, 'user', [{ type: 'text', text: `/${skill} prod` }], {
        modelRef: 'mock:echo',
        startedAt: 1,
        command: { name: skill, kind: 'skill', input: 'SKILL-INPUT', type: 'prompt', expansion: 'SKILL-EXPANSION' },
      }),
      message(2, 'assistant', [{ type: 'text', text: 'Deployed' }], { modelRef: 'mock:echo' }),
      message(3, 'user', [{ type: 'text', text: '/status' }], {
        modelRef: 'mock:echo',
        startedAt: 2,
        command: { name: 'status', kind: 'command', input: '', type: 'prompt', expansion: 'INLINED-GIT-OUTPUT', inlined: { shell: 1, files: ['SECRET-FILE.md'] } },
      }),
      message(4, 'user', [{ type: 'text', text: '/legacy' }], { modelRef: 'mock:echo', startedAt: 3, command: { name: 'legacy', kind: 'macro', input: '', type: 'prompt' } }),
      message(5, 'user', [{ type: 'text', text: '/x' }], { modelRef: 'mock:echo', startedAt: 4, command: { name: `${skill}-and-more`, kind: 'skill', input: '', type: 'prompt' } }),
    ]
    const { snapshot } = sanitizeSnapshot('Commands', path, fileIdOf)
    expect(shareSnapshotSchema.parse(snapshot)).toEqual(snapshot)
    expect(snapshot.messages.map(shared => shared.command)).toEqual([{ name: skill, kind: 'skill' }, undefined, { name: 'status', kind: 'command' }, { name: 'legacy' }, undefined])
    const json = JSON.stringify(snapshot)
    for (const leaked of ['SKILL-INPUT', 'SKILL-EXPANSION', 'INLINED-GIT-OUTPUT', 'SECRET-FILE', 'inlined', 'macro'])
      expect(json, leaked).not.toContain(leaked)
    // Served: the kind is copied field by field, an unknown stored kind is dropped.
    const stored = { ...snapshot, messages: [...snapshot.messages, { role: 'user', command: { name: 'odd', kind: 'weird', extra: 'EXTRA-FIELD' }, parts: [] }] }
    const rendered = renderShareMessages(stored as typeof snapshot, renderContext(NO_OPTIONS))
    expect(rendered.map(shown => shown.command)).toEqual([{ name: skill, kind: 'skill' }, undefined, { name: 'status', kind: 'command' }, { name: 'legacy' }, undefined, { name: 'odd' }])
    expect(JSON.stringify(rendered)).not.toContain('EXTRA-FIELD')
  })
})

describe('capToolValue', () => {
  it('copies values whose JSON fits, cuts the others with a marker', () => {
    const value = { a: [1, 'two', { three: true }], nothing: null }
    const copy = capToolValue(value)
    expect(copy).toEqual(value)
    expect(copy).not.toBe(value)
    expect(capToolValue(undefined)).toBeUndefined()
    expect(capToolValue(() => 1)).toBeUndefined()
    expect(capToolValue(Number.NaN)).toBeNull()
    expect(capToolValue('short')).toBe('short')
    expect(capToolValue('abcdefghij', 10)).toBe('abcdefghij')
    expect(capToolValue('abcdefghijklmnopqrstuvwxyz', 20)).toBe(`abcdefgh${SHARE_TRUNCATION_MARKER}`)
    expect(capToolValue({ key: 'abcdefghijklmnopqrstuvwxyz' }, 20)).toBe(`{"key":"${SHARE_TRUNCATION_MARKER}`)
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(capToolValue(cyclic)).toBeUndefined()
  })

  it('never cuts inside a surrogate pair', () => {
    expect(clipText('ab\u{1F600}cd', 3)).toBe('ab')
    expect(clipText('ab\u{1F600}cd', 4)).toBe('ab\u{1F600}')
    expect(clipText('abc', 10)).toBe('abc')
    const capped = capToolValue('\u{1F600}'.repeat(20), 20)
    expect(capped).toBe(`${'\u{1F600}'.repeat(4)}${SHARE_TRUNCATION_MARKER}`)
  })
})

describe('rasterDataUrlType', () => {
  it('accepts raster image data URLs only', () => {
    expect(rasterDataUrlType(PNG_DATA_URL)).toBe('image/png')
    expect(rasterDataUrlType('DATA:Image/JPEG;base64,/9j/')).toBe('image/jpeg')
    expect(rasterDataUrlType('data:image/webp,raw')).toBe('image/webp')
    for (const url of [SVG_DATA_URL, 'data:text/html,<script>', 'data:image/png', '/api/files/x', 'https://example.com/a.png', 'data:;base64,AAAA'])
      expect(rasterDataUrlType(url), url).toBeNull()
  })
})

describe('renderShareMessages (options applied when served)', () => {
  const { snapshot } = sanitizeSnapshot('Review chat', kitchenSink(), fileIdOf)

  it('shows reasoning, tool details and attachments with every option, file URLs rewritten', () => {
    const messages = renderShareMessages(snapshot, renderContext(ALL_OPTIONS))
    for (const shown of messages)
      expect(shareMessageSchema.parse(shown)).toEqual(shown)
    expect(messages[0]?.parts).toEqual([
      { type: 'text', text: 'Please review this' },
      { type: 'file', mediaType: 'image/png', filename: 'dot.png', url: `/api/share/TOKEN/files/${FILE_A}` },
      { type: 'file', mediaType: 'image/png', url: PNG_DATA_URL },
      { type: 'file', mediaType: 'image/png', url: `/api/share/TOKEN/files/${FILE_A}` },
    ])
    expect(messages[1]?.parts.map(part => part.type)).toEqual(['reasoning', 'text', 'tool', 'tool', 'tool', 'tool', 'source-url', 'source-document'])
    expect(messages[1]?.parts[2]).toEqual({ type: 'tool', toolName: 'web_fetch', status: 'done', input: { url: 'https://nuxt.com/docs' }, output: { status: 200, body: 'docs' } })
    expect(messages[1]?.parts[3]).toEqual({ type: 'tool', toolName: 'mcp__docs__search', status: 'error', input: { q: 'nuxt' }, errorText: 'The server failed' })
    expect(messages.map(shown => [shown.role, shown.status, shown.modelRef, shown.command?.name])).toEqual([
      ['user', undefined, undefined, 'review'],
      ['assistant', undefined, 'openai:gpt-5', undefined],
      ['assistant', 'failed', 'mock:echo', undefined],
      ['user', undefined, undefined, undefined],
      ['assistant', 'stopped', undefined, undefined],
    ])
  })

  it('leaves out reasoning, tool details and attachments when disabled', () => {
    const messages = renderShareMessages(snapshot, renderContext(NO_OPTIONS))
    expect(messages[0]?.parts).toEqual([{ type: 'text', text: 'Please review this' }])
    expect(messages[1]?.parts).toEqual([
      { type: 'text', text: 'Here is my review' },
      { type: 'tool', toolName: 'web_fetch', status: 'done' },
      { type: 'tool', toolName: 'mcp__docs__search', status: 'error' },
      { type: 'tool', toolName: 'current_time', status: 'denied' },
      { type: 'tool', toolName: 'shell', status: 'denied' },
      { type: 'source-url', sourceId: 'src_1', url: 'https://nuxt.com/docs', title: 'Nuxt docs' },
      { type: 'source-document', sourceId: 'doc_1', title: 'Spec', mediaType: 'application/pdf', filename: 'spec.pdf' },
    ])
    const text = JSON.stringify(messages)
    expect(text).not.toContain('Let me think')
    expect(text).not.toContain('The server failed')
    expect(text).not.toContain('/api/')
  })

  it('serves only the files of the share and never the app file URL', () => {
    const messages = renderShareMessages(snapshot, renderContext(ALL_OPTIONS, []))
    expect(messages[0]?.parts).toEqual([
      { type: 'text', text: 'Please review this' },
      { type: 'file', mediaType: 'image/png', url: PNG_DATA_URL },
    ])
    expect(JSON.stringify(messages)).not.toContain('/api/files/')
  })

  it('copies stored parts field by field and skips anything unexpected', () => {
    const stored = {
      title: 'x',
      messages: [
        { role: 'system', parts: [{ type: 'text', text: 'hidden' }] },
        { role: 'assistant', extra: 'EXTRA', parts: [{ type: 'text', text: 'ok', extra: 'EXTRA' }, { type: 'unknown' }, 'junk', { type: 'tool', toolName: 't', status: 'done', input: 1, extra: 'EXTRA' }] },
        'junk',
      ],
    }
    const messages = renderShareMessages(stored as never, renderContext(ALL_OPTIONS))
    expect(messages).toEqual([{ role: 'assistant', parts: [{ type: 'text', text: 'ok' }, { type: 'tool', toolName: 't', status: 'done', input: 1 }] }])
    expect(renderShareMessages(null, renderContext(ALL_OPTIONS))).toEqual([])
    expect(renderShareMessages({ title: null, messages: 'x' } as never, renderContext(ALL_OPTIONS))).toEqual([])
  })
})

describe('snapshot helpers', () => {
  it('measure the serialized UTF-8 size and read the stored title', () => {
    const snapshot = { title: 'été', messages: [] }
    expect(snapshotBytes(snapshot)).toBe(Buffer.byteLength(JSON.stringify(snapshot), 'utf8'))
    expect(snapshotBytes(snapshot)).toBe(JSON.stringify(snapshot).length + 2)
    expect(snapshotTitle({ title: 'Chat', messages: [] })).toBe('Chat')
    expect(snapshotTitle({ title: null, messages: [] })).toBeNull()
    expect(snapshotTitle(null)).toBeNull()
  })
})
