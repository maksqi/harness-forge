// Marketplace routes (API.md 5.34, ADR-054). Owner: W12.2. Thin: validate, call the marketplace service
// (`plugins/marketplaces/`), map the answer. No route needs fresh auth (adding a marketplace installs nothing; installs go
// through `POST /plugins/install` with `{ source: 'marketplace', marketplaceId, plugin }`).
//
// - `GET /marketplaces`: every marketplace, the suggestions not added yet (`MARKETPLACE_SUGGESTIONS`; nothing is
//   fetched for a suggestion before the user adds it) and the installed plugins with an update available.
// - `POST /marketplaces` (`201`): fetches the source at once (GitHub: the ref resolved to a commit, then
//   `.claude-plugin/marketplace.json` of that commit; a hosted `marketplace.json`; a server folder) through `safeFetch`
//   (https only); nothing is stored when that fails. `409` `exists` (the name is taken, or 50 marketplaces exist), `409`
//   `offline` (`HF_OFFLINE=1`, github and url sources), `400` (an invalid `marketplace.json`; a reserved name from
//   another owner than `anthropics`), `404` (no such repository, ref, folder or file), `413` (over 1 MiB), `429`
//   `rate_limited` (GitHub), `502` (the source failed); emits `marketplace.changed`.
// - `GET /marketplaces/:id`: the stored catalog with the entries, installed plugins, updates and diagnostics; `404`.
// - `POST /marketplaces/:id/refresh`: fetches again (a moved ref, a changed file); a failure keeps the stored catalog
//   and sets `lastError`; `409` `offline`; emits `marketplace.changed` (update badges follow `plugin.changed`).
// - `DELETE /marketplaces/:id` (`204`): installed plugins of the marketplace are kept (their origin dangles); emits
//   `marketplace.changed { marketplace: null }`.
// - Logs only the marketplace id, name, repository and a 12-character sha at `info`; never marketplace JSON.
import type { AppDeps } from '../../types.ts'
import type { AppEnv } from '../types.ts'
import { apiRoutes, marketplaceAddBodySchema, marketplaceParamsSchema } from '@harness-forge/shared'
import { Hono } from 'hono'
import { validate } from '../validate.ts'

export function createMarketplacesRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.get(apiRoutes['marketplaces.list'].path, async c => c.json(await deps.marketplaces.list()))

  app.post(apiRoutes['marketplaces.add'].path, validate('json', marketplaceAddBodySchema), async (c) => {
    const body = c.req.valid('json')
    return c.json(await deps.marketplaces.add(body), 201)
  })

  app.get(apiRoutes['marketplaces.get'].path, validate('param', marketplaceParamsSchema), async (c) => {
    const { id } = c.req.valid('param')
    return c.json(await deps.marketplaces.get(id))
  })

  app.post(apiRoutes['marketplaces.refresh'].path, validate('param', marketplaceParamsSchema), async (c) => {
    const { id } = c.req.valid('param')
    return c.json(await deps.marketplaces.refresh(id))
  })

  app.delete(apiRoutes['marketplaces.remove'].path, validate('param', marketplaceParamsSchema), async (c) => {
    const { id } = c.req.valid('param')
    await deps.marketplaces.remove(id)
    return c.body(null, 204)
  })

  return app
}
