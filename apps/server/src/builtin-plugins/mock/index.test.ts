import type { LanguageModelV4CallOptions, LanguageModelV4Prompt, LanguageModelV4ToolResultOutput } from '@ai-sdk/provider'
import type { PluginContext, ProviderDefinition, ToolDefinition } from '@harness-forge/plugin-sdk'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { editFileToolInputSchema, modelInfoListSchema, modelInfoSchema, pluginManifestBaseSchema, shellToolInputSchema, WORKSPACE_TOOL_NAMES, writeFileToolInputSchema } from '@harness-forge/shared'
import { isStepCount, RetryError, streamText, tool } from 'ai'
import { describe, expect, it } from 'vitest'
import { validateProviderDefinition } from '../../registry/validate.ts'
import { readWorkspaceFile, writeWorkspaceFile } from '../../workspace/paths.ts'
import { getBuiltinPlugins } from '../index.ts'
import mockPlugin, {
  createMockWav,
  manifest,
  MOCK_CHECKPOINT_DONE,
  MOCK_CHECKPOINT_LS_COMMAND,
  MOCK_CHECKPOINT_MKDIR_COMMAND,
  MOCK_SHELL_DONE_PREFIX,
  MOCK_SPEECH_VOICES,
  MOCK_TRANSCRIPT,
  MOCK_WORKSPACE_COMMAND,
  MOCK_WORKSPACE_CONTENT,
  MOCK_WORKSPACE_DENIED,
  MOCK_WORKSPACE_DONE,
  MOCK_WORKSPACE_FILE,
  MOCK_WORKSPACE_UNAVAILABLE,
  mockApprovalTool,
  mockCheckpointContent,
  mockCheckpointSteps,
  mockModels,
  mockProvider,
  mockWorkspaceSteps,
} from './index.ts'
import { readWav } from './media.test-util.ts'
import { createMockLanguageModel, mockAuthError, mockPlan } from './models.ts'
import { mockShellStdout } from './workspace.ts'

describe('mock plugin', () => {
  it('has a valid builtin manifest', () => {
    expect(pluginManifestBaseSchema.parse(manifest).id).toBe('mock')
  })

  it('is loaded only with HF_MOCK_PROVIDER=1', () => {
    expect(getBuiltinPlugins({ mockProvider: false }).some(plugin => plugin.id === 'mock')).toBe(false)
    expect(getBuiltinPlugins({ mockProvider: true }).some(plugin => plugin.id === 'mock')).toBe(true)
  })

  it('registers the provider and the approval tool through ctx', async () => {
    const providers: ProviderDefinition[] = []
    const tools: ToolDefinition[] = []
    const ctx = {
      providers: {
        register: (definition: ProviderDefinition) => {
          providers.push(definition)
          return { dispose() {} }
        },
      },
      tools: {
        register: (definition: ToolDefinition) => {
          tools.push(definition)
          return { dispose() {} }
        },
      },
    } as unknown as PluginContext
    await mockPlugin.setup(ctx)
    expect(providers).toEqual([mockProvider])
    expect(tools).toEqual([mockApprovalTool])
  })
})

