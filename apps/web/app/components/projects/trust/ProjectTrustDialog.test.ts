// The project trust review (docs/UI.md 7.33, 8.4, 14; W11.9-T2): the fresh scan on open, the warning, the filter and its
// counts, the groups with "Select all" (no "Approve all"), Approve with fresh auth (never on Enter), the toast, the stale
// alert (focused, the changed items lose their selection), Revoke (focus to the item's checkbox), the event refetch that
// keeps the selection, the empty, unavailable and error states, the orphaned note, the focus key and Close.
import type { ProjectTrustList } from '@harness-forge/shared'
import type { VueWrapper } from '@vue/test-utils'
import type { MockApi } from '~/utils/testing/mock-api'
import { createServerEvent, HarnessError } from '@harness-forge/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, reactive } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAuthStore } from '~/stores/auth'
import { useProjectTrustStore } from '~/stores/project-trust'
import { useProjectsStore } from '~/stores/projects'
import { testIds } from '~/utils/testids'
import { authStatus, projectId, projectMcpList, projectSummary, projectTrustList, trustCommandItem, trustHookItem, trustMcpItem, trustSha } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import ProjectTrustDialog from './ProjectTrustDialog.vue'

const mocks = vi.hoisted(() => ({
  api: null as unknown,
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}))
vi.mock('~/composables/useApi', () => ({ useApi: () => mocks.api }))
vi.mock('vue-sonner', () => ({ toast: mocks.toast }))

const P1 = projectId(1)

let pinia: ReturnType<typeof createPinia>
let api: MockApi
let wrapper: VueWrapper | null = null

beforeEach(() => {
  api = createMockApi()
  mocks.api = api
  mocks.toast.success.mockReset()
  mocks.toast.error.mockReset()
  pinia = createPinia()
  setActivePinia(pinia)
  useProjectsStore().items = [projectSummary()]
  api.projectMcp.list.mockResolvedValue(projectMcpList())
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.replaceChildren()
  disposePinia(pinia)
})

async function mountDialog(list: ProjectTrustList | Error = projectTrustList(), extra: { focusKey?: string | null } = {}) {
  if (list instanceof Error)
    api.projectTrust.list.mockRejectedValueOnce(list)
  else
    api.projectTrust.list.mockResolvedValueOnce(list)
  const state = reactive({ open: true, projectId: P1 as string | null, focusKey: extra.focusKey ?? null })
  const Host = defineComponent({
    setup: () => () => h(TooltipProvider, null, {
      default: () => h(ProjectTrustDialog, { ...state, 'onUpdate:open': (value: boolean) => (state.open = value) }),
    }),
  })
  wrapper = mount(Host, { attachTo: document.body, global: { plugins: [pinia] } })
  await flushPromises()
  await nextTick()
  return state
}

function byTestId<T extends HTMLElement = HTMLElement>(id: string, root: ParentNode = document.body): T | null {
  return root.querySelector<T>(`[data-testid="${id}"]`)
}

function allByTestId(id: string, root: ParentNode = document.body): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)]
}

function item(sha256: string): HTMLElement {
  return allByTestId(testIds.projectTrustItem).find(element => element.dataset.key === sha256)!
}

function group(kind: string): HTMLElement {
  return allByTestId(testIds.projectTrustGroup).find(element => element.dataset.kind === kind)!
}

function approveButton(): HTMLButtonElement {
  return byTestId<HTMLButtonElement>(testIds.projectTrustApprove)!
}

async function click(element: HTMLElement | null) {
  element!.click()
  await flushPromises()
  await nextTick()
}

