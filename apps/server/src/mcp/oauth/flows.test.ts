// The pending OAuth flows (W14.1-T3): single use, the state key, expiry, one flow per server and the cap, with fake
// timers.
import type { FlowEntry } from './flows.ts'
import { LIMITS } from '@harness-forge/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFlowStore } from './flows.ts'

interface TestFlow extends FlowEntry {
  readonly label: string
}

const TTL = LIMITS.mcpOAuthFlowMs

function flow(state: string, key: string, label = state): TestFlow {
  return { state, key, label, expiresAt: Date.now() + TTL }
}

beforeEach(() => {
  vi.useFakeTimers({ now: 1_700_000_000_000 })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('pending OAuth flows', () => {
  it('a state that was never issued finds nothing (state mismatch)', () => {
    const flows = createFlowStore<TestFlow>()
    flows.add(flow('state-aaaaaaaaaaaaaaaa', 'global:docs'))
    expect(flows.take('state-bbbbbbbbbbbbbbbb')).toBeNull()
    expect(flows.size()).toBe(1)
  })

  it('is single use: a replayed state finds nothing', () => {
    const flows = createFlowStore<TestFlow>()
    flows.add(flow('state-aaaaaaaaaaaaaaaa', 'global:docs'))
    expect(flows.take('state-aaaaaaaaaaaaaaaa')?.label).toBe('state-aaaaaaaaaaaaaaaa')
    expect(flows.take('state-aaaaaaaaaaaaaaaa')).toBeNull()
    expect(flows.size()).toBe(0)
  })

  it('expires after 10 minutes: refused at once, removed by its timer', () => {
    let removed = 0
    const flows = createFlowStore<TestFlow>({ onRemoved: () => removed++ })
    flows.add(flow('state-old', 'global:docs'))
    vi.advanceTimersByTime(TTL - 1)
    expect(flows.byKey('global:docs')?.state).toBe('state-old')
    vi.setSystemTime(Date.now() + 1)
    // Expired even before the timer ran.
    expect(flows.byKey('global:docs')).toBeNull()
    vi.advanceTimersByTime(1)
    expect(flows.size()).toBe(0)
    expect(removed).toBe(1)
    expect(flows.take('state-old')).toBeNull()
  })

  it('an expired flow is refused by take even when its timer has not fired', () => {
    const flows = createFlowStore<TestFlow>()
    flows.add(flow('state-late', 'global:docs'))
    vi.setSystemTime(Date.now() + TTL + 5)
    expect(flows.take('state-late')).toBeNull()
  })

  it('a new start replaces the pending flow of the same server', () => {
    const flows = createFlowStore<TestFlow>()
    flows.add(flow('state-first', 'global:docs'))
    flows.add(flow('state-other', 'project:prj_1:docs'))
    flows.add(flow('state-second', 'global:docs'))
    expect(flows.take('state-first')).toBeNull()
    expect(flows.byKey('global:docs')?.state).toBe('state-second')
    expect(flows.size()).toBe(2)
    expect(flows.dropKey('global:docs')).toBe(true)
    expect(flows.dropKey('global:docs')).toBe(false)
  })

  it('holds at most 20 flows: the oldest is dropped', () => {
    const flows = createFlowStore<TestFlow>()
    for (let index = 0; index <= LIMITS.mcpOAuthFlowsMax; index++)
      flows.add(flow(`state-${index}`, `global:server-${index}`))
    expect(LIMITS.mcpOAuthFlowsMax).toBe(20)
    expect(flows.size()).toBe(20)
    expect(flows.take('state-0')).toBeNull()
    expect(flows.take('state-1')?.key).toBe('global:server-1')
    expect(flows.take(`state-${LIMITS.mcpOAuthFlowsMax}`)?.key).toBe(`global:server-${LIMITS.mcpOAuthFlowsMax}`)
  })

  it('drops by predicate and clears every flow and timer', () => {
    const flows = createFlowStore<TestFlow>({ max: 5 })
    flows.add(flow('state-a', 'project:prj_1:a'))
    flows.add(flow('state-b', 'project:prj_2:b'))
    flows.add(flow('state-c', 'global:c'))
    expect(flows.dropWhere(entry => entry.key.startsWith('project:prj_1:'))).toBe(1)
    expect(flows.list().map(entry => entry.state)).toEqual(['state-b', 'state-c'])
    flows.clear()
    expect(flows.size()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