describe('mock provider definition', () => {
  it('has no credentials, no icon, echo as small model and the nineteen models as listing and seeds', async () => {
    expect(mockProvider).toMatchObject({ id: 'mock', name: 'Mock (dev only)', credentials: [], smallModelId: 'echo' })
    expect(mockProvider.icon).toBeUndefined()
    const listed = await mockProvider.listModels?.({ credentials: {}, fetch: globalThis.fetch })
    expect(listed?.map(model => model.id)).toEqual(['echo', 'reasoning', 'tool-approval', 'error', 'image', 'image-chat', 'image-tool', 'transcribe', 'speech', 'workspace', 'checkpoint', 'shell', 'compact', 'plan', 'todo', 'subagent', 'steer', 'agents', 'background'])
    expect(listed).toHaveLength(19)
    expect(mockProvider.seedModels).toEqual(listed)
    expect(modelInfoListSchema.parse(mockModels())).toEqual(mockModels())
    const byId = new Map(mockModels().map(model => [model.id, model]))
    for (const id of ['echo', 'reasoning', 'tool-approval', 'error', 'image-chat', 'image-tool', 'workspace', 'checkpoint', 'shell'])
      expect(modelInfoSchema.parse(byId.get(id)), id).toMatchObject({ contextWindow: 32_000, maxOutputTokens: 4096, cost: { input: 1, output: 2 } })
    for (const id of ['echo', 'reasoning', 'tool-approval', 'error'])
      expect(byId.get(id)?.kind, id).toBeUndefined()
    expect(byId.get('echo')?.capabilities).toMatchObject({ vision: true, pdf: true })
    expect(byId.get('reasoning')).toMatchObject({ capabilities: { reasoning: true }, reasoningEfforts: ['off', 'low', 'medium', 'high', 'max'] })
    expect(byId.get('tool-approval')?.capabilities).toMatchObject({ tools: true })
    await expect(mockProvider.validate?.({ credentials: {}, fetch: globalThis.fetch })).resolves.toBeUndefined()
  })

  it('lists the Phase 6 models with their kinds and capabilities (PROVIDERS.md 8)', () => {
    const byId = new Map(mockModels().map(model => [model.id, model]))
    expect(byId.get('image')).toMatchObject({ name: 'Mock Image', kind: 'image', capabilities: { vision: true, imageOutput: false }, cost: { input: 1, output: 2 } })
    // Explicit chat kinds: the id classifier would take "image-..." for image models (hidden from the picker).
    expect(byId.get('image-chat')).toMatchObject({ name: 'Mock Image Chat', kind: 'chat', capabilities: { imageOutput: true, tools: false } })
    expect(byId.get('image-tool')).toMatchObject({ name: 'Mock Image Tool', kind: 'chat', capabilities: { tools: true, imageOutput: false } })
    expect(byId.get('transcribe')).toEqual({ id: 'transcribe', name: 'Mock Transcribe', kind: 'transcription' })
    expect(byId.get('speech')).toEqual({ id: 'speech', name: 'Mock Speech', kind: 'speech', voices: ['mock-voice-a', 'mock-voice-b'] })
    expect(MOCK_SPEECH_VOICES).toEqual(['mock-voice-a', 'mock-voice-b'])
  })

  it('lists mock:workspace (Phase 7) as an explicit chat model with tools', () => {
    const workspace = mockModels().find(model => model.id === 'workspace')
    expect(workspace).toMatchObject({ name: 'Mock Workspace', kind: 'chat', capabilities: { tools: true, vision: false, imageOutput: false } })
    expect(mockProvider.createLanguageModel('workspace', { credentials: {}, fetch: globalThis.fetch })).toMatchObject({ provider: 'mock', modelId: 'workspace' })
  })

  it('lists mock:checkpoint and mock:shell (Phase 8) as explicit chat models with tools', () => {
    const byId = new Map(mockModels().map(model => [model.id, model]))
    expect(byId.get('checkpoint')).toMatchObject({ name: 'Mock Checkpoint', kind: 'chat', capabilities: { tools: true, vision: false, imageOutput: false } })
    expect(byId.get('shell')).toMatchObject({ name: 'Mock Shell', kind: 'chat', capabilities: { tools: true, vision: false, imageOutput: false } })
    for (const id of ['checkpoint', 'shell'])
      expect(mockProvider.createLanguageModel(id, { credentials: {}, fetch: globalThis.fetch })).toMatchObject({ provider: 'mock', modelId: id })
  })

  it('lists the five agent mocks (Phase 9) as explicit chat models with tools only; mock:compact has a 2000-token window', () => {
    const byId = new Map(mockModels().map(model => [model.id, model]))
    const names: Record<string, string> = { compact: 'Mock Compact', plan: 'Mock Plan', todo: 'Mock Todo', subagent: 'Mock Sub-agent', steer: 'Mock Steer' }
    for (const [id, name] of Object.entries(names)) {
      expect(modelInfoSchema.parse(byId.get(id)), id).toEqual({
        id,
        name,
        kind: 'chat',
        contextWindow: id === 'compact' ? 2000 : 32_000,
        maxOutputTokens: 4096,
        capabilities: { tools: true, vision: false, pdf: false, reasoning: false, structuredOutput: false, imageOutput: false },
        cost: { input: 1, output: 2 },
      })
      expect(mockProvider.createLanguageModel(id, { credentials: {}, fetch: globalThis.fetch })).toMatchObject({ provider: 'mock', modelId: id })
    }
    // Visible chat models (the picker, the provider's `modelCount`): everything except the three media models.
    expect(mockModels().filter(model => model.kind === undefined || model.kind === 'chat')).toHaveLength(16)
  })

  it('lists the two customization mocks (Phase 10) as explicit chat models with tools only', () => {
    const byId = new Map(mockModels().map(model => [model.id, model]))
    const names: Record<string, string> = { agents: 'Mock Agents', background: 'Mock Background' }
    for (const [id, name] of Object.entries(names)) {
      expect(modelInfoSchema.parse(byId.get(id)), id).toEqual({
        id,
        name,
        kind: 'chat',
        contextWindow: 32_000,
        maxOutputTokens: 4096,
        capabilities: { tools: true, vision: false, pdf: false, reasoning: false, structuredOutput: false, imageOutput: false },
        cost: { input: 1, output: 2 },
      })
      expect(mockProvider.createLanguageModel(id, { credentials: {}, fetch: globalThis.fetch })).toMatchObject({ provider: 'mock', modelId: id })
    }
    // The visible models (`GET /api/models`): the chat models plus the image model; transcribe and speech are hidden.
    expect(mockModels().filter(model => model.kind !== 'transcription' && model.kind !== 'speech')).toHaveLength(17)
  })

  it('passes the registry validation of provider definitions', () => {
    expect(() => validateProviderDefinition('mock', mockProvider)).not.toThrow()
  })

  it('maps efforts to the top-level reasoning option', () => {
    const model = mockModels()[1]!
    expect(mockProvider.reasoning?.('auto', model)).toBeUndefined()
    expect(mockProvider.reasoning?.('off', model)).toEqual({ reasoning: 'none' })
    expect(mockProvider.reasoning?.('medium', model)).toEqual({ reasoning: 'medium' })
    expect(mockProvider.reasoning?.('max', model)).toEqual({ reasoning: 'xhigh' })
  })

  it('maps the mock:error failure to auth_invalid, also inside a RetryError', () => {
    const expected = { code: 'auth_invalid', message: 'Mock authentication failure', status: 401, providerId: 'mock', action: 'configure-provider' }
    expect(mockProvider.mapError?.(mockAuthError())).toEqual(expected)
    const retry = new RetryError({ message: 'failed', reason: 'errorNotRetryable', errors: [mockAuthError()] })
    expect(mockProvider.mapError?.(retry)).toEqual(expected)
    expect(mockProvider.mapError?.(new Error('other'))).toBeUndefined()
  })

  it('creates a model per id', () => {
    const model = mockProvider.createLanguageModel('echo', { credentials: {}, fetch: globalThis.fetch })
    expect(model).toMatchObject({ specificationVersion: 'v4', provider: 'mock', modelId: 'echo' })
  })

  it('defines the plugin API 1.1.0 media members: image, transcription and speech models, imageParams, transcriptionOptions', async () => {
    const rt = { credentials: {}, fetch: globalThis.fetch }
    expect(mockProvider.createImageModel?.('image', rt)).toMatchObject({ specificationVersion: 'v4', provider: 'mock', modelId: 'image', maxImagesPerCall: 4 })
    expect(mockProvider.createTranscriptionModel?.('transcribe', rt)).toMatchObject({ specificationVersion: 'v4', provider: 'mock', modelId: 'transcribe' })
    expect(mockProvider.createSpeechModel?.('speech', rt)).toMatchObject({ specificationVersion: 'v4', provider: 'mock', modelId: 'speech' })
    const image = mockModels().find(model => model.id === 'image')!
    expect(mockProvider.imageParams?.({ n: 2, aspectRatio: '16:9', inputs: 0 }, image)).toEqual({ aspectRatio: '16:9', providerOptions: { mock: { aspectRatio: '16:9' } } })
    expect(mockProvider.imageParams?.({ n: 1, inputs: 0 }, image)).toBeUndefined()
    expect(mockProvider.transcriptionOptions?.({ language: 'de' })).toBeUndefined()
    expect(mockProvider.transcriptionOptions?.({})).toBeUndefined()
    expect(MOCK_TRANSCRIPT).toBe('This is a mock transcription.')
    expect(readWav(createMockWav('one two three four five')).durationMs).toBe(2000)
  })
})

