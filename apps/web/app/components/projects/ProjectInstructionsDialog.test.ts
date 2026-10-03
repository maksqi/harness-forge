// ProjectInstructionsDialog (docs/UI.md 9.10, 10.4; W7.9-T6): the title, the project file note, the textarea with its
// counter, Save (an empty text saves null) with saved(project), and an inline failure.
import type { MockApi } from '~/utils/testing/mock-api'
import { HarnessError } from '@harness-forge/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { useProjectsStore } from '~/stores/projects'
import { testIds } from '~/utils/testids'
import { projectId, projectSummary } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import ProjectInstructionsDialog from './ProjectInstructionsDialog.vue'

const mocks = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mocks.api }))

let api: MockApi
let pinia: ReturnType<typeof createPinia>

beforeEach(() => {
  api = createMockApi()
  mocks.api = api
  pinia = createPinia()
  setActivePinia(pinia)
})

afterEach(() => {
  disposePinia(pinia)
  document.body.replaceChildren()
})

function byTestId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.body.querySelector<T>(`[data-testid="${id}"]`)
}

function mountDialog(project = projectSummary({ id: projectId(1), name: 'Website', instructions: 'Use pnpm.' })) {
  useProjectsStore().items = [project]
  const open = ref(true)
  const saved: unknown[] = []
  const Host = defineComponent({
    setup: () => () => h(ProjectInstructionsDialog, {
      'open': open.value,
      project,
      'onUpdate:open': (value: boolean) => {
        open.value = value
      },
      'onSaved': (value: unknown) => saved.push(value),
    }),
  })
  const wrapper = mount(Host, { attachTo: document.body, global: { plugins: [pinia] } })
  return { wrapper, open, saved }
}

async function type(value: string) {
  const input = byTestId<HTMLTextAreaElement>(testIds.projectInstructionsInput)!
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await flushPromises()
}

describe('projectInstructionsDialog', () => {
  it('shows the project instructions with the counter and the note', async () => {
    const { wrapper } = mountDialog()
    await flushPromises()
    const content = byTestId(testIds.projectInstructionsDialog)!
    expect(content.getAttribute('role')).toBe('dialog')
    expect(content.textContent).toContain('Instructions for Website')
    expect(content.textContent).toContain('Sent with every chat in this project, after AGENTS.md / CLAUDE.md from the folder.')
    expect(content.textContent).not.toContain('This folder has')
    const input = byTestId<HTMLTextAreaElement>(testIds.projectInstructionsInput)!
    expect(input.value).toBe('Use pnpm.')
    expect(input.maxLength).toBe(20_000)
    expect(content.textContent).toContain('9 / 20,000')
    await type('x'.repeat(1234))
    expect(content.textContent).toContain('1,234 / 20,000')
    wrapper.unmount()
  })

  it('mentions the folder\'s project file when there is one', async () => {
    const { wrapper } = mountDialog(projectSummary({ id: projectId(1), name: 'Website', instructionsFile: 'AGENTS.md' }))
    await flushPromises()
    expect(byTestId(testIds.projectInstructionsDialog)!.textContent).toContain('This folder has AGENTS.md; it is added first.')
    wrapper.unmount()
  })

  it('saves the text, emits saved and closes; an empty text saves null', async () => {
    const { wrapper, open, saved } = mountDialog()
    await flushPromises()
    await type('Run the tests first.')
    const updated = projectSummary({ id: projectId(1), name: 'Website', instructions: 'Run the tests first.' })
    api.projects.update.mockResolvedValueOnce(updated)
    byTestId<HTMLButtonElement>(testIds.projectInstructionsSave)!.click()
    await flushPromises()
    expect(api.projects.update).toHaveBeenCalledWith({ params: { id: projectId(1) }, body: { instructions: 'Run the tests first.' } })
    expect(saved).toEqual([updated])
    expect(open.value).toBe(false)

    open.value = true
    await flushPromises()
    await type('   ')
    api.projects.update.mockResolvedValueOnce({ ...updated, instructions: null })
    byTestId<HTMLButtonElement>(testIds.projectInstructionsSave)!.click()
    await flushPromises()
    expect(api.projects.update).toHaveBeenLastCalledWith({ params: { id: projectId(1) }, body: { instructions: null } })
    wrapper.unmount()
  })

  it('keeps the dialog open with the error when saving fails', async () => {
    const { wrapper, open, saved } = mountDialog()
    await flushPromises()
    api.projects.update.mockRejectedValueOnce(new HarnessError({ code: 'not_found', message: 'Project not found.' }))
    byTestId<HTMLButtonElement>(testIds.projectInstructionsSave)!.click()
    await flushPromises()
    expect(open.value).toBe(true)
    expect(saved).toEqual([])
    expect(byTestId(testIds.projectInstructionsDialog)!.querySelector('[role="alert"]')?.textContent?.trim()).toBe('Project not found.')
    wrapper.unmount()
  })
})
