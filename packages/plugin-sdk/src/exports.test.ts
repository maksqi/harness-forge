/// <reference types="node" />
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
  AgentColor,
  AgentDefinition,
  CommandDefinition,
  CommandHookSpec,
  DeclarativeAgent,
  DeclarativeOutputStyle,
  DeclarativeSkill,
  Disposable,
  GeneratedImageFile,
  HarnessErrorInit,
  HookEventName,
  HookHandlerSpec,
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
  PluginFormat,
  PluginImagesApi,
  PluginManifest,
  PluginModule,
  PluginSource,
  PromptHookSpec,
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
import { readFileSync } from 'node:fs'
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
  'pluginFormatSchema',
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

  it('has plugin API version 1.6.0 (Phase 12: Claude Code plugins, prompt hooks, five hook events)', () => {
    expect(sdk.PLUGIN_API_VERSION).toBe('1.6.0')
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
    // The 1.4.0 fields (1.6.0 adds optional ones, see below).
    expectTypeOf<'name' | 'description' | 'instructions' | 'tools' | 'model'>().toExtend<keyof AgentDefinition>()
    expectTypeOf<'name' | 'description' | 'content'>().toExtend<keyof SkillDefinition>()
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
    expectTypeOf<CommandHookSpec>().toExtend<HookMatcherGroup['hooks'][number]>()
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

  it('types the additions of plugin API 1.6.0 (ADR-053, ADR-057, ADR-058)', () => {
    // Command, skill and agent fields; names may be qualified with the plugin's own id (checked by the host).
    expectTypeOf<keyof CommandDefinition>().toEqualTypeOf<'name' | 'description' | 'template' | 'syntax' | 'argumentHint' | 'model' | 'allowedTools' | 'run'>()
    expectTypeOf<CommandDefinition['syntax']>().toEqualTypeOf<'template' | 'markdown' | undefined>()
    expectTypeOf<keyof SkillDefinition>().toEqualTypeOf<'name' | 'description' | 'content' | 'baseDir' | 'argumentHint' | 'userInvocable' | 'modelInvocable'>()
    expectTypeOf<keyof AgentDefinition>().toEqualTypeOf<'name' | 'description' | 'instructions' | 'tools' | 'model' | 'disallowedTools' | 'maxTurns' | 'color' | 'skills'>()
    expectTypeOf<AgentColor>().toEqualTypeOf<shared.AgentColor>()
    expectTypeOf<AgentColor>().toEqualTypeOf<'red' | 'blue' | 'green' | 'yellow' | 'purple' | 'orange' | 'pink' | 'cyan'>()
    expectTypeOf<NonNullable<AgentDefinition['color']>>().toEqualTypeOf<AgentColor>()
    // A declarative skill (with its folder) is a valid code registration.
    expectTypeOf<DeclarativeSkill['baseDir']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<DeclarativeSkill>().toExtend<SkillDefinition>()
    // The plugin sources and formats of marketplaces and Claude Code plugins.
    expectTypeOf<PluginSource>().toEqualTypeOf<shared.PluginSource>()
    expectTypeOf<'github' | 'marketplace'>().toExtend<PluginSource>()
    expectTypeOf<PluginFormat>().toEqualTypeOf<'harness' | 'claude'>()
    // Thirteen hook events, prompt handlers and the command handler fields.
    expectTypeOf<HookEventName>().toEqualTypeOf<shared.HookEvent>()
    expectTypeOf<'PostToolUseFailure' | 'PermissionRequest' | 'SubagentStart' | 'PostCompact' | 'SessionEnd'>().toExtend<HookEventName>()
    expectTypeOf<HookHandlerSpec>().toEqualTypeOf<CommandHookSpec | PromptHookSpec>()
    expectTypeOf<HookMatcherGroup['hooks']>().toEqualTypeOf<HookHandlerSpec[]>()
    expectTypeOf<PromptHookSpec['type']>().toEqualTypeOf<'prompt'>()
    expectTypeOf<keyof PromptHookSpec>().toEqualTypeOf<'type' | 'prompt' | 'model' | 'timeout' | 'continueOnBlock' | 'if' | 'statusMessage'>()
    expectTypeOf<keyof CommandHookSpec>().toEqualTypeOf<'type' | 'command' | 'timeout' | 'args' | 'async' | 'if' | 'statusMessage'>()
    // The shared zod shapes and the SDK types are interchangeable.
    expectTypeOf<shared.CommandHookSpecInput>().toExtend<CommandHookSpec>()
    expectTypeOf<shared.PromptHookSpecInput>().toExtend<PromptHookSpec>()
    expectTypeOf<shared.HooksConfigInput>().toExtend<HooksConfig>()
    expectTypeOf<NonNullable<NonNullable<PluginManifest['contributes']>['hooks']>>().toExtend<HooksConfig>()
    const hooks: HooksConfig = {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node', args: ['guard.mjs', '--strict'], if: 'Bash(git push:*)', statusMessage: 'Checking the push' }] }],
      Stop: [{ hooks: [{ type: 'prompt', prompt: 'Are the tests green? $ARGUMENTS', model: 'haiku', timeout: 20 }] }],
      PostToolUseFailure: [{ matcher: 'Bash', hooks: [{ type: 'prompt', prompt: 'Explain the failure.', continueOnBlock: true }] }],
      SessionEnd: [{ hooks: [{ type: 'command', command: 'sh cleanup.sh', async: true }] }],
    }
    expect(shared.hooksConfigSchema.parse(hooks)).toEqual(hooks)
    expect(shared.countHookHandlers(hooks)).toBe(4)
    expect(shared.countCommandHookHandlers(hooks)).toBe(2)
    const command: CommandDefinition = { name: 'review-kit:review', description: 'Reviews.', template: 'Review $ARGUMENTS', syntax: 'markdown', argumentHint: '<files>', model: 'sonnet', allowedTools: ['read_file'] }
    const skill: SkillDefinition = { name: 'pdf', description: 'PDFs.', content: '# PDF', baseDir: 'skills/pdf', argumentHint: '<file>', userInvocable: true, modelInvocable: false }
    const agent: AgentDefinition = { name: 'reviewer', description: 'Reviews.', instructions: 'Review.', disallowedTools: ['shell'], maxTurns: 12, color: 'cyan', skills: ['pdf'] }
    expect([command.syntax, skill.baseDir, agent.color]).toEqual(['markdown', 'skills/pdf', 'cyan'])
    expect(shared.declarativeSkillSchema.parse({ name: skill.name, description: skill.description, content: skill.content, baseDir: skill.baseDir })).toMatchObject({ baseDir: 'skills/pdf' })
  })

  it('keeps ^1.5.0 manifests loading under 1.6.0; prompt-only hooks need no trust', () => {
    // The example hook pack (engines ^1.5.0, one command hook and a style) still parses and still requires trust.
    const hookPack = JSON.parse(readFileSync(new URL('../../../examples/plugins/hook-pack/plugin.json', import.meta.url), 'utf8')) as unknown
    const parsed = shared.pluginManifestSchema.parse(hookPack)
    expect(parsed.engines.harness).toBe('^1.5.0')
    expect(shared.manifestRequiresTrust(parsed)).toBe(true)
    const base = { manifestVersion: 1, id: 'prompt-pack', name: 'Prompt pack', version: '1.0.0', engines: { harness: '^1.6.0' } } as const
    const promptOnly = shared.pluginManifestSchema.parse({ ...base, contributes: { hooks: { Stop: [{ hooks: [{ type: 'prompt', prompt: 'Is the task done?' }] }] } } })
    expect(shared.declaresCommandHooks(promptOnly)).toBe(false)
    expect(shared.manifestRequiresTrust(promptOnly)).toBe(false)
    const mixed = shared.pluginManifestSchema.parse({ ...base, contributes: { hooks: { Stop: [{ hooks: [{ type: 'prompt', prompt: 'Done?' }, { type: 'command', command: 'sh stop.sh' }] }] } } })
    expect(shared.manifestRequiresTrust(mixed)).toBe(true)
    // Unknown events stay errors in a harness manifest; prompt handlers only on the prompt events.
    expect(shared.pluginManifestSchema.safeParse({ ...base, contributes: { hooks: { BeforeTool: [{ hooks: [{ type: 'command', command: 'x' }] }] } } }).success).toBe(false)
    expect(shared.pluginManifestSchema.safeParse({ ...base, contributes: { hooks: { SessionStart: [{ hooks: [{ type: 'prompt', prompt: 'x' }] }] } } }).success).toBe(false)
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
