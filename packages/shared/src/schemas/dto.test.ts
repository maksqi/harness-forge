import type { UIMessage } from 'ai'
import type { z } from 'zod'
import type { HarnessUIMessage, MessageMetadata } from '../chat.ts'
import type { ServerEvent, ServerEventType, serverEventTypeSchema } from '../events.ts'
import type { SettingsProperty, settingsPropertySchema } from './plugin-settings.ts'
import { validateUIMessages } from 'ai'
import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  chatRequestBodySchema,
  harnessDataSchemas,
  harnessUIMessageSchema,
  messageMetadataSchema,
} from '../chat.ts'
import { conflictDetailsSchema } from '../errors.ts'
import { createServerEvent, SERVER_EVENT_TYPES, serverEventSchema } from '../events.ts'
import { createMessageId } from '../ids.ts'
import { isAllowedUploadMime, LIMITS, UPLOAD_MIME_PATTERNS } from '../limits.ts'
import {
  chatBranchBodySchema,
  chatCreateSchema,
  chatDetailSchema,
  chatExportAnySchema,
  chatExportSchema,
  chatExportV1Schema,
  chatExportV2Schema,
  chatsQuerySchema,
  chatSummarySchema,
  chatUpdateSchema,
  messageBranchSchema,
} from './chats.ts'
import {
  backupFileIndexSchema,
  backupManifestSchema,
  dataDeleteBodySchema,
  dataDeleteResultSchema,
  dataExportQuerySchema,
  dataImportFormSchema,
  dataImportResultSchema,
  dataSummarySchema,
} from './data.ts'
import { modelPrefsUpdateSchema, modelsQuerySchema } from './models.ts'
import { pluginFileParamsSchema, shareFileParamsSchema, shareParamsSchema, sharePublicParamsSchema } from './params.ts'
import {
  draftTestRequestSchema,
  iconFileInputSchema,
  pluginDraftSchema,
  pluginFileWriteSchema,
  pluginInstallBodySchema,
  pluginInstallFormSchema,
  pluginLogsQuerySchema,
  pluginManifestUpdateSchema,
  pluginTrustSchema,
} from './plugins.ts'
import { credentialsUpdateSchema } from './providers.ts'
import {
  shareCreateSchema,
  shareOptionsInputSchema,
  shareOptionsSchema,
  sharePartSchema,
  sharesQuerySchema,
  shareSummarySchema,
  shareUpdateSchema,
  shareViewSchema,
} from './shares.ts'
import { DEFAULT_SETTINGS, passwordUpdateSchema, SETTINGS_KEYS, settingsSchema, settingsUpdateSchema } from './system.ts'
import { mcpServerInputSchema, mcpServerUpdateSchema, toolUpdateSchema } from './tools.ts'

const CHAT_ID = '0199a8f0-0000-7000-8000-000000000001'
const MESSAGE_A = 'msg_A000000000000001'
const MESSAGE_B = 'msg_B000000000000001'
const SHARE_TOKEN = `sample0000000001${'A'.repeat(20)}_-`
const EMPTY_TOTALS = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null }

describe('settings', () => {
  it('applies the defaults of DECISIONS.md', () => {
    expect(DEFAULT_SETTINGS).toEqual({
      displayName: '',
      defaultModelRef: null,
      titleModelRef: null,
      instructions: '',
      sendKey: 'enter',
      defaultToolMode: 'ask',
      defaultReasoningEffort: 'auto',
      maxSteps: 20,
      altShortcuts: true,
      showThinking: false,
      density: 'comfortable',
      readingFont: 'sans',
      textSize: 'md',
    })
    expect(Object.isFrozen(DEFAULT_SETTINGS)).toBe(true)
    expect(SETTINGS_KEYS).toHaveLength(13)
    expect(settingsSchema.parse({ maxSteps: 5, _auth: 'internal' })).toEqual({ ...DEFAULT_SETTINGS, maxSteps: 5 })
  })

  it('validates partial updates strictly and without defaults', () => {
    expect(settingsUpdateSchema.parse({ maxSteps: 7 })).toEqual({ maxSteps: 7 })
    expect(settingsUpdateSchema.parse({ displayName: '  Ada  ' })).toEqual({ displayName: 'Ada' })
    for (const body of [{}, { maxSteps: 0 }, { maxSteps: 101 }, { unknown: 1 }, { sendKey: 'shift-enter' }, { defaultModelRef: 'no-colon' }])
      expect(settingsUpdateSchema.safeParse(body).success, JSON.stringify(body)).toBe(false)
    expect(settingsUpdateSchema.parse({ defaultModelRef: null, titleModelRef: 'ollama:llama3:8b' })).toEqual({ defaultModelRef: null, titleModelRef: 'ollama:llama3:8b' })
  })

  it('validates password updates', () => {
    expect(passwordUpdateSchema.safeParse({ newPassword: null }).success).toBe(true)
    expect(passwordUpdateSchema.safeParse({ currentPassword: 'old', newPassword: 'short' }).success).toBe(false)
    expect(passwordUpdateSchema.safeParse({ newPassword: 'long enough' }).success).toBe(true)
  })
})

