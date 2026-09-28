// @ts-check
// Code plugin fixture of the e2e suite (installed from a zip with trust): one read-only tool that answers `pong`.

/** @type {import('@harness-forge/plugin-sdk').PluginModule} */
export default {
  setup(ctx) {
    const { z } = ctx.ai
    ctx.tools.register({
      name: 'e2e_zip_code_ping',
      description: 'Answers pong with the given text.',
      inputSchema: z.object({ text: z.string().max(1000).describe('Any text') }),
      policy: 'safe',
      async execute({ text }) {
        await ctx.storage.set('lastPing', text)
        return { pong: text }
      },
    })
    ctx.logger.info('e2e zip code plugin ready')
  },
}