describe('mock_approval_tool', () => {
  it('echoes its input and asks for approval', async () => {
    expect(mockApprovalTool).toMatchObject({ name: 'mock_approval_tool', policy: 'ask', description: 'Echoes its input. Mock tool that requires approval.' })
    const context = { chatId: 'c', modelRef: 'mock:tool-approval', toolCallId: 'mock_call_1', messages: [], signal: new AbortController().signal }
    await expect(mockApprovalTool.execute({ text: 'hi' }, context)).resolves.toEqual({ echoed: 'hi' })
  })
})

// ---------- mock:workspace (Phase 7, PROVIDERS.md 8) ----------

const ALL_WORKSPACE_TOOLS = [...WORKSPACE_TOOL_NAMES]
const WITHOUT_SHELL = WORKSPACE_TOOL_NAMES.filter(name => name !== 'shell')

function functionTools(names: readonly string[]): LanguageModelV4CallOptions['tools'] {
  return names.map(name => ({ type: 'function' as const, name, inputSchema: { type: 'object', properties: {} } }))
}

/** A prompt: the user message, then one assistant tool call + tool result per entry of `results`. */
function workspacePrompt(results: Array<{ toolName: string, output: LanguageModelV4ToolResultOutput }>, history: LanguageModelV4Prompt = []): LanguageModelV4Prompt {
  const prompt: LanguageModelV4Prompt = [...history, { role: 'user', content: [{ type: 'text', text: 'Do the workspace thing' }] }]
  results.forEach(({ toolName, output }, index) => {
    const toolCallId = `mock_call_${index + 1}`
    prompt.push({ role: 'assistant', content: [{ type: 'tool-call', toolCallId, toolName, input: {} }] })
    prompt.push({ role: 'tool', content: [{ type: 'tool-result', toolCallId, toolName, output }] })
  })
  return prompt
}

