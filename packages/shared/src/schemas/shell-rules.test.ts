import { describe, expect, it } from 'vitest'
import { LIMITS } from '../limits.ts'
import { shellRuleParamsSchema } from './params.ts'
import { shellRuleCreateSchema, shellRuleListSchema, shellRuleSchema } from './shell-rules.ts'

const RULE_ID = 'srl_ABCdef0123456789'
const PROJECT_ID = 'prj_ABCdef0123456789'

describe('shell rules (ADR-038)', () => {
  const rule = { id: RULE_ID, projectId: PROJECT_ID, prefix: 'pnpm test', createdAt: 1 }

  it('parses rules and the list', () => {
    expect(shellRuleSchema.parse(rule)).toEqual(rule)
    const global = { ...rule, projectId: null, prefix: 'ls' }
    expect(shellRuleListSchema.parse({ items: [global, rule] })).toEqual({ items: [global, rule] })
    for (const change of [{ id: 'srl_short' }, { projectId: undefined }, { prefix: '' }, { prefix: 'x'.repeat(LIMITS.shellRulePrefixMaxChars + 1) }, { createdAt: -1 }])
      expect(shellRuleSchema.safeParse({ ...rule, ...change }).success, JSON.stringify(change).slice(0, 60)).toBe(false)
  })

  it('validates creates strictly; the prefix is trimmed (the server validates it with the rule parser)', () => {
    expect(shellRuleCreateSchema.parse({ projectId: PROJECT_ID, prefix: '  pnpm test  ' })).toEqual({ projectId: PROJECT_ID, prefix: 'pnpm test' })
    expect(shellRuleCreateSchema.parse({ projectId: null, prefix: 'ls' })).toEqual({ projectId: null, prefix: 'ls' })
    // Shape only: a prefix the parser refuses (a command runner) still passes the schema.
    expect(shellRuleCreateSchema.parse({ projectId: null, prefix: 'sudo rm' }).prefix).toBe('sudo rm')
    for (const body of [
      {},
      { prefix: 'ls' },
      { projectId: null },
      { projectId: null, prefix: '   ' },
      { projectId: null, prefix: 'x'.repeat(LIMITS.shellRulePrefixMaxChars + 1) },
      { projectId: 'prj_short', prefix: 'ls' },
      { projectId: null, prefix: 'ls', scope: 'global' },
    ])
      expect(shellRuleCreateSchema.safeParse(body).success, JSON.stringify(body).slice(0, 60)).toBe(false)
  })

  it('validates the params', () => {
    expect(shellRuleParamsSchema.parse({ id: RULE_ID })).toEqual({ id: RULE_ID })
    expect(shellRuleParamsSchema.safeParse({ id: 'wcb_ABCdef0123456789' }).success).toBe(false)
  })
})
