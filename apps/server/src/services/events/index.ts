// Phase 0 stub. Owner: W1.5 (W1.5-T1). Implement `EventBus` (./types.ts) and keep the export name and signature:
// `createEventBus(deps: AppDeps): EventBus`. Until then events are dropped (emitting is a no-op, so producers of
// other waves never fail on it). Tests that assert events use `createRecordingEventBus()` from `testing/fakes.ts`.
import type { AppDeps } from '../../types.ts'
import type { EventBus } from './types.ts'
import { noopAsync, noopDisposable } from '../../not-implemented.ts'

export function createEventBus(_deps: AppDeps): EventBus {
  return {
    emit: () => {},
    publish: () => {},
    subscribe: () => noopDisposable,
    subscriberCount: () => 0,
    stop: noopAsync,
  }
}
