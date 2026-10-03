// Changes routes (API.md 5.24, ADR-036, ADR-037) - Phase 8 stubs (501). Owner: W8.2. Keep the export name
// `createChangesRoutes`. Thin: validate, call the checkpoint service, map to the response.
//
// - Chat-scoped (`/chats/:id/changes...`, `/chats/:id/git`, `/chats/:id/rewind`); none needs fresh auth. Each path
//   differs from the `chats.ts` routes under `/chats/:id` in its static segments or its method (API.md 8).
// - The chat's current project counts. Without a project (or with a folder that cannot be opened) `changes.list` and
//   `changes.git` answer `available: false` + `reason`; every other route answers `400 validation_error`.
// - Revert, undo and rewind are `409` (`run-active`, `chatId`) while any chat of the project runs; a revert whose
//   `expectedSha` no longer matches the disk is `409` (`stale`). Every write batch emits `workspace.changed`.
import type { AppDeps } from '../../types.ts'
import type { AppEnv } from '../types.ts'
import {
  apiRoutes,
  changeDiffQuerySchema,
  changeRevertBodySchema,
  changeUndoBodySchema,
  chatParamsSchema,
  rewindBodySchema,
  rewindQuerySchema,
} from '@harness-forge/shared'
import { Hono } from 'hono'
import { notImplemented, validate } from '../validate.ts'

export function createChangesRoutes(_deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.get(apiRoutes['changes.list'].path, validate('param', chatParamsSchema), notImplemented('changes.list'))
  app.get(apiRoutes['changes.diff'].path, validate('param', chatParamsSchema), validate('query', changeDiffQuerySchema), notImplemented('changes.diff'))
  app.get(apiRoutes['changes.git'].path, validate('param', chatParamsSchema), notImplemented('changes.git'))
  app.post(apiRoutes['changes.revert'].path, validate('param', chatParamsSchema), validate('json', changeRevertBodySchema), notImplemented('changes.revert'))
  app.post(apiRoutes['changes.undo'].path, validate('param', chatParamsSchema), validate('json', changeUndoBodySchema), notImplemented('changes.undo'))
  app.get(apiRoutes['changes.rewindPreview'].path, validate('param', chatParamsSchema), validate('query', rewindQuerySchema), notImplemented('changes.rewindPreview'))
  app.post(apiRoutes['changes.rewind'].path, validate('param', chatParamsSchema), validate('json', rewindBodySchema), notImplemented('changes.rewind'))
  return app
}
