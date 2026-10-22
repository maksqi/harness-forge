// ElicitationCard (Phase 14, ADR-060; docs/UI.md 7.35, 10.10, 14, 15): the C54 stub's contract (props, the exposed
// focusFirst, the root test id with `data-state` and `data-server-id`) and W14.9's card: each field kind, Submit (coerced
// and checked like the server), an invalid Submit, Decline, × Dismiss, the countdown and expiry, a 400's issues, the
// 'gone' answer, the posting state, the secret warning, the caution line and the clamped message.
import type { ElicitationFieldIssue, McpElicitation, McpElicitationField } from '@harness-forge/shared'
import { elicitationInitialValues } from '@harness-forge/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { Select } from '@/components/ui/select'
import { testIds } from '~/utils/testids'
import { elicitationId, mcpElicitation } from '~/utils/testing/fixtures'
import ElicitationCard from './ElicitationCard.vue'

const NOW = Date.UTC(2026, 9, 22, 12, 0, 0)

function options(...values: string[]) {
  return values.map(value => ({ value, label: value[0]!.toUpperCase() + value.slice(1) }))
}

function field(overrides: Partial<McpElicitationField> & Pick<McpElicitationField, 'name' | 'type'>): McpElicitationField {
  return { title: null, description: null, required: false, ...overrides }
}

/** One field of each kind (docs/UI.md 7.35). */
const EVERY_KIND: McpElicitationField[] = [
  field({ name: 'email', type: 'string', title: 'Email', description: 'Where to send the report', required: true, format: 'email', maxLength: 254 }),
  field({ name: 'site', type: 'string', format: 'uri' }),
  field({ name: 'due', type: 'string', title: 'Due date', format: 'date' }),
  field({ name: 'start', type: 'string', title: 'Start', format: 'date-time', default: '2026-11-01T09:30:00Z' }),
  field({ name: 'note', type: 'string', title: 'Note', minLength: 2, maxLength: 40 }),
  field({ name: 'priority', type: 'integer', title: 'Priority', minimum: 1, maximum: 4, default: 2 }),
  field({ name: 'ratio', type: 'number', title: 'Ratio' }),
  field({ name: 'notify', type: 'boolean', title: 'Notify me', default: false }),
  field({ name: 'team', type: 'enum', title: 'Team', required: true, options: options('platform', 'web', 'mobile') }),
  field({ name: 'region', type: 'enum', title: 'Region', options: options('eu', 'us', 'asia', 'africa', 'oceania') }),
  field({ name: 'labels', type: 'multi-enum', title: 'Labels', options: options('bug', 'ux', 'auth'), minItems: 1, maxItems: 2 }),
  field({ name: 'tags', type: 'multi-enum', title: 'Tags', options: options('a1', 'b2', 'c3', 'd4', 'e5', 'f6', 'g7', 'h8', 'i9') }),
]

function request(overrides: Partial<McpElicitation> = {}): McpElicitation {
  return mcpElicitation({ expiresAt: NOW + 480_000, ...overrides })
}

function mountCard(props: { request: McpElicitation, busy?: boolean, gone?: boolean }) {
  return mount(ElicitationCard, { props, attachTo: document.body })
}

type CardWrapper = ReturnType<typeof mountCard>

function fieldOf(wrapper: CardWrapper, name: string) {
  return wrapper.get(`[data-testid="${testIds.elicitationField}"][data-name="${name}"]`)
}

function root(wrapper: CardWrapper) {
  return wrapper.get(`[data-testid="${testIds.elicitationCard}"]`)
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['setInterval', 'clearInterval', 'Date'] })
})

afterEach(() => {
  vi.useRealTimers()
  document.body.replaceChildren()
})

