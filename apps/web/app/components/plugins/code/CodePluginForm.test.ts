import type { MockApi } from '~/utils/testing/mock-api'
import { HarnessError } from '@harness-forge/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { testIds } from '~/utils/testids'
import { authStatus, pluginDetail, pluginSummary } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import CodePluginForm from './CodePluginForm.vue'

const mock = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('vue-sonner', () => ({ toast: Object.assign(vi.fn(), toasts) }))

let pinia: ReturnType<typeof createPinia>
let api: MockApi

beforeEach(() => {
  api = createMockApi()
  mock.api = api
  api.plugins.list.mockResolvedValue({ items: [pluginSummary({ id: 'taken', name: 'Taken' })] })
  pinia = createPinia()
  setActivePinia(pinia)
  toasts.success.mockReset()
  toasts.error.mockReset()
})

afterEach(() => {
  disposePinia(pinia)
  document.body.replaceChildren()
})

function mountForm() {
  return mount(CodePluginForm, { attachTo: document.body, global: { plugins: [pinia] } })
}

function byTestId<T extends Element = HTMLElement>(id: string, extra = ''): T | null {
  return document.body.querySelector<T>(`[data-testid="${id}"]${extra}`)
}

async function type(id: string, value: string) {
  const input = byTestId<HTMLInputElement>(id)!
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
}

async function chooseTemplate(template: string) {
  byTestId(testIds.codePluginTemplate, `[data-value="${template}"]`)!.click()
  await nextTick()
}

async function create() {
  byTestId<HTMLButtonElement>(testIds.codePluginCreate)!.click()
  await flushPromises()
}

