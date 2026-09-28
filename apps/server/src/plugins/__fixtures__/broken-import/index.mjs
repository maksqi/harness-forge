// @ts-check
import { z } from 'zod'

/** @type {import('@harness-forge/plugin-sdk').PluginModule} */
export default {
  setup(ctx) {
    ctx.logger.info(String(z))
  },
}
