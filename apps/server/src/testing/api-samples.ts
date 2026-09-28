// One valid request per route of the shared route table (typed against the client input types), for route-table
// driven tests: every endpoint is mounted (C4), every non-public route answers 401 without a session (W1.1), ...
import type { ApiInput, ApiRouteKey, DeclarativeProvider, PluginManifest } from '@harness-forge/shared'
import { apiRoutes, apiUrl } from '@harness-forge/shared'

export const SAMPLE_CHAT_ID = '0199a8f0-0000-7000-8000-000000000001'
export const SAMPLE_MESSAGE_ID = 'msg_sample0000000001'
export const SAMPLE_FILE_ID = 'file_sample0000000001'
export const SAMPLE_PLUGIN_ID = 'sample-plugin'
export const SAMPLE_PROVIDER_ID = 'openai'
export const SAMPLE_MCP_SERVER_ID = 'everything'

export const SAMPLE_DECLARATIVE_PROVIDER = {
  id: SAMPLE_PLUGIN_ID,
  name: 'Sample provider',
  baseURL: 'https://api.example.com/v1',
  apiFormat: 'openai-chat',
} satisfies DeclarativeProvider

export const SAMPLE_MANIFEST = {
  manifestVersion: 1,
  id: SAMPLE_PLUGIN_ID,
  name: 'Sample plugin',
  version: '1.0.0',
  engines: { harness: '^1.0.0' },
  contributes: { providers: [SAMPLE_DECLARATIVE_PROVIDER] },
} satisfies PluginManifest

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** Request input of a route without transport options. */
export type ApiSampleInput<K extends ApiRouteKey> = DistributiveOmit<ApiInput<K>, 'signal' | 'headers' | 'form'> & {
  /** Multipart body, built per request. */
  form?: () => FormData
}

