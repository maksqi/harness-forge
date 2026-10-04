// RememberDialog (docs/UI.md 7.30, 10.7, 14, 15; docs/API.md 5.29; W10.9-T3): the three targets and their copy, the
// disabled project targets outside a saved project chat, the default target (the last choice when enabled), the note's
// counter and cap, Save (body, stores, toast, saved, close, the stored choice), Mod+Enter, focus on open, and every
// inline error.
import type { RememberResult } from '@harness-forge/shared'
import type { MockApi } from '~/utils/testing/mock-api'
import { HarnessError } from '@harness-forge/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { useProjectsStore } from '~/stores/projects'
import { useSettingsStore } from '~/stores/settings'
import { testIds } from '~/utils/testids'
import { chatId, projectId, projectSummary, rememberResult, settings } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { stubLocalStorage } from '~/utils/testing/storage'
import { REMEMBER_TARGET_KEY } from './remember'
import RememberDialog from './RememberDialog.vue'

const mocks = vi.hoisted(() => ({
  api: null as unknown,
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}))
vi.mock('~/composables/useApi', () => ({ useApi: () => mocks.api }))
vi.mock('vue-sonner', () => ({ toast: mocks.toast }))

let api: MockApi
let pinia: ReturnType<typeof createPinia>

const website = projectSummary({ id: projectId(1), name: 'website', instructionsFile: 'AGENTS.md' })

beforeEach(() => {
  api = createMockApi()
  mocks.api = api
  mocks.toast.success.mockReset()
  mocks.toast.error.mockReset()
  stubLocalStorage()
  pinia = createPinia()
  setActivePinia(pinia)
  useProjectsStore().items = [website]
})

