import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { testIds } from '~/utils/testids'
import { chatId, projectId } from '~/utils/testing/fixtures'
import RememberDialog from './RememberDialog.vue'

afterEach(() => {
  document.body.replaceChildren()
})

describe('rememberDialog (P10-0b stub)', () => {
  it('renders its root with the text while open and closes', async () => {
    const wrapper = mount(RememberDialog, {
      props: { open: true, text: 'Run pnpm check first', projectId: projectId(1), chatId: chatId(1) },
      attachTo: document.body,
    })
    await flushPromises()
    const dialog = document.body.querySelector<HTMLElement>(`[data-testid="${testIds.rememberDialog}"]`)!
    expect(dialog.textContent).toContain('Remember')
    expect(dialog.textContent).toContain('Run pnpm check first')
    const cancel = [...dialog.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Cancel')!
    cancel.click()
    expect(wrapper.emitted('update:open')).toEqual([[false]])
    wrapper.unmount()
  })

  it('renders nothing while closed', async () => {
    const wrapper = mount(RememberDialog, { props: { open: false, text: '', projectId: null, chatId: null }, attachTo: document.body })
    await flushPromises()
    expect(document.body.querySelector(`[data-testid="${testIds.rememberDialog}"]`)).toBeNull()
    wrapper.unmount()
  })
})
