// Phase 0 stub. Owner: W3.3. Implement `PluginDrafts` (../types.ts) and keep the export name and signature:
// `createPluginDrafts(deps: AppDeps): PluginDrafts`.
import type { AppDeps } from '../../types.ts'
import type { PluginDrafts } from '../types.ts'
import { rejectsNotImplemented } from '../../not-implemented.ts'

export function createPluginDrafts(_deps: AppDeps): PluginDrafts {
  return {
    create: rejectsNotImplemented('drafts.create'),
    test: rejectsNotImplemented('drafts.test'),
    updateManifest: rejectsNotImplemented('drafts.updateManifest'),
  }
}
