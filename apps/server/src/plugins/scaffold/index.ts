// Phase 0 stub. Owner: W3.4. Implement `PluginFiles` (../types.ts) and keep the export name and signature:
// `createPluginFiles(deps: AppDeps): PluginFiles`.
import type { AppDeps } from '../../types.ts'
import type { PluginFiles } from '../types.ts'
import { rejectsNotImplemented } from '../../not-implemented.ts'

export function createPluginFiles(_deps: AppDeps): PluginFiles {
  return {
    scaffold: rejectsNotImplemented('pluginFiles.scaffold'),
    list: rejectsNotImplemented('pluginFiles.list'),
    read: rejectsNotImplemented('pluginFiles.read'),
    write: rejectsNotImplemented('pluginFiles.write'),
    remove: rejectsNotImplemented('pluginFiles.remove'),
    build: rejectsNotImplemented('pluginFiles.build'),
  }
}