function plan(tools: readonly string[] | undefined, prompt: LanguageModelV4Prompt): ReturnType<typeof mockPlan> {
  return mockPlan('workspace', { prompt, ...(tools === undefined ? {} : { tools: functionTools(tools) }) })
}

const OK: LanguageModelV4ToolResultOutput = { type: 'text', value: 'Created mock-workspace.txt (1 line).' }
const SHELL_TEXT: LanguageModelV4ToolResultOutput = { type: 'text', value: 'Exit code: 0\nHello from the workspace agent.\n' }

describe('mock:workspace plans', () => {
  it('with the shell: write_file, edit_file, shell, then "Workspace done: <stdout>"', () => {
    expect(plan(ALL_WORKSPACE_TOOLS, workspacePrompt([]))).toEqual({
      reasoning: null,
      text: null,
      toolCall: { toolCallId: 'mock_call_1', toolName: 'write_file', input: JSON.stringify({ path: 'mock-workspace.txt', content: 'Hello from the mock agent.\n' }) },
      finishReason: 'tool-calls',
    })
    expect(plan(ALL_WORKSPACE_TOOLS, workspacePrompt([{ toolName: 'write_file', output: OK }])).toolCall).toEqual({
      toolCallId: 'mock_call_2',
      toolName: 'edit_file',
      input: JSON.stringify({ path: 'mock-workspace.txt', old_string: 'mock agent', new_string: 'workspace agent' }),
    })
    const third = plan(ALL_WORKSPACE_TOOLS, workspacePrompt([{ toolName: 'write_file', output: OK }, { toolName: 'edit_file', output: OK }]))
    expect(third).toMatchObject({ text: null, finishReason: 'tool-calls', toolCall: { toolCallId: 'mock_call_3', toolName: 'shell', input: JSON.stringify({ command: 'cat mock-workspace.txt' }) } })
    const done = plan(ALL_WORKSPACE_TOOLS, workspacePrompt([{ toolName: 'write_file', output: OK }, { toolName: 'edit_file', output: OK }, { toolName: 'shell', output: SHELL_TEXT }]))
    expect(done).toEqual({ reasoning: null, text: 'Workspace done: Hello from the workspace agent.', toolCall: null, finishReason: 'stop' })
  })

  it('without the shell (HF_WORKSPACE_SHELL=0, Windows): write_file, edit_file, then "Workspace done."', () => {
    expect(plan(WITHOUT_SHELL, workspacePrompt([])).toolCall?.toolName).toBe('write_file')
    expect(plan(WITHOUT_SHELL, workspacePrompt([{ toolName: 'write_file', output: OK }])).toolCall?.toolName).toBe('edit_file')
    expect(plan(WITHOUT_SHELL, workspacePrompt([{ toolName: 'write_file', output: OK }, { toolName: 'edit_file', output: OK }]))).toMatchObject({ text: MOCK_WORKSPACE_DONE, toolCall: null, finishReason: 'stop' })
    expect(MOCK_WORKSPACE_DONE).toBe('Workspace done.')
    expect(mockWorkspaceSteps(false).map(step => step.toolName)).toEqual(['write_file', 'edit_file'])
    expect(mockWorkspaceSteps(true).map(step => step.toolName)).toEqual(['write_file', 'edit_file', 'shell'])
  })

  it('a denied call ends the plan (a denied result or a denied approval response)', () => {
    const denied: LanguageModelV4ToolResultOutput = { type: 'execution-denied', reason: 'no' }
    expect(plan(ALL_WORKSPACE_TOOLS, workspacePrompt([{ toolName: 'write_file', output: denied }]))).toMatchObject({ text: MOCK_WORKSPACE_DENIED, toolCall: null, finishReason: 'stop' })
    expect(plan(ALL_WORKSPACE_TOOLS, workspacePrompt([{ toolName: 'write_file', output: OK }, { toolName: 'edit_file', output: OK }, { toolName: 'shell', output: denied }])).text).toBe('The tool call was denied.')
    const prompt = workspacePrompt([{ toolName: 'write_file', output: OK }])
    prompt.push({ role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'mock_call_2', toolName: 'edit_file', input: {} }] })
    prompt.push({ role: 'tool', content: [{ type: 'tool-approval-response', approvalId: 'approval_1', approved: false }] })
    expect(plan(ALL_WORKSPACE_TOOLS, prompt).text).toBe(MOCK_WORKSPACE_DENIED)
  })

  it('a failed call ends the plan with its error text', () => {
    const failed: LanguageModelV4ToolResultOutput = { type: 'error-text', value: 'The write_file tool is not implemented yet.' }
    expect(plan(ALL_WORKSPACE_TOOLS, workspacePrompt([{ toolName: 'write_file', output: failed }]))).toMatchObject({ text: 'The tool call failed: The write_file tool is not implemented yet.', finishReason: 'stop' })
    expect(plan(ALL_WORKSPACE_TOOLS, workspacePrompt([{ toolName: 'write_file', output: { type: 'error-json', value: { code: 'x' } } }])).text).toBe('The tool call failed: {"code":"x"}')
  })

  it.each([
    ['no tools in the call (tool mode off)', undefined],
    ['no workspace tools (a chat without a project)', ['mock_approval_tool', 'current_time']],
    ['only read tools', ['read_file', 'list_directory', 'find_files', 'search_files']],
    ['the write tool disabled', ['read_file', 'edit_file', 'shell']],
  ] as const)('%s: "Workspace tools are not available."', (_label, tools) => {
    expect(plan(tools, workspacePrompt([]))).toMatchObject({ text: MOCK_WORKSPACE_UNAVAILABLE, toolCall: null, finishReason: 'stop' })
  })

  it('counts only the results after the last user message (a new message starts over)', () => {
    const history = workspacePrompt([{ toolName: 'write_file', output: OK }, { toolName: 'edit_file', output: OK }, { toolName: 'shell', output: SHELL_TEXT }])
    history.push({ role: 'assistant', content: [{ type: 'text', text: 'Workspace done: Hello from the workspace agent.' }] })
    const next = plan(ALL_WORKSPACE_TOOLS, workspacePrompt([], history))
    // Ids continue after the assistant messages of the history (like mock:tool-approval).
    expect(next.toolCall).toMatchObject({ toolName: 'write_file', toolCallId: 'mock_call_5' })
    // Results of other tools are not workspace steps.
    expect(plan(ALL_WORKSPACE_TOOLS, workspacePrompt([{ toolName: 'mock_approval_tool', output: OK }])).toolCall?.toolName).toBe('write_file')
  })

  it.each([
    [{ type: 'text', value: 'Exit code: 0\nHello from the workspace agent.\n' }, 'Hello from the workspace agent.'],
    [{ type: 'text', value: 'Stopped after 120 s (timeout)\npartial output' }, 'partial output'],
    [{ type: 'text', value: 'Exit code: 0\nstdout:\nline one\nline two\nstderr:\nwarning\n' }, 'line one\nline two'],
    [{ type: 'text', value: 'Exit code: 0\r\nwindows line\r\n' }, 'windows line'],
    [{ type: 'json', value: { command: 'cat x', exitCode: 0, stdout: 'from json\n', stderr: '' } }, 'from json'],
    [{ type: 'json', value: { exitCode: 0 } }, ''],
    [{ type: 'content', value: [{ type: 'text', text: 'Exit code: 0' }, { type: 'text', text: 'from content' }] }, 'from content'],
  ] as Array<[LanguageModelV4ToolResultOutput, string]>)('mockShellStdout(%j) = %j', (output, stdout) => {
    expect(mockShellStdout(output)).toBe(stdout)
  })

  it('streams a planned call as tool-input parts and a tool-call (doStream)', async () => {
    const model = createMockLanguageModel('workspace')
    const { stream } = await model.doStream({ prompt: workspacePrompt([]), tools: functionTools(ALL_WORKSPACE_TOOLS) })
    const parts: string[] = []
    for await (const part of stream as unknown as AsyncIterable<{ type: string, toolName?: string }>)
      parts.push(part.toolName === undefined ? part.type : `${part.type}:${part.toolName}`)
    expect(parts).toEqual(['stream-start', 'response-metadata', 'tool-input-start:write_file', 'tool-input-delta', 'tool-input-end', 'tool-call:write_file', 'finish'])
  })
})

