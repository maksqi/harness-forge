// Phase 0 stub. Owner: W1.2 (W1.2-T5). Implement `CredentialService` (./types.ts) and keep the export name and
// signature: `createCredentialService(deps: AppDeps): CredentialService` (fields from `deps.registry.providers`,
// secrets in `deps.secrets`, options in `provider_configs.options`, env fallbacks from `deps.env.vars`).
import type { AppDeps } from '../../types.ts'
import type { CredentialService } from './types.ts'
import { rejectsNotImplemented } from '../../not-implemented.ts'

export function createCredentialService(_deps: AppDeps): CredentialService {
  return {
    resolve: rejectsNotImplemented('credentials.resolve'),
    states: rejectsNotImplemented('credentials.states'),
    set: rejectsNotImplemented('credentials.set'),
    clear: rejectsNotImplemented('credentials.clear'),
  }
}
