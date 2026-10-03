// AllowRuleOption (docs/UI.md 7.3, 7.23, 10.5, 13.9; W8.10): the always-ask notes, the suggested prefix (editable when
// there is one, read-only chips when there are several), the scope toggle, the inline errors with their codes and the
// `valid` emits the card uses to disable Run.
import type { AllowRules } from './allow-rule'
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { testIds } from '~/utils/testids'
import { ALWAYS_ASK_NOTE, COMBINED_COMMANDS_HINT, NO_RULE_NOTE, SEVERAL_RULES_NOTE } from './allow-rule'
import AllowRuleOption from './AllowRuleOption.vue'

const sel = (id: string) => `[data-testid="${id}"]`

function mountOption(command: string, options: { disabled?: boolean } = {}) {
  const model = ref<AllowRules | null>(null)
  const valid: boolean[] = []
  const props = ref({ command, disabled: options.disabled ?? false })
  const wrapper = mount(defineComponent({
    setup: () => () => h(AllowRuleOption, {
      'command': props.value.command,
      'disabled': props.value.disabled,
      'modelValue': model.value,
      'onUpdate:modelValue': (value: AllowRules | null) => {
        model.value = value
      },
      'onValid': (value: boolean) => valid.push(value),
    }),
  }), { attachTo: document.body })
  return { wrapper, model, valid, props }
}

type Mounted = ReturnType<typeof mountOption>

async function check({ wrapper }: Mounted) {
  await wrapper.get(sel(testIds.toolApprovalAllowRule)).trigger('click')
}