describe('query schemas', () => {
  it('coerces booleans and integers from query strings', () => {
    expect(modelsQuerySchema.parse({ includeHidden: 'true' })).toEqual({ includeHidden: true })
    expect(modelsQuerySchema.parse({ includeHidden: '0' })).toEqual({ includeHidden: false })
    expect(modelsQuerySchema.parse({ includeHidden: false })).toEqual({ includeHidden: false })
    expect(modelsQuerySchema.safeParse({ includeHidden: 'yes' }).success).toBe(false)
    expect(chatsQuerySchema.parse({ limit: '25', q: ' hello ', archived: '1' })).toEqual({ limit: 25, q: 'hello', archived: true })
    expect(chatsQuerySchema.safeParse({ limit: '0' }).success).toBe(false)
    expect(chatsQuerySchema.safeParse({ limit: '101' }).success).toBe(false)
    expect(chatsQuerySchema.safeParse({ limit: '1.5' }).success).toBe(false)
    expect(chatsQuerySchema.safeParse({ cursor: 'not base64url!' }).success).toBe(false)
    expect(pluginLogsQuerySchema.parse({ after: '12', limit: '500' })).toEqual({ after: 12, limit: 500 })
    expect(pluginLogsQuerySchema.safeParse({ limit: '501' }).success).toBe(false)
  })

  it('ignores unknown query and param keys', () => {
    expect(chatsQuerySchema.parse({ q: 'x', _: '123' })).toEqual({ q: 'x' })
  })
})

