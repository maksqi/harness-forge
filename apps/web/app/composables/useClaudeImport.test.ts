// useClaudeImport (Phase 12, ADR-055; docs/UI.md 11.9; C46 signature, W12.10-T1): the calls of the import dialog. A file
// outside the allowlist is never uploaded (whoever calls it), the caps are checked before an upload, and a fresh-auth
// refusal of the scan or the apply opens the password prompt of `useFreshAuth().run`.
import type { MockApi } from '~/utils/testing/mock-api'
import { CLAUDE_HOME_LIMITS, CLAUDE_IMPORT_UPLOAD_PARTS, HarnessError } from '@harness-forge/shared'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick } from 'vue'
import { useAuthStore } from '~/stores/auth'
import { authStatus, claudeImportApplyResult, claudeImportHome, claudeImportPlan, importPlanId } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import { useClaudeImport } from './useClaudeImport'
import { useFreshAuth } from './useFreshAuth'

const mock = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))
vi.mock('./useApi', () => ({ useApi: () => mock.api }))

let api: MockApi
let pinia: ReturnType<typeof createPinia>

beforeEach(() => {
  api = createMockApi()
  mock.api = api
  pinia = createPinia()
  setActivePinia(pinia)
})

afterEach(() => {
  disposePinia(pinia)
})

/** A picked file of the folder `.claude` (`webkitRelativePath` starts with the picked folder's name). */
function picked(path: string, size = 1): File {
  const file = new File([new Uint8Array(size)], path.split('/').at(-1)!)
  Object.defineProperty(file, 'webkitRelativePath', { value: `.claude/${path}` })
  return file
}

/** A file whose reported size is `size` (no bytes are allocated). */
function sized(name: string, size: number): File {
  const file = new File(['x'], name)
  Object.defineProperty(file, 'size', { value: size })
  return file
}

function uploadedNames(call = 0): string[] {
  const form = api.claudeImport.upload.mock.calls[call]![0].form as FormData
  return (form.getAll(CLAUDE_IMPORT_UPLOAD_PARTS.files) as File[]).map(file => file.name)
}

const forbidden = () => new HarnessError({ code: 'forbidden', message: 'Log in again to continue.', action: 'login' })

