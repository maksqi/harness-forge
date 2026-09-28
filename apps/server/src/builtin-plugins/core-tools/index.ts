// Builtin plugin `core-tools` (PLUGINS.md 1): tools `current_time` (policy `safe`) and `web_fetch` (policy `ask`,
// SSRF guard). Phase 0 stub; implemented by W3.5 (W3.5-T4) through the public plugin SDK.
import type { PluginManifest } from '@harness-forge/plugin-sdk'
import { definePlugin } from '@harness-forge/plugin-sdk'

export const manifest = {
  manifestVersion: 1,
  id: 'core-tools',
  name: 'Core tools',
  version: '1.0.0',
  description: 'Builtin tools: current_time and web_fetch.',
  engines: { harness: '^1.0.0' },
  main: 'index.ts',
  permissions: ['network'],
} satisfies PluginManifest

export default definePlugin({
  setup() {},
})
