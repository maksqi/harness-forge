import type { ToolPartLike } from '../chat-format'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useUiStore } from '~/stores/ui'
import { testIds } from '~/utils/testids'
import { planApprovalPart } from '~/utils/testing/fixtures'
import PlanApprovalCard from './PlanApprovalCard.vue'

vi.mock('~/composables/useApi', () => ({ useApi: () => ({}), useApiFetch: () => vi.fn() }))
vi.mock('~/components/chat/nuxt-imports', () => ({ useColorMode: () => ({ value: 'dark' }) }))

const PLAN = '## Move auth to server sessions\n1. Add createSession() in src/auth/session.ts'

function mountCard(props: { disabled?: boolean, source?: string | null } = {}) {
  return mount(PlanApprovalCard, {
    props: { part: planApprovalPart(PLAN) as ToolPartLike, source: 'core-agent', ...props },
    attachTo: document.body,
  })
}

function byId(wrapper: ReturnType<typeof mountCard>, id: string) {
  return wrapper.get(`[data-testid="${id}"]`)
}

const BUTTONS = [testIds.planKeepPlanning, testIds.planApproveAsk, testIds.planApproveEdits]

beforeEach(() => {
  setActivePinia(createPinia())
})

afterEach(() => {
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

describe('planApprovalCard', () => {
  it('is a group named "Plan ready for review" with the plan in a focusable region and three buttons', () => {
    const wrapper = mountCard()
    const root = byId(wrapper, testIds.planApproval)
    expect(root.attributes()).toMatchObject({ 'data-state': 'pending', 'role': 'group', 'aria-label': 'Plan ready for review' })
    expect(root.classes()).toEqual(expect.arrayContaining(['border-info/50', 'bg-info/5']))
    expect(root.text()).toContain('from core-agent')
    const region = byId(wrapper, testIds.planApprovalPlan)
    expect(region.attributes()).toMatchObject({ 'role': 'region', 'aria-label': 'Plan', 'tabindex': '0' })
    expect(region.classes()).toContain('max-h-[45dvh]')
    expect(region.text()).toContain('Add createSession() in src/auth/session.ts')
    expect(byId(wrapper, testIds.planFeedback).attributes()).toMatchObject({ 'aria-label': 'Feedback for the agent (optional)', 'rows': '1' })
    expect(BUTTONS.map(id => byId(wrapper, id).text())).toEqual(['Keep planning', 'Approve, ask before edits', 'Approve, accept edits'])
    expect(byId(wrapper, testIds.planApproveEdits).attributes('data-variant')).toBeUndefined()
    expect(byId(wrapper, testIds.planKeepPlanning).attributes('data-variant')).toBe('outline')
    expect(byId(wrapper, testIds.planApproveAsk).attributes('data-variant')).toBe('outline')
    // The card does not take focus when it appears.
    expect(root.element.contains(document.activeElement)).toBe(false)
  })

  it('stacks the actions full width on phones, the primary one on top, 40px on touch', () => {
    const wrapper = mountCard()
    const actions = byId(wrapper, testIds.planApproveEdits).element.parentElement!
    expect(actions.className).toContain('flex-col-reverse')
    expect(actions.className).toContain('sm:flex-row')
    for (const id of BUTTONS)
      expect(byId(wrapper, id).classes()).toEqual(expect.arrayContaining(['w-full', 'sm:w-auto', 'pointer-coarse:h-10', 'max-sm:h-10']))
  })

  it.each([
    [testIds.planKeepPlanning, { approved: false }],
    [testIds.planApproveAsk, { approved: true, mode: 'ask' }],
    [testIds.planApproveEdits, { approved: true, mode: 'edits' }],
  ])('emits the decision of %s', async (id, decision) => {
    const wrapper = mountCard()
    await byId(wrapper, id).trigger('click')
    expect(wrapper.emitted('decide')).toEqual([[decision]])
  })

  it('sends the trimmed feedback with whichever button is pressed', async () => {
    const keep = mountCard()
    await byId(keep, testIds.planFeedback).setValue('  Split step 2  ')
    await byId(keep, testIds.planKeepPlanning).trigger('click')
    expect(keep.emitted('decide')).toEqual([[{ approved: false, feedback: 'Split step 2' }]])
    keep.unmount()

    const edits = mountCard()
    await byId(edits, testIds.planFeedback).setValue('Keep the tests')
    await byId(edits, testIds.planApproveEdits).trigger('click')
    expect(edits.emitted('decide')).toEqual([[{ approved: true, mode: 'edits', feedback: 'Keep the tests' }]])
    edits.unmount()

    const blank = mountCard()
    await byId(blank, testIds.planFeedback).setValue('   ')
    await byId(blank, testIds.planApproveAsk).trigger('click')
    expect(blank.emitted('decide')).toEqual([[{ approved: true, mode: 'ask' }]])
  })

  it('caps the feedback at 2,000 characters: a longer text shows the error and disables the buttons', async () => {
    const wrapper = mountCard()
    const field = byId(wrapper, testIds.planFeedback)
    await field.setValue('x'.repeat(2000))
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(BUTTONS.every(id => byId(wrapper, id).attributes('disabled') === undefined)).toBe(true)
    await field.setValue('x'.repeat(2001))
    const error = wrapper.get('[role="alert"]')
    expect(error.text()).toBe('Use at most 2,000 characters.')
    expect(field.attributes()).toMatchObject({ 'aria-invalid': 'true', 'aria-describedby': error.attributes('id') })
    for (const id of BUTTONS)
      expect(byId(wrapper, id).attributes('disabled')).toBeDefined()
    await byId(wrapper, testIds.planApproveEdits).trigger('click')
    expect(wrapper.emitted('decide')).toBeUndefined()
  })

  it('never approves on Enter in the feedback field', async () => {
    const wrapper = mountCard()
    const field = byId(wrapper, testIds.planFeedback)
    await field.setValue('Looks good')
    await field.trigger('keydown', { key: 'Enter' })
    await field.trigger('keydown', { key: 'Enter', ctrlKey: true })
    await field.trigger('keydown', { key: 'Enter', metaKey: true })
    expect(wrapper.emitted('decide')).toBeUndefined()
  })

  it('disables every control while the decision is sent', async () => {
    const sending = mountCard({ disabled: true })
    expect(byId(sending, testIds.planApproval).attributes('data-state')).toBe('sending')
    for (const id of [...BUTTONS, testIds.planFeedback])
      expect(byId(sending, id).attributes('disabled')).toBeDefined()
    await byId(sending, testIds.planApproveEdits).trigger('click')
    expect(sending.emitted('decide')).toBeUndefined()
    sending.unmount()

    const once = mountCard()
    await byId(once, testIds.planApproveAsk).trigger('click')
    expect(byId(once, testIds.planApproval).attributes('data-state')).toBe('sending')
    expect(byId(once, testIds.planFeedback).attributes('disabled')).toBeDefined()
    await byId(once, testIds.planApproveEdits).trigger('click')
    expect(once.emitted('decide')).toHaveLength(1)
  })

  it('hands focus back to the composer after a decision, except on touch screens', async () => {
    const ui = useUiStore()
    const desktop = mountCard()
    await byId(desktop, testIds.planApproveEdits).trigger('click')
    expect(ui.composerFocusRequest).toBe(1)
    desktop.unmount()

    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(pointer: coarse)', media: query }))
    const touch = mountCard()
    await byId(touch, testIds.planKeepPlanning).trigger('click')
    expect(ui.composerFocusRequest).toBe(1)
  })
})
