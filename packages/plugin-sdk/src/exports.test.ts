import type { Tool } from 'ai'
import type {
  HarnessErrorInit,
  HookMap,
  ModelInfo,
  PluginContext,
  PluginManifest,
  PluginModule,
  ReasoningLevel,
  SettingsSchema,
  ToolDefinition,
  ToolResultOutput,
} from './index.ts'
import * as shared from '@harness-forge/shared'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { z } from 'zod'
import * as sdk from './index.ts'

/** Every value export of the SDK that comes from `@harness-forge/shared`. */
const REEXPORTED_VALUES = [
  'apiFormatSchema',
  'credentialFieldSchema',
  'declarativeCommandSchema',
  'declarativeProviderSchema',
  'harnessErrorActionSchema',
  'harnessErrorCodeSchema',
  'harnessErrorInitSchema',
  'mcpServerDeclSchema',
  'modelInfoSchema',
  'pluginKindSchema',
  'pluginManifestBaseSchema',
  'pluginManifestSchema',
  'pluginPermissionSchema',
  'pluginSourceSchema',
  'pluginStateSchema',
  'reasoningEffortSchema',
  'reasoningStyleSchema',
  'settingsPropertySchema',
  'settingsSchemaSchema',
  'toolModeSchema',
  'toolPolicySchema',
] as const

describe('exports', () => {
  it('re-exports the plugin data schemas and enums as the same objects as shared', () => {
    for (const name of REEXPORTED_VALUES)
      expect(sdk[name], name).toBe(shared[name])
  })

  it('exports exactly the documented values', () => {
    expect(Object.keys(sdk).sort()).toEqual([...REEXPORTED_VALUES, 'PLUGIN_API_VERSION', 'definePlugin', 'settingsValuesSchema'].sort())
  })

  it('has plugin API version 1.0.0', () => {
    expect(sdk.PLUGIN_API_VERSION).toBe('1.0.0')
  })

  it('definePlugin is the identity', () => {
    const module: PluginModule = { setup() {} }
    expect(sdk.definePlugin(module)).toBe(module)
  })

  it('re-exports the shared types unchanged', () => {
    expectTypeOf<PluginManifest>().toEqualTypeOf<shared.PluginManifest>()
    expectTypeOf<ModelInfo>().toEqualTypeOf<shared.ModelInfo>()
    expectTypeOf<SettingsSchema>().toEqualTypeOf<shared.SettingsSchema>()
    expectTypeOf<HarnessErrorInit>().toEqualTypeOf<shared.HarnessErrorInit>()
  })

  it('derives the AI SDK types of PLUGINS.md section 9', () => {
    expectTypeOf<ReasoningLevel>().toEqualTypeOf<'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'>()
    expectTypeOf<ToolResultOutput['type']>().toEqualTypeOf<'text' | 'json' | 'execution-denied' | 'error-text' | 'error-json' | 'content'>()
    expectTypeOf<ToolResultOutput>().toEqualTypeOf<Awaited<ReturnType<NonNullable<Tool['toModelOutput']>>>>()
    expectTypeOf<keyof HookMap>().toEqualTypeOf<'chat.params' | 'chat.headers' | 'chat.messages' | 'tool.approve' | 'tool.before' | 'tool.after' | 'message.completed'>()
    expectTypeOf<PluginContext['ai']['z']>().toEqualTypeOf<typeof import('zod').z>()
  })

  it('lets the host store typed tools as ToolDefinition', () => {
    const typed: ToolDefinition<{ n: number }, string> = {
      name: 'x',
      description: 'x',
      inputSchema: z.object({ n: z.number() }),
      execute: async input => String(input.n),
    }
    const stored: ToolDefinition = typed
    expect(stored.name).toBe('x')
  })
})
