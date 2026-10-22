// useMcpSignIn (Phase 14, ADR-059; docs/UI.md 8.14, 11.10): the C54 skeleton's signature; W14.7 implements the sign-in
// (fresh-auth run, the same-tab navigation, the toasts, `complete`) and extends this file.
import { describe, expect, it } from 'vitest'
import { mcpSignInKey, useMcpSignIn } from './useMcpSignIn'

describe('useMcpSignIn (skeleton)', () => {
  it('keys a target by its kind, project and server', () => {
    expect(mcpSignInKey({ kind: 'global', serverId: 'linear' })).toBe('global:linear')
    expect(mcpSignInKey({ kind: 'project', projectId: 'prj_a000000000000001', serverId: 'docs' })).toBe('project:prj_a000000000000001:docs')
  })

  it('refuses every action until W14.7 implements it; nothing is busy', async () => {
    const signIn = useMcpSignIn()
    expect(signIn.busyKey.value).toBeNull()
    await expect(signIn.start({ kind: 'global', serverId: 'linear' }, { name: 'Linear' })).rejects.toMatchObject({ code: 'not_implemented' })
    await expect(signIn.signOut({ kind: 'global', serverId: 'linear' }, 'Linear')).rejects.toMatchObject({ code: 'not_implemented' })
    await expect(signIn.complete({ state: 'sampleState0000000000001', code: 'sample-code' })).rejects.toMatchObject({ code: 'not_implemented' })
  })
})
