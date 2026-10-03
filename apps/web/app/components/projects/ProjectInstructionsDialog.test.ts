// ProjectInstructionsDialog skeleton (docs/UI.md 9.10, 10.4; C15, P7-0b): the dialog content carries the root test id
// and names the project. W7.9 adds the textarea and Save.
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { testIds } from '~/utils/testids'
import { projectSummary } from '~/utils/testing/fixtures'
import ProjectInstructionsDialog from './ProjectInstructionsDialog.vue'

afterEach(() => {
  document.body.replaceChildren()
})

describe('projectInstructionsDialog', () => {
  it('renders its content titled with the project name while open', async () => {
    const project = projectSummary({ name: 'Website' })
    const wrapper = mount(ProjectInstructionsDialog, { props: { open: true, project }, attachTo: document.body })
    await flushPromises()
    const content = document.body.querySelector<HTMLElement>(`[data-testid="${testIds.projectInstructionsDialog}"]`)
    expect(content?.getAttribute('role')).toBe('dialog')
    expect(content?.textContent).toContain('Instructions for Website')
    expect(wrapper.props()).toEqual({ open: true, project })

    await wrapper.setProps({ open: false, project: null })
    await flushPromises()
    expect(document.body.querySelector(`[data-testid="${testIds.projectInstructionsDialog}"]`)).toBeNull()
    wrapper.unmount()
  })
})
