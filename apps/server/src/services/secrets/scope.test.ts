import { describe, expect, it } from 'vitest'
import { isSecretScope } from './scope.ts'

describe('secret scopes', () => {
  it('accepts the provider, plugin, mcp, auth and (Phase 11) project scopes', () => {
    for (const scope of ['provider:openai', 'plugin:dice-roller', 'mcp:probe-http', 'auth', 'project:prj_AbCdEf0123456789'])
      expect(isSecretScope(scope), scope).toBe(true)
  })

  it('refuses unknown prefixes and malformed project ids', () => {
    for (const scope of ['project:', 'project:prj_short', 'project:prj_AbCdEf0123456789x', 'project:../x', 'projects:prj_AbCdEf0123456789', 'PROVIDER:openai', 'mcp:Bad'])
      expect(isSecretScope(scope), scope).toBe(false)
  })
})
