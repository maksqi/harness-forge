// The MCP elicitation broker (Phase 14, ADR-060; ARCHITECTURE.md 6.40) behind `ElicitationBroker` (./types.ts). Owner:
// W14.3 (C50 landed this stub with the final factory signature).
//
// The stub attributes no request to a call, so every MCP tool call runs as before Phase 14:
// - `begin` returns a handle that never sees a request (`pending()` null, `waiting()` false, no change, no record);
// - `handler(runtimeKey)` declines every request (reason `not-interactive`, logged at `debug` with the runtime key only);
// - `answer` throws `not_found` (no request is ever pending), `pendingCount` answers 0;
// - `cancelChat` and `stop` are no-ops (no waits).
// `options.waitMs` (default `LIMITS.mcpElicitationWaitMs`; `deps.ts` passes the test-only `HF_TEST_ELICITATION_WAIT_MS`)
// bounds the waits of the real broker.
import type { AppDeps } from '../../types.ts'
import type { ElicitationBroker, ElicitationBrokerOptions, ElicitationCallHandle } from './types.ts'
import { HarnessError } from '@harness-forge/shared'
import { noopAsync } from '../../not-implemented.ts'

/** The stub's handle: a call that never receives a request. */
function idleHandle(): ElicitationCallHandle {
  return {
    pending: () => null,
    waiting: () => false,
    onChange: () => () => {},
    records: () => [],
    end: () => {},
  }
}

export function createElicitationBroker(deps: AppDeps, _options: ElicitationBrokerOptions = {}): ElicitationBroker {
  return {
    begin: () => idleHandle(),
    handler: runtimeKey => async () => {
      deps.logger.debug('mcp elicitation declined', { runtimeKey, reason: 'not-interactive' })
      return { action: 'decline' }
    },
    answer: async () => {
      throw new HarnessError({ code: 'not_found', message: 'This input request is not pending.' })
    },
    pendingCount: () => 0,
    cancelChat: () => {},
    stop: noopAsync,
  }
}
