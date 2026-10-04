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
import { modelKindSchema } from '../enums.ts'
import { conflictDetailsSchema, conflictReasonSchema } from '../errors.ts'
import { chatUpdatedDataSchema, createServerEvent, SERVER_EVENT_TYPES, serverEventSchema } from '../events.ts'
import { createMessageId } from '../ids.ts'
import { isAllowedUploadMime, LIMITS, UPLOAD_MIME_PATTERNS } from '../limits.ts'
import {
  audioSpeechBodySchema,
  audioTranscribeFormSchema,
  audioTranscriptionSchema,
  speechVoiceSchema,
  transcriptionLanguageSchema,
} from './audio.ts'
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
import {
  GENERATE_IMAGE_TOOL_NAME,
  GENERATED_IMAGE_MIME_TYPES,
  generateImageToolInputSchema,
  generateImageToolOutputSchema,
  IMAGE_ASPECT_RATIOS,
  imageAspectRatioSchema,
  imageOptionsSchema,
  imageTurnMetadataSchema,
} from './images.ts'
import { catalogModelSchema, customModelInputSchema, modelCapabilitiesSchema, modelPrefsUpdateSchema, modelsQuerySchema } from './models.ts'
import {
  chatMessageParamsSchema,
  pluginFileParamsSchema,
  shareFileParamsSchema,
  shareParamsSchema,
  sharePublicParamsSchema,
} from './params.ts'
import { modelInfoSchema } from './plugin-data.ts'
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
      imageModelRef: null,
      transcriptionModelRef: null,
      transcriptionLanguage: 'auto',
      speechModelRef: null,
      speechVoice: null,
      speechSpeed: 1,
      projectMaxSteps: 100,
      fileSweep: 'off',
      autoCompact: true,
      compactModelRef: null,
      subagentModelRef: null,
      subagentMaxSteps: 30,
      shiftTabModes: true,
      planFiles: false,
      planDirectory: '.harness/plans',
    })
    expect(Object.isFrozen(DEFAULT_SETTINGS)).toBe(true)
    expect(SETTINGS_KEYS).toHaveLength(28)
    expect(settingsSchema.parse({ maxSteps: 5, _auth: 'internal' })).toEqual({ ...DEFAULT_SETTINGS, maxSteps: 5 })
  })

  it('reads settings stored by v1.1 (without the Phase 6, 7, 8 and 9 keys) with the new defaults', () => {
    const v11 = {
      displayName: 'Ada',
      defaultModelRef: 'openai:gpt-6-sol',
      titleModelRef: null,
      instructions: 'Be brief.',
      sendKey: 'mod-enter',
      defaultToolMode: 'auto',
      defaultReasoningEffort: 'high',
      maxSteps: 30,
      altShortcuts: false,
      showThinking: true,
      density: 'compact',
      readingFont: 'serif',
      textSize: 'lg',
    }
    expect(settingsSchema.parse(v11)).toEqual({
      ...v11,
      imageModelRef: null,
      transcriptionModelRef: null,
      transcriptionLanguage: 'auto',
      speechModelRef: null,
      speechVoice: null,
      speechSpeed: 1,
      projectMaxSteps: 100,
      fileSweep: 'off',
      autoCompact: true,
      compactModelRef: null,
      subagentModelRef: null,
      subagentMaxSteps: 30,
      shiftTabModes: true,
      planFiles: false,
      planDirectory: '.harness/plans',
    })
  })

  it('reads settings stored by v1.4 (without the Phase 9 keys) with the new defaults', () => {
    const v14 = {
      displayName: 'Ada',
      defaultModelRef: 'anthropic:claude-sonnet-5',
      titleModelRef: null,
      instructions: '',
      sendKey: 'enter',
      defaultToolMode: 'edits',
      defaultReasoningEffort: 'auto',
      maxSteps: 20,
      altShortcuts: true,
      showThinking: false,
      density: 'comfortable',
      readingFont: 'sans',
      textSize: 'md',
      imageModelRef: null,
      transcriptionModelRef: null,
      transcriptionLanguage: 'auto',
      speechModelRef: null,
      speechVoice: null,
      speechSpeed: 1,
      projectMaxSteps: 100,
      fileSweep: 'daily',
    }
    expect(settingsSchema.parse(v14)).toEqual({ ...v14, autoCompact: true, compactModelRef: null, subagentModelRef: null, subagentMaxSteps: 30, shiftTabModes: true, planFiles: false, planDirectory: '.harness/plans' })
  })

  it('reads settings stored by v1.5 (without the Phase 10 keys) with the new defaults', () => {
    const v15 = { ...DEFAULT_SETTINGS, instructions: 'Be brief.', subagentMaxSteps: 12 } as Record<string, unknown>
    delete v15.planFiles
    delete v15.planDirectory
    expect(settingsSchema.parse(v15)).toEqual({ ...DEFAULT_SETTINGS, instructions: 'Be brief.', subagentMaxSteps: 12 })
  })

  it('validates the plan file settings (Phase 10, ADR-047)', () => {
    const update = { planFiles: true, planDirectory: 'docs/plans' }
    expect(settingsUpdateSchema.parse(update)).toEqual(update)
    expect(settingsUpdateSchema.parse({ planDirectory: '  .harness/plans  ' })).toEqual({ planDirectory: '.harness/plans' })
    for (const value of ['plans', '.harness/plans', 'a/b/c', 'notes.d/plans', '.claude/plans', 'x'.repeat(200)])
      expect(settingsUpdateSchema.safeParse({ planDirectory: value }).success, value).toBe(true)
    for (const value of [
      '',
      '   ',
      '/abs/plans',
      '\\server\\plans',
      'C:/plans',
      'c:plans',
      '../x',
      'a/../b',
      'a/..',
      '.git/x',
      'a/.GIT/b',
      'a//b',
      'a/',
      './plans',
      'a\u0000b',
      'a\nb',
      'x'.repeat(201),
      null,
    ])
      expect(settingsUpdateSchema.safeParse({ planDirectory: value }).success, JSON.stringify(value)).toBe(false)
    for (const value of ['yes', null, 1])
      expect(settingsUpdateSchema.safeParse({ planFiles: value }).success, JSON.stringify(value)).toBe(false)
  })

  it('validates the agent settings and the plan mode (Phase 9, ADR-040 … ADR-043)', () => {
    const update = { autoCompact: false, compactModelRef: 'openai:gpt-6-mini', subagentModelRef: null, subagentMaxSteps: 200, shiftTabModes: false, defaultToolMode: 'plan' }
    expect(settingsUpdateSchema.parse(update)).toEqual(update)
    expect(settingsSchema.parse({ subagentMaxSteps: 1 }).subagentMaxSteps).toBe(1)
    for (const body of [
      { autoCompact: 'yes' },
      { autoCompact: null },
      { compactModelRef: 'no-colon' },
      { subagentModelRef: '' },
      { subagentMaxSteps: 0 },
      { subagentMaxSteps: 201 },
      { subagentMaxSteps: 2.5 },
      { subagentMaxSteps: null },
      { shiftTabModes: 1 },
      { defaultToolMode: 'planning' },
    ])
      expect(settingsUpdateSchema.safeParse(body).success, JSON.stringify(body)).toBe(false)
  })

  it('validates the automatic file sweep setting (Phase 8, ADR-039)', () => {
    expect(settingsUpdateSchema.parse({ fileSweep: 'weekly' })).toEqual({ fileSweep: 'weekly' })
    expect(settingsSchema.parse({ fileSweep: 'daily' }).fileSweep).toBe('daily')
    for (const value of ['monthly', 'on', null, true, ''])
      expect(settingsUpdateSchema.safeParse({ fileSweep: value }).success, String(value)).toBe(false)
  })

  it('accepts up to 200 steps and the edits mode (Phase 7, ADR-032)', () => {
    expect(LIMITS.stepsMax).toBe(200)
    expect(settingsUpdateSchema.parse({ maxSteps: 200, projectMaxSteps: 1, defaultToolMode: 'edits' })).toEqual({ maxSteps: 200, projectMaxSteps: 1, defaultToolMode: 'edits' })
    for (const body of [{ maxSteps: 201 }, { projectMaxSteps: 0 }, { projectMaxSteps: 201 }, { projectMaxSteps: 1.5 }, { projectMaxSteps: null }])
      expect(settingsUpdateSchema.safeParse(body).success, JSON.stringify(body)).toBe(false)
    // Settings stored by v1.2 keep their maxSteps and get the projectMaxSteps default.
    expect(settingsSchema.parse({ maxSteps: 40 })).toMatchObject({ maxSteps: 40, projectMaxSteps: 100 })
  })

  it('validates the image and voice settings (Phase 6)', () => {
    const update = {
      imageModelRef: 'openai:gpt-image-2',
      transcriptionModelRef: 'groq:whisper-large-v3-turbo',
      transcriptionLanguage: 'de',
      speechModelRef: 'openai:gpt-4o-mini-tts',
      speechVoice: '  alloy ',
      speechSpeed: 1.25,
    }
    expect(settingsUpdateSchema.parse(update)).toEqual({ ...update, speechVoice: 'alloy' })
    expect(settingsUpdateSchema.parse({ transcriptionLanguage: 'auto', speechVoice: null, imageModelRef: null })).toEqual({ transcriptionLanguage: 'auto', speechVoice: null, imageModelRef: null })
    for (const body of [
      { imageModelRef: 'gpt-image-2' },
      { transcriptionLanguage: 'EN' },
      { transcriptionLanguage: 'english' },
      { transcriptionLanguage: null },
      { speechVoice: '' },
      { speechVoice: 'a<b>' },
      { speechVoice: 'v'.repeat(65) },
      { speechSpeed: 0.25 },
      { speechSpeed: 2.5 },
      { speechSpeed: null },
    ])
      expect(settingsUpdateSchema.safeParse(body).success, JSON.stringify(body)).toBe(false)
  })

  it('validates partial updates strictly and without defaults', () => {
    expect(settingsUpdateSchema.parse({ maxSteps: 7 })).toEqual({ maxSteps: 7 })
    expect(settingsUpdateSchema.parse({ displayName: '  Ada  ' })).toEqual({ displayName: 'Ada' })
    for (const body of [{}, { maxSteps: 0 }, { maxSteps: 201 }, { unknown: 1 }, { sendKey: 'shift-enter' }, { defaultModelRef: 'no-colon' }])
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

  it('accepts the edits mode and the project of a new chat (Phase 7, ADR-031, ADR-032)', () => {
    const body = { chatId: CHAT_ID, message: userMessage, trigger: 'submit-message', modelRef: 'mock:workspace', reasoningEffort: 'auto', toolMode: 'edits' }
    expect(chatRequestBodySchema.parse(body)).toEqual(body)
    expect(chatRequestBodySchema.parse({ ...body, projectId: 'prj_ABCdef0123456789' })).toMatchObject({ projectId: 'prj_ABCdef0123456789' })
    for (const projectId of [null, '', 'none', 'prj_short', 'proj_ABCdef0123456789'])
      expect(chatRequestBodySchema.safeParse({ ...body, projectId }).success, String(projectId)).toBe(false)
  })

  it('accepts imageOptions on the chat request (shape only; model rules are checked by the server)', () => {
    const body = { chatId: CHAT_ID, message: userMessage, trigger: 'submit-message', modelRef: 'mock:image', reasoningEffort: 'auto', toolMode: 'ask' }
    const imageOptions = { n: 2, aspectRatio: '16:9', editPrevious: false }
    expect(chatRequestBodySchema.parse({ ...body, imageOptions })).toEqual({ ...body, imageOptions })
    expect(chatRequestBodySchema.parse({ ...body, imageOptions: {} }).imageOptions).toEqual({})
    for (const change of [{ n: 0 }, { n: 5 }, { aspectRatio: '21:9' }, { size: '1024x1024' }])
      expect(chatRequestBodySchema.safeParse({ ...body, imageOptions: change }).success, JSON.stringify(change)).toBe(false)
  })

  it('carries image turn metadata and the generated-file-dropped notice', async () => {
    const reply: HarnessUIMessage = {
      id: createMessageId(),
      role: 'assistant',
      metadata: { modelRef: 'mock:image', startedAt: 1, image: { n: 2, aspectRatio: '1:1', inputs: 1, revisedPrompt: 'Mock: a cat' } },
      parts: [
        { type: 'file', mediaType: 'image/png', url: '/api/files/file_ABCdef0123456789' },
        { type: 'data-notice', data: { level: 'warning', code: 'generated-file-dropped', message: 'A generated file was not kept.' } },
      ],
    }
    await expect(validateUIMessages<HarnessUIMessage>({ messages: [reply], metadataSchema: messageMetadataSchema, dataSchemas: harnessDataSchemas })).resolves.toHaveLength(1)
    expect(messageMetadataSchema.safeParse({ modelRef: 'mock:image', startedAt: 1, image: { n: 5 } }).success).toBe(false)
    expect(messageMetadataSchema.safeParse({ modelRef: 'mock:image', startedAt: 1, image: {} }).success).toBe(false)
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
    projectId: null,
    createdAt: 1,
    updatedAt: 2,
  }

  it('parses summaries and details', () => {
    expect(chatSummarySchema.parse(summary)).toEqual(summary)
    const detail = { ...summary, settings: { toolMode: 'auto' }, messages: [], branches: {}, totals: EMPTY_TOTALS }
    expect(chatDetailSchema.parse(detail)).toEqual(detail)
    // The project (ADR-031) is required on summaries: a project id or null.
    expect(chatSummarySchema.parse({ ...summary, projectId: 'prj_ABCdef0123456789' }).projectId).toBe('prj_ABCdef0123456789')
    const { projectId: _projectId, ...withoutProject } = summary
    expect(chatSummarySchema.safeParse(withoutProject).success).toBe(false)
    expect(chatSummarySchema.safeParse({ ...summary, projectId: 'prj_short' }).success).toBe(false)
    expect(chatDetailSchema.parse({ ...detail, settings: { toolMode: 'edits' } }).settings.toolMode).toBe('edits')
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
    // Exports never carry the project (ADR-031).
    const { projectId: _projectId, ...exported } = summary
    const base = { ...exported, settings: {}, totals: EMPTY_TOTALS }
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

  it('moves chats between projects and filters the list by project (ADR-031)', () => {
    const projectId = 'prj_ABCdef0123456789'
    expect(chatCreateSchema.parse({ projectId })).toEqual({ projectId })
    expect(chatCreateSchema.safeParse({ projectId: null }).success).toBe(false)
    expect(chatUpdateSchema.parse({ projectId })).toEqual({ projectId })
    expect(chatUpdateSchema.parse({ projectId: null })).toEqual({ projectId: null })
    expect(chatUpdateSchema.safeParse({ projectId: 'none' }).success).toBe(false)
    expect(chatsQuerySchema.parse({ projectId })).toEqual({ projectId })
    expect(chatsQuerySchema.parse({ projectId: 'none', q: 'x' })).toEqual({ projectId: 'none', q: 'x' })
    for (const value of ['', 'all', 'null', 'prj_short'])
      expect(chatsQuerySchema.safeParse({ projectId: value }).success, value).toBe(false)
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
    const fileSweep = { mode: 'off', lastAttempt: null, nextRunAt: null }
    expect(dataSummarySchema.parse({ chats: 2, archivedChats: 1, messages: 9, files: 1, fileBytes: 5, fileSweep })).toBeTruthy()
    // Phase 8 (ADR-039): the sweep status is required, the checkpoint storage optional.
    expect(dataSummarySchema.safeParse({ chats: 2, archivedChats: 1, messages: 9, files: 1, fileBytes: 5 }).success).toBe(false)
    expect(dataSummarySchema.parse({ chats: 0, archivedChats: 0, messages: 0, files: 0, fileBytes: 0, fileSweep, checkpoints: { bytes: 10, blobs: 1 } }).checkpoints).toEqual({ bytes: 10, blobs: 1 })
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
  const summary: z.infer<typeof chatSummarySchema> = {
    id: CHAT_ID,
    title: 'Trip',
    titleSource: 'user',
    modelRef: 'mock:echo',
    pinned: false,
    archived: false,
    running: false,
    pendingApproval: false,
    projectId: null,
    createdAt: 1,
    updatedAt: 2,
  }

  it('chat.updated carries the active leaf (ADR-030): required, a message id or null', () => {
    expect(chatUpdatedDataSchema.parse({ ...summary, activeLeafId: MESSAGE_A })).toEqual({ ...summary, activeLeafId: MESSAGE_A })
    expect(serverEventSchema.parse({ type: 'chat.updated', data: { ...summary, activeLeafId: null }, at: 3 })).toMatchObject({ data: { activeLeafId: null } })
    expect(serverEventSchema.safeParse({ type: 'chat.updated', data: summary, at: 3 }).success).toBe(false)
    expect(serverEventSchema.safeParse({ type: 'chat.updated', data: { ...summary, activeLeafId: 'msg_short' }, at: 3 }).success).toBe(false)
    // `chat.created` keeps the plain summary; the summary schema itself has no leaf.
    expect(serverEventSchema.parse({ type: 'chat.created', data: summary, at: 3 }).data).toEqual(summary)
    expect(chatSummarySchema.parse({ ...summary, activeLeafId: MESSAGE_A })).not.toHaveProperty('activeLeafId')
    const event = createServerEvent('chat.updated', { ...summary, activeLeafId: MESSAGE_B }, 4)
    expect(serverEventSchema.parse(event)).toEqual({ type: 'chat.updated', data: { ...summary, activeLeafId: MESSAGE_B }, at: 4 })
  })

  it('covers the 15 event types', () => {
    expect(SERVER_EVENT_TYPES).toHaveLength(15)
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

  it('carries the project in chat events (ADR-031)', () => {
    const moved = { ...summary, projectId: 'prj_ABCdef0123456789', activeLeafId: null }
    expect(serverEventSchema.parse({ type: 'chat.updated', data: moved, at: 3 }).data).toEqual(moved)
    const { projectId: _projectId, ...withoutProject } = summary
    expect(serverEventSchema.safeParse({ type: 'chat.created', data: withoutProject, at: 3 }).success).toBe(false)
  })

  it('key.rotated carries the new key version and the touched chats (ADR-034)', () => {
    const data = { keyVersion: 2, rotatedAt: 9, chatIds: [CHAT_ID] }
    expect(serverEventSchema.parse(createServerEvent('key.rotated', data, 10))).toEqual({ type: 'key.rotated', data, at: 10 })
    for (const change of [{ keyVersion: 0 }, { chatIds: ['x'] }, { chatIds: Array.from({ length: 1001 }).fill(CHAT_ID) }, { rotatedAt: undefined }])
      expect(serverEventSchema.safeParse({ type: 'key.rotated', data: { ...data, ...change }, at: 10 }).success, JSON.stringify(change).slice(0, 60)).toBe(false)
  })
})

describe('images (ADR-028)', () => {
  const image = { fileId: 'file_ABCdef0123456789', url: '/api/files/file_ABCdef0123456789', mediaType: 'image/png', name: 'image-1.png' }

  it('lists the aspect ratios and the stored image types', () => {
    expect(IMAGE_ASPECT_RATIOS).toEqual(['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16'])
    expect(imageAspectRatioSchema.options).toEqual([...IMAGE_ASPECT_RATIOS])
    expect(GENERATED_IMAGE_MIME_TYPES).toEqual(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
    expect(GENERATE_IMAGE_TOOL_NAME).toBe('generate_image')
    expect(LIMITS).toMatchObject({ imagesPerTurnMax: 4, imageInputsMax: 4, generatedImageBytes: LIMITS.uploadBytes, imagePromptMaxChars: 32_000 })
  })

  it('validates image options strictly', () => {
    expect(imageOptionsSchema.parse({})).toEqual({})
    expect(imageOptionsSchema.parse({ n: 4, aspectRatio: '9:16', editPrevious: true })).toEqual({ n: 4, aspectRatio: '9:16', editPrevious: true })
    for (const options of [{ n: 0 }, { n: 5 }, { n: 1.5 }, { aspectRatio: '2:1' }, { aspectRatio: 'auto' }, { editPrevious: 'yes' }, { quality: 'hd' }])
      expect(imageOptionsSchema.safeParse(options).success, JSON.stringify(options)).toBe(false)
  })

  it('validates image turn metadata', () => {
    expect(imageTurnMetadataSchema.parse({ n: 1 })).toEqual({ n: 1 })
    expect(imageTurnMetadataSchema.parse({ n: 2, aspectRatio: '3:2', inputs: 0, revisedPrompt: 'A cat' })).toMatchObject({ inputs: 0 })
    for (const metadata of [{}, { n: 0 }, { n: 5 }, { n: 1, inputs: -1 }, { n: 1, inputs: 5 }, { n: 1, aspectRatio: '5:4' }, { n: 1, revisedPrompt: 'x'.repeat(32_001) }])
      expect(imageTurnMetadataSchema.safeParse(metadata).success, JSON.stringify(metadata).slice(0, 80)).toBe(false)
  })

  it('validates the generate_image tool input', () => {
    expect(generateImageToolInputSchema.parse({ prompt: '  a red fox  ', n: 2, aspectRatio: '16:9' })).toEqual({ prompt: 'a red fox', n: 2, aspectRatio: '16:9' })
    for (const input of [{}, { prompt: '   ' }, { prompt: 'x'.repeat(32_001) }, { prompt: 'fox', n: 0 }, { prompt: 'fox', n: 5 }, { prompt: 'fox', aspectRatio: '1:2' }])
      expect(generateImageToolInputSchema.safeParse(input).success, JSON.stringify(input).slice(0, 80)).toBe(false)
  })

  it('validates the generate_image tool output (file references, never bytes)', () => {
    const output = { modelRef: 'openai:gpt-image-2', images: [image, { ...image, mediaType: 'image/webp', name: 'image-2.webp' }], costUsd: 0.04, revisedPrompt: 'A red fox' }
    expect(generateImageToolOutputSchema.parse(output)).toEqual(output)
    expect(generateImageToolOutputSchema.parse({ modelRef: 'mock:image', images: [image] })).toEqual({ modelRef: 'mock:image', images: [image] })
    // Plugin API 1.2.0: the display name of the model; outputs stored before Phase 7 lack it.
    expect(generateImageToolOutputSchema.parse({ ...output, modelName: 'GPT Image 2' }).modelName).toBe('GPT Image 2')
    for (const change of [
      { images: [] },
      { images: Array.from({ length: 5 }).fill(image) },
      { images: [{ ...image, url: 'data:image/png;base64,AAAA' }] },
      { images: [{ ...image, url: 'https://example.com/image.png' }] },
      { images: [{ ...image, mediaType: 'image/svg+xml' }] },
      { images: [{ ...image, fileId: 'file_short' }] },
      { images: [{ ...image, name: '' }] },
      { modelRef: 'no-colon' },
      { costUsd: -1 },
      { modelName: 'x'.repeat(201) },
      { modelName: null },
    ])
      expect(generateImageToolOutputSchema.safeParse({ ...output, ...change }).success, JSON.stringify(change).slice(0, 80)).toBe(false)
  })

  it('adds the required imageOutput capability; plugin models and custom models may omit it', () => {
    const capabilities = { tools: true, vision: true, pdf: false, reasoning: false, structuredOutput: true }
    expect(modelCapabilitiesSchema.safeParse(capabilities).success).toBe(false)
    expect(modelCapabilitiesSchema.parse({ ...capabilities, imageOutput: true })).toEqual({ ...capabilities, imageOutput: true })
    expect(modelInfoSchema.parse({ id: 'gemini-3-pro-image', capabilities: { imageOutput: true } })).toEqual({ id: 'gemini-3-pro-image', capabilities: { imageOutput: true } })
    expect(modelInfoSchema.parse({ id: 'sample', capabilities: { tools: true } })).toEqual({ id: 'sample', capabilities: { tools: true } })
    expect(customModelInputSchema.parse({ providerId: 'openai', modelId: 'gpt-image-2', kind: 'image', capabilities: { vision: true } })).toMatchObject({ kind: 'image' })
  })
})

describe('voice (ADR-029)', () => {
  it('adds the transcription and speech model kinds', () => {
    expect(modelKindSchema.options).toEqual(['chat', 'embedding', 'image', 'audio', 'transcription', 'speech', 'other'])
    expect(modelInfoSchema.parse({ id: 'whisper-large-v3-turbo', kind: 'transcription' })).toMatchObject({ kind: 'transcription' })
    expect(modelInfoSchema.safeParse({ id: 'x', kind: 'tts' }).success).toBe(false)
    expect(LIMITS).toMatchObject({ audioUploadBytes: 26_214_400, speechTextMaxChars: 4096, transcriptionMaxSeconds: 600, speechFirstChunkChars: 300, speechChunkChars: 1500 })
  })

  it('suggests voices on speech models (unique, at most 100)', () => {
    expect(modelInfoSchema.parse({ id: 'gpt-4o-mini-tts', kind: 'speech', voices: ['alloy', 'echo'] }).voices).toEqual(['alloy', 'echo'])
    for (const voices of [['alloy', 'alloy'], [''], ['v'.repeat(65)], Array.from({ length: 101 }, (_, index) => `voice-${index}`)])
      expect(modelInfoSchema.safeParse({ id: 'tts', kind: 'speech', voices }).success, JSON.stringify(voices).slice(0, 60)).toBe(false)
    const model = {
      ref: 'openai:gpt-4o-mini-tts',
      providerId: 'openai',
      id: 'gpt-4o-mini-tts',
      name: 'GPT-4o mini TTS',
      alias: null,
      kind: 'speech',
      contextWindow: null,
      maxOutputTokens: null,
      capabilities: { tools: false, vision: false, pdf: false, reasoning: false, structuredOutput: false, imageOutput: false },
      reasoningEfforts: [],
      cost: null,
      favorite: false,
      hidden: true,
      custom: false,
      source: 'seed',
      lastUsedAt: null,
    }
    expect(catalogModelSchema.parse(model)).toEqual(model)
    expect(catalogModelSchema.parse({ ...model, voices: ['alloy', 'nova'] }).voices).toEqual(['alloy', 'nova'])
    expect(catalogModelSchema.safeParse({ ...model, voices: Array.from({ length: 101 }).fill('alloy') }).success).toBe(false)
  })

  it('validates the language and the voice', () => {
    for (const language of ['auto', 'en', 'de', 'yue'])
      expect(transcriptionLanguageSchema.safeParse(language).success, language).toBe(true)
    for (const language of ['', 'e', 'EN', 'en-US', 'english', 'Auto'])
      expect(transcriptionLanguageSchema.safeParse(language).success, language).toBe(false)
    expect(speechVoiceSchema.parse(' en-US-Neural2-A ')).toBe('en-US-Neural2-A')
    for (const voice of ['alloy', 'Kore', 'voice_1', 'narrator: calm', 'v2.1'])
      expect(speechVoiceSchema.safeParse(voice).success, voice).toBe(true)
    for (const voice of ['', '   ', 'a/b', 'a\nb', '<script>', 'v'.repeat(65)])
      expect(speechVoiceSchema.safeParse(voice).success, voice).toBe(false)
  })

  it('validates the transcription form fields strictly', () => {
    expect(audioTranscribeFormSchema.parse({})).toEqual({})
    expect(audioTranscribeFormSchema.parse({ modelRef: 'groq:whisper-large-v3-turbo', language: 'auto' })).toEqual({ modelRef: 'groq:whisper-large-v3-turbo', language: 'auto' })
    for (const form of [{ file: 'x' }, { modelRef: 'whisper' }, { language: 'EN' }, { prompt: 'names' }])
      expect(audioTranscribeFormSchema.safeParse(form).success, JSON.stringify(form)).toBe(false)
  })

  it('validates transcriptions', () => {
    const result = { text: 'Hello there.', language: 'en', durationSec: 2.5, modelRef: 'mock:transcribe' }
    expect(audioTranscriptionSchema.parse(result)).toEqual(result)
    expect(audioTranscriptionSchema.parse({ text: '', language: null, durationSec: null, modelRef: 'mock:transcribe' }).text).toBe('')
    for (const change of [{ text: undefined }, { language: undefined }, { durationSec: -1 }, { modelRef: 'mock' }])
      expect(audioTranscriptionSchema.safeParse({ ...result, ...change }).success, JSON.stringify(change)).toBe(false)
  })

  it('validates speech bodies strictly', () => {
    expect(audioSpeechBodySchema.parse({ text: '  Hello world  ' })).toEqual({ text: 'Hello world' })
    expect(audioSpeechBodySchema.parse({ text: 'x'.repeat(LIMITS.speechTextMaxChars), modelRef: 'mock:speech', voice: 'alloy' })).toMatchObject({ voice: 'alloy' })
    for (const body of [{}, { text: '   ' }, { text: 'x'.repeat(LIMITS.speechTextMaxChars + 1) }, { text: 'hi', modelRef: 'speech' }, { text: 'hi', voice: '' }, { text: 'hi', speed: 2 }, { text: 'hi', format: 'mp3' }])
      expect(audioSpeechBodySchema.safeParse(body).success, JSON.stringify(body).slice(0, 80)).toBe(false)
  })
})

describe('message versions (ADR-030)', () => {
  it('validates the params of a version delete and the only-version conflict', () => {
    expect(chatMessageParamsSchema.parse({ id: CHAT_ID, messageId: MESSAGE_A })).toEqual({ id: CHAT_ID, messageId: MESSAGE_A })
    for (const params of [{ id: CHAT_ID }, { id: 'x', messageId: MESSAGE_A }, { id: CHAT_ID, messageId: 'msg_short' }])
      expect(chatMessageParamsSchema.safeParse(params).success, JSON.stringify(params)).toBe(false)
    expect(conflictReasonSchema.options).toContain('only-version')
    expect(conflictDetailsSchema.parse({ reason: 'only-version' })).toEqual({ reason: 'only-version' })
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