async function type({ wrapper }: Mounted, text: string) {
  await wrapper.get(sel(testIds.toolApprovalRulePrefix)).setValue(text)
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('allowRuleOption: commands that always ask', () => {
  it('shows only a note: shell syntax the parser refuses, or a command no rule can allow', () => {
    const cases: Array<[string, string]> = [
      ['ls > out.txt', ALWAYS_ASK_NOTE],
      ['echo $(whoami)', ALWAYS_ASK_NOTE],
      ['ls *.ts', ALWAYS_ASK_NOTE],
      ['sudo rm -rf build', NO_RULE_NOTE],
      ['ls && sh -c "x"', NO_RULE_NOTE],
    ]
    for (const [command, note] of cases) {
      const { wrapper } = mountOption(command)
      expect(wrapper.get('[data-slot="allow-rule-note"]').text(), command).toBe(note)
      expect(wrapper.find(sel(testIds.toolApprovalAllowRule)).exists(), command).toBe(false)
      wrapper.unmount()
    }
  })
})

describe('allowRuleOption: one prefix', () => {
  it('stays collapsed until checked; checking reveals the editable prefix, the scope and the hint', async () => {
    const option = mountOption('pnpm test --filter parser')
    const { wrapper } = option
    const box = wrapper.get(sel(testIds.toolApprovalAllowRule))
    expect(box.attributes('data-state')).toBe('unchecked')
    expect(wrapper.text()).toContain('Always allow commands starting with')
    expect(wrapper.find(sel(testIds.toolApprovalRulePrefix)).exists()).toBe(false)
    expect(wrapper.find(sel(testIds.toolApprovalRuleScope)).exists()).toBe(false)

    await check(option)
    expect(option.model.value).toEqual({ prefixes: ['pnpm test'], scope: 'project' })
    expect(option.valid).toEqual([true])
    const input = wrapper.get<HTMLInputElement>(sel(testIds.toolApprovalRulePrefix))
    expect(input.element.tagName).toBe('INPUT')
    expect([input.element.value, input.attributes('data-value')]).toEqual(['pnpm test', 'pnpm test'])
    // The checkbox label names the input too.
    const label = wrapper.get('label')
    expect(input.attributes('aria-labelledby')).toBe(label.attributes('id'))
    expect(input.attributes('aria-invalid')).toBeUndefined()
    const scope = wrapper.get(sel(testIds.toolApprovalRuleScope))
    expect(scope.attributes('data-value')).toBe('project')
    expect(scope.findAll('button').map(item => [item.text(), item.attributes('data-state')]))
      .toEqual([['This project', 'on'], ['All projects', 'off']])
    expect(wrapper.text()).toContain(COMBINED_COMMANDS_HINT)
    expect(wrapper.text()).not.toContain(SEVERAL_RULES_NOTE)
    expect(wrapper.find(sel(testIds.toolApprovalRuleError)).exists()).toBe(false)
  })

  it('keeps the edited prefix in canonical form while it still covers the command', async () => {
    const option = mountOption('pnpm test --filter parser')
    await check(option)
    await type(option, 'pnpm   test   --filter')
    expect(option.model.value).toEqual({ prefixes: ['pnpm test --filter'], scope: 'project' })
    await type(option, 'pnpm')
    expect(option.model.value).toEqual({ prefixes: ['pnpm'], scope: 'project' })
    expect(option.valid).toEqual([true, true, true])
    expect(option.wrapper.find(sel(testIds.toolApprovalRuleError)).exists()).toBe(false)
  })

  it('shows inline errors with their code, linked to the input, and reports invalid', async () => {
    const option = mountOption('pnpm test --filter parser')
    const { wrapper } = option
    await check(option)
    const cases: Array<[string, string, string]> = [
      ['npm test', 'no-match', 'This doesn\'t match the command.'],
      ['', 'empty', 'Enter the start of a command.'],
      ['pnpm test | cat', 'syntax', 'Use a plain command without |, ;, &&, redirections or substitutions.'],
      ['bash', 'command-runner', 'bash runs other commands, so it can\'t be allowed by a rule.'],
      ['export', 'shell-builtin', 'export changes the shell or runs its arguments, so it can\'t be allowed by a rule.'],
      ['node', 'interpreter', 'A rule for node alone would allow any code. Add what follows it, such as a script name.'],
      ['cd', 'cd', 'cd needs no rule: changing into a project folder is always allowed.'],
    ]
    for (const [prefix, code, message] of cases) {
      await type(option, prefix)
      const error = wrapper.get(sel(testIds.toolApprovalRuleError))
      expect([error.attributes('data-code'), error.text()], prefix).toEqual([code, message])
      const input = wrapper.get(sel(testIds.toolApprovalRulePrefix))
      expect(input.attributes('aria-describedby')).toBe(error.attributes('id'))
      expect(input.attributes('aria-invalid')).toBe('true')
      expect(option.valid.at(-1), prefix).toBe(false)
    }
    await type(option, 'pnpm test')
    expect(wrapper.find(sel(testIds.toolApprovalRuleError)).exists()).toBe(false)
    expect(option.valid.at(-1)).toBe(true)
    expect(option.model.value).toEqual({ prefixes: ['pnpm test'], scope: 'project' })
  })

  it('switches the scope to All projects and keeps it when the active item is clicked again', async () => {
    const option = mountOption('ls -la')
    await check(option)
    const scope = () => option.wrapper.get(sel(testIds.toolApprovalRuleScope))
    await scope().get('button[data-value="global"]').trigger('click')
    expect(option.model.value).toEqual({ prefixes: ['ls'], scope: 'global' })
    expect(scope().attributes('data-value')).toBe('global')
    await scope().get('button[data-value="global"]').trigger('click')
    expect(option.model.value).toEqual({ prefixes: ['ls'], scope: 'global' })
    await scope().get('button[data-value="project"]').trigger('click')
    expect(option.model.value?.scope).toBe('project')
    // Scope changes never touch validity.
    expect(option.valid).toEqual([true])
  })

  it('needs no rule for cd parts: one editable prefix for the rest', async () => {
    const option = mountOption('cd packages/web && pnpm test')
    await check(option)
    expect(option.model.value).toEqual({ prefixes: ['pnpm test'], scope: 'project' })
    expect(option.wrapper.get<HTMLInputElement>(sel(testIds.toolApprovalRulePrefix)).element.value).toBe('pnpm test')
  })

  it('goes back to null (valid) when unchecked, and remembers the edited prefix', async () => {
    const option = mountOption('pnpm test --filter parser')
    await check(option)
    await type(option, 'npm')
    expect(option.valid.at(-1)).toBe(false)
    await check(option)
    expect(option.model.value).toBeNull()
    expect(option.valid.at(-1)).toBe(true)
    expect(option.wrapper.find(sel(testIds.toolApprovalRulePrefix)).exists()).toBe(false)
    await check(option)
    expect(option.wrapper.get<HTMLInputElement>(sel(testIds.toolApprovalRulePrefix)).element.value).toBe('npm')
    expect(option.valid.at(-1)).toBe(false)
  })
})

describe('allowRuleOption: several prefixes', () => {
  it('shows read-only chips, one rule each, with the several-parts note', async () => {
    const option = mountOption('pnpm test && git status')
    await check(option)
    const chips = option.wrapper.findAll(sel(testIds.toolApprovalRulePrefix))
    expect(chips.map(chip => [chip.element.tagName, chip.text(), chip.attributes('data-value')]))
      .toEqual([['LI', 'pnpm test', 'pnpm test'], ['LI', 'git status', 'git status']])
    expect(option.wrapper.find('input').exists()).toBe(false)
    expect(option.wrapper.text()).toContain(SEVERAL_RULES_NOTE)
    expect(option.wrapper.text()).toContain(COMBINED_COMMANDS_HINT)
    expect(option.model.value).toEqual({ prefixes: ['pnpm test', 'git status'], scope: 'project' })
    expect(option.valid).toEqual([true])
  })

  it('deduplicates repeated parts', async () => {
    const option = mountOption('pnpm test; pnpm test --watch=false; git status')
    await check(option)
    expect(option.model.value?.prefixes).toEqual(['pnpm test', 'git status'])
  })
})

describe('allowRuleOption: disabled and a new command', () => {
  it('disables every control while the card is answering', async () => {
    const option = mountOption('pnpm test', { disabled: false })
    await check(option)
    option.props.value = { command: 'pnpm test', disabled: true }
    await option.wrapper.vm.$nextTick()
    expect(option.wrapper.get(sel(testIds.toolApprovalAllowRule)).attributes('disabled')).toBeDefined()
    expect(option.wrapper.get(sel(testIds.toolApprovalRulePrefix)).attributes('disabled')).toBeDefined()
    expect(option.wrapper.get(sel(testIds.toolApprovalRuleScope)).findAll('button').every(item => item.attributes('disabled') !== undefined)).toBe(true)
  })

  it('starts again from the suggestion of a new command', async () => {
    const option = mountOption('pnpm test')
    await check(option)
    await type(option, 'npm')
    option.props.value = { command: 'git status --short', disabled: false }
    await option.wrapper.vm.$nextTick()
    expect(option.wrapper.get<HTMLInputElement>(sel(testIds.toolApprovalRulePrefix)).element.value).toBe('git status')
    expect(option.model.value).toEqual({ prefixes: ['git status'], scope: 'project' })
    expect(option.valid.at(-1)).toBe(true)
    // A command that always asks unchecks the box.
    option.props.value = { command: 'git status > x', disabled: false }
    await option.wrapper.vm.$nextTick()
    expect(option.model.value).toBeNull()
    expect(option.wrapper.get('[data-slot="allow-rule-note"]').text()).toBe(ALWAYS_ASK_NOTE)
  })
})
