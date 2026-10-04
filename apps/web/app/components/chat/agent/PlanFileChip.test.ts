import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { h } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { testIds } from '~/utils/testids'
import PlanFileChip from './PlanFileChip.vue'

const panel = vi.hoisted(() => ({ setOpen: vi.fn(), view: { value: 'git' as string } }))
vi.mock('~/composables/useChangesPanel', () => ({ useChangesPanel: () => panel }))

const PATH = '.harness/plans/2026-10-04-move-auth.md'

function chip(props: { planPath: string | null, planError: string | null, projectChat: boolean }) {
  return mount({ render: () => h(TooltipProvider, null, { default: () => h(PlanFileChip, props) }) }, { attachTo: document.body })
}

beforeEach(() => {
  panel.setOpen.mockReset()
  panel.view.value = 'git'
})

afterEach(() => {
  document.body.replaceChildren()
})

describe('planFileChip', () => {
  it('shows a saved plan file: the path chip with the file name kept, Copy path and Show changes', async () => {
    const wrapper = chip({ planPath: PATH, planError: null, projectChat: true })
    const root = wrapper.get(`[data-testid="${testIds.planFile}"]`)
    expect(root.attributes()).toMatchObject({ 'data-state': 'saved', 'data-path': PATH })
    expect(root.text()).toContain('Saved to')
    const path = root.get('[data-slot="plan-file-path"]')
    expect(path.attributes('tabindex')).toBe('0')
    expect(path.get('.sr-only').text()).toBe(`Plan saved to ${PATH}`)
    const [folder, file] = path.findAll('span[aria-hidden="true"]')
    expect(folder!.text()).toBe('.harness/plans/')
    expect(folder!.classes()).toContain('truncate')
    expect(file!.text()).toBe('2026-10-04-move-auth.md')
    expect(file!.classes()).toContain('shrink-0')
    expect(root.find('button[aria-label="Copy path"]').exists()).toBe(true)

    const show = root.get('[data-slot="plan-file-show-changes"]')
    expect(show.text()).toBe('Show changes')
    await show.trigger('click')
    expect(panel.view.value).toBe('chat')
    expect(panel.setOpen).toHaveBeenCalledWith(true, { focus: true })
  })

  it('offers Show changes only in a project chat', () => {
    const wrapper = chip({ planPath: 'plan.md', planError: null, projectChat: false })
    expect(wrapper.find('[data-slot="plan-file-show-changes"]').exists()).toBe(false)
    expect(wrapper.get('[data-slot="plan-file-path"]').findAll('span[aria-hidden="true"]').map(item => item.text())).toEqual(['plan.md'])
  })

  it('shows a failed write as a warning, and nothing without either', () => {
    const failed = chip({ planPath: null, planError: 'The plan folder is a link.', projectChat: true })
    const root = failed.get(`[data-testid="${testIds.planFile}"]`)
    expect(root.attributes('data-state')).toBe('failed')
    expect(root.attributes('data-path')).toBeUndefined()
    expect(root.classes()).toContain('text-warning')
    expect(root.text()).toBe('Couldn\'t save the plan file: The plan folder is a link.')
    const none = chip({ planPath: null, planError: null, projectChat: false })
    expect(none.find(`[data-testid="${testIds.planFile}"]`).exists()).toBe(false)
  })
})