describe('chat contract', () => {
  const userMessage = { id: 'msg_gate000000000001', role: 'user', parts: [{ type: 'text', text: 'ping' }] }

  it('accepts the gate W2 request body', () => {
    const body = {
      chatId: CHAT_ID,
      message: userMessage,
      trigger: 'submit-message',
      modelRef: 'mock:echo',
      reasoningEffort: 'auto',
      toolMode: 'ask',
    }
    expect(chatRequestBodySchema.parse(body)).toEqual(body)
  })

  it('accepts parentId (a message id or null) and messageId', () => {
    const body = { chatId: CHAT_ID, message: userMessage, trigger: 'submit-message', modelRef: 'mock:echo', reasoningEffort: 'auto', toolMode: 'ask' }
    expect(chatRequestBodySchema.parse({ ...body, parentId: null })).toMatchObject({ parentId: null })
    expect(chatRequestBodySchema.parse({ ...body, parentId: MESSAGE_A })).toMatchObject({ parentId: MESSAGE_A })
    expect(chatRequestBodySchema.parse({ ...body, trigger: 'regenerate-message', messageId: MESSAGE_B })).toMatchObject({ messageId: MESSAGE_B })
  })

  it('rejects invalid chat requests', () => {
    const body = { chatId: CHAT_ID, message: userMessage, trigger: 'submit-message', modelRef: 'mock:echo', reasoningEffort: 'auto', toolMode: 'ask' }
    for (const change of [
      { chatId: 'not-a-uuid' },
      { message: { ...userMessage, id: 'client-id' } },
      { message: { ...userMessage, parts: [{ text: 'no type' }] } },
      { trigger: 'resume' },
      { messageId: 'msg_short' },
      { parentId: 'msg_short' },
      { parentId: '' },
      { modelRef: 'mock' },
      { toolMode: 'yolo' },
      { extra: true },
    ])
      expect(chatRequestBodySchema.safeParse({ ...body, ...change }).success, JSON.stringify(change)).toBe(false)
  })

  it('keeps every part field of UI messages', () => {
    const message = {
      id: 'msg_A000000000000001',
      role: 'assistant',
      metadata: { modelRef: 'mock:echo', startedAt: 1 },
      parts: [
        { type: 'step-start' },
        { type: 'tool-mock_approval_tool', toolCallId: 'mock_call_1', state: 'approval-requested', input: { text: 'x' }, approval: { id: 'ap_1' } },
        { type: 'data-notice', data: { level: 'info', code: 'context-trimmed', message: 'Trimmed' } },
      ],
    }
    expect(harnessUIMessageSchema.parse(message)).toEqual(message)
    expect(harnessUIMessageSchema.safeParse({ ...message, parts: Array.from({ length: LIMITS.messagePartsMax + 1 }, () => ({ type: 'step-start' })) }).success).toBe(false)
  })

  it('works with the AI SDK validateUIMessages', async () => {
    const messages: HarnessUIMessage[] = [
      { id: createMessageId(), role: 'user', metadata: { modelRef: 'mock:echo', startedAt: 1 }, parts: [{ type: 'text', text: 'hi' }] },
      {
        id: createMessageId(),
        role: 'assistant',
        metadata: { modelRef: 'mock:echo', startedAt: 2, finishedAt: 3, usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop' },
        parts: [{ type: 'data-notice', data: { level: 'warning', code: 'tools-unsupported', message: 'No tools' } }, { type: 'text', text: 'hi', state: 'done' }],
      },
    ]
    await expect(validateUIMessages<HarnessUIMessage>({ messages, metadataSchema: messageMetadataSchema, dataSchemas: harnessDataSchemas })).resolves.toHaveLength(2)
    const invalid = [{ ...messages[1], parts: [{ type: 'data-notice', data: { level: 'loud' } }] }]
    await expect(validateUIMessages<HarnessUIMessage>({ messages: invalid, metadataSchema: messageMetadataSchema, dataSchemas: harnessDataSchemas })).rejects.toThrow()
  })

  it('types messages as AI SDK UI messages', () => {
    expectTypeOf<z.output<typeof harnessUIMessageSchema>>().toEqualTypeOf<HarnessUIMessage>()
    expectTypeOf<HarnessUIMessage>().toExtend<UIMessage<MessageMetadata>>()
    expectTypeOf<z.input<typeof harnessUIMessageSchema>>().toBeObject()
    const message = {} as HarnessUIMessage
    const input: z.input<typeof chatRequestBodySchema>['message'] = message
    expect(input).toBe(message)
  })
})

describe('chats', () => {
  const summary = {
    id: CHAT_ID,
    title: null,
    titleSource: null,
    modelRef: 'mock:echo',
    pinned: false,
    archived: false,
    running: false,
    pendingApproval: false,
    createdAt: 1,
    updatedAt: 2,
  }

  it('parses summaries and details', () => {
    expect(chatSummarySchema.parse(summary)).toEqual(summary)
    const detail = { ...summary, settings: { toolMode: 'auto' }, messages: [], branches: {}, totals: EMPTY_TOTALS }
    expect(chatDetailSchema.parse(detail)).toEqual(detail)
  })

  it('requires branches on details: path messages with at least two versions', () => {
    const detail = { ...summary, settings: {}, messages: [], totals: EMPTY_TOTALS }
    expect(chatDetailSchema.safeParse(detail).success).toBe(false)
    const branches = { [MESSAGE_B]: { siblings: [MESSAGE_A, MESSAGE_B], index: 1 } }
    expect(chatDetailSchema.parse({ ...detail, branches }).branches).toEqual(branches)
    expect(chatDetailSchema.safeParse({ ...detail, branches: { 'not-an-id': { siblings: [MESSAGE_A, MESSAGE_B], index: 0 } } }).success).toBe(false)
    expect(messageBranchSchema.safeParse({ siblings: [MESSAGE_A], index: 0 }).success).toBe(false)
    expect(messageBranchSchema.safeParse({ siblings: [MESSAGE_A, MESSAGE_B], index: -1 }).success).toBe(false)
    expect(chatBranchBodySchema.parse({ messageId: MESSAGE_A })).toEqual({ messageId: MESSAGE_A })
    expect(chatBranchBodySchema.safeParse({ messageId: MESSAGE_A, extra: 1 }).success).toBe(false)
    expect(chatBranchBodySchema.safeParse({}).success).toBe(false)
  })

  it('accepts a message tree on import (parentIds aligned by index, activeLeafId)', () => {
    const messages = [
      { id: MESSAGE_A, role: 'user', parts: [{ type: 'text', text: 'v1' }] },
      { id: MESSAGE_B, role: 'user', parts: [{ type: 'text', text: 'v2' }] },
    ]
    const input = { messages, parentIds: [null, null], activeLeafId: MESSAGE_A }
    expect(chatCreateSchema.parse(input)).toEqual(input)
    expect(chatCreateSchema.safeParse({ parentIds: Array.from({ length: LIMITS.chatImportMessagesMax + 1 }).fill(null) }).success).toBe(false)
    expect(chatCreateSchema.safeParse({ activeLeafId: '' }).success).toBe(false)
    expect(chatCreateSchema.safeParse({ parentIds: [''] }).success).toBe(false)
  })

  it('reads chat exports of version 1 and 2 and writes version 2', () => {
    const message = { id: MESSAGE_A, role: 'user', metadata: { modelRef: 'mock:echo', startedAt: 1 }, parts: [{ type: 'text', text: 'hi' }] }
    const base = { ...summary, settings: {}, totals: EMPTY_TOTALS }
    const v1 = { format: 'harness-forge.chat', version: 1, exportedAt: 5, chat: { ...base, messages: [message] } }
    const v2 = { format: 'harness-forge.chat', version: 2, exportedAt: 5, chat: { ...base, messages: [message], parentIds: [null], activeLeafId: MESSAGE_A } }
    expect(chatExportV1Schema.parse(v1)).toEqual(v1)
    expect(chatExportV2Schema.parse(v2)).toEqual(v2)
    expect(chatExportSchema).toBe(chatExportV2Schema)
    expect(chatExportAnySchema.parse(v1).version).toBe(1)
    expect(chatExportAnySchema.parse(v2).version).toBe(2)
    expect(chatExportAnySchema.safeParse({ ...v2, version: 3 }).success).toBe(false)
    expect(chatExportV2Schema.safeParse({ ...v2, chat: { ...v2.chat, activeLeafId: undefined } }).success).toBe(false)
    expect(chatExportV2Schema.parse({ ...v2, chat: { ...v2.chat, messages: [], parentIds: [], activeLeafId: null } }).chat.activeLeafId).toBeNull()
    // Version 1 carries no branches; exports never carry them.
    expect(chatExportV1Schema.parse({ ...v1, chat: { ...v1.chat, branches: {} } }).chat).not.toHaveProperty('branches')
  })

  it('validates creates and updates', () => {
    expect(chatCreateSchema.parse({})).toEqual({})
    expect(chatCreateSchema.parse({ id: CHAT_ID, title: ' Hello ' })).toEqual({ id: CHAT_ID, title: 'Hello' })
    expect(chatCreateSchema.safeParse({ messages: Array.from({ length: LIMITS.chatImportMessagesMax + 1 }, () => ({ id: 'x', role: 'user', parts: [] })) }).success).toBe(false)
    expect(chatUpdateSchema.safeParse({}).success).toBe(false)
    expect(chatUpdateSchema.parse({ modelRef: null, settings: { instructions: null } })).toEqual({ modelRef: null, settings: { instructions: null } })
    expect(chatUpdateSchema.safeParse({ title: '   ' }).success).toBe(false)
  })
})

describe('bulk data (ADR-024)', () => {
  it('validates the backup manifest and file index', () => {
    const manifest = {
      format: 'harness-forge.backup',
      version: 1,
      exportedAt: 5,
      appVersion: '1.1.0',
      chatExportVersion: 2,
      includes: { files: true, settings: false },
      counts: { chats: 1, messages: 2, files: 1, fileBytes: 5 },
    }
    expect(backupManifestSchema.parse(manifest)).toEqual(manifest)
    expect(backupManifestSchema.safeParse({ ...manifest, version: 2 }).success).toBe(false)
    expect(backupManifestSchema.safeParse({ ...manifest, chatExportVersion: 1 }).success).toBe(false)
    const entry = { id: 'file_ABCdef0123456789', sha256: 'a'.repeat(64), name: 'notes.txt', mime: 'text/plain', size: 5, createdAt: 1 }
    expect(backupFileIndexSchema.parse({ items: [entry] })).toEqual({ items: [entry] })
    expect(backupFileIndexSchema.safeParse({ items: [{ ...entry, size: LIMITS.uploadBytes + 1 }] }).success).toBe(false)
    expect(backupFileIndexSchema.safeParse({ items: [{ ...entry, sha256: 'A'.repeat(64) }] }).success).toBe(false)
  })

  it('coerces the export query and the import form fields', () => {
    expect(dataExportQuerySchema.parse({ files: 'false', settings: '1' })).toEqual({ files: false, settings: true })
    expect(dataExportQuerySchema.parse({})).toEqual({})
    expect(dataExportQuerySchema.safeParse({ files: 'no' }).success).toBe(false)
    const file = new File(['{}'], 'chat.json', { type: 'application/json' })
    expect(dataImportFormSchema.parse({ file, onConflict: 'copy', restoreSettings: 'true' })).toEqual({ onConflict: 'copy', restoreSettings: true })
    expect(dataImportFormSchema.safeParse({ onConflict: 'overwrite' }).success).toBe(false)
  })

  it('validates the summary, the import result and delete-all', () => {
    expect(dataSummarySchema.parse({ chats: 2, archivedChats: 1, messages: 9, files: 1, fileBytes: 5 })).toBeTruthy()
    const result = {
      kind: 'backup',
      counts: { imported: 1, copied: 0, skipped: 1, failed: 1, filesImported: 1, filesReused: 0, filesMissing: 1 },
      settingsRestored: false,
      items: [
        { sourceId: CHAT_ID, chatId: CHAT_ID, title: 'Trip', status: 'imported' },
        { sourceId: 'chats/broken.json', chatId: null, title: null, status: 'failed', error: 'Invalid chat export.' },
      ],
      warnings: ['Unknown entry: notes.txt'],
    }
    expect(dataImportResultSchema.parse(result)).toEqual(result)
    expect(dataDeleteBodySchema.parse({ confirm: 'DELETE', files: true })).toEqual({ confirm: 'DELETE', files: true })
    for (const body of [{}, { confirm: 'delete' }, { confirm: 'DELETE', extra: true }, { confirm: 'DELETE', usage: 'yes' }])
      expect(dataDeleteBodySchema.safeParse(body).success, JSON.stringify(body)).toBe(false)
    expect(dataDeleteResultSchema.parse({ chats: 1, messages: 2, files: 0, fileBytes: 0, usageRows: 0 })).toBeTruthy()
    expect(conflictDetailsSchema.parse({ reason: 'busy' })).toEqual({ reason: 'busy' })
  })
})

describe('share links (ADR-025)', () => {
  it('applies option defaults only where options are complete', () => {
    expect(shareOptionsSchema.parse({})).toEqual({ reasoning: false, toolDetails: false, attachments: true })
    // A partial update must never reset the options it does not name.
    expect(shareOptionsInputSchema.parse({ reasoning: true })).toEqual({ reasoning: true })
    expect(shareOptionsInputSchema.safeParse({ comments: true }).success).toBe(false)
  })

  it('validates creates, updates and the list query', () => {
    expect(shareCreateSchema.parse({ chatId: CHAT_ID, title: ' Trip ', options: { toolDetails: true }, expiresAt: null }))
      .toEqual({ chatId: CHAT_ID, title: 'Trip', options: { toolDetails: true }, expiresAt: null })
    expect(shareCreateSchema.safeParse({ chatId: CHAT_ID, extra: 1 }).success).toBe(false)
    expect(shareCreateSchema.safeParse({ chatId: 'x' }).success).toBe(false)
    expect(shareUpdateSchema.parse({ refresh: true })).toEqual({ refresh: true })
    expect(shareUpdateSchema.parse({ title: null, expiresAt: 10 })).toEqual({ title: null, expiresAt: 10 })
    for (const body of [{}, { refresh: false }, { title: '   ' }, { token: 'x' }])
      expect(shareUpdateSchema.safeParse(body).success, JSON.stringify(body)).toBe(false)
    expect(sharesQuerySchema.parse({ chatId: CHAT_ID, _: '1' })).toEqual({ chatId: CHAT_ID })
  })

  it('parses summaries, parts and the public view', () => {
    const summary = {
      id: 'shr_sample0000000001',
      chatId: CHAT_ID,
      chatTitle: 'Trip',
      title: null,
      options: { reasoning: false, toolDetails: false, attachments: true },
      path: `/share/${SHARE_TOKEN}`,
      messageCount: 2,
      snapshotAt: 5,
      outdated: false,
      expiresAt: null,
      expired: false,
      createdAt: 5,
    }
    expect(shareSummarySchema.parse(summary)).toEqual(summary)
    expect(shareSummarySchema.safeParse({ ...summary, id: 'share_1' }).success).toBe(false)
    expect(sharePartSchema.parse({ type: 'tool', toolName: 'current_time', status: 'done', input: {}, output: { now: 1 } })).toBeTruthy()
    for (const part of [{ type: 'step-start' }, { type: 'data-notice', data: {} }, { type: 'tool', toolName: 'x', status: 'approval-requested' }, { type: 'text' }])
      expect(sharePartSchema.safeParse(part).success, JSON.stringify(part)).toBe(false)
    const view = {
      title: 'Trip',
      snapshotAt: 5,
      options: summary.options,
      messages: [
        { role: 'user', command: { name: 'tldr' }, parts: [{ type: 'text', text: 'hi' }] },
        { role: 'assistant', modelRef: 'mock:echo', status: 'stopped', parts: [{ type: 'file', mediaType: 'image/png', url: `/api/share/${SHARE_TOKEN}/files/file_ABCdef0123456789` }] },
      ],
    }
    expect(shareViewSchema.parse(view)).toEqual(view)
    expect(shareViewSchema.safeParse({ ...view, messages: [{ role: 'system', parts: [] }] }).success).toBe(false)
  })

  it('validates share params', () => {
    expect(shareParamsSchema.safeParse({ id: 'shr_sample0000000001' }).success).toBe(true)
    expect(sharePublicParamsSchema.safeParse({ token: SHARE_TOKEN }).success).toBe(true)
    expect(shareFileParamsSchema.safeParse({ token: SHARE_TOKEN, fileId: 'file_ABCdef0123456789' }).success).toBe(true)
    for (const token of ['', SHARE_TOKEN.slice(1), `${SHARE_TOKEN}x`, `sample000000000!${'A'.repeat(22)}`, `sample0000000001${'A'.repeat(21)}=`])
      expect(sharePublicParamsSchema.safeParse({ token }).success, token).toBe(false)
  })
})

describe('providers, models, tools and MCP', () => {
  it('validates credentials updates', () => {
    expect(credentialsUpdateSchema.parse({ values: { apiKey: ' sk-123 \n', baseURL: '' } })).toEqual({ values: { apiKey: 'sk-123', baseURL: '' } })
    expect(credentialsUpdateSchema.safeParse({ values: { 'api-key': 'x' } }).success).toBe(false)
    expect(credentialsUpdateSchema.safeParse({ values: { apiKey: 'x'.repeat(4097) } }).success).toBe(false)
  })

  it('needs at least one model pref', () => {
    expect(modelPrefsUpdateSchema.safeParse({ providerId: 'openai', modelId: 'gpt-6-sol' }).success).toBe(false)
    expect(modelPrefsUpdateSchema.safeParse({ providerId: 'openai', modelId: 'gpt-6-sol', hidden: null }).success).toBe(true)
  })

  it('validates tool and MCP updates', () => {
    expect(toolUpdateSchema.safeParse({}).success).toBe(false)
    expect(toolUpdateSchema.parse({ override: null })).toEqual({ override: null })
    expect(mcpServerInputSchema.safeParse({ id: 'files', name: 'Files', transport: { type: 'stdio', command: 'npx', args: ['-y', 'server'], env: { TOKEN: 'x' } } }).success).toBe(true)
    expect(mcpServerInputSchema.safeParse({ id: 'files', name: 'Files', transport: { type: 'http', url: 'javascript:alert(1)' } }).success).toBe(false)
    expect(mcpServerInputSchema.safeParse({ id: 'files', name: 'Files', transport: { type: 'http', url: 'https://x.example.com', headers: { Authorization: 'a\nb' } } }).success).toBe(false)
    expect(mcpServerUpdateSchema.parse({ transport: { type: 'http', url: 'https://x.example.com/mcp', headers: { Authorization: null } } })).toBeTruthy()
    expect(mcpServerUpdateSchema.safeParse({}).success).toBe(false)
  })
})

describe('plugins', () => {
  const manifest = {
    manifestVersion: 1,
    id: 'lmstudio',
    name: 'LM Studio',
    version: '1.0.0',
    engines: { harness: '^1.0.0' },
    contributes: { providers: [{ id: 'lmstudio', name: 'LM Studio', baseURL: 'http://localhost:1234/v1', apiFormat: 'openai-chat', auth: { type: 'none' } }] },
  }

  it('validates drafts', () => {
    expect(pluginDraftSchema.safeParse({ manifest, credentials: { lmstudio: { apiKey: '' } } }).success).toBe(true)
    expect(pluginDraftSchema.safeParse({ manifest: { ...manifest, main: 'index.mjs' } }).success).toBe(false)
    expect(pluginDraftSchema.safeParse({ manifest, credentials: { other: {} } }).success).toBe(false)
    expect(pluginDraftSchema.safeParse({ manifest: { ...manifest, icon: 'icon.svg' } }).success).toBe(false)
    const iconFile = { name: 'icon.svg', base64: btoa('<svg xmlns="http://www.w3.org/2000/svg"/>') }
    expect(pluginDraftSchema.safeParse({ manifest: { ...manifest, icon: 'icon.svg' }, iconFile }).success).toBe(true)
    expect(pluginDraftSchema.safeParse({ manifest: { ...manifest, icon: 'lobe:lmstudio' }, iconFile }).success).toBe(false)
    // Reserved ids are answered with 403 by the server, so the draft schema accepts them.
    expect(pluginDraftSchema.safeParse({ manifest: { ...manifest, id: 'mock', contributes: {} } }).success).toBe(true)
    expect(pluginManifestUpdateSchema.safeParse({ manifest: { ...manifest, icon: 'icon.png' } }).success).toBe(true)
  })

  it('limits icon files to 256 KB', () => {
    expect(iconFileInputSchema.safeParse({ name: 'icon.png', base64: 'A'.repeat(349_528) }).success).toBe(false)
    expect(iconFileInputSchema.safeParse({ name: 'icon.png', base64: 'not base64!' }).success).toBe(false)
    expect(iconFileInputSchema.safeParse({ name: 'icon.gif', base64: 'AAAA' }).success).toBe(false)
  })

  it('requires modelId for draft pings', () => {
    const request = { provider: manifest.contributes.providers[0], action: 'ping' }
    expect(draftTestRequestSchema.safeParse(request).success).toBe(false)
    expect(draftTestRequestSchema.safeParse({ ...request, modelId: 'qwen3' }).success).toBe(true)
  })

  it('validates install sources', () => {
    const valid = [
      { source: 'npm', spec: 'harness-plugin-dice' },
      { source: 'npm', spec: '@scope/plugin@^1.2.0', trust: true },
      { source: 'url', url: 'https://example.com/p.zip', integrity: `sha256-${'A'.repeat(43)}=` },
      { source: 'url', url: 'https://example.com/p.tgz', integrity: `sha512-${'B'.repeat(86)}==`, enable: false },
      { source: 'path', path: '/home/me/plugins/dice-roller', mode: 'link' },
      { source: 'path', path: 'C:\\plugins\\dice', mode: 'copy' },
    ]
    for (const body of valid)
      expect(pluginInstallBodySchema.safeParse(body).success, JSON.stringify(body)).toBe(true)
    const invalid = [
      { source: 'npm', spec: 'Bad Name' },
      { source: 'url', url: 'http://example.com/p.zip', integrity: `sha256-${'A'.repeat(43)}=` },
      { source: 'url', url: 'https://example.com/p.zip', integrity: 'md5-abc' },
      { source: 'path', path: 'relative/dir', mode: 'link' },
      { source: 'git', url: 'x' },
      { source: 'npm', spec: 'x', extra: 1 },
    ]
    for (const body of invalid)
      expect(pluginInstallBodySchema.safeParse(body).success, JSON.stringify(body)).toBe(false)
    expect(pluginInstallFormSchema.parse({ trust: 'true', file: 'dropped' })).toEqual({ trust: 'true' })
  })

  it('accepts link trust pins', () => {
    expect(pluginTrustSchema.safeParse({ required: true, trusted: true, hash: 'a'.repeat(64), trustedHash: `path:${'b'.repeat(64)}` }).success).toBe(true)
  })

  it('validates plugin file paths and writes', () => {
    for (const path of ['index.mjs', 'src/lib/tools.ts', '.env.example'])
      expect(pluginFileParamsSchema.safeParse({ id: 'x', path }).success, path).toBe(true)
    for (const path of ['', '/abs', '../up', 'a/./b', 'a\\b', 'a//b', 'sp ace', 'a/b/c/d/e/f/g/h/i', 'x'.repeat(257)])
      expect(pluginFileParamsSchema.safeParse({ id: 'x', path }).success, path).toBe(false)
    expect(pluginFileWriteSchema.safeParse({ content: 'a\0b' }).success).toBe(false)
    expect(pluginFileWriteSchema.safeParse({ content: 'é'.repeat(LIMITS.pluginFileBytes / 2 + 1) }).success).toBe(false)
    expect(pluginFileWriteSchema.safeParse({ content: 'ok', baseEtag: 'c'.repeat(64) }).success).toBe(true)
  })
})

describe('server events', () => {
  it('covers the 9 event types', () => {
    expect(SERVER_EVENT_TYPES).toHaveLength(9)
    expectTypeOf<ServerEventType>().toEqualTypeOf<z.infer<typeof serverEventTypeSchema>>()
  })

  it('parses events and builds them', () => {
    const event = createServerEvent('run.finished', { chatId: CHAT_ID, messageId: 'msg_A000000000000001', outcome: 'completed', awaitingApproval: true }, 5)
    expect(serverEventSchema.parse(event)).toEqual({ type: 'run.finished', data: { chatId: CHAT_ID, messageId: 'msg_A000000000000001', outcome: 'completed', awaitingApproval: true }, at: 5 })
    expect(serverEventSchema.parse({ type: 'catalog.changed', data: { providerId: null }, at: 1 })).toBeTruthy()
    expect(serverEventSchema.safeParse({ type: 'chat.renamed', data: {}, at: 1 }).success).toBe(false)
    const deleted: ServerEvent = { type: 'chat.deleted', data: { id: CHAT_ID }, at: 1 }
    expect(serverEventSchema.parse(deleted)).toEqual(deleted)
  })
})

describe('misc', () => {
  it('matches upload MIME types', () => {
    expect(UPLOAD_MIME_PATTERNS).toEqual(['image/*', 'application/pdf', 'text/*'])
    for (const mime of ['image/png', 'text/plain; charset=utf-8', 'application/pdf', 'IMAGE/JPEG'])
      expect(isAllowedUploadMime(mime), mime).toBe(true)
    for (const mime of ['application/zip', 'video/mp4', 'image', 'application/pdfx'])
      expect(isAllowedUploadMime(mime), mime).toBe(false)
  })

  it('infers SettingsProperty from the schema', () => {
    expectTypeOf<z.infer<typeof settingsPropertySchema>>().toEqualTypeOf<SettingsProperty>()
  })
})
