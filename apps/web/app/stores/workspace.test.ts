// Workspace store (docs/UI.md 7.21, 11.5; C20 skeleton): the frozen shape, the getters over loaded entries, the one-shot
// calls (diff, revert, undo) and the stub fetches, which send nothing until W8.8.
import type { MockApi } from '~/utils/testing/mock-api'
import { createServerEvent, HarnessError } from '@harness-forge/shared'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  changeBatchId,
  chatChangeFile,
  chatChanges,
  chatId,
  fileDiff,
  gitStatus,
  restoreResult,
  workspaceChangedData,
} from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { useWorkspaceStore } from './workspace'

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
})

describe('workspace store: shape', () => {
  it('starts empty and exposes the frozen members', () => {
    const workspace = useWorkspaceStore()
    expect(workspace.chat).toEqual({})
    expect(workspace.git).toEqual({})
    expect(workspace.chatChanges(chatId(1))).toBeNull()
    expect(workspace.gitStatus(chatId(1))).toBeNull()
    expect(workspace.changeCount(chatId(1))).toBe(0)
    for (const action of ['fetchChatChanges', 'fetchGit', 'fileDiff', 'revert', 'undo', 'applyEvent', 'refreshLoaded'] as const)
      expect(workspace[action]).toBeTypeOf('function')
  })

  it('reads loaded entries; the count leaves out files back to their original state', () => {
    const workspace = useWorkspaceStore()
    const changes = chatChanges({ files: [chatChangeFile(), chatChangeFile({ path: 'b.ts', status: 'unchanged' }), chatChangeFile({ path: 'c.ts', status: 'added' })] })
    workspace.chat[chatId(1)] = { data: changes, loading: false, error: null, loadedAt: 1 }
    workspace.git[chatId(1)] = { data: gitStatus(), loading: false, error: null, loadedAt: 1 }
    expect(workspace.chatChanges(chatId(1))).toEqual(changes)
    expect(workspace.gitStatus(chatId(1))).toEqual(gitStatus())
    expect(workspace.changeCount(chatId(1))).toBe(2)
  })
})

describe('workspace store: stub actions (C20)', () => {
  it('fetches, events and the reconnect refresh send nothing until W8.8', async () => {
    const workspace = useWorkspaceStore()
    await expect(workspace.fetchChatChanges(chatId(1))).resolves.toBeUndefined()
    await expect(workspace.fetchGit(chatId(1), { force: true })).resolves.toBeUndefined()
    workspace.applyEvent(createServerEvent('workspace.changed', workspaceChangedData()))
    await expect(workspace.refreshLoaded()).resolves.toBeUndefined()
    expect(api.changes.list).not.toHaveBeenCalled()
    expect(api.changes.git).not.toHaveBeenCalled()
  })

  it('loads one diff, reverts and undoes through the changes routes', async () => {
    const workspace = useWorkspaceStore()
    const signal = new AbortController().signal
    api.changes.diff.mockResolvedValue(fileDiff())
    api.changes.revert.mockResolvedValue(restoreResult())
    api.changes.undo.mockResolvedValue(restoreResult({ batchId: changeBatchId(2) }))

    await expect(workspace.fileDiff(chatId(1), 'git', 'src/index.ts', { signal })).resolves.toEqual(fileDiff())
    expect(api.changes.diff).toHaveBeenCalledWith({ params: { id: chatId(1) }, query: { source: 'git', path: 'src/index.ts' }, signal })

    await workspace.revert(chatId(1), { source: 'chat', path: 'src/index.ts', expectedSha: null })
    expect(api.changes.revert).toHaveBeenCalledWith({ params: { id: chatId(1) }, body: { source: 'chat', path: 'src/index.ts', expectedSha: null } })

    await expect(workspace.undo(chatId(1), changeBatchId(1))).resolves.toMatchObject({ batchId: changeBatchId(2) })
    expect(api.changes.undo).toHaveBeenCalledWith({ params: { id: chatId(1) }, body: { batchId: changeBatchId(1), conflicts: 'skip' } })
  })

  it('throws HarnessError from the one-shot calls', async () => {
    const workspace = useWorkspaceStore()
    api.changes.revert.mockRejectedValue(new HarnessError({ code: 'conflict', message: 'A response is running.', details: { reason: 'run-active' } }))
    await expect(workspace.revert(chatId(1), { source: 'chat', path: 'a.ts' })).rejects.toMatchObject({ code: 'conflict' })
  })
})
