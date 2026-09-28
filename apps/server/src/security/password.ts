// Phase 0 stub. Owner: W1.1 (W1.1-T2). Implement `PasswordService` (./types.ts) and keep the export name and
// signature: `createPasswordService(deps: AppDeps): PasswordService`. The stored hash lives in `deps.secrets`
// (scope `auth`, name `password`); `HF_PASSWORD` comes from `deps.env.password`.
import type { AppDeps } from '../types.ts'
import type { PasswordService } from './types.ts'
import { rejectsNotImplemented } from '../not-implemented.ts'

export function createPasswordService(_deps: AppDeps): PasswordService {
  return {
    hash: rejectsNotImplemented('passwords.hash'),
    verify: rejectsNotImplemented('passwords.verify'),
    source: rejectsNotImplemented('passwords.source'),
    check: rejectsNotImplemented('passwords.check'),
    set: rejectsNotImplemented('passwords.set'),
  }
}