describe('mock:workspace end to end through streamText (tools over a temp project folder)', () => {
  async function run(withShell: boolean): Promise<{ text: string, file: string, steps: string[] }> {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'hf-')))
    try {
      const writeFile = tool({
        description: 'Writes a file.',
        inputSchema: writeFileToolInputSchema,
        execute: async input => writeWorkspaceFile(root, input.path, input.content),
        toModelOutput: ({ output }) => ({ type: 'text', value: `Created ${output.rel}.` }),
      })
      const editFile = tool({
        description: 'Edits a file.',
        inputSchema: editFileToolInputSchema,
        execute: async (input) => {
          const current = (await readWorkspaceFile(root, input.path, { maxBytes: 65_536 })).bytes.toString('utf8')
          return writeWorkspaceFile(root, input.path, current.replace(input.old_string, input.new_string))
        },
        toModelOutput: ({ output }) => ({ type: 'text', value: `Edited ${output.rel}: 1 replacement.` }),
      })
      // A stand-in for the shell runner (W7.3): `cat <file>` through the path guard.
      const shell = tool({
        description: 'Runs a command.',
        inputSchema: shellToolInputSchema,
        execute: async input => ({ exitCode: 0, stdout: (await readWorkspaceFile(root, input.command.replace(/^cat /, ''), { maxBytes: 65_536 })).bytes.toString('utf8') }),
        toModelOutput: ({ output }) => ({ type: 'text', value: `Exit code: ${output.exitCode}\n${output.stdout}` }),
      })
      const model = createMockLanguageModel('workspace')
      const prompt = 'Try the workspace tools'
      const result = withShell
        ? streamText({ model, prompt, tools: { write_file: writeFile, edit_file: editFile, shell }, stopWhen: isStepCount(6) })
        : streamText({ model, prompt, tools: { write_file: writeFile, edit_file: editFile }, stopWhen: isStepCount(6) })
      const text = await result.text
      const steps = (await result.steps).flatMap(step => step.toolCalls.map(call => call.toolName))
      return { text, file: await readFile(join(root, MOCK_WORKSPACE_FILE), 'utf8'), steps }
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  }

  it('writes, edits, runs cat and reports the stdout', async () => {
    const outcome = await run(true)
    expect(outcome).toEqual({ text: 'Workspace done: Hello from the workspace agent.', file: 'Hello from the workspace agent.\n', steps: ['write_file', 'edit_file', 'shell'] })
    expect(MOCK_WORKSPACE_CONTENT).toBe('Hello from the mock agent.\n')
    expect(MOCK_WORKSPACE_COMMAND).toBe('cat mock-workspace.txt')
  })

  it('without the shell: writes, edits and answers "Workspace done."', async () => {
    expect(await run(false)).toEqual({ text: 'Workspace done.', file: 'Hello from the workspace agent.\n', steps: ['write_file', 'edit_file'] })
  })
})

