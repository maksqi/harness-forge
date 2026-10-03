// Master-key service (Phase 7, ADR-034, API.md 5.23, ARCHITECTURE.md 6.14). Owner: W7.7 (C16 stub). Implements
// `KeyService` (./types.ts) behind `createKeyService(deps)`.
//
// Stub: both operations reject with `not_implemented` (501) until W7.7 lands the status and the online rotation. The
// key check helper (`computeKeyCheck`) lives in ./check.ts and is already used by the boot recovery (./recover.ts).
import type { AppDeps } from '../../types.ts'
import type { KeyService } from './types.ts'
import { rejectsNotImplemented } from '../../not-implemented.ts'

export function createKeyService(_deps: AppDeps): KeyService {
  return {
    status: rejectsNotImplemented('The key status'),
    rotate: rejectsNotImplemented('The master-key rotation'),
  }
}
