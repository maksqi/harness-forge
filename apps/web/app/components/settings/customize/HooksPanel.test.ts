import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useHooksStore } from '~/stores/hooks'
import { testIds } from '~/utils/testids'
import { codeHookEntry, hookEntry, hookList, projectId } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import HooksPanel from './HooksPanel.vue'

const mock = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))

let pinia: ReturnType<typeof createPinia>

beforeEach(() => {
  mock.api = createMockApi()
  pinia = createPinia()
  setActivePinia(pinia)
})

afterEach(() => {
  document.body.replaceChildren()
  disposePinia(pinia)
})

function sources(): (string | undefined)[] {
  return [...document.body.querySelectorAll<HTMLElement>(`[data-testid="${testIds.hooksSection}"]`)].map(section => section.dataset.source)
}

describe('hooksPanel (P11-0b stub)', () => {
  it('renders its root and the personal section without a project', async () => {
    const wrapper = mount(HooksPanel, { props: { projectId: null, projectName: null }, attachTo: document.body, global: { plugins: [pinia] } })
    expect(document.body.querySelector(`[data-testid="${testIds.hooksPanel}"]`)).not.toBeNull()
    expect(sources()).toEqual(['personal'])
    wrapper.unmount()
  })

  it('renders the sections of a cached project listing and opens the editor and the import through its exposes', async () => {
    const list = hookList({ items: [...hookList().items, codeHookEntry()] })
    useHooksStore().lists = { [projectId(1)]: list }
    const wrapper = mount(HooksPanel, { props: { projectId: projectId(1), projectName: 'website' }, attachTo: document.body, global: { plugins: [pinia] } })
    expect(sources()).toEqual(['personal', 'project', 'plugin'])
    expect(document.body.querySelectorAll(`[data-testid="${testIds.hookRow}"]`)).toHaveLength(3)
    expect(hookEntry().key).toBe(list.items[0]!.key)
    wrapper.vm.create()
    await flushPromises()
    expect(document.body.querySelector<HTMLElement>(`[data-testid="${testIds.hookEditor}"]`)?.dataset.mode).toBe('new')
    wrapper.vm.import()
    await flushPromises()
    expect(document.body.querySelector(`[data-testid="${testIds.hookImportDialog}"]`)).not.toBeNull()
    wrapper.unmount()
  })
})
