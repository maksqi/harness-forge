// Sample code plugin (not exported from the package entry): registers a provider (with an image model, plugin API
// 1.1.0), a tool, a command, a hook, an agent and a skill (plugin API 1.4.0) using only `ctx` (runtime libraries come
// from `ctx.ai`). It doubles as a type
// test of the SDK: it must typecheck without casts. A real plugin would live in `data/plugins/sample-kit/` with this
// manifest as `plugin.json` and `"main": "index.ts"`.
import type { PluginManifest, ProviderRuntime, ReasoningLevel, ToolDefinition } from '../index.ts'
import { definePlugin } from '../index.ts'

export const manifest = {
  manifestVersion: 1,
  id: 'sample-kit',
  name: 'Sample kit',
  version: '1.0.0',
  description: 'A provider, a tool, a command and a hook.',
  engines: { harness: '^1.0.0' },
  main: 'index.ts',
  permissions: ['network', 'hooks'],
  settings: {
    type: 'object',
    properties: {
      signature: { type: 'string', title: 'Instructions suffix', description: 'Appended to the instructions.', default: '' },
    },
  },
} satisfies PluginManifest

const DEFAULT_BASE_URL = 'https://llm.example.com/v1'
const EFFORT: Record<'off' | 'low' | 'medium' | 'high' | 'max', ReasoningLevel> = {
  off: 'none',
  low: 'low',
  medium: 'medium',
  high: 'high',
  max: 'xhigh',
}

function baseURL(credentials: Record<string, string>): string {
  return (credentials.baseURL || DEFAULT_BASE_URL).replace(/\/+$/, '')
}

export default definePlugin({
  setup(ctx) {
    const { z } = ctx.ai
    const compatible = (rt: ProviderRuntime) => ctx.ai.createOpenAICompatible({
      name: 'sample-kit',
      baseURL: baseURL(rt.credentials),
      apiKey: rt.credentials.apiKey,
      fetch: rt.fetch,
      includeUsage: true,
    })

    ctx.providers.register({
      id: 'sample-kit',
      name: 'Sample gateway',
      keyUrl: 'https://llm.example.com/keys',
      smallModelId: 'sample-small',
      credentials: [
        { key: 'apiKey', label: 'API key', type: 'secret', required: true, envVar: 'SAMPLE_API_KEY' },
        { key: 'baseURL', label: 'Base URL', type: 'url', default: DEFAULT_BASE_URL, advanced: true },
      ],
      seedModels: [
        { id: 'sample-large', name: 'Sample Large', capabilities: { tools: true, reasoning: true }, reasoningEfforts: ['low', 'medium', 'high'] },
        { id: 'sample-small', name: 'Sample Small', capabilities: { tools: true } },
        { id: 'sample-image', name: 'Sample Image', kind: 'image', capabilities: { vision: true } },
      ],
      createLanguageModel(modelId, rt) {
        return compatible(rt).chatModel(modelId)
      },
      createImageModel(modelId, rt) {
        return compatible(rt).imageModel(modelId)
      },
      imageParams(request) {
        // An images API with three sizes: the aspect ratio picks the closest one ("Auto" sends nothing).
        if (request.aspectRatio === undefined)
          return undefined
        const [width = 1, height = 1] = request.aspectRatio.split(':').map(Number)
        return { size: width === height ? '1024x1024' : width > height ? '1536x1024' : '1024x1536' }
      },
      transcriptionOptions(hints) {
        return hints.language === undefined ? undefined : { 'sample-kit': { language: hints.language } }
      },
      async listModels(rt) {
        const response = await rt.fetch(`${baseURL(rt.credentials)}/models`, {
          headers: { Authorization: `Bearer ${rt.credentials.apiKey ?? ''}` },
          signal: rt.signal,
        })
        if (!response.ok)
          throw new Error(`Model listing failed with HTTP ${response.status}`)
        const body: unknown = await response.json()
        const listing = z.object({ data: z.array(z.object({ id: z.string(), context_window: z.number().optional() })) }).parse(body)
        return listing.data.map(model => ({ id: model.id, contextWindow: model.context_window }))
      },
      reasoning(effort) {
        return effort === 'auto' ? undefined : { reasoning: EFFORT[effort] }
      },
      mapError(err) {
        if (err instanceof Error && 'statusCode' in err && err.statusCode === 402)
          return { code: 'rate_limited', message: 'The sample quota is exhausted.', action: 'retry' }
        return undefined
      },
    })

    const wordCount: ToolDefinition<{ text: string }, { words: number }> = {
      name: 'sample_word_count',
      description: 'Count the words in a text.',
      inputSchema: z.object({ text: z.string().max(100_000) }),
      policy: 'safe',
      async execute({ text }) {
        const trimmed = text.trim()
        return { words: trimmed ? trimmed.split(/\s+/).length : 0 }
      },
      toModelOutput(output) {
        return { type: 'text', value: `${output.words} words` }
      },
    }
    ctx.tools.register(wordCount)

    ctx.tools.register({
      name: 'sample_echo',
      description: 'Echo the input text; asks for approval for long inputs.',
      inputSchema: z.object({ text: z.string() }),
      policy: input => (input.text.length > 1000 ? 'always' : 'safe'),
      async execute(input, call) {
        ctx.logger.debug('echo', { chatId: call.chatId, length: input.text.length })
        return { echoed: input.text }
      },
    })

    ctx.commands.register({
      name: 'sample-tldr',
      description: 'Summarize text in three bullets',
      template: 'Summarize in three bullets:\n\n{{input}}',
    })

    ctx.commands.register({
      name: 'sample-count',
      description: 'Count the words of the input',
      async run({ input }) {
        const words = input.trim() ? input.trim().split(/\s+/).length : 0
        return { type: 'reply', markdown: `**${words}** words` }
      },
    })

    ctx.hooks.on('chat.params', (input, output) => {
      const { signature } = ctx.settings.get<{ signature?: string }>()
      if (signature && input.toolMode !== 'off')
        output.instructions = `${output.instructions}\n\n${signature}`
    }, { priority: 10 })

    ctx.hooks.on('message.completed', (input) => {
      ctx.logger.info('message completed', { chatId: input.chatId, aborted: input.aborted })
    })

    // Plugin API 1.4.0: an agent type for `task` (its tools only narrow the child's tools) and a skill.
    ctx.agents.register({
      name: 'sample-reviewer',
      description: 'Reviews a diff for bugs and reports them by file.',
      instructions: 'You review code. Read the files you are given and report bugs, one bullet per finding.',
      tools: ['read_file', 'search_files'],
      model: 'inherit',
    })

    ctx.skills.register({
      name: 'sample-release-notes',
      description: 'How to write the release notes of this project.',
      content: '# Release notes\n\n1. List the user-facing changes.\n2. Group them by area.',
    })
  },
})
