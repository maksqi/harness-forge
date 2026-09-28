// Request validation and Phase 0 route stubs. Every route validates params / query / JSON bodies with the schemas of
// `@harness-forge/shared` through `@hono/zod-validator`; a failure throws `validation_error` (HTTP 400, `details.issues`)
// and is rendered by the global error handler.
//
//   app.put(apiRoutes['settings.update'].path, validate('json', settingsUpdateSchema), async (c) => {
//     const patch = c.req.valid('json') // typed
//   })
//
// `zValidator(target, schema, validationHook)` is equivalent (use it when a custom Hono generic context is needed).
import type { ApiRouteKey } from '@harness-forge/shared'
import type { Env, ValidationTargets } from 'hono'
import type { ZodType } from 'zod'
import type { AppContext } from './types.ts'
import { apiRoutes, HarnessError, validationError } from '@harness-forge/shared'
import { zValidator } from '@hono/zod-validator'

/** The part of a zod safe-parse result the hook reads. */
export type ValidationHookResult
  = | { success: true }
    | { success: false, error: { readonly issues: readonly { code: string, message: string, path: readonly PropertyKey[] }[] } }

/** zod-validator hook: throws `validation_error` with the flattened issues instead of answering with zod's JSON. */
export function validationHook(result: ValidationHookResult): void {
  if (!result.success)
    throw validationError(result.error)
}

/** `zValidator` with `validationHook`: `validate('json' | 'query' | 'param' | 'form', schema)`. */
export function validate<Target extends keyof ValidationTargets, T extends ZodType, E extends Env = Env, P extends string = string>(target: Target, schema: T) {
  return zValidator<T, Target, E, P, typeof validationHook>(target, schema, validationHook)
}

const stubRoutes = new Set<ApiRouteKey>()

/** Route keys whose handler is still a Phase 0 stub (recorded when a route module registers `notImplemented`). */
export function stubRouteKeys(): ReadonlySet<ApiRouteKey> {
  return stubRoutes
}

/**
 * Phase 0 stub handler: throws `not_implemented` (HTTP 501) naming the route. Replaced by the owner of each module.
 */
export function notImplemented(key: ApiRouteKey): (c: AppContext) => never {
  const route = apiRoutes[key]
  stubRoutes.add(key)
  return () => {
    throw new HarnessError({
      code: 'not_implemented',
      message: `${route.method} /api${route.path} (${key}) is not implemented yet.`,
    })
  }
}