describe('elicitationCard: layout', () => {
  it('renders the request as a named region with its message as plain text, and never takes focus', () => {
    const wrapper = mountCard({ request: request({ message: '<b>Which</b> team?' }) })
    const card = root(wrapper)
    expect(card.attributes('role')).toBe('region')
    expect(card.attributes('data-state')).toBe('pending')
    expect(card.attributes('data-server-id')).toBe('fixture')
    expect(card.attributes('data-elicitation-id')).toBe(elicitationId(1))
    expect(card.element.querySelector('form')).not.toBeNull()
    const heading = document.getElementById(card.attributes('aria-labelledby')!)
    expect(heading?.textContent?.trim()).toBe('Fixture needs more information')
    expect(wrapper.get(`[data-testid="${testIds.elicitationMessage}"]`).text()).toBe('<b>Which</b> team?')
    expect(card.find('b').exists()).toBe(false)
    expect(card.text()).toContain('Share only what you would give Fixture. Never enter passwords here.')
    expect(document.activeElement).toBe(document.body)
    expect(typeof (wrapper.vm as unknown as { focusFirst: () => void }).focusFirst).toBe('function')
  })

  it('renders each field kind with its control, label, hint and bounds', () => {
    const wrapper = mountCard({ request: request({ form: { fields: EVERY_KIND } }) })
    expect(wrapper.findAll(`[data-testid="${testIds.elicitationField}"]`).map(item => [item.attributes('data-name'), item.attributes('data-type')])).toEqual([
      ['email', 'string'],
      ['site', 'string'],
      ['due', 'string'],
      ['start', 'string'],
      ['note', 'string'],
      ['priority', 'integer'],
      ['ratio', 'number'],
      ['notify', 'boolean'],
      ['team', 'enum'],
      ['region', 'enum'],
      ['labels', 'multi-enum'],
      ['tags', 'multi-enum'],
    ])
    const email = fieldOf(wrapper, 'email').get('input')
    expect(email.attributes()).toMatchObject({ 'type': 'email', 'maxlength': '254', 'autocomplete': 'off', 'aria-required': 'true' })
    // The label names the input; a required field adds " *" (hidden) and "required" (screen readers only).
    const emailLabel = fieldOf(wrapper, 'email').get('label')
    expect(emailLabel.attributes('for')).toBe(email.attributes('id'))
    expect(emailLabel.text().replace(/\s+/g, ' ')).toBe('Email * required')
    const help = document.getElementById(email.attributes('aria-describedby')!)
    expect(help?.textContent).toContain('Where to send the report')
    // No title: the name is the label.
    expect(fieldOf(wrapper, 'site').get('label').text()).toBe('site')
    expect(fieldOf(wrapper, 'site').get('input').attributes('type')).toBe('url')
    expect(fieldOf(wrapper, 'due').get('input').attributes('type')).toBe('date')
    // A date-time default shows as local time (`datetime-local`).
    const start = fieldOf(wrapper, 'start').get<HTMLInputElement>('input')
    expect(start.attributes('type')).toBe('datetime-local')
    expect(start.element.value).toBe(elicitationInitialValues({ fields: EVERY_KIND }).start)
    expect(fieldOf(wrapper, 'note').get('input').attributes()).toMatchObject({ type: 'text', minlength: '2', maxlength: '40' })
    const priority = fieldOf(wrapper, 'priority').get<HTMLInputElement>('input')
    expect(priority.attributes()).toMatchObject({ type: 'number', min: '1', max: '4', step: '1', inputmode: 'numeric' })
    expect(priority.element.value).toBe('2')
    expect(fieldOf(wrapper, 'priority').text()).toContain('Whole number, 1 to 4')
    expect(fieldOf(wrapper, 'ratio').get('input').attributes()).toMatchObject({ type: 'number', step: 'any', inputmode: 'decimal' })
    expect(fieldOf(wrapper, 'notify').get('[role="checkbox"]').attributes('aria-checked')).toBe('false')
    expect(fieldOf(wrapper, 'notify').text()).toContain('Notify me')
    // Four options or fewer: radios; more: a select ("Choose…").
    expect(fieldOf(wrapper, 'team').get('[role="radiogroup"]').findAll('[role="radio"]')).toHaveLength(3)
    expect(fieldOf(wrapper, 'team').find('[role="combobox"]').exists()).toBe(false)
    const region = fieldOf(wrapper, 'region')
    expect(region.find('[role="radiogroup"]').exists()).toBe(false)
    expect(region.get('[role="combobox"]').text()).toContain('Choose…')
    // A multi-select is a group of checkboxes named by its label; more than eight options scroll.
    const labels = fieldOf(wrapper, 'labels').get('[role="group"]')
    expect(document.getElementById(labels.attributes('aria-labelledby')!)?.textContent?.trim()).toBe('Labels')
    expect(labels.findAll('[role="checkbox"]')).toHaveLength(3)
    expect(fieldOf(wrapper, 'labels').text()).toContain('Choose 1 to 2')
    expect(labels.classes()).not.toContain('max-h-48')
    expect(fieldOf(wrapper, 'tags').get('[role="group"]').classes()).toContain('max-h-48')
  })

  it('clamps a long message with Show more / Show less', async () => {
    const message = Array.from({ length: 9 }, (_, index) => `Line ${index + 1}`).join('\n')
    const wrapper = mountCard({ request: request({ message }) })
    const text = wrapper.get(`[data-testid="${testIds.elicitationMessage}"]`)
    expect(text.classes()).toContain('line-clamp-6')
    expect(text.classes()).toContain('whitespace-pre-wrap')
    const toggle = wrapper.get('button[aria-expanded]')
    expect(toggle.text()).toBe('Show more')
    await toggle.trigger('click')
    expect(toggle.attributes('aria-expanded')).toBe('true')
    expect(toggle.text()).toBe('Show less')
    expect(text.classes()).not.toContain('line-clamp-6')
    // A short message has no toggle.
    const short = mountCard({ request: request({ id: elicitationId(2), message: 'Which team?' }) })
    expect(short.find('button[aria-expanded]').exists()).toBe(false)
  })

  it('warns about a field that looks like a secret', () => {
    const wrapper = mountCard({ request: request({ form: { fields: [field({ name: 'password', type: 'string', title: 'Password', required: true })] } }) })
    const warning = wrapper.get('[data-slot="elicitation-sensitive"]')
    expect(warning.text()).toBe('Fixture asks for something that looks like a secret. Answer only if you trust Fixture.')
    expect(fieldOf(wrapper, 'password').get('input').attributes('aria-describedby')).toContain(warning.attributes('id'))
    // An ordinary field has none.
    expect(mountCard({ request: request({ id: elicitationId(2) }) }).find('[data-slot="elicitation-sensitive"]').exists()).toBe(false)
  })
})

