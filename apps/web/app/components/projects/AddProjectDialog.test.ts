// AddProjectDialog skeleton (docs/UI.md 9.10, 10.4; C15, P7-0b): the dialog content carries the root test id and holds
// the FolderBrowser opened at initialPath; closing emits update:open. W7.9 adds the form and the submit.
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { testIds } from '~/utils/testids'
import AddProjectDialog from './AddProjectDialog.vue'

afterEach(() => {
  document.body.replaceChildren()
})

function byTestId(id: string): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`)
}

describe('addProjectDialog', () => {
  it('renders nothing while closed', async () => {
    const wrapper = mount(AddProjectDialog, { props: { open: false }, attachTo: document.body })
    await flushPromises()
    expect(byTestId(testIds.addProjectDialog)).toBeNull()
    wrapper.unmount()
  })

  it('renders its content with the folder browser at the initial path and emits update:open on Escape', async () => {
    const open = ref(true)
    const updates: boolean[] = []
    const Host = defineComponent({
      setup: () => () => h(AddProjectDialog, {
        'open': open.value,
        'initialPath': '/srv/workspaces',
        'onUpdate:open': (value: boolean) => {
          updates.push(value)
          open.value = value
        },
      }),
    })
    const wrapper = mount(Host, { attachTo: document.body })
    await flushPromises()
    const content = byTestId(testIds.addProjectDialog)
    expect(content).not.toBeNull()
    expect(content!.getAttribute('role')).toBe('dialog')
    expect(content!.textContent).toContain('Add project')
    expect(content!.querySelector(`[data-testid="${testIds.folderBrowser}"]`)?.getAttribute('data-path')).toBe('/srv/workspaces')

    content!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(updates).toEqual([false])
    wrapper.unmount()
  })
})
