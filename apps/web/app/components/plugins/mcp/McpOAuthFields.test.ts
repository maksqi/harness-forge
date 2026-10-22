// McpOAuthFields (Phase 14, ADR-059; docs/UI.md 8.14, 10.10): the C54 stub's contract (props, the root test id with
// `data-state`); W14.7 implements the fields.
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { testIds } from '~/utils/testids'
import { oauthDraftOf, redirectUriFor } from './mcp-form'
import McpOAuthFields from './McpOAuthFields.vue'

const REDIRECT_URI = redirectUriFor('http://127.0.0.1:3000')

describe('mcpOAuthFields (stub)', () => {
  it('accepts its props and is closed without a value, open with one', async () => {
    const wrapper = mount(McpOAuthFields, { props: { modelValue: oauthDraftOf(null), secretState: null, redirectUri: REDIRECT_URI } })
    const root = wrapper.get(`[data-testid="${testIds.mcpOauthSection}"]`)
    expect(root.attributes('data-state')).toBe('closed')
    await wrapper.setProps({ modelValue: { clientId: 'hf-linear', scopes: '', clientSecret: '', removeSecret: false }, disabled: true, signedIn: true })
    expect(root.attributes('data-state')).toBe('open')
    expect(root.attributes('aria-disabled')).toBe('true')
    await wrapper.setProps({ modelValue: oauthDraftOf(null), secretState: { set: true, hint: null, source: 'stored' } })
    expect(root.attributes('data-state')).toBe('open')
    wrapper.unmount()
  })
})
