// McpOAuthFields (Phase 14, ADR-059; docs/UI.md 8.14, 10.10; W14.7-T2): the collapsible "Sign-in (OAuth) · optional"
// section (closed without a value, open with one, toggled by the user), the client id, the write-only client secret
// (empty input, "•••• · stored", Remove, enabled only with a client id), the scopes, the read-only redirect URI with Copy,
// and the Authorization header note.
import type { SecretState } from '@harness-forge/shared'
import type { McpOAuthDraft } from './mcp-form'
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { testIds } from '~/utils/testids'
import { oauthDraftOf, redirectUriFor } from './mcp-form'
import McpOAuthFields from './McpOAuthFields.vue'

const REDIRECT_URI = redirectUriFor('http://127.0.0.1:3000')
const STORED: SecretState = { set: true, hint: null, source: 'stored' }

afterEach(() => {
  document.body.replaceChildren()
})

function mountFields(initial: McpOAuthDraft = oauthDraftOf(null), props: { secretState?: SecretState | null, disabled?: boolean, signedIn?: boolean } = {}) {
  const draft = ref<McpOAuthDraft>(initial)
  const options = { secretState: null as SecretState | null, disabled: false, signedIn: false, ...props }
  const Host = defineComponent({
    setup: () => () => h(TooltipProvider, null, {
      default: () => h(McpOAuthFields, {
        'modelValue': draft.value,
        'secretState': options.secretState,
        'redirectUri': REDIRECT_URI,
        'disabled': options.disabled,
        'signedIn': options.signedIn,
        'onUpdate:modelValue': (value: McpOAuthDraft) => {
          draft.value = value
        },
      }),
    }),
  })
  const wrapper = mount(Host, { attachTo: document.body })
  return { wrapper, draft }
}

function section(): HTMLElement {
  return document.body.querySelector<HTMLElement>(`[data-testid="${testIds.mcpOauthSection}"]`)!
}

function byTestId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.body.querySelector<T>(`[data-testid="${id}"]`)
}

async function type(input: HTMLInputElement, value: string) {
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
}

async function toggle() {
  section().querySelector<HTMLButtonElement>('button[aria-controls], button[aria-expanded]')!.click()
  await nextTick()
  await nextTick()
}

describe('mcpOAuthFields', () => {
  it('is closed without a value and opens on a click; open with a value or a stored secret', async () => {
    const empty = mountFields()
    expect(section().dataset.state).toBe('closed')
    expect(section().textContent).toContain('Sign-in (OAuth) · optional')
    expect(byTestId(testIds.mcpOauthClientId)).toBeNull()
    await toggle()
    expect(section().dataset.state).toBe('open')
    expect(byTestId(testIds.mcpOauthClientId)).not.toBeNull()
    expect(section().textContent).toContain('Leave empty to register harness-forge with the server when you sign in.')
    empty.wrapper.unmount()

    const configured = mountFields({ clientId: 'hf-linear', scopes: '', clientSecret: '', removeSecret: false })
    expect(section().dataset.state).toBe('open')
    configured.wrapper.unmount()

    const stored = mountFields(oauthDraftOf(null), { secretState: STORED })
    expect(section().dataset.state).toBe('open')
    await toggle()
    expect(section().dataset.state).toBe('closed')
    stored.wrapper.unmount()
  })

  it('edits the client id and the scopes; the secret needs a client id and is never read back', async () => {
    const { draft } = mountFields()
    await toggle()
    const secret = byTestId<HTMLInputElement>(testIds.mcpOauthClientSecret)!
    expect(secret.type).toBe('password')
    expect(secret.disabled).toBe(true)
    expect(secret.value).toBe('')
    await type(byTestId<HTMLInputElement>(testIds.mcpOauthClientId)!, 'hf-linear')
    expect(draft.value.clientId).toBe('hf-linear')
    expect(byTestId<HTMLInputElement>(testIds.mcpOauthClientId)!.getAttribute('placeholder')).toBe('Registered automatically')
    expect(byTestId<HTMLInputElement>(testIds.mcpOauthClientSecret)!.disabled).toBe(false)
    await type(byTestId<HTMLInputElement>(testIds.mcpOauthClientSecret)!, 's3cret')
    await type(byTestId<HTMLInputElement>(testIds.mcpOauthScopes)!, 'read write')
    expect(draft.value).toEqual({ clientId: 'hf-linear', scopes: 'read write', clientSecret: 's3cret', removeSecret: false })
    expect(byTestId<HTMLInputElement>(testIds.mcpOauthScopes)!.getAttribute('placeholder')).toBe('Server default')
    // No Remove without a stored secret.
    expect(section().querySelector('[data-action="remove-secret"]')).toBeNull()
  })

  it('a stored secret shows "•••• · stored" and Remove toggles its removal', async () => {
    const { draft } = mountFields({ clientId: 'hf-github', scopes: 'repo', clientSecret: '', removeSecret: false }, { secretState: STORED })
    const secret = byTestId<HTMLInputElement>(testIds.mcpOauthClientSecret)!
    expect(secret.placeholder).toBe('•••• · stored')
    expect(secret.dataset.stored).toBe('true')
    const remove = section().querySelector<HTMLButtonElement>('[data-action="remove-secret"]')!
    expect(remove.getAttribute('aria-pressed')).toBe('false')
    remove.click()
    await nextTick()
    expect(draft.value.removeSecret).toBe(true)
    expect(section().querySelector('[data-action="remove-secret"]')!.getAttribute('aria-pressed')).toBe('true')
    expect(byTestId<HTMLInputElement>(testIds.mcpOauthClientSecret)!.placeholder).toBe('')
  })

  it('shows the redirect URI built in script with a Copy button', () => {
    mountFields({ clientId: 'hf-linear', scopes: '', clientSecret: '', removeSecret: false })
    expect(byTestId(testIds.mcpOauthRedirectUri)!.textContent?.trim()).toBe('http://127.0.0.1:3000/oauth/callback')
    expect(section().querySelector('button[aria-label="Copy redirect URI"]')).not.toBeNull()
    expect(section().textContent).toContain('Register this exact address with the authorization server when you use your own client ID.')
  })

  it('an Authorization header disables the fields with its note', () => {
    mountFields({ clientId: 'hf-github', scopes: '', clientSecret: '', removeSecret: false }, { secretState: STORED, disabled: true, signedIn: true })
    expect(section().getAttribute('aria-disabled')).toBe('true')
    expect(section().dataset.signedIn).toBe('true')
    expect(section().textContent).toContain('Servers with an Authorization header don\'t sign in.')
    expect(section().textContent).not.toContain('Leave empty to register')
    expect(byTestId<HTMLInputElement>(testIds.mcpOauthClientId)!.disabled).toBe(true)
    expect(byTestId<HTMLInputElement>(testIds.mcpOauthClientSecret)!.disabled).toBe(true)
    expect(byTestId<HTMLInputElement>(testIds.mcpOauthScopes)!.disabled).toBe(true)
    expect(section().querySelector<HTMLButtonElement>('[data-action="remove-secret"]')!.disabled).toBe(true)
  })
})
