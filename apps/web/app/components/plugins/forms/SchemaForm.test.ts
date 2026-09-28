import type { SettingsSchema } from '@harness-forge/shared'
import type { VueWrapper } from '@vue/test-utils'
import type { SettingsValues } from './schema-form'
import { settingsSchemaSchema } from '@harness-forge/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { SelectRoot } from 'reka-ui'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { testIds } from '~/utils/testids'
import { settingsPatch } from './schema-form'
import SchemaForm from './SchemaForm.vue'

const schema: SettingsSchema = settingsSchemaSchema.parse({
  type: 'object',
  required: ['name', 'token', 'mode'],
  properties: {
    name: { type: 'string', title: 'Name', description: 'Lowercase letters only.', pattern: '^[a-z]+$' },
    token: { type: 'string', title: 'API token', format: 'secret' },
    optionalToken: { type: 'string', title: 'Optional token', format: 'secret' },
    endpoint: { type: 'string', title: 'Endpoint', format: 'url' },
    notes: { type: 'string', title: 'Notes', format: 'multiline' },
    mode: { type: 'string', title: 'Mode', enum: ['fast', 'slow'], default: 'fast' },
    region: { type: 'string', title: 'Region', enum: ['eu', 'us'] },
    count: { type: 'integer', title: 'Count', minimum: 1, maximum: 10, default: 3 },
    ratio: { type: 'number', title: 'Ratio', minimum: 0, maximum: 1 },
    verbose: { type: 'boolean', title: 'Verbose', default: false },
    colors: { type: 'array', title: 'Colors', items: { type: 'string', enum: ['red', 'green', 'blue'] }, default: ['red'] },
    tags: { type: 'array', title: 'Tags', items: { type: 'string' } },
  },
})

/** What the server returns for this schema with a stored token (defaults applied, secrets never included). */
const loaded: SettingsValues = { name: 'abc', mode: 'fast', count: 3, verbose: false, colors: ['red'] }

let wrapper: VueWrapper | null = null

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.replaceChildren()
})

interface Exposed { validate: () => Promise<boolean>, reset: () => void }

async function mountForm(options: { values?: SettingsValues, secretsSet?: string[], secretHints?: Record<string, string | null> } = {}) {
  const model = ref<SettingsValues>(structuredClone(options.values ?? loaded))
  const onSubmit = vi.fn()
  const form = ref<Exposed | null>(null)
  wrapper = mount(defineComponent({
    setup() {
      return () => h(SchemaForm, {
        'ref': form,
        schema,
        'modelValue': model.value,
        'onUpdate:modelValue': (value: SettingsValues) => {
          model.value = value
        },
        'secretsSet': options.secretsSet ?? ['token'],
        'secretHints': options.secretHints ?? { token: 'sk-…9fQ2' },
        onSubmit,
      })
    },
  }), { attachTo: document.body })
  await flushPromises()
  return { model, onSubmit, form }
}

