// EncryptionKeySection (docs/UI.md 9.8, 10.4; docs/API.md 5.23; W7.13): the key status rows, the mismatch alert, the
// HF_MASTER_KEY mode (button disabled, the note and the CLI commands), the load error, and a rotation that reloads the
// status, the summary line and Shared links.
import type { KeyRotationResult } from '@harness-forge/shared'
import type { VueWrapper } from '@vue/test-utils'
import type { Mock } from 'vitest'
import type { DataSettingsContext } from './data-context'
import type { MockApi } from '~/utils/testing/mock-api'
import { HarnessError } from '@harness-forge/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { h, nextTick } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { testIds } from '~/utils/testids'
import { keyStatus } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { dataSettingsContextKey } from './data-context'
import EncryptionKeySection from './EncryptionKeySection.vue'

const mocks = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mocks.api }))

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('vue-sonner', () => ({ toast: Object.assign(vi.fn(), toasts) }))

const MISMATCH = 'The master key doesn\'t match the stored secrets. Saved API keys can\'t be read. Restore the previous key (HF_MASTER_KEY or data/secret.key), or enter the keys again.'

let pinia: ReturnType<typeof createPinia>
let api: MockApi
let page: { [K in keyof DataSettingsContext]: Mock<DataSettingsContext[K]> }
let wrappers: VueWrapper[] = []

beforeEach(() => {
  api = createMockApi()
  mocks.api = api
  toasts.success.mockReset()
  toasts.error.mockReset()
  pinia = createPinia()
  setActivePinia(pinia)
  page = { reloadSummary: vi.fn(), reloadShares: vi.fn() }
  api.keys.get.mockResolvedValue(keyStatus({ secrets: 4 }))
})

afterEach(() => {
  for (const wrapper of wrappers)
    wrapper.unmount()
  wrappers = []
  disposePinia(pinia)
  document.body.replaceChildren()
})

async function mountSection(options: { context?: boolean } = {}): Promise<VueWrapper> {
  const provide = options.context === false ? {} : { [dataSettingsContextKey as symbol]: page }
  // The copy buttons of the CLI commands use tooltips (the app shell provides TooltipProvider).
  const wrapper = mount({ render: () => h(TooltipProvider, null, { default: () => h(EncryptionKeySection) }) }, {
    attachTo: document.body,
    global: { plugins: [pinia], provide },
  })
  wrappers.push(wrapper)
  await flushPromises()
  return wrapper
}

function byTestId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.body.querySelector<T>(`[data-testid="${id}"]`)
}

function slot(name: string): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(`[data-slot="${name}"]`)
}

function rows(): Record<string, string> {
  const status = slot('key-status')
  const terms = [...(status?.querySelectorAll('dt') ?? [])].map(term => term.textContent?.trim() ?? '')
  const values = [...(status?.querySelectorAll('dd') ?? [])].map(value => value.textContent?.replace(/\s+/g, ' ').trim() ?? '')
  return Object.fromEntries(terms.map((term, index) => [term, values[index] ?? '']))
}

function rotateButton(): HTMLButtonElement {
  return byTestId<HTMLButtonElement>(testIds.dataKeyRotate)!
}

async function click(element: HTMLElement | null | undefined): Promise<void> {
  expect(element).toBeTruthy()
  element!.click()
  await flushPromises()
}

async function type(id: string, value: string): Promise<void> {
  const input = byTestId<HTMLInputElement>(id)
  expect(input).not.toBeNull()
  input!.value = value
  input!.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
}

