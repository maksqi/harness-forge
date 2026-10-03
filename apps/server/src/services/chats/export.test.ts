import type { ChatDetail } from '@harness-forge/shared'
import { chatExportAnySchema, chatExportSchema } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { buildChatExport, EXPORT_TOOL_OUTPUT_BYTES, exportFilename, linearTree, renderChatMarkdown, titleSlug } from './export.ts'

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
