// FolderBrowser (docs/UI.md 9.10, 10.4, 14.1, 14.2; W7.9-T5): the roots (a missing one disabled), then the breadcrumb,
// Parent folder and the subfolders (projects disabled with their badge), the 500-folder note, the abort of an older
// request, the live region and the focus move, and the inline errors by code.
import type { ProjectBrowse } from '@harness-forge/shared'
import type { MockApi } from '~/utils/testing/mock-api'
import { HarnessError } from '@harness-forge/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { testIds } from '~/utils/testids'
import { projectId } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import FolderBrowser from './FolderBrowser.vue'

const mocks = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mocks.api }))

let api: MockApi
let pinia: ReturnType<typeof createPinia>

const ROOT = '/srv/workspaces'
const roots = [{ path: ROOT, available: true }, { path: '/mnt/gone', available: false }]

function listing(path: string | null, names: string[] = [], extra: Partial<ProjectBrowse> = {}): ProjectBrowse {
  return {
    path,
    parent: null,
    roots,
    entries: names.map(name => ({ name, path: `${path}/${name}`, projectId: null })),
    truncated: false,
    ...extra,
  }
}

/** Answers browse requests from a table keyed by path ('' = the roots). */
function serve(table: Record<string, ProjectBrowse | HarnessError>) {
  api.projects.browse.mockImplementation(async ({ query }: { query: { path?: string } }) => {
    const answer = table[query.path ?? '']
    if (!answer)
      throw new HarnessError({ code: 'not_found', message: 'No such folder.' })
    if (answer instanceof HarnessError)
      throw answer
    return answer
  })
}

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

function mountBrowser(initial: string | null) {
  const model = ref<string | null>(initial)
  const Host = defineComponent({
    setup: () => () => h(FolderBrowser, {
      'modelValue': model.value,
      'onUpdate:modelValue': (value: string | null) => {
        model.value = value
      },
    }),
  })
  const wrapper = mount(Host, { attachTo: document.body, global: { plugins: [pinia] } })
  return { wrapper, model }
}

function browser(): HTMLElement {
  return document.body.querySelector<HTMLElement>(`[data-testid="${testIds.folderBrowser}"]`)!
}

function entries(): HTMLButtonElement[] {
  return [...document.body.querySelectorAll<HTMLButtonElement>(`[data-testid="${testIds.folderBrowserEntry}"]`)]
}

function crumbs(): HTMLElement[] {
  return [...document.body.querySelectorAll<HTMLElement>(`[data-testid="${testIds.folderBrowserCrumb}"]`)]
}

function up(): HTMLButtonElement | null {
  return document.body.querySelector<HTMLButtonElement>(`[data-testid="${testIds.folderBrowserUp}"]`)
}

