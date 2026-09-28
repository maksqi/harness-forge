// Builtin plugin `mock` (PROVIDERS.md 8): the dev-only `mock` provider (`mock:echo`, `mock:reasoning`,
// `mock:tool-approval`, `mock:error`) and the tool `mock_approval_tool`. Loaded only with `HF_MOCK_PROVIDER=1`.
// Phase 0 stub; implemented by W1.4 (W1.4-T6).
import type { PluginManifest } from '@harness-forge/plugin-sdk'
import { definePlugin } from '@harness-forge/plugin-sdk'

export const manifest = {
  manifestVersion: 1,
  id: 'mock',
  name: 'Mock provider',
  version: '1.0.0',
  description: 'Deterministic mock models and a mock approval tool for development and end-to-end tests.',
  engines: { harness: '^1.0.0' },
  main: 'index.ts',
} satisfies PluginManifest

export default definePlugin({
  setup() {},
})