function field(key: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-testid="${testIds.schemaField}"][data-value="${key}"]`)
  expect(element, key).not.toBeNull()
  return element!
}

function control<T extends HTMLElement = HTMLInputElement>(key: string, selector = 'input'): T {
  const element = field(key).querySelector<T>(selector)
  expect(element, `${key} ${selector}`).not.toBeNull()
  return element!
}

async function type(key: string, value: string, selector = 'input') {
  const input = control<HTMLInputElement | HTMLTextAreaElement>(key, selector)
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await flushPromises()
}

async function leave(key: string, selector = 'input') {
  control(key, selector).dispatchEvent(new Event('blur'))
  await flushPromises()
}

function errorOf(key: string): string | null {
  return field(key).querySelector('[role="alert"]')?.textContent?.trim() ?? null
}

function button(testId: string): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!
}

async function submit() {
  document.querySelector<HTMLFormElement>(`[data-testid="${testIds.schemaForm}"]`)!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await flushPromises()
  await nextTick()
}

function buttonByText(root: HTMLElement, text: string): HTMLButtonElement {
  const found = Array.from(root.querySelectorAll('button')).find(item => item.textContent?.trim() === text)
  expect(found, text).toBeDefined()
  return found!
}

describe('schemaForm: rendering', () => {
  it('renders every property in key order with its control, label, required marker and help text', async () => {
    await mountForm()
    const fields = Array.from(document.querySelectorAll<HTMLElement>(`[data-testid="${testIds.schemaField}"]`))
    expect(fields.map(item => [item.dataset.value, item.dataset.kind])).toEqual([
      ['name', 'text'],
      ['token', 'secret'],
      ['optionalToken', 'secret'],
      ['endpoint', 'url'],
      ['notes', 'multiline'],
      ['mode', 'select'],
      ['region', 'select'],
      ['count', 'integer'],
      ['ratio', 'number'],
      ['verbose', 'boolean'],
      ['colors', 'checkboxes'],
      ['tags', 'tags'],
    ])
    expect(field('name').textContent).toContain('Lowercase letters only.')
    expect(field('name').querySelector('.sr-only')?.textContent).toBe('(required)')
    expect(field('endpoint').querySelector('.sr-only')).toBeNull()
    expect(control('name').value).toBe('abc')
    expect(control('endpoint').type).toBe('url')
    expect(control('notes', 'textarea')).toBeTruthy()
    const count = control('count')
    expect([count.type, count.value, count.min, count.max, count.step]).toEqual(['number', '3', '1', '10', '1'])
    expect(control('ratio').step).toBe('any')
    expect(field('verbose').querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('false')
    const colorBoxes = Array.from(field('colors').querySelectorAll<HTMLElement>('[role="checkbox"]'))
    expect(colorBoxes.map(box => [box.dataset.value, box.getAttribute('aria-checked')])).toEqual([
      ['red', 'true'],
      ['green', 'false'],
      ['blue', 'false'],
    ])
    expect(field('mode').querySelector('[role="combobox"]')?.textContent).toContain('fast')
  })

  it('never shows a stored secret: only "Stored" and the masked hint, then Replace or Clear', async () => {
    const { model } = await mountForm()
    const token = field('token')
    expect(token.querySelector('input')).toBeNull()
    expect(token.textContent).toContain('Stored')
    expect(token.textContent).toContain('sk-…9fQ2')
    expect(model.value.token).toBeUndefined()
    // Required secrets cannot be cleared.
    expect(Array.from(token.querySelectorAll('button')).map(item => item.textContent?.trim())).toEqual(['Replace'])

    buttonByText(token, 'Replace').click()
    await flushPromises()
    const input = control('token')
    expect(input.type).toBe('password')
    expect(input.value).toBe('')
    expect(token.textContent).toContain('stays until you save a new one')

    await type('token', 'sk-new-secret')
    expect(model.value.token).toBe('sk-new-secret')
    const reveal = field('token').querySelector<HTMLButtonElement>('button[aria-label="Show API token"]')!
    reveal.click()
    await flushPromises()
    expect(control('token').type).toBe('text')

    buttonByText(field('token'), 'Cancel').click()
    await flushPromises()
    expect(model.value.token).toBeUndefined()
    expect(field('token').querySelector('input')).toBeNull()
  })

  it('offers Clear for optional stored secrets and Undo', async () => {
    const { model } = await mountForm({ secretsSet: ['token', 'optionalToken'], secretHints: { token: 'sk-…9fQ2', optionalToken: null } })
    const optional = field('optionalToken')
    buttonByText(optional, 'Clear').click()
    await flushPromises()
    expect(model.value.optionalToken).toBe('')
    expect(field('optionalToken').textContent).toContain('Removed when you save')
    buttonByText(field('optionalToken'), 'Undo').click()
    await flushPromises()
    expect(model.value.optionalToken).toBeUndefined()
  })

  it('shows an empty password input with a reveal toggle for a secret that is not stored', async () => {
    const { model } = await mountForm({ secretsSet: [], secretHints: {} })
    const input = control('token')
    expect(input.type).toBe('password')
    expect(input.placeholder).toBe('Not set')
    await type('token', 'abc')
    expect(model.value.token).toBe('abc')
    await type('token', '')
    expect(model.value.token).toBeUndefined()
  })
})

describe('schemaForm: editing and validation', () => {
  it('keeps Save disabled until something changed, and Discard goes back', async () => {
    await mountForm()
    expect(button(testIds.schemaFormSave).disabled).toBe(true)
    await type('notes', 'Line one\nLine two', 'textarea')
    expect(button(testIds.schemaFormSave).disabled).toBe(false)
    buttonByText(document.body, 'Discard').click()
    await flushPromises()
    expect(control<HTMLTextAreaElement>('notes', 'textarea').value).toBe('')
    expect(button(testIds.schemaFormSave).disabled).toBe(true)
  })

  it('shows messages from settingsValuesSchema once a field was left, and blocks submit until valid', async () => {
    const { onSubmit } = await mountForm()
    await type('name', 'ABC')
    expect(errorOf('name')).toBeNull()
    await leave('name')
    expect(errorOf('name')).toBe('Must match the pattern ^[a-z]+$.')
    expect(control('name').getAttribute('aria-invalid')).toBe('true')

    await type('endpoint', 'ftp://example.com')
    await type('count', '12')
    await submit()
    expect(onSubmit).not.toHaveBeenCalled()
    expect(errorOf('endpoint')).toBe('Enter an absolute http:// or https:// URL.')
    expect(errorOf('count')).toBe('Enter a number from 1 to 10.')
    // Focus moves to the first invalid field.
    expect(document.activeElement).toBe(control('name'))

    await type('name', 'abc')
    await type('endpoint', 'https://example.com/api')
    await type('count', '7')
    expect([errorOf('name'), errorOf('endpoint'), errorOf('count')]).toEqual([null, null, null])
    await submit()
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ name: 'abc', endpoint: 'https://example.com/api', count: 7 })
  })

  it('requires a missing required secret and a whole number', async () => {
    const { onSubmit } = await mountForm({ secretsSet: [], secretHints: {} })
    await type('count', '2.5')
    await submit()
    expect(onSubmit).not.toHaveBeenCalled()
    expect(errorOf('token')).toBe('API token is required.')
    expect(errorOf('count')).toBe('Enter a whole number.')
  })

  it('round-trips every field type into the submitted values and the PUT patch', async () => {
    const { model, onSubmit } = await mountForm()
    await type('notes', 'Hello\nworld', 'textarea')
    await type('ratio', '0.5')
    await type('endpoint', 'https://api.example.com')

    // Select: choose a region (reka-ui's root emits the new value).
    const selects = wrapper!.findAllComponents(SelectRoot)
    expect(selects).toHaveLength(2)
    selects[1]!.vm.$emit('update:modelValue', 'us')
    await flushPromises()
    // Switch and checkbox group.
    field('verbose').querySelector<HTMLButtonElement>('[role="switch"]')!.click()
    field('colors').querySelector<HTMLButtonElement>('[data-value="blue"]')!.click()
    await flushPromises()
    // Tags: Enter and comma add, duplicates are ignored, Backspace removes the last.
    const tags = control('tags')
    for (const value of ['alpha', 'beta,', 'alpha']) {
      tags.value = value.replace(',', '')
      tags.dispatchEvent(new Event('input', { bubbles: true }))
      tags.dispatchEvent(new KeyboardEvent('keydown', { key: value.endsWith(',') ? ',' : 'Enter', bubbles: true, cancelable: true }))
      await flushPromises()
    }
    expect(model.value.tags).toEqual(['alpha', 'beta'])
    tags.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }))
    await flushPromises()
    expect(model.value.tags).toEqual(['alpha'])
    // A new secret value.
    buttonByText(field('token'), 'Replace').click()
    await flushPromises()
    await type('token', 'sk-rotated')

    await submit()
    expect(onSubmit).toHaveBeenCalledTimes(1)
    const submitted = onSubmit.mock.calls[0]![0] as SettingsValues
    expect(submitted).toEqual({
      name: 'abc',
      token: 'sk-rotated',
      endpoint: 'https://api.example.com',
      notes: 'Hello\nworld',
      mode: 'fast',
      region: 'us',
      count: 3,
      ratio: 0.5,
      verbose: true,
      colors: ['red', 'blue'],
      tags: ['alpha'],
    })
    expect(settingsPatch(schema, submitted, loaded)).toEqual({
      token: 'sk-rotated',
      endpoint: 'https://api.example.com',
      notes: 'Hello\nworld',
      region: 'us',
      ratio: 0.5,
      verbose: true,
      colors: ['red', 'blue'],
      tags: ['alpha'],
    })
  })

  it('resets non-secret properties to their defaults', async () => {
    const { model } = await mountForm({ values: { ...loaded, mode: 'slow', count: 9, colors: [], tags: ['x'] } })
    expect(button(testIds.schemaFormReset).disabled).toBe(false)
    button(testIds.schemaFormReset).click()
    await flushPromises()
    expect(model.value).toMatchObject({ mode: 'fast', count: 3, colors: ['red'], tags: [], verbose: false })
    expect(button(testIds.schemaFormReset).disabled).toBe(true)
    expect(button(testIds.schemaFormSave).disabled).toBe(false)
  })

  it('exposes validate() and reset(): reset() discards the edits and their messages', async () => {
    const { model, form } = await mountForm()
    await type('name', 'Nope')
    expect(model.value.name).toBe('Nope')
    expect(await form.value!.validate()).toBe(false)
    expect(errorOf('name')).toBe('Must match the pattern ^[a-z]+$.')
    form.value!.reset()
    await flushPromises()
    expect(control('name').value).toBe('abc')
    expect(model.value.name).toBe('abc')
    expect(errorOf('name')).toBeNull()
    expect(await form.value!.validate()).toBe(true)
  })

  it('starts from a new v-model object (the saved settings), even when it equals the edited values', async () => {
    const { model } = await mountForm()
    await type('name', 'saved')
    expect(button(testIds.schemaFormSave).disabled).toBe(false)
    // The parent saved: it passes the values the server returned.
    model.value = { ...loaded, name: 'saved' }
    await flushPromises()
    expect(control('name').value).toBe('saved')
    expect(button(testIds.schemaFormSave).disabled).toBe(true)

    model.value = { ...loaded, name: 'other' }
    await flushPromises()
    expect(control('name').value).toBe('other')
    expect(button(testIds.schemaFormSave).disabled).toBe(true)
  })

  it('locks every control while disabled', async () => {
    await mountForm()
    await wrapper!.setProps({})
    wrapper!.unmount()
    wrapper = mount(SchemaForm, { props: { schema, modelValue: structuredClone(loaded), secretsSet: ['token'], disabled: true }, attachTo: document.body })
    await flushPromises()
    expect(control('name').disabled).toBe(true)
    expect(button(testIds.schemaFormReset).disabled).toBe(true)
    expect(button(testIds.schemaFormSave).disabled).toBe(true)
  })
})
