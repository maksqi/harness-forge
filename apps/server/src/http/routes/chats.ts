// Chat CRUD routes (API.md 5.9) - Phase 0 stubs (501). Owner: W1.5 (W1.5-T4). Keep the export name
// `createChatsRoutes`. `DELETE /chats/:id` stops an active run first (`deps.runs.stop`).
import type { AppDeps } from '../../types.ts'
import type { AppEnv } from '../types.ts'
import {
  apiRoutes,
  chatCreateSchema,
  chatExportQuerySchema,
  chatParamsSchema,
  chatsQuerySchema,
  chatUpdateSchema,
} from '@harness-forge/shared'
import { Hono } from 'hono'
import { notImplemented, validate } from '../validate.ts'

export function createChatsRoutes(_deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.get(apiRoutes['chats.list'].path, validate('query', chatsQuerySchema), notImplemented('chats.list'))
  app.post(apiRoutes['chats.create'].path, validate('json', chatCreateSchema), notImplemented('chats.create'))
  app.get(apiRoutes['chats.get'].path, validate('param', chatParamsSchema), notImplemented('chats.get'))
  app.patch(apiRoutes['chats.update'].path, validate('param', chatParamsSchema), validate('json', chatUpdateSchema), notImplemented('chats.update'))
  app.delete(apiRoutes['chats.remove'].path, validate('param', chatParamsSchema), notImplemented('chats.remove'))
  app.get(apiRoutes['chats.export'].path, validate('param', chatParamsSchema), validate('query', chatExportQuerySchema), notImplemented('chats.export'))
  return app
}
