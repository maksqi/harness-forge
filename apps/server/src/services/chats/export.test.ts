import type { ChatDetail } from '@harness-forge/shared'
import { chatExportAnySchema, chatExportSchema } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { buildChatExport, compactionLine, EXPORT_TOOL_OUTPUT_BYTES, exportFilename, hookLine, linearTree, renderChatMarkdown, STEER_HEADING, taskResultHeading, titleSlug } from './export.ts'

const CHAT_ID = '0199a8f0-0000-7000-8000-000000000001'
const NOW = Date.UTC(2026, 8, 28, 12, 30)

function sampleChat(): ChatDetail {
  return {
    id: CHAT_ID,
    title: 'Plan the trip',
    titleSource: 'user',
    modelRef: 'anthropic:claude-sonnet-5',
    pinned: true,
    archived: false,
    running: true,
    pendingApproval: true,
    projectId: null,
    createdAt: 1,
    updatedAt: 2,
    settings: { toolMode: 'ask' },
    totals: { inputTokens: 10, outputTokens: 20, reasoningTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01 },
    branches: {},
    messages: [
      {
        id: 'msg_user000000000001',
        role: 'user',
        metadata: { modelRef: 'anthropic:claude-sonnet-5', startedAt: 1 },
        parts: [
          { type: 'text', text: 'Find flights to **Lisbon**.' },
          { type: 'file', mediaType: 'application/pdf', filename: 'itinerary [v2].pdf', url: '/api/files/file_0000000000000001' },
        ],
      },
      {
        id: 'msg_asst000000000001',
        role: 'assistant',
        metadata: { modelRef: 'openai:gpt-6', startedAt: 2, finishedAt: 3 },
        parts: [
          { type: 'step-start' },
          { type: 'reasoning', text: 'The user wants flights.\n\nCheck dates.', state: 'done' },
          { type: 'tool-web_fetch', toolCallId: 'call_1', state: 'output-available', input: { url: 'https://example.com' }, output: { status: 200, body: '```html```' } },
          { type: 'dynamic-tool', toolName: 'mcp__search__query', toolCallId: 'call_2', state: 'output-error', input: { q: 'x' }, errorText: 'Timed out' },
          { type: 'text', text: 'Here are the options.' },
          { type: 'source-url', sourceId: 's1', url: 'https://example.com/a', title: 'Example' },
          { type: 'data-notice', data: { level: 'info', code: 'context-trimmed', message: 'Trimmed.' } },
        ],
      },
    ],
  }
}

const EXPECTED_MARKDOWN = `# Plan the trip

Exported from harness-forge on 2026-09-28 · Model: anthropic:claude-sonnet-5

## User

Find flights to **Lisbon**.

[itinerary \\[v2\\].pdf](/api/files/file_0000000000000001)

## Assistant (openai:gpt-6)

> The user wants flights.
>
> Check dates.

**Tool** \`web_fetch\` (output-available)

\`\`\`json
{
  "url": "https://example.com"
}
\`\`\`

\`\`\`\`json
{
  "status": 200,
  "body": "\`\`\`html\`\`\`"
}
\`\`\`\`

**Tool** \`mcp__search__query\` (output-error)

\`\`\`json
{
  "q": "x"
}
\`\`\`

\`\`\`text
Timed out
\`\`\`

Here are the options.

Source: [Example](https://example.com/a)
`

