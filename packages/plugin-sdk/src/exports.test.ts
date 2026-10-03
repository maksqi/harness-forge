import type {
  ImageModelV3,
  ImageModelV4,
  SharedV4ProviderOptions,
  SpeechModelV3,
  SpeechModelV4,
  TranscriptionModelV3,
  TranscriptionModelV4,
} from '@ai-sdk/provider'
import type { generateImage, Tool } from 'ai'
import type {
  GeneratedImageFile,
  HarnessErrorInit,
  HookMap,
  ImageAspectRatio,
  ImageGenerateOptions,
  ImageGenerateResult,
  ImageParamsRequest,
  ImageParamsResult,
  ModelInfo,
  ModelKind,
  PluginContext,
  PluginImagesApi,
  PluginManifest,
  PluginModule,
  ProviderDefinition,
  ReasoningLevel,
  SettingsSchema,
  ToolCallContext,
  ToolDefinition,
  ToolResultOutput,
  ToolWorkspace,
  ToolWorkspaceAccess,
  TranscriptionHints,
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

  it('has plugin API version 1.2.0 (Phase 7: workspace tools, ImageGenerateResult.modelName)', () => {
    expect(sdk.PLUGIN_API_VERSION).toBe('1.2.0')
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
    expectTypeOf<ImageAspectRatio>().toEqualTypeOf<shared.ImageAspectRatio>()
    expectTypeOf<ModelKind>().toEqualTypeOf<shared.ModelKind>()
  })

  it('types the media additions of plugin API 1.1.0 (ADR-028, ADR-029)', () => {
    type MediaMethod = 'createImageModel' | 'createTranscriptionModel' | 'createSpeechModel' | 'imageParams' | 'transcriptionOptions'
    type Factory<K extends MediaMethod> = ReturnType<NonNullable<ProviderDefinition[K]>>
    expectTypeOf<Factory<'createImageModel'>>().toEqualTypeOf<ImageModelV4 | ImageModelV3>()
    expectTypeOf<Factory<'createTranscriptionModel'>>().toEqualTypeOf<TranscriptionModelV4 | TranscriptionModelV3>()
    expectTypeOf<Factory<'createSpeechModel'>>().toEqualTypeOf<SpeechModelV4 | SpeechModelV3>()
    expectTypeOf<Factory<'imageParams'>>().toEqualTypeOf<ImageParamsResult | undefined>()
    expectTypeOf<Factory<'transcriptionOptions'>>().toEqualTypeOf<SharedV4ProviderOptions | undefined>()
    expectTypeOf<Parameters<NonNullable<ProviderDefinition['imageParams']>>>().toEqualTypeOf<[ImageParamsRequest, ModelInfo]>()
    expectTypeOf<Parameters<NonNullable<ProviderDefinition['transcriptionOptions']>>>().toEqualTypeOf<[TranscriptionHints]>()
    expectTypeOf<ImageParamsRequest>().toEqualTypeOf<{ n: number, aspectRatio?: shared.ImageAspectRatio, inputs: number }>()
    // The call options of `generateImage` accept what `imageParams` returns.
    type GenerateImageOptions = Parameters<typeof generateImage>[0]
    expectTypeOf<NonNullable<ImageParamsResult['size']>>().toExtend<NonNullable<GenerateImageOptions['size']>>()
    expectTypeOf<NonNullable<ImageParamsResult['aspectRatio']>>().toExtend<NonNullable<GenerateImageOptions['aspectRatio']>>()
    expectTypeOf<NonNullable<ImageParamsResult['providerOptions']>>().toExtend<NonNullable<GenerateImageOptions['providerOptions']>>()
    expectTypeOf<PluginContext['images']>().toEqualTypeOf<PluginImagesApi>()
    expectTypeOf<PluginImagesApi['generate']>().toEqualTypeOf<(options: ImageGenerateOptions) => Promise<ImageGenerateResult>>()
    expectTypeOf<ImageGenerateOptions['aspectRatio']>().toEqualTypeOf<shared.ImageAspectRatio | undefined>()
    expectTypeOf<ImageGenerateResult['images']>().toEqualTypeOf<GeneratedImageFile[]>()
    expectTypeOf<keyof GeneratedImageFile>().toEqualTypeOf<'fileId' | 'url' | 'mediaType' | 'name' | 'size'>()
    // `ctx.ai` gains no image function: plugins generate images through `ctx.images` (stored files, usage rows).
    expectTypeOf<keyof PluginContext['ai']>().toEqualTypeOf<'z' | 'tool' | 'jsonSchema' | 'generateText' | 'createOpenAICompatible' | 'createAnthropic' | 'createOpenAI' | 'createGoogleGenerativeAI'>()
  })

  it('types the workspace additions of plugin API 1.2.0 (ADR-031, ADR-032)', () => {
    expectTypeOf<ToolWorkspaceAccess>().toEqualTypeOf<shared.WorkspaceAccess>()
    expectTypeOf<ToolWorkspaceAccess>().toEqualTypeOf<'read' | 'write' | 'execute'>()
    expectTypeOf<ToolWorkspace>().toEqualTypeOf<{ readonly projectId: string, readonly name: string, readonly root: string }>()
    expectTypeOf<ToolCallContext['workspace']>().toEqualTypeOf<ToolWorkspace | undefined>()
    expectTypeOf<ToolDefinition['workspace']>().toEqualTypeOf<ToolWorkspaceAccess | undefined>()
    expectTypeOf<ImageGenerateResult['modelName']>().toEqualTypeOf<string>()
    // The edits mode reaches hooks through the shared enum.
    expectTypeOf<shared.ToolMode>().toEqualTypeOf<'off' | 'ask' | 'edits' | 'auto'>()
    const tool: ToolDefinition<{ path: string }, string> = {
      name: 'read_note',
      description: 'Reads a note of the project.',
      inputSchema: z.object({ path: z.string() }),
      workspace: 'read',
      execute: async (input, c) => `${c.workspace?.root ?? ''}/${input.path}`,
    }
    expect(tool.workspace).toBe('read')
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
