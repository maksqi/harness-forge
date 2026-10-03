// The shell rule stubs (docs/UI.md 7.23, 9.10, 10.5, 13.9; C20, P8-0b): AllowRuleOption, AllowlistEditor,
// AllowlistDialog and GlobalAllowlistSection accept their frozen props and render their root test ids (or data-slot).
// W8.10 / W8.11 implement them behind these contracts (the editor's behavior: AllowlistEditor.test.ts).
import type { AllowRules } from './allow-rule'
import type { MockApi } from '~/utils/testing/mock-api'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { useShellRulesStore } from '~/stores/shell-rules'
import { testIds } from '~/utils/testids'
import { projectId, projectSummary, shellRule, shellRuleId } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { ALWAYS_ASK_NOTE } from './allow-rule'
import AllowlistDialog from './AllowlistDialog.vue'
import AllowlistEditor from './AllowlistEditor.vue'
import AllowRuleOption from './AllowRuleOption.vue'
import GlobalAllowlistSection from './GlobalAllowlistSection.vue'

const mock = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))

let pinia: ReturnType<typeof createPinia>
let api: MockApi

beforeEach(() => {
  api = createMockApi()
  mock.api = api
  pinia = createPinia()
  setActivePinia(pinia)
})

afterEach(() => {
  disposePinia(pinia)
  document.body.replaceChildren()
})

describe('allowRuleOption (stub)', () => {
  it('shows only the always-ask note for a command the parser refuses', () => {
    const wrapper = mount(AllowRuleOption, { props: { command: 'ls > out.txt' } })
    expect(wrapper.get('[data-slot="allow-rule-note"]').text()).toBe(ALWAYS_ASK_NOTE)
    expect(wrapper.find(`[data-testid="${testIds.toolApprovalAllowRule}"]`).exists()).toBe(false)
  })

  it('checks into the suggested prefixes with the scope This project (v-model), and back to null', async () => {
    const model = ref<AllowRules | null>(null)
    const valid: boolean[] = []
    const wrapper = mount(defineComponent({
      setup: () => () => h(AllowRuleOption, {
        'command': 'pnpm test --filter parser',
        'modelValue': model.value,
        'onUpdate:modelValue': (value: AllowRules | null) => {
          model.value = value
        },
        'onValid': (value: boolean) => valid.push(value),
      }),
    }), { attachTo: document.body })
    const checkbox = wrapper.get(`[data-testid="${testIds.toolApprovalAllowRule}"]`)
    expect(checkbox.attributes('data-state')).toBe('unchecked')
    await checkbox.trigger('click')
    expect(model.value).toEqual({ prefixes: ['pnpm test'], scope: 'project' })
    expect(wrapper.get(`[data-testid="${testIds.toolApprovalAllowRule}"]`).attributes('data-state')).toBe('checked')
    await wrapper.get(`[data-testid="${testIds.toolApprovalAllowRule}"]`).trigger('click')
    expect(model.value).toBeNull()
    expect(valid).toEqual([true, true])
  })
})

describe('allowlistEditor (contract)', () => {
  it('loads the rules it never had, then shows "No allowed commands yet." without rules', async () => {
    api.shellRules.list.mockResolvedValue({ items: [] })
    const wrapper = mount(AllowlistEditor, { props: { projectId: projectId(1) } })
    await flushPromises()
    expect(api.shellRules.list).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-slot="allowlist-editor"]').get(`[data-testid="${testIds.allowlistEmpty}"]`).text()).toBe('No allowed commands yet.')
  })

  it('lists the rules of its scope with their id and prefix', () => {
    const store = useShellRulesStore()
    store.loaded = true
    store.items = [
      shellRule({ id: shellRuleId(1), prefix: 'pnpm test' }),
      shellRule({ id: shellRuleId(2), projectId: null, prefix: 'ls' }),
    ]
    const project = mount(AllowlistEditor, { props: { projectId: projectId(1) } })
    expect(project.findAll(`[data-testid="${testIds.allowlistRule}"]`).map(rule => [rule.attributes('data-rule-id'), rule.attributes('data-value')]))
      .toEqual([[shellRuleId(1), 'pnpm test']])
    const global = mount(AllowlistEditor, { props: { projectId: null } })
    expect(global.findAll(`[data-testid="${testIds.allowlistRule}"]`).map(rule => rule.attributes('data-value'))).toEqual(['ls'])
  })
})

describe('allowlistDialog (contract)', () => {
  it('opens for a project with its title and the editor of that project', async () => {
    api.shellRules.list.mockResolvedValue({ items: [] })
    const wrapper = mount(AllowlistDialog, { props: { open: true, project: projectSummary({ id: projectId(1), name: 'website' }) }, attachTo: document.body })
    await flushPromises()
    const dialog = document.body.querySelector<HTMLElement>(`[data-testid="${testIds.allowlistDialog}"]`)!
    expect(dialog.textContent).toContain('Allowed commands in website')
    expect(wrapper.findComponent(AllowlistEditor).props('projectId')).toBe(projectId(1))
  })

  it('stays closed without a project', async () => {
    mount(AllowlistDialog, { props: { open: true, project: null }, attachTo: document.body })
    await flushPromises()
    expect(document.body.querySelector(`[data-testid="${testIds.allowlistDialog}"]`)).toBeNull()
  })
})

describe('globalAllowlistSection (contract)', () => {
  it('renders the section "Allowed in every project" with the global editor', () => {
    api.shellRules.list.mockResolvedValue({ items: [] })
    const wrapper = mount(GlobalAllowlistSection)
    const section = wrapper.get(`[data-testid="${testIds.allowlistSection}"]`)
    expect(section.text()).toContain('Allowed in every project')
    expect(wrapper.getComponent(AllowlistEditor).props('projectId')).toBeNull()
  })
})