describe('elicitationCard: answers', () => {
  it('submits the coerced values (numbers as numbers, a local date-time as UTC, empty optional fields left out)', async () => {
    const wrapper = mountCard({ request: request({ form: { fields: EVERY_KIND } }) })
    await fieldOf(wrapper, 'email').get('input').setValue('  ada@example.com ')
    await fieldOf(wrapper, 'ratio').get('input').setValue('0.5')
    await fieldOf(wrapper, 'notify').get('[role="checkbox"]').trigger('click')
    await fieldOf(wrapper, 'team').findAll('[role="radio"]')[1]!.trigger('click')
    fieldOf(wrapper, 'region').getComponent(Select).vm.$emit('update:modelValue', 'asia')
    await fieldOf(wrapper, 'labels').findAll('[role="checkbox"]')[2]!.trigger('click')
    await fieldOf(wrapper, 'labels').findAll('[role="checkbox"]')[0]!.trigger('click')
    await wrapper.get('form').trigger('submit')
    const answers = wrapper.emitted('respond')!
    expect(answers).toHaveLength(1)
    const answer = answers[0]![0] as { action: string, content: Record<string, unknown> }
    expect(answer.action).toBe('accept')
    expect(answer.content).toEqual({
      email: 'ada@example.com',
      start: expect.any(String),
      priority: 2,
      ratio: 0.5,
      notify: true,
      team: 'web',
      region: 'asia',
      labels: ['bug', 'auth'],
    })
    expect(Date.parse(answer.content.start as string)).toBe(Date.UTC(2026, 10, 1, 9, 30))
    expect(wrapper.find(`[data-testid="${testIds.elicitationFieldError}"]`).exists()).toBe(false)
  })

  it('an invalid Submit shows the issues under their fields and focuses the first invalid one', async () => {
    const wrapper = mountCard({ request: request({ form: { fields: EVERY_KIND } }) })
    await fieldOf(wrapper, 'note').get('input').setValue('x')
    await wrapper.get(`[data-testid="${testIds.elicitationSubmit}"]`).trigger('click')
    await wrapper.get('form').trigger('submit')
    await nextTick()
    expect(wrapper.emitted('respond')).toBeUndefined()
    const errors = wrapper.findAll(`[data-testid="${testIds.elicitationFieldError}"]`)
    expect(errors.length).toBeGreaterThanOrEqual(3)
    const email = fieldOf(wrapper, 'email').get('input')
    const emailError = fieldOf(wrapper, 'email').get(`[data-testid="${testIds.elicitationFieldError}"]`)
    expect(email.attributes('aria-invalid')).toBe('true')
    expect(email.attributes('aria-describedby')!.split(' ')).toContain(emailError.attributes('id'))
    expect(fieldOf(wrapper, 'note').find(`[data-testid="${testIds.elicitationFieldError}"]`).exists()).toBe(true)
    expect(fieldOf(wrapper, 'team').get('[role="radiogroup"]').attributes('aria-invalid')).toBe('true')
    expect(document.activeElement).toBe(email.element)
    // Editing a field clears its issue.
    await email.setValue('ada@example.com')
    expect(fieldOf(wrapper, 'email').find(`[data-testid="${testIds.elicitationFieldError}"]`).exists()).toBe(false)
  })

  it('declines and dismisses (× sends cancel)', async () => {
    const wrapper = mountCard({ request: request() })
    await wrapper.get(`[data-testid="${testIds.elicitationDecline}"]`).trigger('click')
    const dismiss = wrapper.get(`[data-testid="${testIds.elicitationDismiss}"]`)
    expect(dismiss.attributes('aria-label')).toBe('Dismiss request')
    await dismiss.trigger('click')
    expect(wrapper.emitted('respond')).toEqual([[{ action: 'decline' }], [{ action: 'cancel' }]])
  })

  it('a 400 answer\'s issues show under their fields and take the focus (the server\'s `path` shape too)', async () => {
    const wrapper = mountCard({ request: request() })
    // W14.3's route sends `details.issues[].path` = ['content', <field>]; TOOL_ELICITATIONS passes them on as they are.
    const issues = [
      { path: ['content', 'email'], code: 'format', message: 'Enter an email address.' },
      { field: 'other', code: 'unknown-field', message: 'This field is not part of the form.' },
    ] as unknown as ElicitationFieldIssue[]
    await wrapper.setProps({ issues })
    await flushPromises()
    const email = fieldOf(wrapper, 'email').get('input')
    expect(fieldOf(wrapper, 'email').get(`[data-testid="${testIds.elicitationFieldError}"]`).text()).toBe('Enter an email address.')
    expect(email.attributes('aria-invalid')).toBe('true')
    expect(document.activeElement).toBe(email.element)
    // An issue the form cannot place shows as an alert under the fields.
    expect(wrapper.get(`[role="alert"][data-testid="${testIds.elicitationFieldError}"]`).text()).toBe('This field is not part of the form.')
  })

  it('posting: submitting, busy and every control disabled', async () => {
    const wrapper = mountCard({ request: request() })
    await wrapper.setProps({ busy: true })
    expect(root(wrapper).attributes('data-state')).toBe('submitting')
    expect(root(wrapper).attributes('aria-busy')).toBe('true')
    expect(wrapper.get(`[data-testid="${testIds.elicitationSubmit}"]`).attributes('disabled')).toBeDefined()
    expect(wrapper.get(`[data-testid="${testIds.elicitationDecline}"]`).attributes('disabled')).toBeDefined()
    expect(fieldOf(wrapper, 'email').get('input').attributes('disabled')).toBeDefined()
    await wrapper.get('form').trigger('submit')
    expect(wrapper.emitted('respond')).toBeUndefined()
  })

  it('the \'gone\' answer: "This request is no longer open." and no more answers', async () => {
    const wrapper = mountCard({ request: request() })
    fieldOf(wrapper, 'email').get<HTMLInputElement>('input').element.focus()
    await wrapper.setProps({ gone: true })
    expect(root(wrapper).text()).toContain('This request is no longer open.')
    expect(root(wrapper).attributes('data-state')).toBe('expired')
    expect(wrapper.get(`[data-testid="${testIds.elicitationSubmit}"]`).attributes('disabled')).toBeDefined()
    // Focus stays on the card's own container.
    expect(document.activeElement).toBe(root(wrapper).element)
    await wrapper.get(`[data-testid="${testIds.elicitationDecline}"]`).trigger('click')
    expect(wrapper.emitted('respond')).toBeUndefined()
  })
})