describe('markdown export', () => {
  it('renders title, export line and one section per message', () => {
    expect(renderChatMarkdown(sampleChat(), NOW)).toBe(EXPECTED_MARKDOWN)
  })

  it('falls back to the chat model and a default title', () => {
    const chat: ChatDetail = {
      ...sampleChat(),
      title: null,
      modelRef: null,
      messages: [{ id: 'msg_asst000000000002', role: 'assistant', parts: [{ type: 'text', text: 'Hi' }] }],
    }
    expect(renderChatMarkdown(chat, NOW)).toBe('# Untitled chat\n\nExported from harness-forge on 2026-09-28\n\n## Assistant\n\nHi\n')
  })

  it('truncates long tool outputs at 4 KB and omits embedded data URLs', () => {
    const chat: ChatDetail = {
      ...sampleChat(),
      messages: [{
        id: 'msg_asst000000000003',
        role: 'assistant',
        parts: [
          { type: 'tool-big', toolCallId: 'c', state: 'output-available', input: {}, output: 'x'.repeat(10_000) },
          { type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,AAAA' },
        ],
      }],
    }
    const markdown = renderChatMarkdown(chat, NOW)
    expect(markdown).toContain('… (truncated)')
    expect(markdown).not.toContain('x'.repeat(EXPORT_TOOL_OUTPUT_BYTES))
    expect(markdown).toContain('x'.repeat(EXPORT_TOOL_OUTPUT_BYTES - 1))
    expect(markdown).toContain('image/png (embedded file not exported)')
    expect(markdown).not.toContain('base64')
  })
})

/** A chat with the Phase 9 parts: a steer inside a reply, a `/compact` reply and an automatic marker during a reply. */
function agentChat(): ChatDetail {
  const compaction = { modelRef: 'mock:compact', tokensBefore: 9000, tokensAfter: 700, createdAt: 5 }
  return {
    ...sampleChat(),
    title: 'Agent work',
    modelRef: 'mock:steer',
    messages: [
      { id: 'msg_user000000000011', role: 'user', parts: [{ type: 'text', text: 'Fix the tests.' }] },
      {
        id: 'msg_asst000000000011',
        role: 'assistant',
        metadata: { modelRef: 'mock:steer', startedAt: 2 },
        parts: [
          { type: 'step-start' },
          { type: 'text', text: 'Running the tests.' },
          {
            type: 'data-steer',
            id: 'steer_part_1',
            data: {
              id: 'msg_queued0000000001',
              parts: [
                { type: 'text', text: 'Skip the slow suite.' },
                { type: 'file', mediaType: 'text/plain', filename: 'slow.txt', url: '/api/files/file_0000000000000002' },
              ],
              queuedAt: 3,
              deliveredAt: 4,
            },
          },
          { type: 'step-start' },
          { type: 'text', text: 'Skipped it; all green.' },
          // Invalid steer data is left out (no split, no section).
          { type: 'data-steer', data: { id: 'bad', parts: [], queuedAt: 1, deliveredAt: 1 } },
        ],
      },
      { id: 'msg_user000000000012', role: 'user', metadata: { modelRef: 'mock:steer', startedAt: 6, command: { name: 'compact', input: 'keep numbers', type: 'compact' } }, parts: [{ type: 'text', text: '/compact keep numbers' }] },
      {
        id: 'msg_asst000000000012',
        role: 'assistant',
        metadata: { modelRef: 'mock:compact', startedAt: 7 },
        parts: [
          { type: 'step-start' },
          { type: 'data-compaction', data: { ...compaction, trigger: 'manual', keep: 'none', focus: 'keep numbers', summary: 'The user fixed the tests.\n\nNumbers: 42.', messagesCompacted: 4 } },
        ],
      },
      { id: 'msg_user000000000013', role: 'user', parts: [{ type: 'text', text: 'Continue.' }] },
      {
        id: 'msg_asst000000000013',
        role: 'assistant',
        metadata: { modelRef: 'mock:steer', startedAt: 8 },
        parts: [
          { type: 'step-start' },
          { type: 'text', text: 'Step one done.' },
          { type: 'data-compaction', data: { ...compaction, trigger: 'auto', keep: 'last-user', summary: 'Continued after step one.', messagesCompacted: 1 } },
          { type: 'step-start' },
          { type: 'text', text: 'Step two done.' },
          // Invalid marker data is left out.
          { type: 'data-compaction', data: { trigger: 'auto', summary: 'BROKEN-MARKER' } },
        ],
      },
    ],
  } as ChatDetail
}

const AGENT_MARKDOWN = `# Agent work

Exported from harness-forge on 2026-09-28 · Model: mock:steer

## User

Fix the tests.

## Assistant (mock:steer)

Running the tests.

## User (during the run)

Skip the slow suite.

[slow.txt](/api/files/file_0000000000000002)

## Assistant (mock:steer)

Skipped it; all green.

## User

/compact keep numbers

## Assistant (mock:compact)

_Conversation compacted (4 messages summarized)_

> The user fixed the tests.
>
> Numbers: 42.

## User

Continue.

## Assistant (mock:steer)

Step one done.

_Conversation compacted (1 message summarized)_

> Continued after step one.

Step two done.
`

describe('markdown export: agent parts (Phase 9)', () => {
  it('renders steers as user sections inside the reply and markers with their summary', () => {
    expect(renderChatMarkdown(agentChat(), NOW)).toBe(AGENT_MARKDOWN)
    expect(buildChatExport(agentChat(), 'md', NOW).body).toBe(AGENT_MARKDOWN)
    expect(AGENT_MARKDOWN).not.toContain('BROKEN-MARKER')
    expect(AGENT_MARKDOWN).not.toContain('data-')
    expect(STEER_HEADING).toBe('## User (during the run)')
  })

  it('a reply that ends with a steer keeps the reply before it; a steer never splits a user message', () => {
    const chat = agentChat()
    const reply = chat.messages[1]!
    const ended: ChatDetail = { ...chat, messages: [{ ...reply, parts: reply.parts.slice(0, 4) }] }
    expect(renderChatMarkdown(ended, NOW)).toBe([
      '# Agent work',
      'Exported from harness-forge on 2026-09-28 · Model: mock:steer',
      '## Assistant (mock:steer)',
      'Running the tests.',
      '## User (during the run)',
      'Skip the slow suite.',
      '[slow.txt](/api/files/file_0000000000000002)',
    ].join('\n\n').concat('\n'))
    // Steers are only recognized in replies.
    const user: ChatDetail = { ...chat, messages: [{ id: 'msg_user000000000019', role: 'user', parts: [{ type: 'text', text: 'Hi' }, reply.parts[2]!] }] }
    expect(renderChatMarkdown(user, NOW)).not.toContain(STEER_HEADING)
  })

  it('compactionLine counts the summarized messages', () => {
    expect(compactionLine({ messagesCompacted: 0 })).toBe('_Conversation compacted (0 messages summarized)_')
    expect(compactionLine({ messagesCompacted: 1 })).toBe('_Conversation compacted (1 message summarized)_')
    expect(compactionLine({ messagesCompacted: 42 })).toBe('_Conversation compacted (42 messages summarized)_')
  })

  it('the json export keeps the parts as stored', () => {
    const parsed = chatExportSchema.parse(JSON.parse(buildChatExport(agentChat(), 'json', NOW).body))
    expect(parsed.chat.messages).toEqual(agentChat().messages)
  })
})

// ---------- Phase 10: background task results (W10.6-T4) ----------

/** A `data-task-result` part (ADR-046) of the task `n`. */
function taskResult(n: number, output: Record<string, unknown> = {}): ChatDetail['messages'][number]['parts'][number] {
  return {
    type: 'data-task-result',
    data: {
      taskId: `bgt_000000000000000${n}`,
      toolCallId: `call_bg${n}`,
      messageId: 'msg_asst000000000021',
      output: { status: 'completed', type: 'explore', description: `Scan part ${n}`, modelRef: 'mock:background', steps: [], stepsOmitted: 0, report: `Report ${n}: found **3** files.`, startedAt: 1, finishedAt: 2, ...output },
      deliveredAt: 3,
    },
  } as ChatDetail['messages'][number]['parts'][number]
}

function backgroundChat(): ChatDetail {
  return {
    ...sampleChat(),
    title: 'Background work',
    modelRef: 'mock:background',
    messages: [
      { id: 'msg_user000000000021', role: 'user', parts: [{ type: 'text', text: 'Scan the repo in the background.' }] },
      {
        id: 'msg_asst000000000021',
        role: 'assistant',
        metadata: { modelRef: 'mock:background', startedAt: 2 },
        parts: [
          { type: 'step-start' },
          { type: 'text', text: 'Started two scans.' },
          { type: 'step-start' },
          taskResult(1),
          { type: 'step-start' },
          { type: 'text', text: 'The first scan is in.' },
          // Invalid result data is left out (no split, no section).
          { type: 'data-task-result', data: { taskId: 'nope', output: { report: 'BROKEN-RESULT' } } } as ChatDetail['messages'][number]['parts'][number],
        ],
      },
      // The carrier of a turn the server started: only results, no "## User" heading.
      { id: 'msg_user000000000022', role: 'user', parts: [taskResult(2, { status: 'failed', report: '  ', error: 'The model was not available.', description: 'Scan\npart  2' })] },
      { id: 'msg_asst000000000022', role: 'assistant', metadata: { modelRef: 'mock:background', startedAt: 4 }, parts: [{ type: 'step-start' }, { type: 'text', text: 'The second scan failed.' }] },
      { id: 'msg_user000000000023', role: 'user', parts: [taskResult(3, { status: 'aborted', report: '', description: '' })] },
    ],
  } as ChatDetail
}

const BACKGROUND_MARKDOWN = `# Background work

Exported from harness-forge on 2026-09-28 · Model: mock:background

## User

Scan the repo in the background.

## Assistant (mock:background)

Started two scans.

## Background task: Scan part 1 (completed)

Report 1: found **3** files.

## Assistant (mock:background)

The first scan is in.

## Background task: Scan part 2 (failed)

Error: The model was not available.

## Assistant (mock:background)

The second scan failed.

## Background task: explore (aborted)

_(no report)_
`

describe('markdown export: background task results (Phase 10)', () => {
  it('renders each result as a section with its report, splitting a reply and replacing the carrier heading', () => {
    expect(renderChatMarkdown(backgroundChat(), NOW)).toBe(BACKGROUND_MARKDOWN)
    expect(BACKGROUND_MARKDOWN).not.toContain('BROKEN-RESULT')
    expect(BACKGROUND_MARKDOWN).not.toContain('bgt_')
    expect(taskResultHeading({ description: ' Look  around ', type: 'explore', status: 'limit' })).toBe('## Background task: Look around (limit)')
  })

  it('a reply that holds only a result gets no empty heading, and the json export keeps the parts', () => {
    const chat = backgroundChat()
    const only: ChatDetail = { ...chat, messages: [{ id: 'msg_asst000000000029', role: 'assistant', parts: [{ type: 'step-start' }, taskResult(4)] }] }
    expect(renderChatMarkdown(only, NOW).split('\n\n').slice(2)).toEqual(['## Background task: Scan part 4 (completed)', 'Report 4: found **3** files.\n'])
    const parsed = chatExportSchema.parse(JSON.parse(buildChatExport(chat, 'json', NOW).body))
    expect(parsed.chat.messages).toEqual(chat.messages)
  })
})

/** A `data-hook` part (ADR-048): the record `n` of `event` with `outcome` and extra fields. */
function hookRecord(n: number, event: string, outcome: string, extra: Record<string, unknown> = {}): ChatDetail['messages'][number]['parts'][number] {
  return {
    type: 'data-hook',
    data: {
      id: `hev_000000000000000${n}`,
      event,
      outcome,
      createdAt: 5,
      hooks: [{ source: 'project', label: 'sh .claude/hooks/SECRET-LABEL.sh', exitCode: 0, durationMs: 12, systemMessage: 'SYSTEM-MESSAGE' }],
      ...extra,
    },
  } as ChatDetail['messages'][number]['parts'][number]
}

function hookChat(): ChatDetail {
  return {
    ...sampleChat(),
    title: 'Hooks at work',
    modelRef: 'mock:hooks',
    messages: [
      {
        id: 'msg_user000000000031',
        role: 'user',
        parts: [{ type: 'text', text: 'Fix the bug.' }, hookRecord(1, 'UserPromptSubmit', 'context', { context: 'Branch: main\nOpen issues: 2' })],
      },
      {
        id: 'msg_asst000000000031',
        role: 'assistant',
        metadata: { modelRef: 'mock:hooks', startedAt: 2 },
        parts: [
          { type: 'step-start' },
          { type: 'tool-write_file', toolCallId: 'call_w1', state: 'output-denied', input: { path: 'a.txt' }, approval: { id: 'ap_1', approved: false, reason: 'Blocked by hook: no writes' } },
          hookRecord(2, 'PreToolUse', 'denied', { toolCallId: 'call_w1', toolName: 'write_file', reason: 'No writes to a.txt.' }),
          hookRecord(3, 'PostToolUse', 'rewritten', { toolCallId: 'call_w2', toolName: 'write_file', updatedInput: { path: 'UPDATED-PATH' } }),
          // Invalid record data is left out.
          { type: 'data-hook', data: { id: 'nope', event: 'Stop', reason: 'BROKEN-RECORD' } } as ChatDetail['messages'][number]['parts'][number],
          { type: 'text', text: 'I could not write the file.' },
        ],
      },
      // The carrier of a Stop continuation: only records, no "## User" heading.
      { id: 'msg_user000000000032', role: 'user', parts: [hookRecord(4, 'Stop', 'continued', { reason: 'Run the tests first.' })] },
      { id: 'msg_asst000000000032', role: 'assistant', metadata: { modelRef: 'mock:hooks', startedAt: 4 }, parts: [{ type: 'step-start' }, { type: 'text', text: 'Hook continuation: Run the tests first.' }] },
    ],
  } as ChatDetail
}

const HOOK_MARKDOWN = `# Hooks at work

Exported from harness-forge on 2026-09-28 · Model: mock:hooks

## User

Fix the bug.

_Hook: UserPromptSubmit (context)_

> Branch: main
> Open issues: 2

## Assistant (mock:hooks)

**Tool** \`write_file\` (output-denied)

\`\`\`json
{
  "path": "a.txt"
}
\`\`\`

_Hook: PreToolUse (denied)_

Reason: No writes to a.txt.

_Hook: PostToolUse (rewritten)_

I could not write the file.

_Hook: Stop (continued)_

Reason: Run the tests first.

## Assistant (mock:hooks)

Hook continuation: Run the tests first.
`

describe('markdown export: hook records (Phase 11)', () => {
  it('renders each record as a line with its context and reason at its place; a carrier has no heading', () => {
    const markdown = renderChatMarkdown(hookChat(), NOW)
    expect(markdown).toBe(HOOK_MARKDOWN)
    for (const hidden of ['BROKEN-RECORD', 'SECRET-LABEL', 'SYSTEM-MESSAGE', 'UPDATED-PATH', 'hev_'])
      expect(markdown).not.toContain(hidden)
    expect(hookLine({ event: 'SessionStart', outcome: 'context' })).toBe('_Hook: SessionStart (context)_')
  })

  it('the json export keeps the hook parts as stored', () => {
    const chat = hookChat()
    const parsed = chatExportSchema.parse(JSON.parse(buildChatExport(chat, 'json', NOW).body))
    expect(parsed.chat.messages).toEqual(chat.messages)
  })
})

describe('json export', () => {
  it('is a version 2 ChatExport of the chat with running and pendingApproval false', () => {
    const file = buildChatExport(sampleChat(), 'json', NOW)
    expect(file.filename).toBe('plan-the-trip-2026-09-28.json')
    expect(file.contentType).toBe('application/json; charset=utf-8')
    const parsed = chatExportSchema.parse(JSON.parse(file.body))
    const { branches: _branches, projectId: _projectId, ...chat } = sampleChat()
    expect(parsed).toEqual({
      format: 'harness-forge.chat',
      version: 2,
      exportedAt: NOW,
      chat: {
        ...chat,
        running: false,
        pendingApproval: false,
        parentIds: [null, 'msg_user000000000001'],
        activeLeafId: 'msg_asst000000000001',
      },
    })
    expect(JSON.parse(file.body).chat).not.toHaveProperty('branches')
    expect(chatExportAnySchema.parse(JSON.parse(file.body)).version).toBe(2)
    expect(file.body.endsWith('}\n')).toBe(true)
  })

  it('never carries the project of the chat (ADR-031), in JSON or Markdown', () => {
    const project = 'prj_exportproject001'
    const chat = { ...sampleChat(), projectId: project }
    const json = buildChatExport(chat, 'json', NOW)
    expect(JSON.parse(json.body).chat).not.toHaveProperty('projectId')
    expect(json.body).not.toContain(project)
    expect(json.body).toBe(buildChatExport(sampleChat(), 'json', NOW).body)
    const markdown = buildChatExport(chat, 'md', NOW)
    expect(markdown.body).toBe(EXPECTED_MARKDOWN)
  })

  it('writes every version of the given tree, not only the active path of the detail', () => {
    const chat = sampleChat()
    const [question, answer] = chat.messages
    const retry = { ...answer!, id: 'msg_asst000000000009', parts: [{ type: 'text' as const, text: 'Another answer.' }] }
    const tree = { messages: [question!, answer!, retry], parentIds: [null, question!.id, question!.id], activeLeafId: retry.id }
    const parsed = chatExportSchema.parse(JSON.parse(buildChatExport({ ...chat, messages: [question!, retry] }, 'json', NOW, tree).body))
    expect(parsed.chat.messages.map(message => message.id)).toEqual([question!.id, answer!.id, retry.id])
    expect(parsed.chat.parentIds).toEqual([null, question!.id, question!.id])
    expect(parsed.chat.activeLeafId).toBe(retry.id)
    // Markdown shows the active path of the detail.
    const markdown = buildChatExport({ ...chat, messages: [question!, retry] }, 'md', NOW, tree).body
    expect(markdown).toContain('Another answer.')
    expect(markdown).not.toContain('Here are the options.')
  })

  it('linearTree chains the messages and ends at the last one', () => {
    const { messages } = sampleChat()
    expect(linearTree(messages)).toEqual({ messages, parentIds: [null, messages[0]!.id], activeLeafId: messages[1]!.id })
    expect(linearTree([])).toEqual({ messages: [], parentIds: [], activeLeafId: null })
  })

  it('exports an empty chat without an active leaf', () => {
    const file = buildChatExport({ ...sampleChat(), messages: [] }, 'json', NOW)
    expect(chatExportSchema.parse(JSON.parse(file.body)).chat).toMatchObject({ messages: [], parentIds: [], activeLeafId: null })
  })

  it('names markdown exports .md', () => {
    const file = buildChatExport(sampleChat(), 'md', NOW)
    expect(file.filename).toBe('plan-the-trip-2026-09-28.md')
    expect(file.contentType).toBe('text/markdown; charset=utf-8')
    expect(file.body).toBe(EXPECTED_MARKDOWN)
  })
})

describe('file names', () => {
  it.each([
    ['Plan the trip', 'plan-the-trip'],
    ['  ../../etc/passwd  ', 'etc-passwd'],
    ['Q3: "Revenue" / Costs?', 'q3-revenue-costs'],
    ['\u039A\u039F\u03A3\u039C\u039F\u03A3 2026', '\u03BA\u03BF\u03C3\u03BC\u03BF\u03C2-2026'],
    ['!!!', 'chat'],
    [null, 'chat'],
  ])('slug of %j is %j', (title, slug) => {
    expect(titleSlug(title)).toBe(slug)
  })

  it('caps the slug at 60 characters and adds the date and extension', () => {
    const name = exportFilename('word '.repeat(40), 'md', NOW)
    expect(name).toMatch(/^[a-z-]{1,60}-2026-09-28\.md$/)
    expect(name.startsWith('word-word')).toBe(true)
    expect(name).not.toContain('--')
  })
})
