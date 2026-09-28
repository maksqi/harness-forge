// Phase 0 stub. Owner: W1.1 (W1.1-T3). Implement `SessionService` (./types.ts) and keep the export name and signature:
// `createSessionService(deps: AppDeps): SessionService`. Key = `deps.keyring.subkey('session')`; the epoch lives in
// `deps.settings` (`SESSION_EPOCH_KEY`).
import type { AppDeps } from '../types.ts'
import type { SessionService } from './types.ts'
import { rejectsNotImplemented } from '../not-implemented.ts'

export function createSessionService(_deps: AppDeps): SessionService {
  return {
    issue: rejectsNotImplemented('sessions.issue'),
    verify: rejectsNotImplemented('sessions.verify'),
    revokeAll: rejectsNotImplemented('sessions.revokeAll'),
  }
}