/** A valid input for every route key. */
export const API_SAMPLES: { readonly [K in ApiRouteKey]: ApiSampleInput<K> } = {
  'health.get': {},

  'auth.status': {},
  'auth.login': { body: { password: 'correct horse battery staple' } },
  'auth.logout': {},
  'auth.setPassword': { body: { newPassword: 'correct horse battery staple' } },

  'settings.get': {},
  'settings.update': { body: { displayName: 'Sample' } },

  'events.stream': {},

  'providers.list': {},
  'providers.update': { params: { id: SAMPLE_PROVIDER_ID }, body: { enabled: false } },
  'providers.test': { params: { id: SAMPLE_PROVIDER_ID }, body: {} },

  'credentials.set': { params: { id: SAMPLE_PROVIDER_ID }, body: { values: { apiKey: 'sample-api-key' } } },
  'credentials.clear': { params: { id: SAMPLE_PROVIDER_ID } },

  'models.list': { query: { providerId: SAMPLE_PROVIDER_ID, includeHidden: 'true' } },
  'models.refresh': { params: { id: SAMPLE_PROVIDER_ID } },
  'models.updatePrefs': { body: { providerId: SAMPLE_PROVIDER_ID, modelId: 'gpt-6-luna', favorite: true } },
  'models.addCustom': { body: { providerId: SAMPLE_PROVIDER_ID, modelId: 'my-custom-model' } },
  'models.removeCustom': { query: { providerId: SAMPLE_PROVIDER_ID, modelId: 'my-custom-model' } },

  'icons.list': {},
  'icons.get': { params: { slug: 'claude-color' } },

  'chats.list': { query: { q: 'hello', limit: '10' } },
  'chats.create': { body: { id: SAMPLE_CHAT_ID, title: 'Sample chat' } },
  'chats.get': { params: { id: SAMPLE_CHAT_ID } },
  'chats.update': { params: { id: SAMPLE_CHAT_ID }, body: { pinned: true } },
  'chats.remove': { params: { id: SAMPLE_CHAT_ID } },
  'chats.export': { params: { id: SAMPLE_CHAT_ID }, query: { format: 'md' } },

  'chat.send': {
    body: {
      chatId: SAMPLE_CHAT_ID,
      message: { id: SAMPLE_MESSAGE_ID, role: 'user', parts: [{ type: 'text', text: 'ping' }] },
      trigger: 'submit-message',
      modelRef: 'mock:echo',
      reasoningEffort: 'auto',
      toolMode: 'ask',
    },
  },
  'chat.resume': { params: { id: SAMPLE_CHAT_ID } },
  'chat.stop': { params: { id: SAMPLE_CHAT_ID } },

  'files.upload': {
    form: () => {
      const form = new FormData()
      form.append('file', new File(['hello'], 'hello.txt', { type: 'text/plain' }))
      return form
    },
  },
  'files.get': { params: { id: SAMPLE_FILE_ID } },

  'tools.list': {},
  'tools.update': { params: { name: 'current_time' }, body: { override: 'allow' } },

  'mcp.list': {},
  'mcp.create': { body: { id: SAMPLE_MCP_SERVER_ID, name: 'Everything', transport: { type: 'http', url: 'https://mcp.example.com/mcp' } } },
  'mcp.update': { params: { id: SAMPLE_MCP_SERVER_ID }, body: { name: 'Everything (renamed)' } },
  'mcp.remove': { params: { id: SAMPLE_MCP_SERVER_ID } },
  'mcp.reconnect': { params: { id: SAMPLE_MCP_SERVER_ID } },

  'commands.list': {},

  'plugins.list': {},
  'plugins.get': { params: { id: SAMPLE_PLUGIN_ID } },
  'plugins.remove': { params: { id: SAMPLE_PLUGIN_ID }, query: { keepData: 'true' } },
  'plugins.enable': { params: { id: SAMPLE_PLUGIN_ID } },
  'plugins.disable': { params: { id: SAMPLE_PLUGIN_ID } },
  'plugins.reload': { params: { id: SAMPLE_PLUGIN_ID } },
  'plugins.getSettings': { params: { id: SAMPLE_PLUGIN_ID } },
  'plugins.updateSettings': { params: { id: SAMPLE_PLUGIN_ID }, body: { values: { region: 'eu' } } },
  'plugins.icon': { params: { id: SAMPLE_PLUGIN_ID } },
  'plugins.logs': { params: { id: SAMPLE_PLUGIN_ID }, query: { after: '0', limit: '50' } },

  'pluginInstall.inspect': { body: { source: 'npm', spec: 'harness-forge-plugin-sample@1.0.0' } },
  'pluginInstall.install': { body: { source: 'npm', spec: 'harness-forge-plugin-sample@1.0.0', trust: true } },
  'pluginInstall.trust': { params: { id: SAMPLE_PLUGIN_ID }, body: { sha256: 'a'.repeat(64) } },
  'pluginInstall.export': { params: { id: SAMPLE_PLUGIN_ID } },

  'pluginDrafts.create': { body: { manifest: SAMPLE_MANIFEST } },
  'pluginDrafts.test': { body: { provider: SAMPLE_DECLARATIVE_PROVIDER, action: 'list-models' } },
  'pluginDrafts.updateManifest': { params: { id: SAMPLE_PLUGIN_ID }, body: { manifest: SAMPLE_MANIFEST } },

  'pluginFiles.scaffold': { body: { id: 'my-tool', name: 'My tool', template: 'tool' } },
  'pluginFiles.list': { params: { id: SAMPLE_PLUGIN_ID } },
  'pluginFiles.read': { params: { id: SAMPLE_PLUGIN_ID, path: 'lib/tools.mjs' } },
  'pluginFiles.write': { params: { id: SAMPLE_PLUGIN_ID, path: 'lib/tools.mjs' }, body: { content: 'export const answer = 42\n' } },
  'pluginFiles.remove': { params: { id: SAMPLE_PLUGIN_ID, path: 'lib/old.mjs' } },
  'pluginFiles.build': { params: { id: SAMPLE_PLUGIN_ID }, body: { reload: true } },
}

export interface SampleRequest {
  method: string
  /** Absolute path including `/api` and the query string. */
  path: string
  init: RequestInit
}

interface LooseSample {
  params?: Record<string, unknown>
  query?: Record<string, unknown>
  body?: unknown
  form?: () => FormData
}

const LOOSE_SAMPLES = API_SAMPLES as unknown as Readonly<Record<ApiRouteKey, LooseSample>>

/**
 * The sample request of a route (JSON bodies with `Content-Type: application/json`); `sample` overrides the default
 * input, `headers` are added.
 */
export function sampleRequest<K extends ApiRouteKey>(key: K, options: { sample?: ApiSampleInput<K>, headers?: Record<string, string> } = {}): SampleRequest {
  const route = apiRoutes[key]
  const sample = (options.sample as LooseSample | undefined) ?? LOOSE_SAMPLES[key]
  const url = (apiUrl as (key: ApiRouteKey, input?: { params?: unknown, query?: unknown }, baseUrl?: string) => string)(
    key,
    { params: sample.params, query: sample.query },
    '/api',
  )
  const headers: Record<string, string> = { ...options.headers }
  const init: RequestInit = { method: route.method, headers }
  if (sample.form !== undefined) {
    init.body = sample.form()
  }
  else if (sample.body !== undefined) {
    headers['content-type'] = 'application/json'
    init.body = JSON.stringify(sample.body)
  }
  return { method: route.method, path: url, init }
}
