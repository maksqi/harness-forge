// Phase 0 stub. Owner: W3.5 (W3.5-T3). Implement `ToolService` (./types.ts) and keep the export name and signature:
// `createToolService(deps: AppDeps): ToolService` (table `tool_prefs`). Until then `prefs()` is empty (every tool
// enabled, no override) so the Phase 2 chat pipeline can call it.
import type { AppDeps } from '../types.ts'
import type { ToolPref, ToolService } from './types.ts'
import { rejectsNotImplemented } from '../not-implemented.ts'

export function createToolService(_deps: AppDeps): ToolService {
  return {
    list: rejectsNotImplemented('tools.list'),
    update: rejectsNotImplemented('tools.update'),
    prefs: async () => new Map<string, ToolPref>(),
  }
}
