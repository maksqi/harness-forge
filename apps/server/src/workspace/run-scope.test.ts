import type { ToolCallContext } from '@harness-forge/plugin-sdk'
import type { CheckpointJournal } from '../services/checkpoints/types.ts'
import type { WorkspaceRunScope } from './run-scope.ts'
import { describe, expect, it } from 'vitest'
import { bindRunScope, runScopeOf } from './run-scope.ts'

function context(toolCallId = 'call_1'): ToolCallContext {
  return {
    chatId: '0199a8f0-0000-7000-8000-000000000001',
    modelRef: 'mock:checkpoint',
    toolCallId,
    messages: [],
    signal: new AbortController().signal,
    workspace: { projectId: 'prj_AAAAAAAAAAAAAAAA', name: 'Demo', root: '/srv/projects/demo' },
  }
}

const journal: CheckpointJournal = {
  scope: { chatId: '0199a8f0-0000-7000-8000-000000000001', messageId: 'msg_AAAAAAAAAAAAAAAA', projectId: 'prj_AAAAAAAAAAAAAAAA' },
  write: async () => {
    throw new Error('not used')
  },
  recordShell: async () => {},
  recordUntracked: async () => {},
}

function scope(toolCallId: string, shellCwd = { current: '.' }): WorkspaceRunScope {
  return {
    chatId: '0199a8f0-0000-7000-8000-000000000001',
    messageId: 'msg_AAAAAAAAAAAAAAAA',
    projectId: 'prj_AAAAAAAAAAAAAAAA',
    toolCallId,
    journal,
    shellRules: { projectId: 'prj_AAAAAAAAAAAAAAAA', prefixes: ['ls', 'pnpm test'] },
    shellCwd,
  }
}

describe('run scope', () => {
  it('a context object without a binding has no scope', () => {
    expect(runScopeOf(context())).toBeNull()
    expect(runScopeOf({})).toBeNull()
  })

  it('binds a frozen copy to the object; the run shares one shellCwd object', () => {
    const shellCwd = { current: '.' }
    const first = context('call_1')
    const second = context('call_2')
    bindRunScope(first, scope('call_1', shellCwd))
    bindRunScope(second, scope('call_2', shellCwd))
    const bound = runScopeOf(first)
    expect(bound).toMatchObject({ chatId: '0199a8f0-0000-7000-8000-000000000001', messageId: 'msg_AAAAAAAAAAAAAAAA', toolCallId: 'call_1', journal })
    expect(bound?.shellRules.prefixes).toEqual(['ls', 'pnpm test'])
    expect(Object.isFrozen(bound)).toBe(true)
    expect(runScopeOf(second)?.toolCallId).toBe('call_2')
    // The folder moves for the whole run: a finished call updates it, the next call reads it.
    runScopeOf(first)!.shellCwd.current = 'packages/web'
    expect(runScopeOf(second)?.shellCwd.current).toBe('packages/web')
    expect(shellCwd.current).toBe('packages/web')
  })

  it('a copy of the context (a spread, a plugin-built object) does not carry the scope', () => {
    const c = context()
    bindRunScope(c, scope('call_1'))
    expect(runScopeOf({ ...c })).toBeNull()
    expect(runScopeOf(structuredClone({ ...c, signal: undefined }))).toBeNull()
  })

  it('nothing is reachable through the context object: no property, no symbol, the same JSON', () => {
    const c = context()
    const keysBefore = Reflect.ownKeys(c)
    const jsonBefore = JSON.stringify({ ...c, signal: undefined })
    bindRunScope(c, scope('call_1'))
    expect(Reflect.ownKeys(c)).toEqual(keysBefore)
    expect(Object.getOwnPropertySymbols(c)).toEqual([])
    expect(JSON.stringify({ ...c, signal: undefined })).toBe(jsonBefore)
    expect(Object.getPrototypeOf(c)).toBe(Object.prototype)
    // A plugin walking every property never meets the journal or the rules.
    const seen = new Set<unknown>()
    const walk = (value: unknown): void => {
      if (typeof value !== 'object' || value === null || seen.has(value))
        return
      seen.add(value)
      for (const key of Reflect.ownKeys(value))
        walk((value as Record<PropertyKey, unknown>)[key])
    }
    walk(c)
    expect(seen.has(journal)).toBe(false)
  })

  it('binding the same object again replaces the scope', () => {
    const c = context()
    bindRunScope(c, scope('call_1'))
    bindRunScope(c, { ...scope('call_1'), journal: null })
    expect(runScopeOf(c)?.journal).toBeNull()
  })
})
