// Phase 0 stub. Owner: W1.3 (W1.3-T5). Implement `Registry` (./types.ts) and keep the export name and signature:
// `createRegistry(deps: AppDeps): Registry`. Until then registrations fail and `onChange` subscriptions are inert.
import type { AppDeps } from '../types.ts'
import type { Registry } from './types.ts'
import { noopDisposable, throwsNotImplemented } from '../not-implemented.ts'

export function createRegistry(_deps: AppDeps): Registry {
  return {
    providers: {
      register: throwsNotImplemented('registry.providers.register'),
      get: throwsNotImplemented('registry.providers.get'),
      list: throwsNotImplemented('registry.providers.list'),
    },
    models: {
      register: throwsNotImplemented('registry.models.register'),
      list: throwsNotImplemented('registry.models.list'),
    },
    tools: {
      register: throwsNotImplemented('registry.tools.register'),
      get: throwsNotImplemented('registry.tools.get'),
      list: throwsNotImplemented('registry.tools.list'),
    },
    commands: {
      register: throwsNotImplemented('registry.commands.register'),
      get: throwsNotImplemented('registry.commands.get'),
      list: throwsNotImplemented('registry.commands.list'),
    },
    hooks: {
      on: throwsNotImplemented('registry.hooks.on'),
      list: throwsNotImplemented('registry.hooks.list'),
      run: throwsNotImplemented('registry.hooks.run'),
    },
    mcpServers: {
      register: throwsNotImplemented('registry.mcpServers.register'),
      get: throwsNotImplemented('registry.mcpServers.get'),
      list: throwsNotImplemented('registry.mcpServers.list'),
    },
    onChange: () => noopDisposable,
    contributions: throwsNotImplemented('registry.contributions'),
  }
}