describe('folderBrowser', () => {
  it('lists the roots first, a missing root disabled with "Not found"', async () => {
    serve({ '': listing(null) })
    const { wrapper } = mountBrowser(null)
    expect(browser().dataset.state).toBe('loading')
    await flushPromises()
    expect(api.projects.browse).toHaveBeenCalledWith({ query: {}, signal: expect.any(AbortSignal) })
    expect(browser().dataset.path).toBe('')
    expect(browser().dataset.state).toBe('ready')
    expect(entries().map(entry => [entry.dataset.path, entry.disabled])).toEqual([[ROOT, false], ['/mnt/gone', true]])
    expect(entries()[1]!.textContent).toContain('Not found')
    expect(entries()[1]!.getAttribute('aria-label')).toBe('/mnt/gone, not found')
    expect(up()).toBeNull()
    expect(document.body.querySelector('nav[aria-label="Folder path"]')).toBeNull()
    wrapper.unmount()
  })

  it('opens a folder: breadcrumb from the root, Parent folder, subfolders, projects disabled with a badge', async () => {
    serve({
      '': listing(null),
      [ROOT]: listing(ROOT, ['website']),
      [`${ROOT}/website`]: {
        ...listing(`${ROOT}/website`, ['packages', 'shared']),
        parent: ROOT,
        entries: [
          { name: 'packages', path: `${ROOT}/website/packages`, projectId: null },
          { name: 'shared', path: `${ROOT}/website/shared`, projectId: projectId(1) },
        ],
      },
    })
    const { wrapper, model } = mountBrowser(null)
    await flushPromises()
    entries()[0]!.click()
    await flushPromises()
    expect(model.value).toBe(ROOT)
    expect(browser().dataset.path).toBe(ROOT)
    expect(crumbs().map(crumb => [crumb.textContent?.trim(), crumb.getAttribute('aria-current')])).toEqual([['workspaces', 'page']])

    entries()[0]!.click()
    await flushPromises()
    expect(model.value).toBe(`${ROOT}/website`)
    expect(crumbs().map(crumb => [crumb.textContent?.trim(), crumb.dataset.path, crumb.getAttribute('aria-current')])).toEqual([
      ['workspaces', ROOT, null],
      ['website', `${ROOT}/website`, 'page'],
    ])
    expect(document.body.querySelector('nav[aria-label="Folder path"]')).not.toBeNull()
    expect(entries().map(entry => [entry.querySelector('.truncate')?.textContent, entry.disabled])).toEqual([['packages', false], ['shared', true]])
    expect(entries().map(entry => entry.querySelector('[data-slot="badge"]')?.textContent?.trim() ?? null)).toEqual([null, 'Project'])
    expect(entries()[1]!.getAttribute('aria-label')).toBe('shared, already a project')
    // The live region announces the folder; focus moved to the first entry.
    expect(document.body.querySelector('[aria-live="polite"]')?.textContent?.trim()).toBe('Opened website, 2 folders')
    expect(document.activeElement).toBe(entries()[0])

    // A crumb opens its folder; Parent folder goes up, and at the root's top back to the roots.
    crumbs()[0]!.click()
    await flushPromises()
    expect(model.value).toBe(ROOT)
    up()!.click()
    await flushPromises()
    expect(model.value).toBeNull()
    expect(browser().dataset.path).toBe('')
    wrapper.unmount()
  })

  it('goes up from a nested folder to its parent and marks an empty folder', async () => {
    serve({ [`${ROOT}/a/b`]: listing(`${ROOT}/a/b`, []), [`${ROOT}/a`]: listing(`${ROOT}/a`, ['b']) })
    const { wrapper, model } = mountBrowser(`${ROOT}/a/b`)
    await flushPromises()
    expect(browser().dataset.state).toBe('empty')
    expect(browser().textContent).toContain('No folders here.')
    // The roots arrived with the answer: the crumbs start at the root.
    expect(crumbs().map(crumb => crumb.textContent?.trim())).toEqual(['workspaces', 'a', 'b'])
    expect(document.activeElement).toBe(up())
    up()!.click()
    await flushPromises()
    expect(model.value).toBe(`${ROOT}/a`)
    wrapper.unmount()
  })

  it('ends a cut list with the 500-folder note', async () => {
    serve({ [ROOT]: listing(ROOT, ['a', 'b'], { truncated: true }) })
    const { wrapper } = mountBrowser(ROOT)
    await flushPromises()
    expect(browser().textContent).toContain('Showing the first 500 folders.')
    wrapper.unmount()
  })

  it('aborts the previous request when another folder opens', async () => {
    const signals: AbortSignal[] = []
    api.projects.browse.mockImplementation(({ query, signal }: { query: { path?: string }, signal: AbortSignal }) => {
      signals.push(signal)
      if (query.path === `${ROOT}/slow`)
        return new Promise(() => {})
      return Promise.resolve(listing(query.path ?? null, ['fast']))
    })
    const { wrapper, model } = mountBrowser(`${ROOT}/slow`)
    await flushPromises()
    model.value = ROOT
    await flushPromises()
    expect(signals).toHaveLength(2)
    expect(signals[0]!.aborted).toBe(true)
    expect(signals[1]!.aborted).toBe(false)
    expect(browser().dataset.state).toBe('ready')
    expect(entries().map(entry => entry.textContent?.trim())).toEqual(['fast'])
    wrapper.unmount()
  })

  it('shows a missing folder inline (data-code not_found) with Parent folder and back to the roots', async () => {
    serve({ '': listing(null) })
    const { wrapper, model } = mountBrowser(`${ROOT}/gone`)
    await flushPromises()
    expect(browser().dataset.state).toBe('error')
    const error = document.body.querySelector<HTMLElement>(`[data-testid="${testIds.folderBrowserError}"]`)!
    expect(error.dataset.code).toBe('not_found')
    expect(error.textContent).toContain('This folder no longer exists.')
    const buttons = [...error.querySelectorAll('button')].map(button => button.textContent?.trim())
    expect(buttons).toEqual(['Parent folder', 'Back to workspace folders'])
    error.querySelectorAll('button')[1]!.click()
    await flushPromises()
    expect(model.value).toBeNull()
    expect(browser().dataset.state).toBe('ready')
    wrapper.unmount()
  })

  it('explains a folder outside the roots (400) and offers Retry for other failures', async () => {
    serve({
      '/etc': new HarnessError({ code: 'validation_error', message: 'path: outside' }),
      [ROOT]: new HarnessError({ code: 'internal_error', message: 'Something went wrong.' }),
    })
    const { wrapper, model } = mountBrowser('/etc')
    await flushPromises()
    let error = document.body.querySelector<HTMLElement>(`[data-testid="${testIds.folderBrowserError}"]`)!
    expect(error.dataset.code).toBe('validation_error')
    expect(error.textContent).toContain('Choose a folder inside the workspace folders.')

    model.value = ROOT
    await flushPromises()
    error = document.body.querySelector<HTMLElement>(`[data-testid="${testIds.folderBrowserError}"]`)!
    expect(error.dataset.code).toBe('internal_error')
    expect(error.textContent).toContain('Something went wrong.')
    serve({ [ROOT]: listing(ROOT, ['back']) })
    ;[...error.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Retry')!.click()
    await flushPromises()
    expect(entries().map(entry => entry.textContent?.trim())).toEqual(['back'])
    wrapper.unmount()
  })

  it('disables every control while disabled', async () => {
    serve({ [ROOT]: listing(ROOT, ['a']) })
    const wrapper = mount(FolderBrowser, { props: { modelValue: ROOT, disabled: true }, attachTo: document.body, global: { plugins: [pinia] } })
    await flushPromises()
    expect(browser().getAttribute('aria-disabled')).toBe('true')
    expect(entries().every(entry => entry.disabled)).toBe(true)
    expect(up()!.disabled).toBe(true)
    expect(crumbs().every(crumb => (crumb as HTMLButtonElement).disabled)).toBe(true)
    expect(wrapper.props()).toEqual({ modelValue: ROOT, disabled: true })
    wrapper.unmount()
  })
})
