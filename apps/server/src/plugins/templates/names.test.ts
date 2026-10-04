import type { NameRegistry } from './names.ts'
import { CLIENT_COMMANDS, HARNESS_COMMANDS } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { EMPTY_NAME_REGISTRY, isReservedCommandName, pickTemplateNames } from './names.ts'

describe('reserved command names', () => {
  it('treats the client-only commands and the harness command /compact as taken', () => {
    for (const name of [...CLIENT_COMMANDS, ...HARNESS_COMMANDS])
      expect(isReservedCommandName(name), name).toBe(true)
    expect(HARNESS_COMMANDS).toContain('compact')
    for (const name of ['tldr', 'wordcount', 'compact-2', 'compactor', 'remember-2'])
      expect(isReservedCommandName(name), name).toBe(false)
  })

  it('treats /remember (Phase 10, the Remember dialog) as taken', () => {
    expect(CLIENT_COMMANDS).toContain('remember')
    expect(isReservedCommandName('remember')).toBe(true)
  })

  it('the command pack still picks its short names, with suffixes when taken', () => {
    expect(pickTemplateNames('acme', 'command-pack').commands).toEqual({ summary: 'tldr', count: 'wordcount' })
    const registry: NameRegistry = { ...EMPTY_NAME_REGISTRY, command: name => name === 'tldr' }
    expect(pickTemplateNames('acme', 'command-pack', registry).commands).toEqual({ summary: 'tldr-2', count: 'wordcount' })
  })
})
