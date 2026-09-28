// "Provider" template: an LLM provider written in code for any OpenAI-compatible API (`ctx.providers.register` with
// `ctx.ai.createOpenAICompatible`, a live model listing through the host `fetch`, credentials entered in Settings).
/* eslint-disable no-template-curly-in-string -- the strings below are lines of generated JavaScript source */
import type { TemplateDefinition } from './definition.ts'
import { commentText, entryHeader, jsString, moduleClose, moduleOpen, sourceFile } from './source.ts'

export const providerTemplate: TemplateDefinition = {
  id: 'provider',
  label: 'Provider',
  description: 'Adds an LLM provider written in code.',
  permissions: ['network'],
  entry: ({ language, name, names }) => sourceFile([
    ...entryHeader({
      language,
      comments: [
        `${commentText(name)}: an LLM provider written in code, for any OpenAI-compatible API.`,
        'After "Build & reload", open Settings -> Providers, enter the base URL (and an API key when the API needs',
        'one), then Test. The models of the API appear in the model picker.',
      ],
      typeImports: ['ModelInfo'],
    }),
    '',
    ...(language === 'ts'
      ? [
          '/** The API root without a trailing slash, e.g. "https://api.example.com/v1". */',
          'function baseURL(credentials: Record<string, string>): string {',
        ]
      : [
          '/**',
          ' * The API root without a trailing slash, e.g. "https://api.example.com/v1".',
          ' * @param {Record<string, string>} credentials',
          ' */',
          'function baseURL(credentials) {',
        ]),
    '  return (credentials.baseURL ?? \'\').replace(/\\/+$/, \'\')',
    '}',
    '',
    ...moduleOpen(language),
    '  setup(ctx) {',
    '    ctx.providers.register({',
    '      // Model refs of this provider look like "<id>:<model id>".',
    `      id: ${jsString(names.provider)},`,
    `      name: ${jsString(name)},`,
    '      // Fields of the key dialog (Settings -> Providers). Secrets are stored encrypted.',
    '      credentials: [',
    '        { key: \'baseURL\', label: \'Base URL\', type: \'url\', required: true },',
    '        { key: \'apiKey\', label: \'API key\', type: \'secret\' },',
    '      ],',
    '      // Models to show when the live listing is unavailable, for example:',
    '      // seedModels: [{ id: \'my-model\', name: \'My model\', capabilities: { tools: true } }],',
    '',
    '      // Called for every request; no network I/O here. rt.fetch is the host fetch (aborted with the run).',
    '      createLanguageModel(modelId, rt) {',
    '        const provider = ctx.ai.createOpenAICompatible({',
    `          name: ${jsString(names.provider)},`,
    '          baseURL: baseURL(rt.credentials),',
    '          apiKey: rt.credentials.apiKey,',
    '          fetch: rt.fetch,',
    '          includeUsage: true,',
    '        })',
    '        return provider.chatModel(modelId)',
    '      },',
    '',
    '      // The live model list (cached for 24 hours); also the credential test of the key dialog.',
    '      async listModels(rt) {',
    '        const apiKey = rt.credentials.apiKey',
    '        const response = await rt.fetch(`${baseURL(rt.credentials)}/models`, {',
    '          headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},',
    '          signal: rt.signal,',
    '        })',
    '        if (!response.ok)',
    '          throw new Error(`Listing the models failed with HTTP ${response.status}.`)',
    ...(language === 'ts'
      ? ['        const body = await response.json() as { data?: Array<{ id: string }> }']
      : ['        /** @type {{ data?: Array<{ id: string }> }} */', '        const body = await response.json()']),
    ...(language === 'ts'
      ? ['        return (body.data ?? []).map((model): ModelInfo => ({ id: model.id }))']
      : ['        return (body.data ?? []).map(model => ({ id: model.id }))']),
    '      },',
    '    })',
    '  },',
    moduleClose(language),
  ]),
  readme: ({ names }) => [
    `The plugin registers the provider \`${names.provider}\` for an OpenAI-compatible API. Open **Settings -> Providers**,`,
    'enter the base URL (for example `https://api.example.com/v1`) and an API key when the API needs one, then press',
    `**Test**. Models appear in the model picker as \`${names.provider}:<model id>\`. Add \`reasoning()\` or \`mapError()\``,
    'to map reasoning efforts and errors (see the provider example in docs/PLUGINS.md).',
  ],
}
