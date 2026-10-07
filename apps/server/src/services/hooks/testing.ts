// Test kit of the Phase 12 hook tests (W12.5; never imported by production code): a test app with a project in a
// `realpath(mkdtemp())` root, the real hook service with its spawns observed (every shell pid must be dead after each
// test), the C36 fakes of the project config reader and project trust (or the real ones), a recording of every server
// event, and a stand-in for the provider's model resolution that answers `MockLanguageModelV4` models.
import type { LanguageModelV4 } from '@ai-sdk/provider'
import type { ProjectSummary, ServerEvent } from '@harness-forge/shared'
import type { ResolvedModel } from '../../providers/types.ts'
import type { TestApp, TestAppOptions } from '../../testing/create-test-app.ts'
import type { FakeProjectConfigService } from '../../testing/fake-project-config.ts'
import type { FakeProjectTrustService } from '../../testing/fake-project-trust.ts'
import type { OpenWorkspace } from '../projects/types.ts'
import type { HookServiceOptions } from './index.ts'
import type { HookScope, HookService } from './types.ts'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { vi } from 'vitest'
import { createTestApp } from '../../testing/create-test-app.ts'
import { createHookService } from './index.ts'

export const TEST_CHAT_ID = '0199a8f0-0000-7000-8000-0000000000d5'

/** True while a process exists (a zombie counts until it is reaped). */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Polls `check` every 20 ms until it holds (rejects after `timeoutMs`). */
export async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!await check()) {
    if (Date.now() > deadline)
      throw new Error('Timed out waiting for a condition.')
    await delay(20)
  }
}

export interface HookHarness {
  readonly t: TestApp
  readonly hooks: HookService
  readonly project: ProjectSummary
  /** The project folder (canonical). */
  readonly root: string
  readonly workspace: OpenWorkspace
  readonly events: ServerEvent[]
  /** Shell pids in spawn order. */
  readonly spawned: number[]
  /** The fakes (only with `fakes: true`). */
  readonly config: FakeProjectConfigService
  readonly trust: FakeProjectTrustService
}

export interface OpenOptions {
  /** Extra environment of the test app (`HF_MOCK_PROVIDER=1` is always set). */
  readonly env?: Record<string, string>
  readonly service?: HookServiceOptions
  /** Use the C36 fakes of the project config reader and project trust (default true). */
  readonly fakes?: boolean
  /** More test app options. */
  readonly app?: Partial<TestAppOptions>
}

export interface HookTestKit {
  readonly open: (options?: OpenOptions) => Promise<HookHarness>
  /** Registers a cleanup (run in reverse order by `cleanup`). */
  readonly defer: (cleanup: () => Promise<void> | void) => void
  /** Pids a test started besides the shells (`sleep` children): checked dead by `cleanup`. */
  readonly pids: number[]
  /** `afterEach`: runs the cleanups and waits until every spawned pid is dead. */
  readonly cleanup: () => Promise<void>
}

export function createHookTestKit(): HookTestKit {
  const cleanups: Array<() => Promise<void> | void> = []
  const pids: number[] = []

  async function open(options: OpenOptions = {}): Promise<HookHarness> {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'hf-')))
    cleanups.push(() => rm(base, { recursive: true, force: true }))
    const spawned: number[] = []
    const fakes = options.fakes !== false
    const t = await createTestApp({
      workspaceRoots: [base],
      env: { HF_MOCK_PROVIDER: '1', ...options.env },
      ...(fakes ? { projectConfig: 'fake' as const, projectTrust: 'fake' as const } : {}),
      ...options.app,
      factories: {
        ...options.app?.factories,
        hooks: deps => createHookService(deps, {
          ...options.service,
          runner: {
            killGraceMs: 200,
            ...options.service?.runner,
            onSpawn: (pid) => {
              spawned.push(pid)
              pids.push(pid)
            },
          },
        }),
      },
    })
    cleanups.push(() => t.close())
    const project = await t.deps.projects.create({ name: 'Demo', path: base, newFolder: 'demo' })
    const opened = await t.deps.projects.openWorkspace(project.id)
    if (!opened.ok)
      throw new Error(opened.message)
    const events: ServerEvent[] = []
    const subscription = t.deps.events.subscribe(event => events.push(event))
    cleanups.push(() => subscription.dispose())
    return {
      t,
      hooks: t.deps.hooks,
      project,
      root: opened.workspace.root,
      workspace: opened.workspace,
      events,
      spawned,
      config: t.deps.projectConfig as FakeProjectConfigService,
      trust: t.deps.projectTrust as FakeProjectTrustService,
    }
  }

  return {
    open,
    pids,
    defer: cleanup => cleanups.push(cleanup),
    cleanup: async () => {
      vi.restoreAllMocks()
      vi.unstubAllEnvs()
      for (const cleanup of cleanups.splice(0).reverse())
        await cleanup()
      const started = pids.splice(0)
      await waitFor(() => started.every(pid => !alive(pid)))
    },
  }
}

/** The scope of a run of the harness's project (a test chat id, `ask`, the run model `mock:echo`). */
export function hookScope(h: Pick<HookHarness, 'project' | 'workspace'>, fields: Partial<HookScope> = {}): HookScope {
  return { chatId: TEST_CHAT_ID, projectId: h.project.id, workspace: h.workspace, toolMode: 'ask', origin: 'request', modelRef: 'mock:echo', ...fields }
}

export function testSignal(): AbortSignal {
  return new AbortController().signal
}

/**
 * Makes `providers.resolveModel` answer `models[ref]` (a mock language model, as the resolution of the real `mock:echo`
 * with the ref, ids and model replaced); other refs resolve as before. Returns the refs asked for.
 */
export function stubModels(t: TestApp, models: Readonly<Record<string, LanguageModelV4>>): string[] {
  const asked: string[] = []
  const real = t.deps.providers.resolveModel.bind(t.deps.providers)
  vi.spyOn(t.deps.providers, 'resolveModel').mockImplementation(async (ref, resolveOptions) => {
    asked.push(ref)
    const model = models[ref]
    if (model === undefined)
      return real(ref, resolveOptions)
    const base = await real('mock:echo', resolveOptions)
    const separator = ref.indexOf(':')
    return { ...base, modelRef: ref, providerId: ref.slice(0, separator), modelId: ref.slice(separator + 1), model } as ResolvedModel
  })
  return asked
}
