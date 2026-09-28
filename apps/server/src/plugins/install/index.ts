// Phase 0 stub. Owner: W3.2. Implement `PluginInstaller` (../types.ts) and keep the export name and signature:
// `createPluginInstaller(deps: AppDeps): PluginInstaller`. `recover()` runs at boot before the plugin host starts; it
// is a no-op until then.
import type { AppDeps } from '../../types.ts'
import type { PluginInstaller } from '../types.ts'
import { noopAsync, rejectsNotImplemented } from '../../not-implemented.ts'

export function createPluginInstaller(_deps: AppDeps): PluginInstaller {
  return {
    recover: noopAsync,
    inspect: rejectsNotImplemented('installer.inspect'),
    install: rejectsNotImplemented('installer.install'),
    export: rejectsNotImplemented('installer.export'),
  }
}
