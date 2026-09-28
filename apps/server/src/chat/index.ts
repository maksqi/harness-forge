// Phase 0 stub. Owner: W2.1. Implement `ChatRunner` (./types.ts) and keep the export name and signature:
// `createChatRunner(deps: AppDeps): ChatRunner`. Until then no run is ever active: `isActive` is false, `active` is
// empty, `stop` answers false and `resume` null (so Phase 1 chats code works), and `start` fails with `not_implemented`.
import type { AppDeps } from '../types.ts'
import type { ChatRunner } from './types.ts'
import { noopAsync, rejectsNotImplemented } from '../not-implemented.ts'

export function createChatRunner(_deps: AppDeps): ChatRunner {
  return {
    start: rejectsNotImplemented('runs.start'),
    resume: () => null,
    stop: async () => false,
    isActive: () => false,
    active: () => [],
    stopAll: noopAsync,
  }
}
