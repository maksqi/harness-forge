// Deterministic, rotatable test keyring (Phase 7, C16-T2). `createTestApp()` injects `createFakeKeyring()` unless a test
// passes its own keyring; `testing/fakes.ts` re-exports it. Built on the real `createMasterKeyring`, so route tests can
// rotate it with the controls of `security/keyring.ts`:
//
//   const keyring = createFakeKeyring()
//   swapMasterKey(keyring, fakeMasterKey('next'), 2)   // every subkey and keyVersion change in place
import type { Keyring } from '../security/types.ts'
import { createHash } from 'node:crypto'
import { createMasterKeyring } from '../security/keyring.ts'

/** Seed of the default fake keyring. */
export const FAKE_KEYRING_SEED = 'harness-forge-test-master-key'

/** The 32-byte master key of a seed: `sha256(seed)`. */
export function fakeMasterKey(seed: string = FAKE_KEYRING_SEED): Uint8Array {
  return new Uint8Array(createHash('sha256').update(seed).digest())
}

/**
 * Deterministic keyring at version 1: HKDF-SHA256 subkeys of `sha256(seed)` (the derivation parameters of the real
 * keyring, so the bytes equal those of the Phase 1 – 6 fake). Rotatable: `swapMasterKey`, `beginKeyChange` and
 * `whenKeyStable` accept it.
 */
export function createFakeKeyring(seed: string = FAKE_KEYRING_SEED): Keyring {
  const master = fakeMasterKey(seed)
  try {
    return createMasterKeyring(master)
  }
  finally {
    master.fill(0)
  }
}