describe('encryptionKeySection', () => {
  it('renders the "Encryption key" section with its root test id', async () => {
    const wrapper = await mountSection()
    const root = wrapper.get(`[data-testid="${testIds.dataKeySection}"]`)
    expect(root.element).toBe(wrapper.findComponent(EncryptionKeySection).element)
    expect(root.attributes('data-slot')).toBe('settings-section')
    expect(root.get('h2').text()).toBe('Encryption key')
    expect(root.text()).toContain('API keys and other secrets are encrypted on this server with a master key.')
  })

  it('shows the status of a key file that was never rotated', async () => {
    await mountSection()
    expect(api.keys.get).toHaveBeenCalledTimes(1)
    expect(rows()).toEqual({
      Source: 'Key file in the data directory',
      Version: '1',
      Rotated: 'Never',
      Secrets: '4 encrypted',
    })
    expect(rotateButton().disabled).toBe(false)
    expect(rotateButton().textContent?.trim()).toBe('Rotate key…')
    expect(slot('key-mismatch-alert')).toBeNull()
    expect(slot('key-env-note')).toBeNull()
    expect(slot('key-rotate-commands')).toBeNull()
  })

  it('shows when the key was rotated and the secrets it cannot read', async () => {
    const rotatedAt = Date.now() - 3 * 3_600_000
    api.keys.get.mockResolvedValue(keyStatus({ keyVersion: 3, rotatedAt, secrets: 5, unreadableSecrets: 2 }))
    await mountSection()
    expect(rows()).toMatchObject({ Version: '3', Rotated: '3h ago', Secrets: '5 encrypted · 2 can\'t be read' })
    const time = slot('key-rotated')?.querySelector('time')
    expect(time?.getAttribute('datetime')).toBe(new Date(rotatedAt).toISOString())
    expect(slot('key-secrets')?.className).toContain('text-destructive')
  })

  it('disables rotation for a key from HF_MASTER_KEY and shows the offline commands', async () => {
    api.keys.get.mockResolvedValue(keyStatus({ source: 'env', canRotate: false, secrets: 2 }))
    await mountSection()
    expect(rows().Source).toBe('HF_MASTER_KEY environment variable')
    expect(rotateButton().disabled).toBe(true)
    expect(slot('key-env-note')?.textContent?.replace(/\s+/g, ' ').trim())
      .toBe('The key comes from HF_MASTER_KEY. Stop the server and run pnpm key:rotate with HF_NEW_MASTER_KEY set to the new key.')
    const commands = [...slot('key-rotate-commands')!.querySelectorAll('pre')].map(block => block.textContent)
    expect(commands).toEqual([
      'docker run --rm -v <volume>:/data -e HF_MASTER_KEY=<old> -e HF_NEW_MASTER_KEY=<new> harness-forge node apps/server/dist/main.mjs rotate-key',
      'HF_MASTER_KEY=<old> HF_NEW_MASTER_KEY=<new> pnpm key:rotate',
    ])
    expect(slot('key-rotate-commands')?.textContent).toContain('Docker')
    expect(slot('key-rotate-commands')?.textContent).toContain('Source checkout')

    await click(rotateButton())
    expect(byTestId(testIds.keyRotateDialog)).toBeNull()
  })

  it('warns about a key-check mismatch and keeps rotation disabled', async () => {
    api.keys.get.mockResolvedValue(keyStatus({ keyCheck: 'mismatch', canRotate: false, secrets: 3, unreadableSecrets: 3 }))
    await mountSection()
    const alert = slot('key-mismatch-alert')
    expect(alert?.getAttribute('role')).toBe('alert')
    expect(alert?.textContent?.trim()).toBe(MISMATCH)
    expect(rotateButton().disabled).toBe(true)
  })

  it('shows nothing extra while the key check is unknown', async () => {
    api.keys.get.mockResolvedValue(keyStatus({ keyCheck: 'unknown' }))
    await mountSection()
    expect(slot('key-mismatch-alert')).toBeNull()
    expect(rotateButton().disabled).toBe(false)
  })

  it('says so when the status cannot be loaded, and retries', async () => {
    api.keys.get.mockRejectedValueOnce(new HarnessError({ code: 'internal_error', message: 'The database is locked.' }))
    await mountSection()
    const alert = slot('settings-load-error')
    expect(alert?.textContent).toContain('Could not load the encryption key status')
    expect(alert?.textContent).toContain('The database is locked.')
    expect(rotateButton()).toBeNull()

    await click([...alert!.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Retry'))
    expect(api.keys.get).toHaveBeenCalledTimes(2)
    expect(slot('settings-load-error')).toBeNull()
    expect(rows().Source).toBe('Key file in the data directory')
  })

  it('rotates through the dialog, then reloads the status, the summary line and Shared links', async () => {
    api.keys.get
      .mockResolvedValueOnce(keyStatus({ secrets: 4, shares: 2, pendingApprovals: 1 }))
      .mockResolvedValueOnce(keyStatus({ secrets: 4, keyVersion: 2, rotatedAt: Date.now() }))
    const result: KeyRotationResult = {
      keyVersion: 2,
      rotatedAt: Date.now(),
      secrets: 4,
      skippedSecrets: 0,
      shares: 2,
      approvalsExpired: 1,
      chats: 1,
      runsStopped: 0,
    }
    api.keys.rotate.mockResolvedValue(result)
    await mountSection()

    await click(rotateButton())
    const dialog = byTestId(testIds.keyRotateDialog)
    expect(dialog?.textContent).toContain('Every share link changes (2 links)')
    expect(dialog?.textContent).toContain('pending approvals expire (1 waiting)')

    await type(testIds.keyRotateConfirm, 'ROTATE')
    await click(byTestId(testIds.keyRotateSubmit))

    expect(api.keys.rotate).toHaveBeenCalledWith({ body: { confirm: 'ROTATE' } })
    expect(toasts.success).toHaveBeenCalledWith('Master key rotated', { description: '4 secrets encrypted again · 1 approval expired' })
    expect(byTestId(testIds.keyRotateDialog)).toBeNull()
    expect(api.keys.get).toHaveBeenCalledTimes(2)
    expect(rows()).toMatchObject({ Version: '2', Rotated: 'just now' })
    expect(page.reloadSummary).toHaveBeenCalledTimes(1)
    expect(page.reloadShares).toHaveBeenCalledTimes(1)
  })

  it('works on its own, without the Data page around it', async () => {
    api.keys.rotate.mockResolvedValue({
      keyVersion: 2,
      rotatedAt: Date.now(),
      secrets: 0,
      skippedSecrets: 0,
      shares: 0,
      approvalsExpired: 0,
      chats: 0,
      runsStopped: 0,
    })
    await mountSection({ context: false })
    await click(rotateButton())
    await type(testIds.keyRotateConfirm, 'ROTATE')
    await click(byTestId(testIds.keyRotateSubmit))
    expect(api.keys.get).toHaveBeenCalledTimes(2)
    expect(page.reloadSummary).not.toHaveBeenCalled()
  })
})