describe('elicitationCard: countdown and expiry', () => {
  it('counts down, warns in the last minute and expires at 0:00', async () => {
    const wrapper = mountCard({ request: request({ expiresAt: NOW + 61_000 }) })
    const countdown = wrapper.get(`[data-testid="${testIds.elicitationCountdown}"]`)
    expect(countdown.attributes('aria-hidden')).toBe('true')
    expect(countdown.classes()).toContain('tabular-nums')
    expect(countdown.text()).toBe('1:01 left')
    expect(countdown.classes()).not.toContain('text-warning')
    await vi.advanceTimersByTimeAsync(2000)
    expect(countdown.text()).toBe('0:59 left')
    expect(countdown.classes()).toContain('text-warning')
    fieldOf(wrapper, 'email').get<HTMLInputElement>('input').element.focus()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(countdown.text()).toBe('0:00 left')
    expect(root(wrapper).attributes('data-state')).toBe('expired')
    expect(root(wrapper).text()).toContain('This request expired.')
    expect(wrapper.get(`[data-testid="${testIds.elicitationSubmit}"]`).attributes('disabled')).toBeDefined()
    expect(wrapper.get(`[data-testid="${testIds.elicitationDismiss}"]`).attributes('disabled')).toBeDefined()
    expect(document.activeElement).toBe(root(wrapper).element)
    await wrapper.get('form').trigger('submit')
    expect(wrapper.emitted('respond')).toBeUndefined()
  })

  it('stops its timer when unmounted', () => {
    const wrapper = mountCard({ request: request() })
    expect(vi.getTimerCount()).toBe(1)
    wrapper.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('elicitationCard: focusFirst (the jump pill)', () => {
  it('focuses the first field, a radio group\'s tabbable radio, else Submit', async () => {
    const card = mountCard({ request: request() })
    ;(card.vm as unknown as { focusFirst: () => void }).focusFirst()
    expect(document.activeElement).toBe(fieldOf(card, 'email').get('input').element)
    card.unmount()

    const radios = mountCard({ request: request({ form: { fields: [EVERY_KIND[8]!] } }) })
    await flushPromises()
    ;(radios.vm as unknown as { focusFirst: () => void }).focusFirst()
    expect(document.activeElement?.getAttribute('role')).toBe('radio')
    radios.unmount()

    const empty = mountCard({ request: request({ form: { fields: [] } }) })
    ;(empty.vm as unknown as { focusFirst: () => void }).focusFirst()
    expect(document.activeElement).toBe(empty.get(`[data-testid="${testIds.elicitationSubmit}"]`).element)
  })
})
