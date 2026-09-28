// Builtin plugin `core-tools` (PLUGINS.md 1): tools `current_time` (policy `safe`), `web_fetch` (policy `ask`, SSRF
// guard of security/ssrf.ts) and `generate_image` (policy `ask`, plugin API 1.1.0 `ctx.images`, ADR-028), registered
// through the public plugin SDK. The `allowLocalhost` setting lets `web_fetch` reach loopback addresses (a local dev
// server); private, link-local and metadata addresses always stay blocked. `generate_image` is always registered and
// uses the image model of Settings → Media (`imageModelRef`).
import type { PluginManifest } from '@harness-forge/plugin-sdk'
import { definePlugin } from '@harness-forge/plugin-sdk'
import { appVersion } from '../../paths.ts'
import { currentTimeTool } from './current-time.ts'
import { createGenerateImageTool } from './generate-image.ts'
import { createWebFetchTool } from './web-fetch.ts'

export { CURRENT_TIME_TOOL_NAME, currentTime, currentTimeTool } from './current-time.ts'
export { createGenerateImageTool, GENERATE_IMAGE_TOOL_NAME, generatedImagesText } from './generate-image.ts'
export { createWebFetchTool, WEB_FETCH_TOOL_NAME, webFetch } from './web-fetch.ts'

export const manifest = {
  manifestVersion: 1,
  id: 'core-tools',
  name: 'Core tools',
  version: '1.1.0',
  description: 'Builtin tools: current_time, web_fetch and generate_image.',
  engines: { harness: '^1.1.0' },
  main: 'index.ts',
  permissions: ['network'],
  settings: {
    type: 'object',
    properties: {
      allowLocalhost: {
        type: 'boolean',
        title: 'Allow localhost in web_fetch',
        description: 'Let web_fetch reach loopback addresses (localhost, 127.0.0.1, ::1). Private network, link-local and cloud metadata addresses stay blocked.',
        default: false,
      },
    },
  },
} satisfies PluginManifest

/** Settings of `core-tools` (`ctx.settings.get()`). */
export interface CoreToolsSettings {
  allowLocalhost?: boolean
}

/** `User-Agent` of `web_fetch` requests. */
export function webFetchUserAgent(): string {
  try {
    return `harness-forge/${appVersion()} web_fetch`
  }
  catch {
    return 'harness-forge web_fetch'
  }
}

export default definePlugin({
  setup(ctx) {
    ctx.tools.register(currentTimeTool)
    ctx.tools.register(createWebFetchTool({
      allowLocalhost: () => ctx.settings.get<CoreToolsSettings>().allowLocalhost === true,
      userAgent: webFetchUserAgent(),
    }))
    ctx.tools.register(createGenerateImageTool({ generate: options => ctx.images.generate(options) }))
  },
})
