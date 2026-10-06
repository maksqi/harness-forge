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
  AgentDefinition,
  CommandHookSpec,
  DeclarativeAgent,
  DeclarativeOutputStyle,
  DeclarativeSkill,
  Disposable,
  GeneratedImageFile,
  HarnessErrorInit,
  HookEventName,
  HookMap,
  HookMatcherGroup,
  HooksConfig,
  ImageAspectRatio,
  ImageGenerateOptions,
  ImageGenerateResult,
  ImageParamsRequest,
  ImageParamsResult,
  ModelInfo,
  ModelKind,
  OutputStyleDefinition,
  PluginContext,
  PluginImagesApi,
  PluginManifest,
  PluginModule,
  ProviderDefinition,
  ReasoningLevel,
  SettingsSchema,
  SkillDefinition,
  ToolCallContext,
  ToolDefinition,
  ToolMode,
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

  it('has plugin API version 1.5.0 (Phase 11: command hooks and output styles)', () => {
    expect(sdk.PLUGIN_API_VERSION).toBe('1.5.0')
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
    // The edits mode (and the plan mode of 1.3.0) reaches hooks through the shared enum.
    expectTypeOf<shared.ToolMode>().toEqualTypeOf<'off' | 'ask' | 'edits' | 'plan' | 'auto'>()
    const tool: ToolDefinition<{ path: string }, string> = {
      name: 'read_note',
      description: 'Reads a note of the project.',
      inputSchema: z.object({ path: z.string() }),
      workspace: 'read',
      execute: async (input, c) => `${c.workspace?.root ?? ''}/${input.path}`,
    }
    expect(tool.workspace).toBe('read')
  })

  it('types the additions of plugin API 1.3.0 (ADR-041, ADR-043)', async () => {
    expectTypeOf<ToolMode>().toEqualTypeOf<shared.ToolMode>()
    expectTypeOf<HookMap['chat.params'][0]['toolMode']>().toEqualTypeOf<'off' | 'ask' | 'edits' | 'plan' | 'auto'>()
    expectTypeOf<ReturnType<ToolDefinition<unknown, number>['execute']>>().toEqualTypeOf<Promise<number> | number | AsyncIterable<number>>()
    // An async generator: every yield is a preliminary output, the last one is the final output.
    const streaming: ToolDefinition<{ steps: number }, { done: number }> = {
      name: 'count',
      description: 'Counts.',
      inputSchema: z.object({ steps: z.number() }),
      async* execute(input) {
        for (let done = 1; done <= input.steps; done++)
          yield { done }
      },
    }
    // A plain value and a promise are still accepted.
    const direct: ToolDefinition<{ steps: number }, { done: number }> = { ...streaming, execute: input => ({ done: input.steps }) }
    const promised: ToolDefinition<{ steps: number }, { done: number }> = { ...streaming, execute: async input => ({ done: input.steps }) }
    const stored: ToolDefinition[] = [streaming, direct, promised]
    const context = { chatId: 'c', modelRef: 'mock:echo', toolCallId: 't', messages: [], signal: new AbortController().signal }
    const yielded: unknown[] = []
    for await (const value of streaming.execute({ steps: 3 }, context) as AsyncIterable<{ done: number }>)
      yielded.push(value)
    expect(yielded).toEqual([{ done: 1 }, { done: 2 }, { done: 3 }])
    expect(direct.execute({ steps: 2 }, context)).toEqual({ done: 2 })
    await expect(promised.execute({ steps: 2 }, context)).resolves.toEqual({ done: 2 })
    expect(stored).toHaveLength(3)
  })

  it('types the additions of plugin API 1.4.0 (ADR-045)', () => {
    expectTypeOf<PluginContext['agents']['register']>().toEqualTypeOf<(d: AgentDefinition) => Disposable>()
    expectTypeOf<PluginContext['skills']['register']>().toEqualTypeOf<(d: SkillDefinition) => Disposable>()
    expectTypeOf<keyof AgentDefinition>().toEqualTypeOf<'name' | 'description' | 'instructions' | 'tools' | 'model'>()
    expectTypeOf<keyof SkillDefinition>().toEqualTypeOf<'name' | 'description' | 'content'>()
    expectTypeOf<DeclarativeAgent>().toEqualTypeOf<shared.DeclarativeAgent>()
    expectTypeOf<DeclarativeSkill>().toEqualTypeOf<shared.DeclarativeSkill>()
    // A manifest entry is a valid code registration, and the manifest declares both lists.
    expectTypeOf<DeclarativeAgent>().toExtend<AgentDefinition>()
    expectTypeOf<DeclarativeSkill>().toExtend<SkillDefinition>()
    expectTypeOf<NonNullable<PluginManifest['contributes']>['agents']>().toEqualTypeOf<DeclarativeAgent[] | undefined>()
    expectTypeOf<NonNullable<PluginManifest['contributes']>['skills']>().toEqualTypeOf<DeclarativeSkill[] | undefined>()
    const agent: AgentDefinition = { name: 'reviewer', description: 'Reviews diffs.', instructions: 'Review the diff.', tools: ['read_file'], model: 'inherit' }
    const skill: SkillDefinition = { name: 'release-notes', description: 'Writes release notes.', content: '# Steps' }
    expect(shared.declarativeAgentSchema.parse(agent)).toEqual(agent)
    expect(shared.declarativeSkillSchema.parse(skill)).toEqual(skill)
  })

  it('types the additions of plugin API 1.5.0 (ADR-048, ADR-051, ADR-052)', () => {
    expectTypeOf<PluginContext['outputStyles']['register']>().toEqualTypeOf<(d: OutputStyleDefinition) => Disposable>()
    expectTypeOf<keyof OutputStyleDefinition>().toEqualTypeOf<'name' | 'description' | 'content' | 'keepCodingInstructions'>()
    expectTypeOf<DeclarativeOutputStyle>().toEqualTypeOf<shared.DeclarativeOutputStyle>()
    expectTypeOf<DeclarativeOutputStyle>().toExtend<OutputStyleDefinition>()
    expectTypeOf<NonNullable<PluginManifest['contributes']>['outputStyles']>().toEqualTypeOf<DeclarativeOutputStyle[] | undefined>()
    // The command hook events are the shared enum; a manifest `hooks` object is a valid `HooksConfig`.
    expectTypeOf<HookEventName>().toEqualTypeOf<shared.HookEvent>()
    expectTypeOf<CommandHookSpec['type']>().toEqualTypeOf<'command'>()
    expectTypeOf<HookMatcherGroup['hooks']>().toEqualTypeOf<CommandHookSpec[]>()
    expectTypeOf<HooksConfig>().toEqualTypeOf<Partial<Record<HookEventName, HookMatcherGroup[]>>>()
    expectTypeOf<NonNullable<NonNullable<PluginManifest['contributes']>['hooks']>>().toExtend<HooksConfig>()
    // The new code hook events.
    expectTypeOf<HookMap['prompt.submit'][1]>().toEqualTypeOf<{ block?: string, context?: string }>()
    expectTypeOf<HookMap['session.start'][0]['source']>().toEqualTypeOf<'startup' | 'compact'>()
    expectTypeOf<HookMap['run.stop'][0]['origin']>().toEqualTypeOf<shared.RunOrigin>()
    expectTypeOf<HookMap['run.stop'][1]>().toEqualTypeOf<{ continue?: string }>()
    expectTypeOf<HookMap['subagent.stop'][1]>().toEqualTypeOf<{ continue?: string }>()
    expectTypeOf<HookMap['compact.before'][0]['trigger']>().toEqualTypeOf<'manual' | 'auto'>()
    expectTypeOf<HookMap['notification'][0]['type']>().toEqualTypeOf<'permission_prompt'>()
    expectTypeOf<HookMap['tool.after'][1]>().toEqualTypeOf<{ output: unknown, context?: string }>()
    const style: OutputStyleDefinition = { name: 'terse', description: 'Short answers.', content: 'Answer briefly.', keepCodingInstructions: true }
    expect(shared.declarativeOutputStyleSchema.parse(style)).toEqual(style)
    const hooks: HooksConfig = { PostToolUse: [{ matcher: 'Write|Edit', hooks: [{ type: 'command', command: 'sh after.sh', timeout: 30 }] }] }
    expect(shared.countHookHandlers(hooks)).toBe(1)
  })

  it('derives the AI SDK types of PLUGINS.md section 9', () => {
    expectTypeOf<ReasoningLevel>().toEqualTypeOf<'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'>()
    expectTypeOf<ToolResultOutput['type']>().toEqualTypeOf<'text' | 'json' | 'execution-denied' | 'error-text' | 'error-json' | 'content'>()
    expectTypeOf<ToolResultOutput>().toEqualTypeOf<Awaited<ReturnType<NonNullable<Tool['toModelOutput']>>>>()
    expectTypeOf<keyof HookMap>().toEqualTypeOf<
      | 'chat.params'
      | 'chat.headers'
      | 'chat.messages'
      | 'tool.approve'
      | 'tool.before'
      | 'tool.after'
      | 'message.completed'
      | 'prompt.submit'
      | 'session.start'
      | 'run.stop'
      | 'subagent.stop'
      | 'compact.before'
      | 'notification'
    >()
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