afterEach(() => {
  disposePinia(pinia)
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

interface MountOptions {
  text?: string
  projectId?: string | null
  chatId?: string | null
}

function mountDialog(options: MountOptions = {}) {
  const open = ref(true)
  const saved: RememberResult[] = []
  const Host = defineComponent({
    setup: () => () => h(RememberDialog, {
      'open': open.value,
      'text': options.text ?? '',
      'projectId': options.projectId === undefined ? projectId(1) : options.projectId,
      'chatId': options.chatId === undefined ? chatId(1) : options.chatId,
      'onUpdate:open': (value: boolean) => {
        open.value = value
      },
      'onSaved': (result: RememberResult) => saved.push(result),
    }),
  })
  const wrapper = mount(Host, { attachTo: document.body, global: { plugins: [pinia] } })
  return { wrapper, open, saved }
}

function byTestId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.body.querySelector<T>(`[data-testid="${id}"]`)
}

function note(): HTMLTextAreaElement {
  return byTestId<HTMLTextAreaElement>(testIds.rememberText)!
}

function targets(): HTMLButtonElement[] {
  return [...document.body.querySelectorAll<HTMLButtonElement>(`[data-testid="${testIds.rememberTarget}"]`)]
}

function target(value: string): HTMLButtonElement {
  return targets().find(item => item.dataset.value === value)!
}

function saveButton(): HTMLButtonElement {
  return byTestId<HTMLButtonElement>(testIds.rememberSave)!
}

/** The text of the elements an attribute (`aria-labelledby`, `aria-describedby`) names. */
function textOf(element: Element, attribute: string): string {
  return (element.getAttribute(attribute) ?? '').split(/\s+/).filter(Boolean).map(id => document.getElementById(id)?.textContent?.trim() ?? '').join(' | ')
}

async function type(value: string) {
  note().value = value
  note().dispatchEvent(new Event('input', { bubbles: true }))
  await flushPromises()
}

function press(element: Element, init: KeyboardEventInit) {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  element.dispatchEvent(event)
  return event
}

describe('rememberDialog: targets', () => {
  it('names the project file, the project instructions and the custom instructions in a project chat', async () => {
    mountDialog()
    await flushPromises()
    const dialog = byTestId(testIds.rememberDialog)!
    expect(dialog.getAttribute('role')).toBe('dialog')
    expect(dialog.textContent).toContain('Remember')
    expect(dialog.querySelector('[role="radiogroup"]')!.getAttribute('aria-labelledby')).toBeTruthy()
    expect(textOf(dialog.querySelector('[role="radiogroup"]')!, 'aria-labelledby')).toBe('Save to')

    expect(targets().map(item => item.dataset.value)).toEqual(['project-file', 'project-instructions', 'global'])
    expect(targets().map(item => textOf(item, 'aria-labelledby'))).toEqual([
      'AGENTS.md in website',
      'Instructions of website',
      'Custom instructions',
    ])
    expect(targets().map(item => textOf(item, 'aria-describedby'))).toEqual([
      'Added as a line at the end of the file.',
      'Kept by harness-forge and sent with this project\'s chats.',
      'Sent with every chat.',
    ])
    expect(targets().every(item => !item.disabled && item.getAttribute('aria-disabled') === null)).toBe(true)
    expect(dialog.textContent).not.toContain('Open a chat in a project to use this.')
    // The default in a project chat without a stored choice: the project file.
    expect(target('project-file').getAttribute('aria-checked')).toBe('true')
  })

  it('offers a new AGENTS.md when the project has neither file, and CLAUDE.md when that is the file', async () => {
    useProjectsStore().items = [{ ...website, instructionsFile: null }]
    const first = mountDialog()
    await flushPromises()
    expect(textOf(target('project-file'), 'aria-labelledby')).toBe('AGENTS.md in website (new file)')
    first.wrapper.unmount()

    useProjectsStore().items = [{ ...website, instructionsFile: 'CLAUDE.md' }]
    mountDialog()
    await flushPromises()
    expect(textOf(target('project-file'), 'aria-labelledby')).toBe('CLAUDE.md in website')
  })

  it('disables the project targets outside a project chat, with the reason, and selects the custom instructions', async () => {
    mountDialog({ projectId: null, chatId: chatId(1) })
    await flushPromises()
    for (const value of ['project-file', 'project-instructions']) {
      const item = target(value)
      expect(item.disabled).toBe(true)
      expect(item.getAttribute('aria-disabled')).toBe('true')
      expect(item.hasAttribute('data-disabled')).toBe(true)
      expect(textOf(item, 'aria-describedby')).toContain('Open a chat in a project to use this.')
    }
    expect(textOf(target('project-file'), 'aria-labelledby')).toBe('AGENTS.md in a project (new file)')
    expect(target('global').disabled).toBe(false)
    expect(target('global').getAttribute('aria-checked')).toBe('true')

    // A click on a disabled target changes nothing.
    target('project-instructions').click()
    await flushPromises()
    expect(target('global').getAttribute('aria-checked')).toBe('true')
  })

  it('treats the draft chat (no chat id yet) like a chat without a project', async () => {
    mountDialog({ projectId: projectId(1), chatId: null })
    await flushPromises()
    expect(target('project-file').disabled).toBe(true)
    expect(target('project-instructions').disabled).toBe(true)
    expect(textOf(target('project-file'), 'aria-labelledby')).toBe('AGENTS.md in website')
    expect(target('global').getAttribute('aria-checked')).toBe('true')
  })

  it('starts on the last choice when it is enabled here', async () => {
    localStorage.setItem(REMEMBER_TARGET_KEY, 'project-instructions')
    const project = mountDialog()
    await flushPromises()
    expect(target('project-instructions').getAttribute('aria-checked')).toBe('true')
    project.wrapper.unmount()

    mountDialog({ projectId: null })
    await flushPromises()
    expect(target('global').getAttribute('aria-checked')).toBe('true')
  })

  it('switches targets with a click and with the arrow keys', async () => {
    mountDialog({ text: 'Prefer pnpm' })
    await flushPromises()
    expect(document.activeElement).toBe(target('project-file'))
    press(target('project-file'), { key: 'ArrowDown' })
    await new Promise(resolve => setTimeout(resolve, 10))
    await flushPromises()
    expect(document.activeElement).toBe(target('project-instructions'))
    expect(target('project-instructions').getAttribute('aria-checked')).toBe('true')

    target('global').click()
    await flushPromises()
    expect(target('global').getAttribute('aria-checked')).toBe('true')
    expect(target('project-file').getAttribute('aria-checked')).toBe('false')
  })
})

describe('rememberDialog: note and focus', () => {
  it('opens an empty dialog with focus in the note and a prefilled one on the selected target', async () => {
    const empty = mountDialog()
    await flushPromises()
    expect(document.activeElement).toBe(note())
    expect(saveButton().disabled).toBe(true)
    empty.wrapper.unmount()

    mountDialog({ text: '  Run pnpm check first ' })
    await flushPromises()
    expect(note().value).toBe('Run pnpm check first')
    expect(document.activeElement).toBe(target('project-file'))
    expect(saveButton().disabled).toBe(false)
  })

  it('counts the note and refuses one over 2,000 characters', async () => {
    mountDialog({ text: 'Run pnpm check first' })
    await flushPromises()
    const counter = document.body.querySelector('[data-slot="remember-counter"]')!
    expect(counter.textContent).toBe('20 / 2,000')
    expect(counter.getAttribute('aria-live')).toBe('off')

    await type('x'.repeat(2001))
    expect(counter.textContent).toBe('2,001 / 2,000')
    expect(note().getAttribute('aria-invalid')).toBe('true')
    expect(textOf(note(), 'aria-describedby')).toBe('Use at most 2,000 characters.')
    expect(saveButton().disabled).toBe(true)

    await type(`  ${'x'.repeat(2000)}  `)
    expect(counter.textContent).toBe('2,000 / 2,000')
    expect(note().getAttribute('aria-invalid')).toBeNull()
    expect(saveButton().disabled).toBe(false)

    await type('   ')
    expect(saveButton().disabled).toBe(true)
  })

  it('cancel and Esc close the dialog', async () => {
    const { open } = mountDialog({ text: 'x' })
    await flushPromises()
    const cancel = [...byTestId(testIds.rememberDialog)!.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Cancel')!
    cancel.click()
    await flushPromises()
    expect(open.value).toBe(false)
    expect(byTestId(testIds.rememberDialog)).toBeNull()

    open.value = true
    await flushPromises()
    press(note(), { key: 'Escape' })
    await flushPromises()
    expect(open.value).toBe(false)
    expect(api.memory.remember).not.toHaveBeenCalled()
  })
})

describe('rememberDialog: save', () => {
  it('saves to the project file: the body carries the chat, the project is applied, the toast names the file', async () => {
    const updated = { ...website, chatCount: 3 }
    api.memory.remember.mockResolvedValue(rememberResult({ project: updated }))
    const { open, saved } = mountDialog({ text: 'Run pnpm check first' })
    await flushPromises()
    saveButton().click()
    await flushPromises()
    expect(api.memory.remember).toHaveBeenCalledWith({ body: { target: 'project-file', text: 'Run pnpm check first', chatId: chatId(1) } })
    expect(useProjectsStore().byId(projectId(1))).toEqual(updated)
    expect(mocks.toast.success).toHaveBeenCalledWith('Saved to AGENTS.md')
    expect(saved).toHaveLength(1)
    expect(open.value).toBe(false)
    expect(localStorage.getItem(REMEMBER_TARGET_KEY)).toBe('project-file')
  })

  it('says when AGENTS.md was created, and saves to the project instructions', async () => {
    api.memory.remember.mockResolvedValueOnce(rememberResult({ created: true, project: { ...website, instructionsFile: 'AGENTS.md' } }))
    useProjectsStore().items = [{ ...website, instructionsFile: null }]
    const first = mountDialog({ text: 'a' })
    await flushPromises()
    saveButton().click()
    await flushPromises()
    expect(mocks.toast.success).toHaveBeenLastCalledWith('Created AGENTS.md in website')
    expect(useProjectsStore().byId(projectId(1))?.instructionsFile).toBe('AGENTS.md')
    first.wrapper.unmount()

    const withInstructions = { ...website, instructions: 'Old\n- b' }
    api.memory.remember.mockResolvedValueOnce(rememberResult({ target: 'project-instructions', file: undefined, created: undefined, project: withInstructions }))
    mountDialog({ text: 'b' })
    await flushPromises()
    target('project-instructions').click()
    await flushPromises()
    saveButton().click()
    await flushPromises()
    expect(api.memory.remember).toHaveBeenLastCalledWith({ body: { target: 'project-instructions', text: 'b', chatId: chatId(1) } })
    expect(useProjectsStore().byId(projectId(1))?.instructions).toBe('Old\n- b')
    expect(mocks.toast.success).toHaveBeenLastCalledWith('Saved to the instructions of website')
    expect(localStorage.getItem(REMEMBER_TARGET_KEY)).toBe('project-instructions')
  })

  it('saves to the custom instructions without a chat id outside a saved chat and applies the settings', async () => {
    const next = settings({ instructions: '- Prefer pnpm' })
    api.memory.remember.mockResolvedValue({ target: 'global', settings: next })
    mountDialog({ text: 'Prefer pnpm', projectId: null, chatId: null })
    await flushPromises()
    saveButton().click()
    await flushPromises()
    expect(api.memory.remember).toHaveBeenCalledWith({ body: { target: 'global', text: 'Prefer pnpm' } })
    expect(useSettingsStore().settings).toEqual(next)
    expect(mocks.toast.success).toHaveBeenCalledWith('Saved to your custom instructions')
  })

  it('mod+Enter saves from the note (Ctrl or Cmd); Enter adds a line', async () => {
    api.memory.remember.mockResolvedValue(rememberResult())
    const { open } = mountDialog()
    await flushPromises()
    await type('First line')
    const enter = press(note(), { key: 'Enter' })
    await flushPromises()
    expect(enter.defaultPrevented).toBe(false)
    expect(api.memory.remember).not.toHaveBeenCalled()

    const ctrl = press(note(), { key: 'Enter', ctrlKey: true })
    await flushPromises()
    expect(ctrl.defaultPrevented).toBe(true)
    expect(api.memory.remember).toHaveBeenCalledTimes(1)
    expect(open.value).toBe(false)

    open.value = true
    await flushPromises()
    await type('Second')
    press(target('project-file'), { key: 'Enter', metaKey: true })
    await flushPromises()
    expect(api.memory.remember).toHaveBeenCalledTimes(2)
  })

  it('keeps Save busy while the request runs', async () => {
    let finish!: (result: RememberResult) => void
    api.memory.remember.mockReturnValue(new Promise<RememberResult>((resolve) => {
      finish = resolve
    }))
    mountDialog({ text: 'x' })
    await flushPromises()
    saveButton().click()
    await flushPromises()
    expect(saveButton().disabled).toBe(true)
    expect(saveButton().getAttribute('aria-busy')).toBe('true')
    press(note(), { key: 'Enter', ctrlKey: true })
    expect(api.memory.remember).toHaveBeenCalledTimes(1)
    finish(rememberResult())
    await flushPromises()
    expect(byTestId(testIds.rememberDialog)).toBeNull()
  })
})

describe('rememberDialog: errors', () => {
  const cases: [HarnessError, string][] = [
    [new HarnessError({ code: 'payload_too_large', message: 'AGENTS.md would pass 1048576 bytes.' }), 'The file would be larger than 1 MB.'],
    [
      new HarnessError({
        code: 'validation_error',
        message: 'instructions: The instructions would be longer than 20000 characters.',
        details: { issues: [{ path: ['instructions'], message: 'Too long', code: 'too_big' }] },
      }),
      'The instructions would be longer than 20,000 characters. Shorten them in Settings first.',
    ],
    [new HarnessError({ code: 'validation_error', message: 'The project folder /srv/website is not available: missing' }), 'The project folder is unavailable.'],
    [new HarnessError({ code: 'validation_error', message: 'AGENTS.md is a link. Links are not written.' }), 'AGENTS.md is a link. Links are not written.'],
    [new HarnessError({ code: 'not_found', message: 'Chat 0199 not found.' }), 'Chat 0199 not found.'],
  ]

  it('shows each failure inline with its code and keeps the dialog open', async () => {
    const { open, saved } = mountDialog({ text: 'x' })
    await flushPromises()
    for (const [error, text] of cases) {
      api.memory.remember.mockRejectedValueOnce(error)
      saveButton().click()
      await flushPromises()
      const alert = byTestId(testIds.rememberError)!
      expect(alert.getAttribute('role')).toBe('alert')
      expect(alert.dataset.code).toBe(error.code)
      expect(alert.textContent?.trim()).toBe(text)
      expect(textOf(saveButton(), 'aria-describedby')).toBe(text)
      expect(open.value).toBe(true)
    }
    expect(saved).toHaveLength(0)
    expect(mocks.toast.success).not.toHaveBeenCalled()
    expect(localStorage.getItem(REMEMBER_TARGET_KEY)).toBeNull()

    // Editing the note clears the error.
    await type('x y')
    expect(byTestId(testIds.rememberError)).toBeNull()
  })
})
