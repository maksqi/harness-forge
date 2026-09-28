// Builtin plugin `core-providers`: the 13 builtin BYOK providers (docs/PROVIDERS.md), registered through the public
// plugin SDK (ADR-009). Builtins have no `plugin.json` on disk; the manifest is exported by the module.
import type { PluginManifest } from '@harness-forge/plugin-sdk'
import { definePlugin } from '@harness-forge/plugin-sdk'
import { PROVIDER_DEFINITIONS } from './providers/index.ts'

export { PROVIDER_DEFINITIONS }

export const manifest = {
  manifestVersion: 1,
  id: 'core-providers',
  name: 'Core providers',
  version: '1.0.0',
  description: 'Builtin LLM providers: Anthropic, OpenAI, Google, xAI, DeepSeek, Moonshot AI, Alibaba, Z.ai, MiniMax, Mistral, Groq, OpenRouter and Ollama.',
  engines: { harness: '^1.0.0' },
  main: 'index.ts',
} satisfies PluginManifest

export default definePlugin({
  setup(ctx) {
    for (const definition of PROVIDER_DEFINITIONS)
      ctx.providers.register(definition)
  },
})