describe('codePluginForm', () => {
  it('derives the id from the name until it is edited, and creates the plugin', async () => {
    api.pluginFiles.scaffold.mockResolvedValue(pluginDetail({ id: 'weather-tools', name: 'Weather Tools' }))
    const wrapper = mountForm()
    await flushPromises()
    await type(testIds.codePluginName, 'Weather Tools')
    expect(byTestId<HTMLInputElement>(testIds.codePluginId)!.value).toBe('weather-tools')
    await chooseTemplate('tool')
    expect(byTestId(testIds.codePluginTemplate, '[data-value="tool"]')!.getAttribute('data-state')).toBe('checked')
    await create()
    expect(api.pluginFiles.scaffold).toHaveBeenCalledWith({ body: { id: 'weather-tools', name: 'Weather Tools', template: 'tool' } })
    expect(toasts.success).toHaveBeenCalledWith('Created Weather Tools')
    expect(wrapper.emitted('created')).toEqual([['weather-tools']])

    await type(testIds.codePluginId, 'my-own-id')
    await type(testIds.codePluginName, 'Something else')
    expect(byTestId<HTMLInputElement>(testIds.codePluginId)!.value).toBe('my-own-id')
    wrapper.unmount()
  })

  it('writes JavaScript by default and TypeScript when chosen', async () => {
    api.pluginFiles.scaffold.mockResolvedValue(pluginDetail({ id: 'typed-tools', name: 'Typed Tools' }))
    const wrapper = mountForm()
    await flushPromises()
    const group = byTestId(testIds.codePluginLanguage)!
    expect(group.dataset.value).toBe('js')
    expect(document.body.textContent).toContain('index.mjs with JSDoc types')
    await type(testIds.codePluginName, 'Typed Tools')
    await chooseTemplate('tool')
    document.body.querySelector<HTMLButtonElement>(`[data-testid="${testIds.codePluginLanguage}"] [data-value="ts"]`)!.click()
    await flushPromises()
    expect(byTestId(testIds.codePluginLanguage)!.dataset.value).toBe('ts')
    expect(document.body.textContent).toContain('index.ts, compiled by the server')
    await create()
    expect(api.pluginFiles.scaffold).toHaveBeenCalledWith({ body: { id: 'typed-tools', name: 'Typed Tools', template: 'tool', language: 'ts' } })
    wrapper.unmount()
  })

  it('offers the four templates and validates before sending', async () => {
    const wrapper = mountForm()
    await flushPromises()
    const templates = [...document.body.querySelectorAll(`[data-testid="${testIds.codePluginTemplate}"]`)].map(item => item.getAttribute('data-value'))
    expect(templates).toEqual(['tool', 'provider', 'mcp-bridge', 'command-pack'])
    await create()
    expect(document.body.textContent).toContain('Enter a name.')
    expect(document.body.textContent).toContain('Choose a template.')
    expect(api.pluginFiles.scaffold).not.toHaveBeenCalled()

    await type(testIds.codePluginName, 'Taken')
    expect(document.body.textContent).toContain('A plugin with this id already exists.')
    await type(testIds.codePluginId, 'core-thing')
    expect(document.body.textContent).toContain('reserved')
    await chooseTemplate('mcp-bridge')
    await type(testIds.codePluginId, 'a'.repeat(33))
    expect(document.body.textContent).toContain('at most 32 characters')
    wrapper.unmount()
  })

  it('shows a conflict from the server under the id', async () => {
    api.pluginFiles.scaffold.mockRejectedValue(new HarnessError({ code: 'conflict', message: 'A plugin with the id "fresh" already exists.', details: { reason: 'exists' } }))
    const wrapper = mountForm()
    await flushPromises()
    await type(testIds.codePluginName, 'Fresh')
    await chooseTemplate('command-pack')
    await create()
    expect(document.body.textContent).toContain('A plugin with the id "fresh" already exists.')
    expect(wrapper.emitted('created')).toBeUndefined()
    expect(toasts.error).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('asks for the password on a fresh-auth refusal, logs in and retries once', async () => {
    api.pluginFiles.scaffold
      .mockRejectedValueOnce(new HarnessError({ code: 'forbidden', message: 'Confirm your password to continue.', action: 'login' }))
      .mockResolvedValueOnce(pluginDetail({ id: 'secure-tool', name: 'Secure tool' }))
    api.auth.login.mockResolvedValue(authStatus({ enabled: true, freshUntil: Date.now() + 600_000 }))
    const wrapper = mountForm()
    await flushPromises()
    await type(testIds.codePluginName, 'Secure tool')
    await chooseTemplate('provider')
    await create()
    expect(byTestId(testIds.confirmPasswordDialog)).not.toBeNull()
    await type(testIds.confirmPasswordInput, 'hunter2 hunter2')
    byTestId<HTMLButtonElement>(testIds.confirmPasswordSubmit)!.click()
    await flushPromises()
    expect(api.auth.login).toHaveBeenCalledWith({ body: { password: 'hunter2 hunter2' } })
    expect(api.pluginFiles.scaffold).toHaveBeenCalledTimes(2)
    expect(wrapper.emitted('created')).toEqual([['secure-tool']])
    wrapper.unmount()
  })

  it('shows a wrong password in the prompt and does nothing when it is cancelled', async () => {
    api.pluginFiles.scaffold.mockRejectedValue(new HarnessError({ code: 'forbidden', message: 'Confirm your password.', action: 'login' }))
    api.auth.login.mockRejectedValue(new HarnessError({ code: 'unauthorized', message: 'Wrong password.' }))
    const wrapper = mountForm()
    await flushPromises()
    await type(testIds.codePluginName, 'Nope')
    await chooseTemplate('tool')
    await create()
    await type(testIds.confirmPasswordInput, 'bad')
    byTestId<HTMLButtonElement>(testIds.confirmPasswordSubmit)!.click()
    await flushPromises()
    expect(byTestId(testIds.confirmPasswordDialog)?.textContent).toContain('Wrong password')
    const cancel = [...byTestId(testIds.confirmPasswordDialog)!.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Cancel')!
    cancel.click()
    await flushPromises()
    expect(byTestId(testIds.confirmPasswordDialog)).toBeNull()
    expect(byTestId<HTMLButtonElement>(testIds.codePluginCreate)!.disabled).toBe(false)
    expect(api.pluginFiles.scaffold).toHaveBeenCalledTimes(1)
    expect(toasts.error).not.toHaveBeenCalled()
    expect(wrapper.emitted('created')).toBeUndefined()
    wrapper.unmount()
  })

  it('emits cancel', async () => {
    const wrapper = mountForm()
    await flushPromises()
    const cancel = [...document.body.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Cancel')!
    cancel.click()
    expect(wrapper.emitted('cancel')).toHaveLength(1)
    wrapper.unmount()
  })
})
