// Provider credential routes (API.md 5.6, ARCHITECTURE.md 6.6, W1.2-T5). Write-only: responses are the
// `ProviderSummary` of the providers service, whose credential entries carry only `{ set, hint, source }` (plus `value`
// for non-secret fields); a secret value is never echoed.
//
// `PUT /providers/:id/credentials`: validate + store (secret fields encrypted, `''` clears), clear `lastError`, emit
//   `provider.changed`, then validate the stored credentials and refresh the model listing in the background, coalesced
//   per provider (the providers service and the catalog emit their own `provider.changed` / `catalog.changed` when done).
// `DELETE /providers/:id/credentials`: remove every stored value (env fallbacks keep working), emit `provider.changed`
//   and `catalog.changed`.
import type { Logger } from '../../logger.ts'
import type { AppDeps } from '../../types.ts'
import type { AppContext, AppEnv } from '../types.ts'
import { apiRoutes, credentialsUpdateSchema, HarnessError, providerParamsSchema } from '@harness-forge/shared'
import { Hono } from 'hono'
import { validate } from '../validate.ts'

/**
 * Background check after a save: skipped while required fields are missing; a successful provider test is followed by
 * a live model listing. Failures are logged, never thrown (the test result itself is persisted by the providers
 * service and shows up as the provider status).
 */
export function validateCredentialsInBackground(deps: AppDeps, providerId: string, logger: Logger = deps.logger): Promise<void> {
  return (async () => {
    try {
      const { missing } = await deps.credentials.resolve(providerId)
      if (missing.length > 0)
        return
      const result = await deps.providers.test(providerId)
      if (result.ok)
        await deps.catalog.refresh(providerId)
    }
    catch (error) {
      // `not_implemented`: a service of a later wave is still a stub.
      if (error instanceof HarnessError && error.code === 'not_implemented')
        logger.debug('background credential validation skipped', { providerId, err: error })
      else
        logger.warn('background credential validation failed', { providerId, err: error })
    }
  })()
}

/** Schedules a background validation of a provider; returns when that run (and any rerun it absorbed) is done. */
export type ValidationScheduler = (providerId: string, logger?: Logger) => Promise<void>

/**
 * Coalesces background validations per provider: while one runs, further requests for the same provider collapse into
 * a single rerun after it, so repeated saves never pile up provider calls and the last saved values are always checked.
 */
export function createValidationScheduler(deps: AppDeps): ValidationScheduler {
  const running = new Map<string, { again: boolean, done: Promise<void> }>()
  return (providerId, logger = deps.logger) => {
    const current = running.get(providerId)
    if (current !== undefined) {
      current.again = true
      return current.done
    }
    const state = { again: false, done: Promise.resolve() }
    state.done = (async () => {
      try {
        do {
          state.again = false
          await validateCredentialsInBackground(deps, providerId, logger)
        } while (state.again)
      }
      finally {
        running.delete(providerId)
      }
    })()
    running.set(providerId, state)
    return state.done
  }
}

function requestLogger(c: AppContext, deps: AppDeps): Logger {
  return c.get('logger') ?? deps.logger
}

export function createCredentialsRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  const scheduleValidation = createValidationScheduler(deps)

  app.put(
    apiRoutes['credentials.set'].path,
    validate('param', providerParamsSchema),
    validate('json', credentialsUpdateSchema),
    async (c) => {
      const { id } = c.req.valid('param')
      const { values } = c.req.valid('json')
      await deps.credentials.set(id, values)
      const provider = await deps.providers.get(id)
      deps.events.emit('provider.changed', { id, provider })
      void scheduleValidation(id, requestLogger(c, deps))
      c.header('Cache-Control', 'no-store')
      return c.json(provider)
    },
  )

  app.delete(apiRoutes['credentials.clear'].path, validate('param', providerParamsSchema), async (c) => {
    const { id } = c.req.valid('param')
    await deps.credentials.clear(id)
    const provider = await deps.providers.get(id)
    deps.events.emit('provider.changed', { id, provider })
    deps.events.emit('catalog.changed', { providerId: id })
    c.header('Cache-Control', 'no-store')
    return c.json(provider)
  })

  return app
}
