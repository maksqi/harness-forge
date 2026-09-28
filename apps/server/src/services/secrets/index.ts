// Phase 0 stub. Owner: W1.2 (W1.2-T2). Implement `SecretStore` (./types.ts) and keep the export name and signature:
// `createSecretStore(deps: AppDeps): SecretStore` (table `secrets`, key `deps.keyring.subkey('encryption')`).
import type { AppDeps } from '../../types.ts'
import type { SecretStore } from './types.ts'
import { rejectsNotImplemented } from '../../not-implemented.ts'

export function createSecretStore(_deps: AppDeps): SecretStore {
  return {
    get: rejectsNotImplemented('secrets.get'),
    set: rejectsNotImplemented('secrets.set'),
    delete: rejectsNotImplemented('secrets.delete'),
    deleteScope: rejectsNotImplemented('secrets.deleteScope'),
    list: rejectsNotImplemented('secrets.list'),
  }
}
