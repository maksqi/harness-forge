import type { PluginModule } from './types.ts'

/** Identity helper that types the default export of a code plugin's entry module. */
export function definePlugin(m: PluginModule): PluginModule {
  return m
}
