// Code plugin scaffold / files / build routes (API.md 5.18). Owner: W3.4 (W3.4-T2, T3). Thin: validate with the
// shared schemas, call `deps.pluginFiles` (plugins/scaffold), map DTOs.
//
// The route table writes the rest path as `/plugins/:id/files/*`; Hono binds it as `:path{.+}` so `path` is a param
// decoded once and validated by `pluginFileParamsSchema` (`..`, absolute paths, NUL and backslashes are rejected with
// 400; the service still resolves every segment inside the plugin directory). `/plugins/:id/files` (the tree) never
// matches it. Fresh auth (ADR-017): `pluginFiles.scaffold` and `pluginFiles.build` are `fresh` routes (enforced by the
// fresh-auth middleware); writes and deletes of plugins that run code call `requireFreshAuth` through the service.
import type { AppDeps } from '../../types.ts'
import type { AppEnv, AppMiddleware } from '../types.ts'
import { Buffer } from 'node:buffer'
import {
  apiRoutes,
  HarnessError,
  LIMITS,
  pluginBuildBodySchema,
  pluginFileParamsSchema,
  pluginFileWriteSchema,
  pluginParamsSchema,
  scaffoldRequestSchema,
} from '@harness-forge/shared'
import { Hono } from 'hono'
import { freshAuthOptions } from '../middleware/fresh-auth.ts'
import { validate } from '../validate.ts'

/** Hono path of `pluginFiles.read` / `write` / `remove` (`/plugins/:id/files/*` in the route table). */
export const PLUGIN_FILE_PATH = '/plugins/:id/files/:path{.+}'

/**
 * A file over `LIMITS.pluginFileBytes` is `413 payload_too_large` (API.md 2.2), not a schema `validation_error`: checked
 * on the parsed body before the zod validator. Bodies that are not JSON are left to the validator.
 */
function fileSizeLimit(): AppMiddleware {
  return async (c, next) => {
    let body: unknown
    try {
      body = await c.req.json()
    }
    catch {
      body = undefined
    }
    const content = typeof body === 'object' && body !== null ? (body as { content?: unknown }).content : undefined
    if (typeof content === 'string' && Buffer.byteLength(content, 'utf8') > LIMITS.pluginFileBytes) {
      throw new HarnessError({
        code: 'payload_too_large',
        message: `Files are limited to ${LIMITS.pluginFileBytes / 1024} KB.`,
        details: { limitBytes: LIMITS.pluginFileBytes },
      })
    }
    await next()
  }
}

export function createPluginFilesRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.post(apiRoutes['pluginFiles.scaffold'].path, validate('json', scaffoldRequestSchema), async (c) => {
    const request = c.req.valid('json')
    return c.json(await deps.pluginFiles.scaffold(request), 201)
  })

  app.get(apiRoutes['pluginFiles.list'].path, validate('param', pluginParamsSchema), async (c) => {
    const { id } = c.req.valid('param')
    return c.json({ items: await deps.pluginFiles.list(id) })
  })

  app.get(PLUGIN_FILE_PATH, validate('param', pluginFileParamsSchema), async (c) => {
    const { id, path } = c.req.valid('param')
    return c.json(await deps.pluginFiles.read(id, path))
  })

  app.put(PLUGIN_FILE_PATH, validate('param', pluginFileParamsSchema), fileSizeLimit(), validate('json', pluginFileWriteSchema), async (c) => {
    const { id, path } = c.req.valid('param')
    return c.json(await deps.pluginFiles.write(id, path, c.req.valid('json'), freshAuthOptions(c)))
  })

  app.delete(PLUGIN_FILE_PATH, validate('param', pluginFileParamsSchema), async (c) => {
    const { id, path } = c.req.valid('param')
    await deps.pluginFiles.remove(id, path, freshAuthOptions(c))
    return c.body(null, 204)
  })

  app.post(apiRoutes['pluginFiles.build'].path, validate('param', pluginParamsSchema), validate('json', pluginBuildBodySchema), async (c) => {
    const { id } = c.req.valid('param')
    return c.json(await deps.pluginFiles.build(id, c.req.valid('json')))
  })

  return app
}