describe('useClaudeImport', () => {
  it('asks for the server home and scans it', async () => {
    api.claudeImport.home.mockResolvedValue(claudeImportHome())
    api.claudeImport.scan.mockResolvedValue(claudeImportPlan({ source: 'scan' }))
    const claude = useClaudeImport()
    expect(await claude.serverHome()).toEqual(claudeImportHome())
    expect((await claude.scanServer()).source).toBe('scan')
  })

  it('uploads the picked files by their relative path and the .claude.json', async () => {
    api.claudeImport.upload.mockResolvedValue(claudeImportPlan())
    await useClaudeImport().planFromFiles([new File(['a'], 'agents/a.md'), new File(['s'], 'settings.json')], new File(['{}'], '.claude.json'))
    const form = api.claudeImport.upload.mock.calls[0]![0].form as FormData
    expect((form.getAll(CLAUDE_IMPORT_UPLOAD_PARTS.files) as File[]).map(file => file.name)).toEqual(['agents/a.md', 'settings.json'])
    expect((form.get(CLAUDE_IMPORT_UPLOAD_PARTS.claudeJson) as File).name).toBe('.claude.json')
  })

  it('uploads a zip as is', async () => {
    api.claudeImport.upload.mockResolvedValue(claudeImportPlan())
    await useClaudeImport().planFromZip(new File(['PK'], 'claude.zip'))
    const form = api.claudeImport.upload.mock.calls[0]![0].form as FormData
    expect((form.get(CLAUDE_IMPORT_UPLOAD_PARTS.zip) as File).name).toBe('claude.zip')
    expect(form.get('label')).toBe('claude.zip')
  })

  it('applies a selection by plan id and item keys', async () => {
    api.claudeImport.apply.mockResolvedValue(claudeImportApplyResult())
    await useClaudeImport().apply(importPlanId(1), { items: { 'agent:reviewer:agents/reviewer.md': { action: 'import' } }, instructions: 'append' })
    expect(api.claudeImport.apply).toHaveBeenCalledWith({
      body: { planId: importPlanId(1), items: [{ key: 'agent:reviewer:agents/reviewer.md', action: 'import' }], instructions: 'append' },
    })
  })

  it('never uploads a file outside the allowlist, whoever calls it', async () => {
    api.claudeImport.upload.mockResolvedValue(claudeImportPlan())
    await useClaudeImport().planFromFiles([
      picked('agents/reviewer.md'),
      picked('.credentials.json'),
      picked('projects/abc/session.jsonl'),
      picked('history.jsonl'),
      picked('settings.local.json'),
      picked('plugins/installed_plugins.json'),
      picked('skills/pdf/helper.py'),
      picked('CLAUDE.md'),
    ], null)
    expect(uploadedNames()).toEqual(['CLAUDE.md', 'agents/reviewer.md'])
  })

  it('checks the caps before an upload starts', async () => {
    const claude = useClaudeImport()
    await expect(claude.planFromFiles([picked('history.jsonl')], null)).rejects.toMatchObject({ code: 'validation_error', message: 'Nothing to import in this folder.' })
    await expect(claude.planFromFiles([picked('agents/a.md')], sized('.claude.json', CLAUDE_HOME_LIMITS.claudeJsonBytes + 1))).rejects.toMatchObject({ code: 'validation_error' })
    const big = [picked('CLAUDE.md'), sized('.claude.json', CLAUDE_HOME_LIMITS.claudeJsonBytes)]
    Object.defineProperty(big[0]!, 'size', { value: CLAUDE_HOME_LIMITS.claudeMdBytes })
    // 1 MiB + 16 MiB stays under 32 MiB: allowed.
    api.claudeImport.upload.mockResolvedValue(claudeImportPlan())
    await claude.planFromFiles([big[0]!], big[1]!)
    expect(api.claudeImport.upload).toHaveBeenCalledTimes(1)
    await expect(claude.planFromZip(sized('claude.zip', CLAUDE_HOME_LIMITS.totalBytes + 1))).rejects.toMatchObject({ code: 'payload_too_large', message: 'The upload is larger than 32 MiB.' })
    expect(api.claudeImport.upload).toHaveBeenCalledTimes(1)
  })

  it('sends a .claude.json alone under its fixed part name', async () => {
    api.claudeImport.upload.mockResolvedValue(claudeImportPlan())
    await useClaudeImport().planFromFiles([], new File(['{}'], 'my-claude.json'))
    const form = api.claudeImport.upload.mock.calls[0]![0].form as FormData
    expect(form.getAll(CLAUDE_IMPORT_UPLOAD_PARTS.files)).toEqual([])
    expect((form.get(CLAUDE_IMPORT_UPLOAD_PARTS.claudeJson) as File).name).toBe('.claude.json')
  })

  it('turns a fresh-auth refusal of the scan and the apply into the password prompt', async () => {
    const auth = useAuthStore()
    auth.status = authStatus({ enabled: true, source: 'settings', freshUntil: Date.now() + 600_000 })
    api.auth.login.mockResolvedValue(authStatus({ enabled: true, source: 'settings', freshUntil: Date.now() + 600_000 }))
    api.claudeImport.scan.mockRejectedValueOnce(forbidden()).mockResolvedValueOnce(claudeImportPlan({ source: 'scan' }))
    api.claudeImport.apply.mockRejectedValueOnce(forbidden()).mockResolvedValueOnce(claudeImportApplyResult())
    const scope = effectScope()
    const { claude, freshAuth } = scope.run(() => ({ claude: useClaudeImport(), freshAuth: useFreshAuth() }))!

    const scan = freshAuth.run(() => claude.scanServer(), { required: true })
    await vi.waitFor(() => expect(freshAuth.open.value).toBe(true))
    await freshAuth.submit('correct-horse')
    expect((await scan).source).toBe('scan')
    expect(api.claudeImport.scan).toHaveBeenCalledTimes(2)

    const apply = freshAuth.run(() => claude.apply(importPlanId(1), { items: { a: { action: 'import' } }, instructions: 'skip' }), { required: true })
    await vi.waitFor(() => expect(freshAuth.open.value).toBe(true))
    await freshAuth.submit('correct-horse')
    await nextTick()
    expect(await apply).toEqual(claudeImportApplyResult())
    expect(api.claudeImport.apply).toHaveBeenLastCalledWith({ body: { planId: importPlanId(1), items: [{ key: 'a', action: 'import' }] } })
    scope.stop()
  })
})
