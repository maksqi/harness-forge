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
    ]
    for (const name of names)
      expect(shared, name).toHaveProperty(name)
  })
})
