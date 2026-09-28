// Phase 0 stub. Owner: W1.2 (W1.2-T1). Implement `Keyring` (./types.ts) and keep the export name and signature:
// `createKeyring(deps: AppDeps): Keyring`. The factory runs at boot (eagerly, from `createDeps`): load the master key
// synchronously from `deps.env.masterKey` or `deps.env.paths.secretKey` (generated once, mode 0600) and throw on an
// invalid or group/world readable key. Tests get a fake keyring from `createTestApp()` (`testing/fakes.ts`).
import type { AppDeps } from '../types.ts'
import type { Keyring } from './types.ts'
import { throwsNotImplemented } from '../not-implemented.ts'

export function createKeyring(_deps: AppDeps): Keyring {
  return {
    keyVersion: 1,
    subkey: throwsNotImplemented('keyring.subkey'),
  }
}
