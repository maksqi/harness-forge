// Phase 0 stub. Owner: W1.3 (W1.3-T1..T4, T7, T8). Implement `PluginHost` (./types.ts) and keep the export name and
// signature: `createPluginHost(deps: AppDeps): PluginHost`. Builtins come from `deps.builtins`. Until then `start` /
// `stop` are no-ops (the server boots without plugins) and every other operation fails with `not_implemented`.
import type { AppDeps } from '../types.ts'
import type { PluginHost } from './types.ts'
import { noopAsync, rejectsNotImplemented, throwsNotImplemented } from '../not-implemented.ts'

export function createPluginHost(_deps: AppDeps): PluginHost {
  return {
    start: noopAsync,
    stop: noopAsync,
    list: rejectsNotImplemented('plugins.list'),
    get: rejectsNotImplemented('plugins.get'),
    summary: rejectsNotImplemented('plugins.summary'),
    record: rejectsNotImplemented('plugins.record'),
    state: throwsNotImplemented('plugins.state'),
    isActive: throwsNotImplemented('plugins.isActive'),
    directory: rejectsNotImplemented('plugins.directory'),
    enable: rejectsNotImplemented('plugins.enable'),
    disable: rejectsNotImplemented('plugins.disable'),
    reload: rejectsNotImplemented('plugins.reload'),
    uninstall: rejectsNotImplemented('plugins.uninstall'),
    trust: rejectsNotImplemented('plugins.trust'),
    getSettings: rejectsNotImplemented('plugins.getSettings'),
    updateSettings: rejectsNotImplemented('plugins.updateSettings'),
    settingsValues: rejectsNotImplemented('plugins.settingsValues'),
    logs: rejectsNotImplemented('plugins.logs'),
    icon: rejectsNotImplemented('plugins.icon'),
    guard: rejectsNotImplemented('plugins.guard'),
    log: throwsNotImplemented('plugins.log'),
    inspectDirectory: rejectsNotImplemented('plugins.inspectDirectory'),
    saveRecord: rejectsNotImplemented('plugins.saveRecord'),
    load: rejectsNotImplemented('plugins.load'),
    unload: rejectsNotImplemented('plugins.unload'),
    forget: rejectsNotImplemented('plugins.forget'),
    compile: rejectsNotImplemented('plugins.compile'),
    withoutWatch: rejectsNotImplemented('plugins.withoutWatch'),
    declarativeProvider: throwsNotImplemented('plugins.declarativeProvider'),
  }
}
