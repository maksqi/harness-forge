// ProjectFileEditor (Phase 12, ADR-056; docs/UI.md 9.14, 10.9; C46 stub): the root test id and attributes, the load,
// the save with the loaded sha256 and the stale conflict.
import type { ProjectFileTarget } from './customize'
import type { MockApi } from '~/utils/testing/mock-api'
import { HarnessError } from '@harness-forge/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { h, nextTick } from 'vue'
import { testIds } from '~/utils/testids'
import { projectDefinitionFile, projectDefinitionWriteResult, projectId, trustSha } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import ProjectFileEditor from './ProjectFileEditor.vue'

const mock = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))

let api: MockApi
let pinia: ReturnType<typeof createPinia>

beforeEach(() => {
  api = createMockApi()
  mock.api = api
  pinia = createPinia()
  setActivePinia(pinia)
})

afterEach(() => {
  document.body.replaceChildren()
  disposePinia(pinia)
})

function byTestId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.body.querySelector<T>(`[data-testid="${id}"]`)
}

async function settle() {
  await flushPromises()
  await nextTick()
  await flushPromises()
}

async function mountEditor(entry: ProjectFileTarget = { path: '.claude/agents/reviewer.md', kind: 'agent', name: 'reviewer', create: false }) {
  const events = { saved: vi.fn(), open: vi.fn() }
  mount({ render: () => h(ProjectFileEditor, { 'open': true, 'projectId': projectId(1), entry, 'onSaved': events.saved, 'onUpdate:open': events.open }) }, { attachTo: document.body, global: { plugins: [pinia] } })
  await settle()
  return events
}

describe('projectFileEditor', () => {
  it('opens on the raw file with its kind, path and mode', async () => {
    api.projectDefinitions.read.mockResolvedValue(projectDefinitionFile())
    await mountEditor()
    const editor = byTestId(testIds.projectFileEditor)!
    expect(editor.dataset).toMatchObject({ kind: 'agent', path: '.claude/agents/reviewer.md', mode: 'edit' })
    expect(byTestId<HTMLTextAreaElement>(testIds.projectFileContent)!.value).toContain('name: reviewer')
    expect(api.projectDefinitions.read).toHaveBeenCalledWith({ params: { id: projectId(1) }, query: { path: '.claude/agents/reviewer.md' } })
  })

  it('saves with the loaded sha256 and reports the pending approvals', async () => {
    api.projectDefinitions.read.mockResolvedValue(projectDefinitionFile())
    api.projectDefinitions.write.mockResolvedValue(projectDefinitionWriteResult({ path: '.claude/agents/reviewer.md', trust: { pending: 0 } }))
    const events = await mountEditor()
    byTestId(testIds.projectFileSave)!.click()
    await settle()
    expect(api.projectDefinitions.write).toHaveBeenCalledWith({
      params: { id: projectId(1) },
      body: { path: '.claude/agents/reviewer.md', expectedSha256: trustSha(1), content: projectDefinitionFile().content },
    })
    expect(events.saved).toHaveBeenCalledWith({ path: '.claude/agents/reviewer.md', pending: 0 })
    expect(events.open).toHaveBeenCalledWith(false)
  })

  it('shows the conflict of a stale save with Load from disk and Overwrite', async () => {
    api.projectDefinitions.read.mockResolvedValue(projectDefinitionFile())
    api.projectDefinitions.write.mockRejectedValueOnce(new HarnessError({ code: 'conflict', message: 'Changed.', details: { reason: 'stale' } }))
    await mountEditor()
    byTestId(testIds.projectFileSave)!.click()
    await settle()
    expect(byTestId(testIds.projectFileConflict)?.getAttribute('role')).toBe('alert')
    expect(byTestId(testIds.projectFileReload)).not.toBeNull()
    expect(byTestId(testIds.projectFileOverwrite)).not.toBeNull()
  })

  it('writes the mcpServers key of .mcp.json', async () => {
    api.projectDefinitions.read.mockResolvedValue(projectDefinitionFile({ path: '.mcp.json', kind: 'mcp', content: '{ "mcpServers": { "memory": { "command": "npx" } } }', sha256: trustSha(3) }))
    api.projectDefinitions.write.mockResolvedValue(projectDefinitionWriteResult({ path: '.mcp.json', trust: { pending: 1 } }))
    const events = await mountEditor({ path: '.mcp.json', kind: 'mcp', name: null, create: false })
    expect(byTestId(testIds.projectFileEditor)?.dataset.kind).toBe('mcp')
    byTestId(testIds.projectFileSave)!.click()
    await settle()
    expect(api.projectDefinitions.write).toHaveBeenCalledWith({
      params: { id: projectId(1) },
      body: { path: '.mcp.json', expectedSha256: trustSha(3), mcpServers: { memory: { command: 'npx' } } },
    })
    expect(events.saved).toHaveBeenCalledWith({ path: '.mcp.json', pending: 1 })
  })
})