// ---------- mock:checkpoint and mock:shell (Phase 8, PROVIDERS.md 8) ----------

/** A prompt with `turns` earlier user turns (each answered), then the last user message and the given results. */
function turnPrompt(turns: number, results: Array<{ toolName: string, output: LanguageModelV4ToolResultOutput }>, text = 'Next turn'): LanguageModelV4Prompt {
  const history: LanguageModelV4Prompt = []
  for (let index = 0; index < turns; index++) {
    history.push({ role: 'user', content: [{ type: 'text', text: `turn ${index + 1}` }] })
    history.push({ role: 'assistant', content: [{ type: 'text', text: MOCK_CHECKPOINT_DONE }] })
  }
  const prompt: LanguageModelV4Prompt = [...history, { role: 'user', content: [{ type: 'text', text }] }]
  results.forEach(({ toolName, output }, index) => {
    const toolCallId = `mock_call_${turns + index + 1}`
    prompt.push({ role: 'assistant', content: [{ type: 'tool-call', toolCallId, toolName, input: {} }] })
    prompt.push({ role: 'tool', content: [{ type: 'tool-result', toolCallId, toolName, output }] })
  })
  return prompt
}

function checkpointPlan(tools: readonly string[] | undefined, prompt: LanguageModelV4Prompt): ReturnType<typeof mockPlan> {
  return mockPlan('checkpoint', { prompt, ...(tools === undefined ? {} : { tools: functionTools(tools) }) })
}

function shellPlan(tools: readonly string[] | undefined, prompt: LanguageModelV4Prompt): ReturnType<typeof mockPlan> {
  return mockPlan('shell', { prompt, ...(tools === undefined ? {} : { tools: functionTools(tools) }) })
}

const WRITTEN: LanguageModelV4ToolResultOutput = { type: 'text', value: 'Created checkpoint.txt (1 line).' }
const MKDIR: LanguageModelV4ToolResultOutput = { type: 'text', value: 'Exit code: 0\nThe working folder is now mock-dir (the next call starts there).\nstdout:\n(no output)' }
const LS: LanguageModelV4ToolResultOutput = { type: 'text', value: 'Exit code: 0\nstdout:\n(no output)' }

