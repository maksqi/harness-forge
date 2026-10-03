// Project file mention routes (API.md 5.27, ADR-042). Owner: W9.6. Thin: validate, call the project file service
// (`services/project-files/`), map to the response.
//
// - `GET /projects/:id/files?q=&limit=`: ranked entries (`rankPaths`) from the per-project in-memory index (built with
//   the workspace walker: `.gitignore`, `node_modules`, `.git` and secret-looking paths left out; single-flight builds,
//   30 s TTL, dropped on `workspace.changed`); an unknown project is `404`, an unavailable folder `400`.
// - `POST /projects/:id/files/attach` (`201` with the `FileRef`): resolves the path through `resolveWorkspacePath`,
//   refuses `.git` and secret-looking paths, folders and links out of the project (`400`), files over
//   `LIMITS.mentionFileMaxBytes` (`413`) and missing files (`404`), then stores the bytes through the upload path of
//   `POST /files` (type sniffing, pins).
// - No fresh auth; never logs queries, paths or file contents at `info` (the access log never logs the query string).
import type { AppDeps } from '../../types.ts'
import type { AppEnv } from '../types.ts'
import { apiRoutes, projectFileAttachBodySchema, projectFilesQuerySchema, projectParamsSchema } from '@harness-forge/shared'
import { Hono } from 'hono'
import { validate } from '../validate.ts'

export function createProjectFilesRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.get(apiRoutes['projectFiles.search'].path, validate('param', projectParamsSchema), validate('query', projectFilesQuerySchema), async (c) => {
    return c.json(await deps.projectFiles.search(c.req.valid('param').id, c.req.valid('query')))
  })

  app.post(apiRoutes['projectFiles.attach'].path, validate('param', projectParamsSchema), validate('json', projectFileAttachBodySchema), async (c) => {
    return c.json(await deps.projectFiles.attach(c.req.valid('param').id, c.req.valid('json')), 201)
  })

  return app
}
