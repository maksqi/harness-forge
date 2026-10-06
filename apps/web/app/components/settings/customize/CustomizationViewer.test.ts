import type { CustomizationEntry } from '@harness-forge/shared'
// CustomizationViewer (docs/UI.md 9.12, 10.7, 14; W10.8-T4): the frontmatter as a definition list, the raw file from
// `GET /customizations/source` in a read-only editor, Copy path, Copy to personal (the parsed draft), Export .md, and
// "This file no longer exists." for a 404.
import type { VueWrapper } from '@vue/test-utils'
import type { MockApi } from '~/utils/testing/mock-api'
import { HarnessError } from '@harness-forge/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, reactive } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { testIds } from '~/utils/testids'
import { AGENT_MARKDOWN, customizationEntry, definitionDiagnostic, projectId, styleEntry } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import CustomizationViewer from './CustomizationViewer.vue'

const mocks = vi.hoisted(() => ({ api: null as unknown, downloadText: vi.fn() }))

vi.mock('~/composables/useApi', () => ({ useApi: () => mocks.api }))
vi.mock('~/utils/download', () => ({ downloadText: mocks.downloadText }))

let api: MockApi
let pinia: ReturnType<typeof createPinia>
let wrapper: VueWrapper | null = null

beforeEach(() => {
  api = createMockApi()
  mocks.api = api
  mocks.downloadText.mockReset()
  pinia = createPinia()
  setActivePinia(pinia)
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.replaceChildren()
  disposePinia(pinia)
})

async function mountViewer(entry: CustomizationEntry) {
  const state = reactive({ open: true })
  const emitted = { open: [] as boolean[], copy: [] as unknown[] }
  const Host = defineComponent({
    setup: () => () => h(TooltipProvider, null, {
      default: () => h(CustomizationViewer, {
        'open': state.open,
        entry,
        'projectId': projectId(1),
        'onUpdate:open': (value: boolean) => {
          emitted.open.push(value)
          state.open = value
        },
        'onCopy': (draft: unknown) => emitted.copy.push(draft),
      }),
    }),
  })
  wrapper = mount(Host, { attachTo: document.body, global: { plugins: [pinia] } })
  await flushPromises()
  return { state, emitted }
}

function viewer(): HTMLElement {
  return document.body.querySelector<HTMLElement>(`[data-testid="${testIds.customizationViewer}"]`)!
}

function button(label: string): HTMLButtonElement {
  return [...viewer().querySelectorAll<HTMLButtonElement>('button')].find(element => element.textContent?.trim() === label)!
}

describe('customizationViewer', () => {
  it('shows the frontmatter, the raw file read-only with lint markers, and the path of a project file', async () => {
    api.customizations.source.mockResolvedValue({ content: AGENT_MARKDOWN, path: '.harness/agents/reviewer.md' })
    const entry = customizationEntry({ diagnostics: [definitionDiagnostic()] })
    await mountViewer(entry)
    expect(api.customizations.source).toHaveBeenCalledWith({
      query: { projectId: projectId(1), kind: 'agent', name: 'reviewer', source: 'project', path: '.harness/agents/reviewer.md' },
    })
    expect(viewer().dataset).toMatchObject({ kind: 'agent', source: 'project' })
    expect(viewer().getAttribute('role')).toBe('dialog')
    expect(viewer().textContent).toContain('reviewer')
    const terms = [...viewer().querySelectorAll('dt')].map(term => term.textContent?.trim())
    expect(terms).toEqual(['Description', 'Tools', 'Model', 'Source'])
    expect(viewer().querySelector('dl')?.textContent).toContain('read_file, search_files')
    expect(viewer().querySelector('dl')?.textContent).toContain('Default sub-agent model')
    expect(viewer().textContent).toContain('.harness/agents/reviewer.md')
    expect(button('Copy path')).toBeDefined()
    await vi.waitFor(() => expect(viewer().querySelector('[data-slot="markdown-editor"]')?.getAttribute('data-ready')).toBe('true'))
    await nextTick()
    const content = viewer().querySelector<HTMLElement>('.cm-content')!
    expect(content.getAttribute('aria-readonly')).toBe('true')
    expect(content.getAttribute('aria-label')).toBe('Contents of .harness/agents/reviewer.md')
    expect(content.textContent).toContain('Review the diff.')
    expect(viewer().querySelector('.cm-hf-lint-marker-warning')).not.toBeNull()
    await vi.waitFor(() => expect(document.activeElement?.getAttribute('data-slot')).toBe('sheet-close'))
  })

  it('copies the parsed file to personal and exports it as {name}.md', async () => {
    api.customizations.source.mockResolvedValue({ content: AGENT_MARKDOWN })
    const { emitted } = await mountViewer(customizationEntry({ source: 'builtin', name: 'reviewer', path: undefined }))
    button('Copy to personal').click()
    expect(emitted.copy).toEqual([{
      kind: 'agent',
      name: 'reviewer',
      description: 'Reviews a diff and reports bugs',
      tools: ['read_file', 'search_files'],
      model: null,
      argumentHint: null,
      body: 'Review the diff. Report each bug with its file and line.',
    }])
    button('Export .md').click()
    expect(mocks.downloadText).toHaveBeenCalledWith(AGENT_MARKDOWN, 'reviewer.md', 'text/markdown')
    expect(viewer().textContent).not.toContain('Copy path')
  })

  it('says when the file no longer exists and closes', async () => {
    api.customizations.source.mockRejectedValue(new HarnessError({ code: 'not_found', message: 'Not found.' }))
    const { emitted } = await mountViewer(customizationEntry())
    expect(viewer().textContent).toContain('This file no longer exists.')
    expect(button('Copy to personal')).toBeUndefined()
    button('Close').click()
    await flushPromises()
    expect(emitted.open).toEqual([false])
  })

  it('titles a style by its label and copies it with its label and flag (Phase 11)', async () => {
    api.customizations.source.mockResolvedValue({ content: '---\nname: Terse Mode\ndescription: Short answers\nkeep-coding-instructions: true\n---\nBe brief.\n', path: '.harness/output-styles/terse-mode.md' })
    const { emitted } = await mountViewer(styleEntry({ name: 'terse-mode', label: 'Terse Mode', description: 'Short answers', path: '.harness/output-styles/terse-mode.md' }))
    expect(viewer().dataset.kind).toBe('style')
    expect(viewer().querySelector('h2')?.textContent?.trim()).toBe('Terse Mode')
    expect(viewer().textContent).toContain('terse-mode')
    expect(viewer().textContent).toContain('Keeps coding instructions')
    expect(viewer().textContent).not.toContain('Model')
    button('Copy to personal').click()
    expect(emitted.copy[0]).toMatchObject({ kind: 'style', name: 'terse-mode', label: 'Terse Mode', keepCodingInstructions: true, body: 'Be brief.' })
  })

  it('lists how a skill runs (Phase 11)', async () => {
    api.customizations.source.mockResolvedValue({ content: '---\nname: deploy\ndescription: Deploy\ndisable-model-invocation: true\nargument-hint: <env>\n---\nShip it.\n' })
    await mountViewer(customizationEntry({ kind: 'skill', name: 'deploy', description: 'Deploy', tools: undefined, argumentHint: '<env>', modelInvocable: false, path: '.harness/skills/deploy/SKILL.md' }))
    expect(viewer().textContent).toContain('/deploy')
    expect(viewer().textContent).toContain('<env>')
    expect(viewer().textContent).toContain('Only when you run it')
  })
})
