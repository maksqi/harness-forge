import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { h, nextTick } from 'vue'
import ConfirmDialog from './ConfirmDialog.vue'

function body() {
  return document.body
}

describe('confirmDialog', () => {
  afterEach(() => {
    body().replaceChildren()
  })

  it('shows title, description and slot content; confirm emits and forwards attributes to the button', async () => {
    const wrapper = mount(ConfirmDialog, {
      props: { 'open': true, 'title': 'Uninstall Dice tool?', 'description': 'Its tools are removed.', 'confirmLabel': 'Uninstall', 'data-testid': 'plugin-uninstall-confirm' },
      slots: { default: () => h('label', { 'data-testid': 'plugin-uninstall-keep-data' }, 'Keep settings and stored data') },
      attachTo: body(),
    })
    await nextTick()
    expect(body().textContent).toContain('Uninstall Dice tool?')
    expect(body().textContent).toContain('Its tools are removed.')
    expect(body().querySelector('[data-testid="plugin-uninstall-keep-data"]')).not.toBeNull()
    const confirm = body().querySelector<HTMLButtonElement>('[data-testid="plugin-uninstall-confirm"]')
    expect(confirm?.textContent?.trim()).toBe('Uninstall')
    confirm!.click()
    expect(wrapper.emitted('confirm')).toHaveLength(1)
    wrapper.unmount()
  })

  it('is described by its description, through an id that exists', async () => {
    const wrapper = mount(ConfirmDialog, {
      props: { open: true, title: 'Delete chat?', description: 'This cannot be undone.' },
      attachTo: body(),
    })
    await nextTick()
    const dialog = body().querySelector('[role="alertdialog"]')!
    const describedBy = dialog.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    expect(document.getElementById(describedBy!)?.textContent?.trim()).toBe('This cannot be undone.')
    wrapper.unmount()
  })

  it('has no aria-describedby (and no reka warning) without a description', async () => {
    const warn = vi.spyOn(console, 'warn')
    const wrapper = mount(ConfirmDialog, {
      props: { open: true, title: 'Delete?' },
      attachTo: body(),
    })
    await nextTick()
    const dialog = body().querySelector('[role="alertdialog"]')!
    expect(dialog.hasAttribute('aria-describedby')).toBe(false)
    expect(warn.mock.calls.flat().join('\n')).not.toContain('Missing `Description`')
    warn.mockRestore()
    wrapper.unmount()
  })

  it('cannot be dismissed while pending', async () => {
    const wrapper = mount(ConfirmDialog, {
      props: { open: true, title: 'Delete?', pending: true },
      attachTo: body(),
    })
    await nextTick()
    const cancel = Array.from(body().querySelectorAll('button')).find(button => button.textContent?.trim() === 'Cancel')
    expect(cancel?.disabled).toBe(true)
    body().querySelector('[role="alertdialog"]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await nextTick()
    expect(wrapper.emitted('update:open')).toBeUndefined()
    wrapper.unmount()
  })
})
