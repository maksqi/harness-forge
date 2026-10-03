// Project file mention routes (API.md 5.27, ADR-042) - Phase 9 stubs (501). Owner: W9.6. Keep the export name
// `createProjectFilesRoutes`. Thin: validate, call the project file service, map to the response.
//
// - `GET /projects/:id/files?q=&limit=`: ranked entries (`rankPaths`) from the per-project in-memory index (built with
//   the workspace walker: `.gitignore`, `node_modules` and secret-looking paths left out; single-flight builds, 30 s
//   TTL, dropped on `workspace.changed`); an unknown project is `404`, an unavailable folder `400`.
// - `POST /projects/:id/files/attach` (`201` with the `FileRef`): resolves the path through `resolveWorkspacePath`,
//   refuses `.git` and secret-looking paths (`400`) and files over `LIMITS.mentionFileMaxBytes` (`413`), then stores
//   the bytes through the upload path of `POST /files` (type sniffing, pins).
// - No fresh auth; never logs queries or file contents at `info`.
import type { AppDeps } from '../../types.ts'
import type { AppEnv } from '../types.ts'
import { apiRoutes, projectFileAttachBodySchema, projectFilesQuerySchema, projectParamsSchema } from '@harness-forge/shared'
import { Hono } from 'hono'
import { notImplemented, validate } from '../validate.ts'

export function createProjectFilesRoutes(_deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.get(apiRoutes['projectFiles.search'].path, validate('param', projectParamsSchema), validate('query', projectFilesQuerySchema), notImplemented('projectFiles.search'))
  app.post(apiRoutes['projectFiles.attach'].path, validate('param', projectParamsSchema), validate('json', projectFileAttachBodySchema), notImplemented('projectFiles.attach'))
  return app
}
