/// <reference types="node" />
import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as shared from './index.ts'

const SRC = new URL('./', import.meta.url)

function sourceFiles(): string[] {
  return readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter(file => file.endsWith('.ts') && !file.endsWith('.test.ts'))
}

describe('isomorphic package', () => {
  it('uses no Node built-ins or globals outside tests (it runs in the browser)', () => {
    const forbidden = [/from 'node:/, /\brequire\(/, /\bprocess\./, /\bBuffer\b/, /__dirname|__filename/, /import\(['"]node:/]
    for (const file of sourceFiles()) {
      const text = readFileSync(new URL(file, SRC), 'utf8')
      for (const pattern of forbidden)
        expect(pattern.test(text), `${file}: ${pattern}`).toBe(false)
    }
  })

  it('imports `ai` for types only', () => {
    for (const file of sourceFiles()) {
      const text = readFileSync(new URL(file, SRC), 'utf8')
      for (const line of text.split('\n').filter(line => /from 'ai'/.test(line)))
        expect(line.startsWith('import type '), `${file}: ${line}`).toBe(true)
    }
  })

  it('exports the documented names', () => {
    const names = [
      'HarnessError',
      'harnessErrorEnvelopeSchema',
      'harnessErrorInitSchema',
      'errorStatusByCode',
      'apiRoutes',
      'createApiClient',
      'apiUrl',
      'listResponseSchema',
      'cursorPageSchema',
      'isReservedPluginId',
      'BUILTIN_PLUGIN_IDS',
      'BUILTIN_PROVIDER_IDS',
      'CLIENT_COMMANDS',
      'mcpToolName',
      'createChatId',
      'createMessageId',
      'createShareId',
      'parseModelRef',
      'formatModelRef',
      'LIMITS',
      'UPLOAD_MIME_PATTERNS',
      'pluginManifestSchema',
      'declarativeProviderSchema',
      'mcpServerDeclSchema',
      'credentialFieldSchema',
      'modelInfoSchema',
      'settingsSchemaSchema',
      'reasoningEffortSchema',
      'toolPolicySchema',
      'harnessDataSchemas',
      'messageMetadataSchema',
      'harnessUIMessageSchema',
      'chatRequestBodySchema',
      'serverEventSchema',
      'serverEventTypeSchema',
      'settingsSchema',
      'settingsUpdateSchema',
      'chatSummarySchema',
      'chatDetailSchema',
      'chatExportAnySchema',
      'dataImportResultSchema',
      'shareViewSchema',
      'providerSummarySchema',
      'catalogModelSchema',
      'pluginDetailSchema',
      'pluginInspectionSchema',
      // Phase 9 (ADR-040 … ADR-043)
      'HARNESS_COMMANDS',
      'isHarnessCommand',
      'AGENT_TOOL_NAMES',
      'AGENT_TOOL_SCHEMAS',
      'todoStatusSchema',
      'taskTypeSchema',
      'todoItemSchema',
      'todoWriteInputSchema',
      'todoWriteOutputSchema',
      'exitPlanModeInputSchema',
      'exitPlanModeOutputSchema',
      'taskInputSchema',
      'taskStepSchema',
      'taskOutputSchema',
      'compactionDataSchema',
      'steerDataSchema',
      'activityDataSchema',
      'messageUsageSchema',
      'userMessagePartSchema',
      'queueItemSchema',
      'queueAddBodySchema',
      'queueListSchema',
      'queueRemovalSchema',
      'queueChangedDataSchema',
      'chatQueueItemParamsSchema',
      'projectFilesQuerySchema',
      'projectFileEntrySchema',
      'projectFileSearchSchema',
      'projectFileAttachBodySchema',
      'runOriginSchema',
      // Phase 9 pure helpers (C23): history-derived agent state and file mentions
      'findCompaction',
      'compactionMarkers',
      'compactionCutoff',
      'splitSteers',
      'latestTodos',
      'countTodos',
      'isContentPart',
      'NON_CONTENT_PART_TYPES',
      'COMPACTION_PART_TYPE',
      'STEER_PART_TYPE',
      'TODO_WRITE_PART_TYPE',
      'mentionTokenAt',
      'parseMentions',
      'formatMention',
      'isMentionablePath',
      'scorePath',
      'rankPaths',
      'MENTION_QUERY_MAX_CHARS',
      // Phase 10 (ADR-044 … ADR-047): agent customization contracts
      'CUSTOMIZATION_ID_PATTERN',
      'BACKGROUND_TASK_ID_PATTERN',
      'customizationIdSchema',
      'backgroundTaskIdSchema',
      'createCustomizationId',
      'createBackgroundTaskId',
      'AGENT_NAME_PATTERN',
      'agentNameSchema',
      'BUILTIN_AGENT_TYPES',
      'AGENT_TYPE_ALIASES',
      'isReservedAgentName',
      'customizationKindSchema',
      'customizationSourceSchema',
      'customizationStateSchema',
      'commandSourceSchema',
      'rememberTargetSchema',
      'definitionDiagnosticSchema',
      'agentTypeInputSchema',
      'skillInputSchema',
      'skillOutputSchema',
      'taskAgentSchema',
      'customizationEntrySchema',
      'customizationListSchema',
      'customizationsQuerySchema',
      'customizationSourceQuerySchema',
      'customizationSourceResultSchema',
      'customizationSchema',
      'customizationCreateSchema',
      'customizationUpdateSchema',
      'customizationParamsSchema',
      'customizationChangedDataSchema',
      'backupCustomizationsSchema',
      'rememberBodySchema',
      'rememberResultSchema',
      'backgroundTaskSchema',
      'backgroundTaskListSchema',
      'chatTaskParamsSchema',
      'taskResultDataSchema',
      'taskChangedDataSchema',
      'commandsQuerySchema',
      'declarativeAgentSchema',
      'declarativeSkillSchema',
      'isSafePlanDirectory',
      // Phase 10 pure helpers (C29): definition files, command arguments, tool lists
      'CUSTOMIZATION_KINDS',
      'CUSTOMIZATION_SOURCES',
      'DEFINITION_FOLDERS',
      'DEFINITION_LIMITS',
      'parseDefinition',
      'formatDefinition',
      'resolvePrecedence',
      'expandArguments',
      'splitArguments',
      'normalizeToolList',
      'matchToolAllowlist',
      'CLAUDE_TOOL_ALIASES',
    ]
    for (const name of names)
      expect(shared, name).toHaveProperty(name)
  })
})
