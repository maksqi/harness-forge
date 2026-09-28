// Test helper for the composer component tests (not app code; never imported by components): seeds the stores with
// providers, models, tools and commands, and stubs NuxtLink as a plain anchor.
import type { CatalogModel, CommandSummary, ProviderSummary, SendKey, ToolSummary } from '@harness-forge/shared'
import { DEFAULT_SETTINGS } from '@harness-forge/shared'
import { defineComponent, h } from 'vue'
import { useModelsStore } from '~/stores/models'
import { usePluginsStore } from '~/stores/plugins'
import { useProvidersStore } from '~/stores/providers'
import { useSettingsStore } from '~/stores/settings'
import { catalogModel, providerSummary, toolSummary } from '~/utils/testing/fixtures'

export const anthropic = providerSummary({ id: 'anthropic', name: 'Anthropic (Claude)' })
export const ollama = providerSummary({ id: 'ollama', name: 'Ollama', local: true, icon: null })
export const openai = providerSummary({ id: 'openai', name: 'OpenAI', status: 'not_configured', modelCount: 0 })

/** Reasoning model with efforts, tools and vision. */
export const sonnet = catalogModel({ id: 'claude-sonnet-5', name: 'Claude Sonnet 5', reasoningEfforts: ['auto', 'low', 'medium', 'high'] })
/** Favorite; no vision, no PDF, no effort control. */
export const haiku = catalogModel({
  id: 'claude-haiku-5',
  name: 'Claude Haiku 5',
  favorite: true,
  capabilities: { tools: true, vision: false, pdf: false, reasoning: false, structuredOutput: true, imageOutput: false },
})
/** No tools. */
export const llama = catalogModel({
  providerId: 'ollama',
  id: 'llama3:8b',
  name: 'Llama 3 8B',
  contextWindow: 8192,
  capabilities: { tools: false, vision: false, pdf: false, reasoning: false, structuredOutput: false, imageOutput: false },
})
export const hiddenModel = catalogModel({ id: 'claude-embed', name: 'Claude Embed', hidden: true })

export interface SeedOptions {
  providers?: ProviderSummary[]
  models?: CatalogModel[]
  tools?: ToolSummary[]
  commands?: CommandSummary[]
  sendKey?: SendKey
}

/** Fills the stores as if they were loaded (no requests are made). */
export function seedStores(options: SeedOptions = {}) {
  const providers = useProvidersStore()
  providers.items = options.providers ?? [anthropic, ollama, openai]
  providers.loaded = true
  const models = useModelsStore()
  models.items = options.models ?? [sonnet, haiku, llama, hiddenModel]
  models.loaded = true
  const plugins = usePluginsStore()
  plugins.tools = options.tools ?? [toolSummary()]
  plugins.toolsLoaded = true
  plugins.commands = options.commands ?? [{ name: 'summarize', description: 'Summarize the chat', pluginId: 'core-commands' }]
  plugins.commandsLoaded = true
  const settings = useSettingsStore()
  settings.settings = { ...DEFAULT_SETTINGS, sendKey: options.sendKey ?? 'enter' }
  return { providers, models, plugins, settings }
}

/** NuxtLink stand-in: an anchor with the target as href. */
export const NuxtLinkStub = defineComponent({
  props: { to: { type: String, required: true } },
  setup(props, { slots, attrs }) {
    return () => h('a', { ...attrs, href: props.to }, slots.default?.())
  },
})

/** Items rendered in <body> (popovers, menus). */
export function bodyAll(selector: string): HTMLElement[] {
  return Array.from(document.body.querySelectorAll<HTMLElement>(selector))
}

export function byTestId(id: string, extra = ''): string {
  return `[data-testid="${id}"]${extra}`
}
