// Builtin plugin `core-commands`: server-side template slash commands (docs/PLUGINS.md). Client-only commands
// (`/new`, `/model`, `/effort`, `/mode`, `/help`) never reach the server.
import type { PluginManifest } from '@harness-forge/plugin-sdk'
import { definePlugin } from '@harness-forge/plugin-sdk'
import { BUILTIN_COMMANDS } from './commands.ts'

export { BUILTIN_COMMANDS }

export const manifest = {
  manifestVersion: 1,
  id: 'core-commands',
  name: 'Core commands',
  version: '1.0.0',
  description: 'Builtin slash commands: /explain, /summarize, /review, /fix, /refactor, /tests, /docs, /commit, /translate and /proofread.',
  engines: { harness: '^1.0.0' },
  main: 'index.ts',
} satisfies PluginManifest

export default definePlugin({
  setup(ctx) {
    for (const command of BUILTIN_COMMANDS)
      ctx.commands.register(command)
  },
})