describe('mock:checkpoint plans', () => {
  it('with the shell: write_file "Turn <n>", mkdir + cd, ls, then "Checkpoint done."', () => {
    expect(checkpointPlan(ALL_WORKSPACE_TOOLS, turnPrompt(0, []))).toEqual({
      reasoning: null,
      text: null,
      toolCall: { toolCallId: 'mock_call_1', toolName: 'write_file', input: JSON.stringify({ path: 'checkpoint.txt', content: 'Turn 1\n' }) },
      finishReason: 'tool-calls',
    })
    expect(checkpointPlan(ALL_WORKSPACE_TOOLS, turnPrompt(0, [{ toolName: 'write_file', output: WRITTEN }])).toolCall).toEqual({
      toolCallId: 'mock_call_2',
      toolName: 'shell',
      input: JSON.stringify({ command: 'mkdir -p mock-dir && cd mock-dir' }),
    })
    expect(checkpointPlan(ALL_WORKSPACE_TOOLS, turnPrompt(0, [{ toolName: 'write_file', output: WRITTEN }, { toolName: 'shell', output: MKDIR }])).toolCall).toEqual({
      toolCallId: 'mock_call_3',
      toolName: 'shell',
      input: JSON.stringify({ command: 'ls' }),
    })
    const done = checkpointPlan(ALL_WORKSPACE_TOOLS, turnPrompt(0, [{ toolName: 'write_file', output: WRITTEN }, { toolName: 'shell', output: MKDIR }, { toolName: 'shell', output: LS }]))
    expect(done).toEqual({ reasoning: null, text: 'Checkpoint done.', toolCall: null, finishReason: 'stop' })
    expect([MOCK_CHECKPOINT_MKDIR_COMMAND, MOCK_CHECKPOINT_LS_COMMAND, MOCK_CHECKPOINT_DONE]).toEqual(['mkdir -p mock-dir && cd mock-dir', 'ls', 'Checkpoint done.'])
  })

  it('every turn writes "Turn <n>" with n = the user messages of the prompt (each user message is a rewind point)', () => {
    expect(checkpointPlan(ALL_WORKSPACE_TOOLS, turnPrompt(1, [])).toolCall).toMatchObject({ toolName: 'write_file', toolCallId: 'mock_call_2', input: JSON.stringify({ path: 'checkpoint.txt', content: 'Turn 2\n' }) })
    expect(checkpointPlan(ALL_WORKSPACE_TOOLS, turnPrompt(4, [])).toolCall?.input).toBe(JSON.stringify({ path: 'checkpoint.txt', content: 'Turn 5\n' }))
    expect(mockCheckpointContent(3)).toBe('Turn 3\n')
    expect(mockCheckpointSteps(2, true).map(step => [step.toolName, step.input])).toEqual([
      ['write_file', { path: 'checkpoint.txt', content: 'Turn 2\n' }],
      ['shell', { command: 'mkdir -p mock-dir && cd mock-dir' }],
      ['shell', { command: 'ls' }],
    ])
  })

  it('without the shell (HF_WORKSPACE_SHELL=0, Windows): write_file, then "Checkpoint done."', () => {
    expect(checkpointPlan(WITHOUT_SHELL, turnPrompt(0, [])).toolCall?.toolName).toBe('write_file')
    expect(checkpointPlan(WITHOUT_SHELL, turnPrompt(0, [{ toolName: 'write_file', output: WRITTEN }]))).toMatchObject({ text: 'Checkpoint done.', toolCall: null, finishReason: 'stop' })
    expect(checkpointPlan(['write_file'], turnPrompt(0, [{ toolName: 'write_file', output: WRITTEN }])).text).toBe('Checkpoint done.')
    expect(mockCheckpointSteps(1, false).map(step => step.toolName)).toEqual(['write_file'])
  })

  it('a denied call ends the plan (a denied result or a denied approval response)', () => {
    const denied: LanguageModelV4ToolResultOutput = { type: 'execution-denied', reason: 'no' }
    expect(checkpointPlan(ALL_WORKSPACE_TOOLS, turnPrompt(0, [{ toolName: 'write_file', output: denied }]))).toMatchObject({ text: 'The tool call was denied.', toolCall: null, finishReason: 'stop' })
    expect(checkpointPlan(ALL_WORKSPACE_TOOLS, turnPrompt(0, [{ toolName: 'write_file', output: WRITTEN }, { toolName: 'shell', output: denied }])).text).toBe('The tool call was denied.')
    const prompt = turnPrompt(0, [{ toolName: 'write_file', output: WRITTEN }])
    prompt.push({ role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'mock_call_2', toolName: 'shell', input: {} }] })
    prompt.push({ role: 'tool', content: [{ type: 'tool-approval-response', approvalId: 'approval_1', approved: false }] })
    expect(checkpointPlan(ALL_WORKSPACE_TOOLS, prompt).text).toBe('The tool call was denied.')
  })

  it('a failed call ends the plan with its error text', () => {
    const failed: LanguageModelV4ToolResultOutput = { type: 'error-text', value: 'Path is outside the project folder.' }
    expect(checkpointPlan(ALL_WORKSPACE_TOOLS, turnPrompt(0, [{ toolName: 'write_file', output: failed }]))).toMatchObject({ text: 'The tool call failed: Path is outside the project folder.', finishReason: 'stop' })
  })

  it.each([
    ['no tools in the call (tool mode off)', undefined],
    ['no workspace tools (a chat without a project)', ['mock_approval_tool', 'current_time']],
    ['only read tools and the shell', ['read_file', 'list_directory', 'shell']],
  ] as const)('%s: "Workspace tools are not available."', (_label, tools) => {
    expect(checkpointPlan(tools, turnPrompt(0, []))).toMatchObject({ text: MOCK_WORKSPACE_UNAVAILABLE, toolCall: null, finishReason: 'stop' })
  })
})

