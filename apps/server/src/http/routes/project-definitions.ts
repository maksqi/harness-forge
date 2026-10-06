// Project definition file routes (API.md 5.36, ADR-056) - Phase 12 stubs (501). Owner: W12.4. Keep the export name
// `createProjectDefinitionsRoutes`. Thin: validate, call the project definitions service
// (`services/project-definitions/`), map the answer.
//
// - `GET /projects/:id/definitions/file?path`: the file as it is on disk (`exists: false` when missing), its sha256 and
//   the parser diagnostics; `404` unknown project; an unavailable folder is `409`.
// - `PUT /projects/:id/definitions/file`: writes a definition (`content`), the `hooks` key of a settings file (every
//   other key and the key order kept; null removes it) or the `mcpServers` key of `.mcp.json`; `expectedSha256` (null =
//   the file must not exist) is checked under the file lock (`409` `stale`); parser errors are `400` with
//   `details.diagnostics`; the path guard is re-checked inside the lock (links, `.git`, secret-looking names refused).
//   Not journaled: emits `workspace.changed { source: 'user', chatId: null }`. No fresh auth and no idle rule: saving
//   never approves anything; the answer carries `trust.pending`.
// - `DELETE /projects/:id/definitions/file?path&expectedSha256` (`204`): markdown definitions only (an emptied skill
//   folder is removed); `409` `stale`.
// - Never logs file contents at `info`.
import type { AppDeps } from '../../types.ts'
import type { AppEnv } from '../types.ts'
import {
  apiRoutes,
  projectDefinitionQuerySchema,
  projectDefinitionRemoveQuerySchema,
  projectDefinitionWriteBodySchema,
  projectParamsSchema,
} from '@harness-forge/shared'
import { Hono } from 'hono'
import { notImplemented, validate } from '../validate.ts'

export function createProjectDefinitionsRoutes(_deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.get(apiRoutes['projectDefinitions.read'].path, validate('param', projectParamsSchema), validate('query', projectDefinitionQuerySchema), notImplemented('projectDefinitions.read'))
  app.put(apiRoutes['projectDefinitions.write'].path, validate('param', projectParamsSchema), validate('json', projectDefinitionWriteBodySchema), notImplemented('projectDefinitions.write'))
  app.delete(apiRoutes['projectDefinitions.remove'].path, validate('param', projectParamsSchema), validate('query', projectDefinitionRemoveQuerySchema), notImplemented('projectDefinitions.remove'))
  return app
}
