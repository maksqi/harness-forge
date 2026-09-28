import type { ToolDefinition } from '@harness-forge/plugin-sdk'
import { definePlugin, PLUGIN_API_VERSION } from '@harness-forge/plugin-sdk'

export default definePlugin({
  setup(ctx) {
    const { z } = ctx.ai
    const wordCount: ToolDefinition<{ text: string }, { words: number }> = {
      name: 'word_count',
      description: 'Count the words in a text.',
      inputSchema: z.object({ text: z.string().max(100_000) }),
      policy: 'safe',
      async execute({ text }) {
        const trimmed = text.trim()
        return { words: trimmed ? trimmed.split(/\s+/).length : 0 }
      },
    }
    ctx.tools.register(wordCount)
    ctx.logger.info(`word count ready (plugin API ${PLUGIN_API_VERSION})`)
  },
})