describe('mock:shell plans', () => {
  it('runs the trimmed user text as one shell call, then "Shell done: <stdout>"', () => {
    expect(shellPlan(ALL_WORKSPACE_TOOLS, turnPrompt(0, [], '  cd sub  '))).toEqual({
      reasoning: null,
      text: null,
      toolCall: { toolCallId: 'mock_call_1', toolName: 'shell', input: JSON.stringify({ command: 'cd sub' }) },
      finishReason: 'tool-calls',
    })
    const stdout: LanguageModelV4ToolResultOutput = { type: 'text', value: 'Exit code: 0\nThe working folder is now sub (the next call starts there).\nstdout:\n/srv/demo/sub\n' }
    expect(shellPlan(ALL_WORKSPACE_TOOLS, turnPrompt(0, [{ toolName: 'shell', output: stdout }], 'pwd'))).toEqual({ reasoning: null, text: 'Shell done: /srv/demo/sub', toolCall: null, finishReason: 'stop' })
    expect(shellPlan(['shell'], turnPrompt(0, [{ toolName: 'shell', output: { type: 'json', value: { stdout: 'a\n' } } }], 'ls'))).toMatchObject({ text: 'Shell done: a' })
    expect(shellPlan(['shell'], turnPrompt(0, [{ toolName: 'shell', output: { type: 'json', value: { stdout: '' } } }], 'true')).text).toBe(MOCK_SHELL_DONE_PREFIX)
  })

  it('a new user message starts over (ids continue after the assistant messages)', () => {
    expect(shellPlan(['shell'], turnPrompt(2, [], 'ls')).toolCall).toMatchObject({ toolName: 'shell', toolCallId: 'mock_call_3' })
  })

  it('an empty user text answers "(empty message)" without a call', () => {
    expect(shellPlan(['shell'], turnPrompt(0, [], '   '))).toMatchObject({ text: '(empty message)', toolCall: null, finishReason: 'stop' })
  })

  it('denied and failed calls', () => {
    expect(shellPlan(['shell'], turnPrompt(0, [{ toolName: 'shell', output: { type: 'execution-denied' } }], 'rm x')).text).toBe('The tool call was denied.')
    expect(shellPlan(['shell'], turnPrompt(0, [{ toolName: 'shell', output: { type: 'error-text', value: 'The command could not start.' } }], 'ls')).text).toBe('The tool call failed: The command could not start.')
  })

  it.each([
    ['no tools in the call', undefined],
    ['no shell (HF_WORKSPACE_SHELL=0, a chat without a project)', ['write_file', 'edit_file', 'read_file']],
  ] as const)('%s: "Workspace tools are not available."', (_label, tools) => {
    expect(shellPlan(tools, turnPrompt(0, [], 'ls'))).toMatchObject({ text: MOCK_WORKSPACE_UNAVAILABLE, toolCall: null, finishReason: 'stop' })
  })
})

describe('mock:checkpoint end to end through streamText (stand-in tools over a temp project folder)', () => {
  it('writes "Turn 1", creates and enters mock-dir, lists it and answers "Checkpoint done."', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'hf-')))
    try {
      const commands: string[] = []
      const writeFile = tool({
        description: 'Writes a file.',
        inputSchema: writeFileToolInputSchema,
        execute: async input => writeWorkspaceFile(root, input.path, input.content),
        toModelOutput: ({ output }) => ({ type: 'text', value: `Created ${output.rel}.` }),
      })
      // A stand-in for the shell runner: records the command, runs nothing.
      const shell = tool({
        description: 'Runs a command.',
        inputSchema: shellToolInputSchema,
        execute: async (input) => {
          commands.push(input.command)
          return { exitCode: 0, stdout: '' }
        },
        toModelOutput: ({ output }) => ({ type: 'text', value: `Exit code: ${output.exitCode}\nstdout:\n${output.stdout}` }),
      })
      const result = streamText({ model: createMockLanguageModel('checkpoint'), prompt: 'Change the checkpoint', tools: { write_file: writeFile, shell }, stopWhen: isStepCount(6) })
      expect(await result.text).toBe('Checkpoint done.')
      expect((await result.steps).flatMap(step => step.toolCalls.map(call => call.toolName))).toEqual(['write_file', 'shell', 'shell'])
      expect(commands).toEqual(['mkdir -p mock-dir && cd mock-dir', 'ls'])
      expect(await readFile(join(root, 'checkpoint.txt'), 'utf8')).toBe('Turn 1\n')
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
