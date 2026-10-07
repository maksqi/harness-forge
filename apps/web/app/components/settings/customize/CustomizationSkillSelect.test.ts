// CustomizationSkillSelect (Phase 12, ADR-058; docs/UI.md 9.14; W12.11-T3): the agent's Skills picker: the trigger
// with its count, the searchable options, the limit of 5, the chips with an unknown name as a warning and removal.
import type { VueWrapper } from '@vue/test-utils'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import CustomizationSkillSelect from './CustomizationSkillSelect.vue'

let wrapper: VueWrapper | null = null

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.replaceChildren()
})

const OPTIONS = ['docs', 'lint', 'pdf', 'release', 'review', 'triage'].map(name => ({ name, description: `The ${name} skill` }))

function mountSelect(initial: string[]) {
  const value = ref<string[]>(initial)
  const Host = defineComponent({
    setup: () => () => h(TooltipProvider, null, {
      default: () => h(CustomizationSkillSelect, {
        'modelValue': value.value,
        'options': OPTIONS,
        'label': 'Skills',
        'data-testid': 'skills',
        'onUpdate:modelValue': (next: string[]) => {
          value.value = next
        },
      }),
    }),
  })
  wrapper = mount(Host, { attachTo: document.body })
  return value
}

function trigger(): HTMLElement {
  return document.body.querySelector<HTMLElement>('[data-testid="skills"]')!
}

function option(name: string): HTMLElement {
  return document.body.querySelector<HTMLElement>(`[data-slot="customization-skill-option"][data-skill-name="${name}"]`)!
}

describe('customizationSkillSelect', () => {
  it('chooses skills from the list with the count on the trigger', async () => {
    const value = mountSelect([])
    expect(trigger().dataset.count).toBe('0')
    expect(trigger().textContent).toContain('Choose skills…')
    expect(trigger().getAttribute('aria-label')).toBe('Skills, 0 skills chosen')
    trigger().click()
    await flushPromises()
    expect(option('pdf').textContent).toContain('The pdf skill')
    option('pdf').click()
    await flushPromises()
    expect(value.value).toEqual(['pdf'])
    expect(trigger().dataset.count).toBe('1')
    expect(trigger().textContent).toContain('1 skill chosen')
    expect(option('pdf').dataset.state).toBe('checked')
  })

  it('stops at five skills and keeps an unknown name as a warning chip that can be removed', async () => {
    const value = mountSelect(['docs', 'lint', 'pdf', 'release', 'gone'])
    trigger().click()
    await flushPromises()
    expect(option('triage').getAttribute('data-disabled')).not.toBeNull()
    expect(option('docs').getAttribute('data-disabled')).toBeNull()
    const gone = document.body.querySelector<HTMLElement>('[data-slot="customization-skill-chip"][data-skill-name="gone"]')!
    expect(gone.dataset.state).toBe('unknown')
    expect(gone.textContent).toContain('not available now')
    gone.querySelector<HTMLButtonElement>('button[aria-label="Remove gone"]')!.click()
    await flushPromises()
    expect(value.value).toEqual(['docs', 'lint', 'pdf', 'release'])
  })
})
