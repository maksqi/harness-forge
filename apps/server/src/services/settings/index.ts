// Phase 0 stub. Owner: W1.2 (W1.2-T3). Implement `SettingsService` (./types.ts) and keep the export name and
// signature: `createSettingsService(deps: AppDeps): SettingsService` (table `settings`, defaults from
// `DEFAULT_SETTINGS` of `@harness-forge/shared`).
import type { AppDeps } from '../../types.ts'
import type { SettingsService } from './types.ts'
import { rejectsNotImplemented } from '../../not-implemented.ts'

export function createSettingsService(_deps: AppDeps): SettingsService {
  return {
    get: rejectsNotImplemented('settings.get'),
    update: rejectsNotImplemented('settings.update'),
    getInternal: rejectsNotImplemented('settings.getInternal'),
    setInternal: rejectsNotImplemented('settings.setInternal'),
  }
}
