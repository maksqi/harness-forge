// SubmittedPlaceholder (docs/UI.md 7.6, 7.24, 7.31, 7.34): "Thinking…", "Compacting conversation…", "Running hooks…" and
// (Phase 12, W12.17) the running hook's status message from the HOOK_ACTIVITY injection.
import type { HookEvent } from '@harness-forge/shared'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { testIds } from '~/utils/testids'
import { HOOK_ACTIVITY } from './chat-context'
import SubmittedPlaceholder from './SubmittedPlaceholder.vue'

type Activity = { event: HookEvent, toolCallId: string | null, label?: string | null } | null

function render(activity: 'compacting' | 'hooks' | null, hookActivity?: Activity) {
  const current = ref<Activity>(hookActivity ?? null)
  const live = ref(activity)
  const provide = hookActivity === undefined ? {} : { [HOOK_ACTIVITY as symbol]: current }
  const wrapper = mount(defineComponent({
    setup: () => () => h(SubmittedPlaceholder, { activity: live.value }),
  }), { global: { provide } })
  return { wrapper, current, live, line: () => wrapper.get(`[data-testid="${testIds.submittedPlaceholder}"]`) }
}

describe('submittedPlaceholder', () => {
  it('reads "Thinking…", "Compacting conversation…" and "Running hooks…" by activity, hidden from screen readers', () => {
    expect(render(null).line().text()).toBe('Thinking…')
    expect(render('compacting').line().text()).toBe('Compacting conversation…')
    const hooks = render('hooks')
    expect(hooks.line().text()).toBe('Running hooks…')
    expect(hooks.line().attributes('aria-hidden')).toBe('true')
    expect(hooks.line().get('[data-slot="running-hook"]').text()).toBe('Running hooks…')
    expect(render(null).line().find('[data-slot="running-hook"]').exists()).toBe(false)
  })

  it('shows the running hook\'s status message instead of "Running hooks…" (W12.17), and follows it', async () => {
    const { current, line } = render('hooks', { event: 'UserPromptSubmit', toolCallId: null, label: '  Checking the prompt…  ' })
    expect(line().get('[data-slot="running-hook"]').text()).toBe('Checking the prompt…')
    current.value = { event: 'Stop', toolCallId: null, label: 'Running the test suite…' }
    await nextTick()
    expect(line().get('[data-slot="running-hook"]').text()).toBe('Running the test suite…')
    // No label, a blank one or one the injection's older shape leaves out: "Running hooks…".
    current.value = { event: 'Stop', toolCallId: null, label: null }
    await nextTick()
    expect(line().text()).toBe('Running hooks…')
    current.value = { event: 'Stop', toolCallId: null, label: '   ' }
    await nextTick()
    expect(line().text()).toBe('Running hooks…')
    current.value = { event: 'Stop', toolCallId: null }
    await nextTick()
    expect(line().text()).toBe('Running hooks…')
  })

  it('uses the label only for the hooks activity', async () => {
    const { live, line } = render('compacting', { event: 'PreCompact', toolCallId: null, label: 'Saving the transcript…' })
    expect(line().text()).toBe('Compacting conversation…')
    live.value = null
    await nextTick()
    expect(line().text()).toBe('Thinking…')
    live.value = 'hooks'
    await nextTick()
    expect(line().text()).toBe('Saving the transcript…')
  })
})
