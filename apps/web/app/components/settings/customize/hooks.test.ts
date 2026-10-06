import { HOOK_EVENTS } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { codeHookEntry, hookEntry, trustSha } from '~/utils/testing/fixtures'
import { draftFromHook, HOOK_COPY, HOOK_EVENT_INFO, hookDeleteCopy, hookJson, hookRowMeta, hookStateBadge, importHooks, matcherPreview } from './hooks'

describe('customize hooks helpers (P11-0b first versions)', () => {
  it('describes the eight events in order; only the tool events match tools', () => {
    expect(Object.keys(HOOK_EVENT_INFO)).toEqual([...HOOK_EVENTS])
    expect(HOOK_EVENT_INFO.PreToolUse).toMatchObject({ label: 'PreToolUse', toolMatcher: true })
    expect(HOOK_EVENT_INFO.Stop).toMatchObject({ label: 'Stop', toolMatcher: false, description: 'When the agent finishes a reply. It can make it continue.' })
    expect(HOOK_COPY.runHooks).toBe('Run hooks')
  })

  it('reads the badge, the meta line and the draft of a row', () => {
    expect(hookStateBadge(hookEntry())).toBeNull()
    expect(hookStateBadge(hookEntry({ source: 'project', state: 'pending', sha256: trustSha(1) }))).toEqual({ label: 'Needs approval', tone: 'warning' })
    expect(hookStateBadge(hookEntry({ state: 'off' }))?.label).toBe('Off')
    expect(hookRowMeta(hookEntry({ timeout: 30 }), id => id)).toEqual(['Personal', 'timeout 30s'])
    expect(hookRowMeta(codeHookEntry(), () => 'Hook pack')).toEqual(['Hook pack'])
    expect(draftFromHook(hookEntry({ state: 'off' }))).toEqual({ event: 'PostToolUse', matcher: 'Write|Edit', command: 'sh .claude/hooks/format.sh', timeout: null, enabled: false })
  })

  it('writes the Claude Code hooks object of command rows', () => {
    expect(JSON.parse(hookJson([hookEntry({ timeout: 30 }), codeHookEntry()]))).toEqual({
      hooks: { PostToolUse: [{ matcher: 'Write|Edit', hooks: [{ type: 'command', command: 'sh .claude/hooks/format.sh', timeout: 30 }] }] },
    })
  })

  it('type-checks the placeholders', () => {
    expect(matcherPreview('Bash', ['shell'])).toMatchObject({ ok: true })
    expect(importHooks('').error).toBeNull()
    expect(hookDeleteCopy(hookEntry()).confirm).toBe('Delete hook')
  })
})
