import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { testIds } from '~/utils/testids'
import { customizationEntry, projectId } from '~/utils/testing/fixtures'
import CustomizationViewer from './CustomizationViewer.vue'

afterEach(() => {
  document.body.replaceChildren()
})

describe('customizationViewer (P10-0b stub)', () => {
  it('renders its root with the entry\'s kind and source while open', async () => {
    const wrapper = mount(CustomizationViewer, { props: { open: true, entry: customizationEntry(), projectId: projectId(1) }, attachTo: document.body })
    await flushPromises()
    const viewer = document.body.querySelector<HTMLElement>(`[data-testid="${testIds.customizationViewer}"]`)!
    expect(viewer.dataset).toMatchObject({ kind: 'agent', source: 'project' })
    expect(viewer.textContent).toContain('reviewer')
    wrapper.unmount()
  })

  it('renders nothing without an entry', async () => {
    const wrapper = mount(CustomizationViewer, { props: { open: true, entry: null, projectId: null }, attachTo: document.body })
    await flushPromises()
    expect(document.body.querySelector(`[data-testid="${testIds.customizationViewer}"]`)).toBeNull()
    wrapper.unmount()
  })
})