describe('projectTrustDialog', () => {
  it('opens on Needs review with a fresh scan, the warning, the groups and the first pending checkbox focused', async () => {
    await mountDialog()
    expect(api.projectTrust.list).toHaveBeenCalledWith({ params: { id: P1 } })
    const dialog = byTestId(testIds.projectTrustDialog)!
    expect(dialog.textContent).toContain('Review Website')
    expect(dialog.textContent).toContain('Files in this project can run commands on your server. Nothing below runs until you approve it. Any change needs a new approval.')
    expect(byTestId(testIds.projectTrustWarning)!.textContent).toContain('Approve only what you would run yourself.')
    expect(byTestId(testIds.projectTrustWarning)!.getAttribute('role')).toBe('note')

    const filter = byTestId(testIds.projectTrustFilter)!
    expect(filter.dataset.value).toBe('pending')
    expect(filter.textContent).toContain('Needs review · 2')
    expect(filter.textContent).toContain('All · 3')
    expect(allByTestId(testIds.projectTrustGroup).map(element => [element.dataset.kind, element.dataset.count])).toEqual([['hook', '1'], ['mcp', '1']])
    expect(group('hook').getAttribute('role')).toBe('group')
    expect(document.getElementById(group('hook').getAttribute('aria-labelledby')!)!.textContent).toContain('Hooks · 1')
    expect(byTestId(testIds.projectTrustSelectAll, group('mcp'))!.parentElement!.textContent).toContain('Select all 1')

    // Nothing is selected and nothing has a one-click approval.
    expect(approveButton().disabled).toBe(true)
    expect(approveButton().dataset.count).toBe('0')
    expect(dialog.textContent).not.toMatch(/approve all/i)
    expect(document.activeElement).toBe(byTestId(testIds.projectTrustSelect, item(trustSha(1))))

    // The MCP item shows whether its variables are set (the project's MCP list, fetched quietly).
    expect(api.projectMcp.list).toHaveBeenCalledWith({ params: { id: P1 } })
    expect(item(trustSha(3)).textContent).toContain('Variables: MCP_TOKEN (not set)')
  })

  it('shows every item under All, selects per item or per group, and approves the selection', async () => {
    await mountDialog()
    await click(byTestId(testIds.projectTrustFilter)!.querySelector<HTMLElement>('[data-value="all"]'))
    expect(byTestId(testIds.projectTrustFilter)!.dataset.value).toBe('all')
    expect(allByTestId(testIds.projectTrustGroup).map(element => element.dataset.kind)).toEqual(['hook', 'mcp', 'command'])
    // The approved command has Revoke and no checkbox, and its group has no Select all.
    expect(byTestId(testIds.projectTrustRevoke, item(trustSha(4)))).not.toBeNull()
    expect(byTestId(testIds.projectTrustSelectAll, group('command'))).toBeNull()

    await click(byTestId(testIds.projectTrustSelect, item(trustSha(1))))
    expect(approveButton().dataset.count).toBe('1')
    expect(approveButton().textContent?.trim()).toBe('Approve 1 item')
    await click(byTestId(testIds.projectTrustSelectAll, group('mcp')))
    expect(approveButton().dataset.count).toBe('2')
    expect(approveButton().textContent?.trim()).toBe('Approve 2 items')
    expect(byTestId(testIds.projectTrustDialog)!.textContent).toContain('2 selected')
    // Select all again clears the group.
    await click(byTestId(testIds.projectTrustSelectAll, group('mcp')))
    expect(approveButton().dataset.count).toBe('1')
    await click(byTestId(testIds.projectTrustSelectAll, group('mcp')))

    const approved = projectTrustList({ items: projectTrustList().items.map(entry => ({ ...entry, state: 'approved' as const })) })
    api.projectTrust.approve.mockResolvedValueOnce(approved)
    await click(approveButton())
    expect(api.projectTrust.approve).toHaveBeenCalledWith({
      params: { id: P1 },
      body: { items: [{ kind: 'hook', sha256: trustSha(1) }, { kind: 'mcp', sha256: trustSha(3) }] },
    })
    expect(mocks.toast.success).toHaveBeenCalledWith('Approved 2 items in Website')
    expect(approveButton().dataset.count).toBe('0')
    expect(byTestId(testIds.projectTrustDialog)!.textContent).toContain('Everything in Website is approved.')
  })

  it('never approves on Enter', async () => {
    await mountDialog()
    await click(byTestId(testIds.projectTrustSelect, item(trustSha(1))))
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    approveButton().dispatchEvent(enter)
    await flushPromises()
    expect(enter.defaultPrevented).toBe(true)
    expect(api.projectTrust.approve).not.toHaveBeenCalled()
    expect(approveButton().getAttribute('type')).toBe('button')
    expect(byTestId(testIds.projectTrustDialog)!.querySelector('form, [type="submit"]')).toBeNull()
  })

  it('asks for the password before approving when the session is not fresh', async () => {
    useAuthStore().status = authStatus({ enabled: true, authenticated: true, source: 'settings', freshUntil: null })
    await mountDialog()
    await click(byTestId(testIds.projectTrustSelect, item(trustSha(1))))
    await click(approveButton())
    const prompt = byTestId(testIds.confirmPasswordDialog)!
    expect(prompt.textContent).toContain('Approving project commands needs your password.')
    expect(api.projectTrust.approve).not.toHaveBeenCalled()
  })

  it('shows the stale alert, refetches and keeps only the unchanged selection', async () => {
    await mountDialog()
    await click(byTestId(testIds.projectTrustSelect, item(trustSha(1))))
    await click(byTestId(testIds.projectTrustSelect, item(trustSha(3))))
    api.projectTrust.approve.mockRejectedValueOnce(new HarnessError({ code: 'conflict', message: 'An item changed.', details: { reason: 'stale' } }))
    // The hook changed meanwhile: a new hash, marked as changed.
    api.projectTrust.list.mockResolvedValueOnce(projectTrustList({ items: [trustHookItem({ sha256: trustSha(5), changed: true }), trustMcpItem(), trustCommandItem()] }))
    await click(approveButton())
    const alert = byTestId(testIds.projectTrustError)!
    expect(alert.getAttribute('role')).toBe('alert')
    expect(alert.dataset.code).toBe('conflict')
    expect(alert.textContent).toContain('1 item changed while you were reviewing. Check it again.')
    expect(document.activeElement).toBe(alert)
    expect(item(trustSha(5)).dataset.state).toBe('changed')
    expect(item(trustSha(5)).textContent).toContain('Changed since you approved it.')
    expect(approveButton().dataset.count).toBe('1')
    expect(byTestId<HTMLButtonElement>(testIds.projectTrustSelect, item(trustSha(3)))!.dataset.state).toBe('checked')
  })

  it('revokes an approved item and moves focus to its checkbox', async () => {
    await mountDialog()
    await click(byTestId(testIds.projectTrustFilter)!.querySelector<HTMLElement>('[data-value="all"]'))
    api.projectTrust.revoke.mockResolvedValueOnce(projectTrustList({ items: [trustHookItem(), trustMcpItem(), trustCommandItem({ state: 'pending' })] }))
    await click(byTestId(testIds.projectTrustRevoke, item(trustSha(4))))
    expect(api.projectTrust.revoke).toHaveBeenCalledWith({ params: { id: P1, sha256: trustSha(4) } })
    expect(mocks.toast.success).toHaveBeenCalledWith('Revoked /status. It won\'t run until you approve it again.')
    expect(item(trustSha(4)).dataset.state).toBe('new')
    expect(document.activeElement).toBe(byTestId(testIds.projectTrustSelect, item(trustSha(4))))
  })

  it('refetches quietly on project-trust.changed and keeps the selection of items that are still pending', async () => {
    await mountDialog()
    await click(byTestId(testIds.projectTrustSelect, item(trustSha(1))))
    await click(byTestId(testIds.projectTrustSelect, item(trustSha(3))))
    api.projectTrust.list.mockResolvedValueOnce(projectTrustList({ items: [trustHookItem(), trustMcpItem({ state: 'approved' }), trustCommandItem()] }))
    useProjectTrustStore().applyEvent(createServerEvent('project-trust.changed', { projectId: P1, pending: 1 }, 1))
    await flushPromises()
    await nextTick()
    expect(approveButton().dataset.count).toBe('1')
    expect(byTestId(testIds.projectTrustFilter)!.textContent).toContain('Needs review · 1')
    expect(byTestId(testIds.projectTrustError)).toBeNull()
  })

  it('opens on the focus key\'s item (All when it is approved)', async () => {
    await mountDialog(projectTrustList(), { focusKey: trustSha(4) })
    expect(byTestId(testIds.projectTrustFilter)!.dataset.value).toBe('all')
    expect(document.activeElement).toBe(byTestId(testIds.projectTrustRevoke, item(trustSha(4))))
  })

  it('opens on All with nothing pending, and notes earlier approvals that no longer match', async () => {
    await mountDialog(projectTrustList({ items: [trustCommandItem()], orphaned: 2 }))
    expect(byTestId(testIds.projectTrustFilter)!.dataset.value).toBe('all')
    expect(byTestId(testIds.projectTrustDialog)!.querySelector('[data-slot="project-trust-orphaned"]')!.textContent)
      .toContain('2 earlier approvals no longer match: an approved item was removed or renamed.')
    expect(byTestId(testIds.projectTrustDialog)!.textContent).toContain('Everything in Website is approved.')
  })

  it('shows the empty state, an unavailable folder\'s issue and load errors with Retry', async () => {
    await mountDialog(projectTrustList({ items: [] }))
    expect(byTestId(testIds.projectTrustEmpty)!.textContent?.trim()).toBe('This project has no hooks, MCP servers or commands that run shell commands.')
    expect(byTestId(testIds.projectTrustFilter)).toBeNull()
    wrapper!.unmount()
    wrapper = null
    document.body.replaceChildren()

    disposePinia(pinia)
    pinia = createPinia()
    setActivePinia(pinia)
    useProjectsStore().items = [projectSummary()]
    await mountDialog(projectTrustList({ items: [], available: false, issue: 'The folder does not exist.' }))
    expect(byTestId(testIds.projectTrustEmpty)!.textContent?.trim()).toBe('The folder does not exist.')
    wrapper!.unmount()
    wrapper = null
    document.body.replaceChildren()

    disposePinia(pinia)
    pinia = createPinia()
    setActivePinia(pinia)
    useProjectsStore().items = [projectSummary()]
    await mountDialog(new HarnessError({ code: 'internal_error', message: 'The scan failed.' }))
    const alert = byTestId(testIds.projectTrustError)!
    expect(alert.dataset.code).toBe('internal_error')
    expect(alert.textContent).toContain('The scan failed.')
    api.projectTrust.list.mockResolvedValueOnce(projectTrustList())
    await click([...alert.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Retry')!)
    expect(byTestId(testIds.projectTrustError)).toBeNull()
    expect(allByTestId(testIds.projectTrustItem)).toHaveLength(2)
  })

  it('closes without approving', async () => {
    const state = await mountDialog()
    await click(byTestId(testIds.projectTrustSelect, item(trustSha(1))))
    const close = [...byTestId(testIds.projectTrustDialog)!.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Close')!
    await click(close)
    expect(state.open).toBe(false)
    expect(api.projectTrust.approve).not.toHaveBeenCalled()
    expect(byTestId(testIds.projectTrustDialog)).toBeNull()
  })

  it('renders nothing while closed', async () => {
    const Host = defineComponent({ setup: () => () => h(ProjectTrustDialog, { open: false, projectId: null }) })
    wrapper = mount(Host, { attachTo: document.body, global: { plugins: [pinia] } })
    await flushPromises()
    expect(byTestId(testIds.projectTrustDialog)).toBeNull()
    expect(api.projectTrust.list).not.toHaveBeenCalled()
  })
})
