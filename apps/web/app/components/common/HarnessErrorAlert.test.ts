import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import HarnessErrorAlert from './HarnessErrorAlert.vue'

describe('harnessErrorAlert', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders the title, the server message and the action from an envelope', async () => {
    const error = { error: { code: 'auth_invalid', message: 'Anthropic said 401.', providerId: 'anthropic', action: 'configure-provider' } }
    const wrapper = mount(HarnessErrorAlert, {
      props: { error, providerName: 'Anthropic (Claude)' },
      attrs: { 'data-testid': 'chat-error' },
    })
    const root = wrapper.get('[data-testid="chat-error"]')
    expect(root.attributes('data-code')).toBe('auth_invalid')
    expect(root.attributes('role')).toBe('alert')
    expect(wrapper.text()).toContain('Anthropic (Claude) rejected the API key')
    expect(wrapper.text()).toContain('Anthropic said 401.')
    const action = wrapper.get('[data-testid="chat-error-action"]')
    expect(action.attributes('data-action')).toBe('configure-provider')
    expect(action.text()).toBe('Open settings')
    await action.trigger('click')
    expect(wrapper.emitted('action')).toEqual([['configure-provider']])
  })

  it('keeps chat test ids out of other contexts', () => {
    const wrapper = mount(HarnessErrorAlert, { props: { error: { code: 'provider_unreachable', message: 'Timed out' } } })
    const action = wrapper.get('[data-action="retry"]')
    expect(action.attributes('data-testid')).toBeUndefined()
  })

  it('counts down before Retry on rate limits', async () => {
    const wrapper = mount(HarnessErrorAlert, {
      props: { error: { code: 'rate_limited', message: 'Slow down', retryAfterMs: 3000 } },
    })
    const retry = () => wrapper.get('[data-action="retry"]')
    expect(retry().text()).toBe('Retry in 3s')
    expect(retry().attributes('disabled')).toBeDefined()
    await vi.advanceTimersByTimeAsync(3100)
    expect(retry().text()).toBe('Retry')
    expect(retry().attributes('disabled')).toBeUndefined()
  })

  it('renders anything thrown as a generic error without leaking its text', () => {
    const wrapper = mount(HarnessErrorAlert, { props: { error: new Error('secret stack at /srv/app.js:10') } })
    expect(wrapper.text()).toContain('Something went wrong')
    expect(wrapper.text()).not.toContain('secret stack')
  })

  it('shows details as text in a collapsible', () => {
    const wrapper = mount(HarnessErrorAlert, {
      props: { error: { code: 'provider_error', message: 'Upstream failed', details: { upstream: '<b>overloaded</b>' } } },
    })
    expect(wrapper.text()).toContain('Details')
    expect(wrapper.find('b').exists()).toBe(false)
  })
})
