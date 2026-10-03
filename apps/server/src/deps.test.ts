import type { CreateDepsOptions } from './deps.ts'
import type { CheckpointService } from './services/checkpoints/types.ts'
import type { ProjectFileService } from './services/project-files/types.ts'
import type { ShellRuleService } from './services/shell-rules/types.ts'
import type { FakeCheckpointService } from './testing/fake-checkpoints.ts'
import type { FakeProjectFileService } from './testing/fake-project-files.ts'
import type { FakeProjectService } from './testing/fake-projects.ts'
import type { FakeShellRuleService } from './testing/fake-shell-rules.ts'
import type { AppDeps } from './types.ts'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { getConnInfo } from '@hono/node-server/conninfo'
import { afterEach, describe, expect, it } from 'vitest'
import { chatBody, postChat, readSse, runnerOf, streamedText, testChatId } from './chat/testing.ts'
import { openDatabase } from './db/client.ts'
import { createDeps, SERVICE_FACTORIES, SERVICE_NAMES, SHUTDOWN_STEPS, startDeps, stopDeps } from './deps.ts'
import { EnvError, loadEnv } from './env.ts'
import { createMemoryLogger } from './logger.ts'
import { createPluginInstaller } from './plugins/install/index.ts'
import { createRedactor } from './security/redact.ts'
import { createCheckpointService } from './services/checkpoints/index.ts'
import { createDataService } from './services/data/index.ts'
import { createProjectFileService } from './services/project-files/index.ts'
import { createProjectService } from './services/projects/index.ts'
import { SAMPLE_SHARE_TOKEN } from './testing/api-samples.ts'
import { createTestApp } from './testing/create-test-app.ts'
import { createFakeProjectFileService } from './testing/fake-project-files.ts'
import { createFakeProjectService } from './testing/fake-projects.ts'
import {
  createFakeAudioService,
  createFakeDataService,
  createFakeImageService,
  createFakeKeyring,
  createFakeShareService,
  createMemorySettingsService,
  createRecordingEventBus,
} from './testing/fakes.ts'
import { resolveWorkspacePath } from './workspace/paths.ts'

const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup()
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harness-forge-deps-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

async function baseOptions(): Promise<CreateDepsOptions> {
  const database = await openDatabase({ path: ':memory:' })
  cleanups.push(() => database.close())
  return {
    env: loadEnv({ HF_DATA_DIR: tempDir() }),
    logger: createMemoryLogger().logger,
    redactor: createRedactor(),
    db: database.db,
    builtins: [],
    overrides: { keyring: createFakeKeyring() },
  }
}

describe('createDeps', () => {
  it('creates every service of AppServices', async () => {
    const deps = createDeps(await baseOptions())
    expect([...SERVICE_NAMES].sort()).toEqual(Object.keys(SERVICE_FACTORIES).sort())
    for (const name of SERVICE_NAMES)
      expect(deps[name], name).toBeDefined()
    expect(Object.isFrozen(deps)).toBe(true)
  })

  it('uses overrides instead of factories', async () => {
    const events = createRecordingEventBus()
    const deps = createDeps({ ...(await baseOptions()), overrides: { events } })
    expect(deps.events).toBe(events)
  })

  it('lets a factory read services declared after it while it runs', async () => {
    const settings = createMemorySettingsService()
    let seenByEvents: unknown
    const deps = createDeps({
      ...(await baseOptions()),
      factories: {
        // `events` is created before `settings` in SERVICE_NAMES order.
        events: (d) => {
          seenByEvents = d.settings
          return createRecordingEventBus()
        },
        settings: () => settings,
      },
    })
    expect(seenByEvents).toBe(settings)
    expect(deps.settings).toBe(settings)
  })

  it('reports construction cycles', async () => {
    const options = await baseOptions()
    expect(() => createDeps({
      ...options,
      factories: {
        events: (d) => {
          void d.settings
          return createRecordingEventBus()
        },
        settings: (d) => {
          void d.events
          return createMemorySettingsService()
        },
      },
    })).toThrow(/Circular dependency/)
  })

  it('fails when a factory throws', async () => {
    const options = await baseOptions()
    expect(() => createDeps({
      ...options,
      factories: {
        registry: () => {
          throw new Error('invalid master key')
        },
      },
    })).toThrow('invalid master key')
  })
})

describe('remaining stubs (chat runs until W2.1, tool prefs until W3.5)', () => {
  it('stub queries are safe no-ops; lifecycle, subscriptions and events work', async () => {
    const t = await createTestApp()
    cleanups.push(() => t.close())
    expect(t.deps.runs.isActive('0199a8f0-0000-7000-8000-000000000001')).toBe(false)
    expect(t.deps.runs.active()).toEqual([])
    await expect(t.deps.runs.stop('0199a8f0-0000-7000-8000-000000000001')).resolves.toBe(false)
    expect((await t.deps.tools.prefs()).size).toBe(0)
    t.deps.registry.onChange(() => {}).dispose()
    t.deps.events.emit('catalog.changed', { providerId: null })
    await expect(startDeps(t.deps)).resolves.toBeUndefined()
    await expect(stopDeps(t.deps)).resolves.toBeUndefined()
  })
})

describe('phase 5 services', () => {
  it('wires the data and share services (implemented in P5-A)', async () => {
    const t = await createTestApp({ start: false })
    cleanups.push(() => t.close())
    expect(SERVICE_NAMES).toEqual(expect.arrayContaining(['data', 'shares']))
    await expect(t.deps.data.summary()).resolves.toMatchObject({ chats: 0, messages: 0, files: 0 })
    await expect(t.deps.shares.list({})).resolves.toEqual([])
    await expect(t.deps.shares.view(SAMPLE_SHARE_TOKEN)).rejects.toMatchObject({ code: 'not_found' })
    await expect(t.deps.files.purge()).resolves.toMatchObject({ files: 0 })
  })

  it('createTestApp accepts the Phase 5 fakes as overrides', async () => {
    const data = createFakeDataService()
    const shares = createFakeShareService()
    const t = await createTestApp({ start: false, overrides: { data, shares } })
    cleanups.push(() => t.close())
    expect(t.deps.data).toBe(data)
    expect(t.deps.shares).toBe(shares)
    expect(t.deps.runs.hasRun('0199a8f0-0000-7000-8000-000000000001')).toBe(false)
  })
})

describe('phase 6 services (P6-0b skeleton, implemented in P6-A)', () => {
  it('wires the image and audio services; no new member answers not_implemented any more', async () => {
    const t = await createTestApp({ start: false })
    cleanups.push(() => t.close())
    expect(SERVICE_NAMES).toEqual(expect.arrayContaining(['images', 'audio']))
    const signal = new AbortController().signal
    const calls: Array<[string, () => Promise<unknown>]> = [
      ['images.generate', () => t.deps.images.generate({ modelRef: 'mock:image', prompt: 'a red fox', n: 1, signal, chatId: null, messageId: null })],
      ['audio.transcribe', () => t.deps.audio.transcribe({ file: new Blob([new Uint8Array(128)], { type: 'audio/webm' }), form: {}, signal })],
      ['audio.speak', () => t.deps.audio.speak({ text: 'Hello world', signal })],
      ['files.saveGenerated', () => t.deps.files.saveGenerated({ data: new Uint8Array([0x89, 0x50, 0x4E, 0x47]), mediaType: 'image/png', name: 'image-1.png' })],
      ['chats.deleteMessage', () => t.deps.chats.deleteMessage('0199a8f0-0000-7000-8000-000000000001', 'msg_AAAAAAAAAAAAAAAA')],
      ['providers.resolveImageModel', () => t.deps.providers.resolveImageModel('mock:image')],
      ['providers.resolveTranscriptionModel', () => t.deps.providers.resolveTranscriptionModel('mock:transcribe', { signal })],
      ['providers.resolveSpeechModel', () => t.deps.providers.resolveSpeechModel('mock:speech')],
    ]
    for (const [name, call] of calls) {
      // Each call may resolve or fail for its own reason (no model set, unknown chat, a bad file), never as a stub.
      const outcome: unknown = await call().then(() => null, (reason: unknown) => reason)
      expect((outcome as { code?: unknown } | null)?.code, name).not.toBe('not_implemented')
    }
    // The existing members keep working next to the stubs.
    await expect(t.deps.chats.list({})).resolves.toMatchObject({ items: [] })
  })

  it('createTestApp accepts the Phase 6 fakes', async () => {
    const audio = createFakeAudioService()
    const t = await createTestApp({ start: false, overrides: { audio }, factories: { images: createFakeImageService } })
    cleanups.push(() => t.close())
    expect(t.deps.audio).toBe(audio)
    expect('calls' in t.deps.images).toBe(true)
  })
})

describe('phase 7 services (projects, maintenance, keys)', () => {
  it('wires projects, maintenance and keys (the project service is real since W7.1)', async () => {
    const t = await createTestApp({ start: false })
    cleanups.push(() => t.close())
    expect(SERVICE_NAMES).toEqual(expect.arrayContaining(['projects', 'maintenance', 'keys']))
    await expect(t.deps.projects.list()).resolves.toEqual([])
    expect(t.deps.maintenance.current()).toBeNull()
    await expect(t.deps.maintenance.exclusive('import', async () => 'done')).resolves.toBe('done')
    expect(typeof t.deps.keys.status).toBe('function')
  })

  it('startDeps runs projects.start() first: the default root <dataDir>/workspaces exists with mode 0700', async () => {
    const order: string[] = []
    const t = await createTestApp({
      start: false,
      factories: {
        projects: (d) => {
          const real = createProjectService(d)
          return { ...real, start: async () => {
            order.push('projects')
            await real.start()
          } }
        },
        installer: (d) => {
          const real = createPluginInstaller(d)
          return { ...real, recover: async () => {
            order.push('installer')
            await real.recover()
          } }
        },
      },
    })
    cleanups.push(() => t.close())
    expect(existsSync(t.env.paths.workspaces)).toBe(false)
    await startDeps(t.deps)
    expect(order).toEqual(['projects', 'installer'])
    expect(statSync(t.env.paths.workspaces).isDirectory()).toBe(true)
    if (process.platform !== 'win32')
      expect(statSync(t.env.paths.workspaces).mode & 0o777).toBe(0o700)
    expect(t.env.workspaceRootsDefault).toBe(true)
    expect(await t.deps.projects.roots()).toEqual([realpathSync(t.env.paths.workspaces)])
  })

  it('a refused root fails the boot before anything else starts', async () => {
    const order: string[] = []
    const t = await createTestApp({
      start: false,
      factories: {
        projects: d => ({ ...createProjectService(d), start: async () => {
          throw new EnvError('HF_WORKSPACE_ROOTS: /missing does not exist.')
        } }),
        installer: (d) => {
          const real = createPluginInstaller(d)
          return { ...real, recover: async () => {
            order.push('installer')
          } }
        },
      },
    })
    cleanups.push(() => t.close())
    await expect(startDeps(t.deps)).rejects.toBeInstanceOf(EnvError)
    expect(order).toEqual([])
  })

  it('createTestApp sets HF_WORKSPACE_ROOTS and HF_WORKSPACE_SHELL; explicit roots skip the default root', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'hf-')))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    const t = await createTestApp({ workspaceRoots: [root], workspaceShell: false })
    cleanups.push(() => t.close())
    expect(t.env).toMatchObject({ workspaceRoots: [root], workspaceRootsDefault: false, workspaceShell: false })
    expect(await t.deps.projects.roots()).toEqual([root])
    expect(existsSync(t.env.paths.workspaces)).toBe(false)
    // `env` wins over the options.
    const u = await createTestApp({ start: false, workspaceShell: false, env: { HF_WORKSPACE_SHELL: '1' } })
    cleanups.push(() => u.close())
    expect(u.env.workspaceShell).toBe(true)
  })

  it('the temp data directory of createTestApp is canonical (realpath)', async () => {
    const t = await createTestApp({ start: false })
    cleanups.push(() => t.close())
    expect(realpathSync(t.env.dataDir)).toBe(t.env.dataDir)
  })

  it('createTestApp accepts the Phase 7 fake project service', async () => {
    const t = await createTestApp({ factories: { projects: createFakeProjectService } })
    cleanups.push(() => t.close())
    const projects = t.deps.projects as FakeProjectService
    const project = await projects.add({ name: 'Demo' })
    const opened = await t.deps.projects.openWorkspace(project.id)
    expect(opened).toMatchObject({ ok: true, workspace: { projectId: project.id, name: 'Demo', root: project.path } })
  })
})

describe('testing helpers', () => {
  it('the fake keyring derives stable, distinct 32-byte subkeys', () => {
    const keyring = createFakeKeyring()
    const session = keyring.subkey('session')
    expect(session).toHaveLength(32)
    expect(keyring.subkey('session')).toEqual(session)
    expect(keyring.subkey('encryption')).not.toEqual(session)
    const share = keyring.subkey('share')
    expect(share).toHaveLength(32)
    expect(createFakeKeyring().subkey('share')).toEqual(share)
    for (const other of ['encryption', 'session', 'approval'] as const)
      expect(keyring.subkey(other)).not.toEqual(share)
  })

  it('the recording event bus delivers, records and closes subscribers', async () => {
    const bus = createRecordingEventBus()
    const seen: string[] = []
    let closed = false
    const subscription = bus.subscribe(event => seen.push(event.type), { onClose: () => (closed = true) })
    bus.emit('catalog.changed', { providerId: 'openai' })
    expect(seen).toEqual(['catalog.changed'])
    expect(bus.ofType('catalog.changed')[0]?.data.providerId).toBe('openai')
    subscription.dispose()
    expect(bus.subscriberCount()).toBe(0)
    bus.subscribe(() => {}, { onClose: () => (closed = true) })
    await bus.stop()
    expect(closed).toBe(true)
  })

  it('createTestApp shares a database file between two instances', async () => {
    const dataDir = tempDir()
    const databasePath = join(dataDir, 'shared.db')
    const first = await createTestApp({ dataDir, databasePath })
    await first.database.client.execute(`INSERT INTO settings (key, value, updated_at) VALUES ('_probe', '1', 1)`)
    await first.close()
    const second = await createTestApp({ dataDir, databasePath })
    cleanups.push(() => second.close())
    const result = await second.database.client.execute(`SELECT value FROM settings WHERE key = '_probe'`)
    expect(result.rows).toHaveLength(1)
  })

  it('createTestApp requests carry node-server bindings (getConnInfo works)', async () => {
    const t = await createTestApp({ start: false })
    cleanups.push(() => t.close())
    t.app.get('/conn', c => c.json(getConnInfo(c).remote))
    expect(await (await t.request('/conn')).json()).toMatchObject({ address: '127.0.0.1', addressType: 'IPv4' })
    const remote = await (await t.request('/conn', undefined, { remoteAddress: '::1' })).json()
    expect(remote).toMatchObject({ address: '::1', addressType: 'IPv6' })
  })

  it('createTestApp exposes a typed client and parses test env vars', async () => {
    const t = await createTestApp({ env: { HF_SAFE_MODE: '1' } })
    cleanups.push(() => t.close())
    expect(await t.client.health.get()).toMatchObject({ ok: true, safeMode: true })
    expect(await t.client.settings.get()).toMatchObject({ maxSteps: expect.any(Number) })
  })
})

describe('phase 8 skeleton (checkpoints, shell rules, the data service lifecycle)', () => {
  const CHAT = '0199a8f0-0000-7000-8000-000000000081'

  it('wires checkpoints and shellRules; no member answers not_implemented any more (implemented in P8-A)', async () => {
    const t = await createTestApp()
    cleanups.push(() => t.close())
    expect(SERVICE_NAMES).toEqual(expect.arrayContaining(['checkpoints', 'shellRules']))
    const { checkpoints, shellRules } = t.deps
    const calls: Array<[string, () => Promise<unknown>]> = [
      ['checkpoints.listChanges', () => checkpoints.listChanges(CHAT)],
      ['checkpoints.fileDiff', () => checkpoints.fileDiff(CHAT, { source: 'chat', path: 'a.txt' })],
      ['checkpoints.gitStatus', () => checkpoints.gitStatus(CHAT)],
      ['checkpoints.revert', () => checkpoints.revert(CHAT, { source: 'chat', path: 'a.txt' })],
      ['checkpoints.undo', () => checkpoints.undo(CHAT, { batchId: 'wcb_AAAAAAAAAAAAAAAA', conflicts: 'skip' })],
      ['checkpoints.rewindPreview', () => checkpoints.rewindPreview(CHAT, 'msg_AAAAAAAAAAAAAAAA')],
      ['checkpoints.rewind', () => checkpoints.rewind(CHAT, { messageId: 'msg_AAAAAAAAAAAAAAAA', conflicts: 'skip' })],
      ['shellRules.list', () => shellRules.list()],
      ['shellRules.create', () => shellRules.create({ projectId: null, prefix: 'ls' })],
      ['shellRules.remove', () => shellRules.remove('srl_AAAAAAAAAAAAAAAA')],
    ]
    for (const [name, call] of calls) {
      // Each call may resolve or fail for its own reason (an unknown chat, rule or batch), never as a stub.
      const outcome: unknown = await call().then(() => null, (reason: unknown) => reason)
      expect((outcome as { code?: unknown } | null)?.code, name).not.toBe('not_implemented')
    }
    // An empty store and the rule set of a run.
    await expect(checkpoints.summary()).resolves.toEqual({ bytes: 0, blobs: 0 })
    await expect(checkpoints.prune()).resolves.toMatchObject({ evictedByAge: 0, evictedByBudget: 0 })
    expect(await shellRules.forRun('prj_AAAAAAAAAAAAAAAA')).toEqual({ projectId: 'prj_AAAAAAAAAAAAAAAA', prefixes: ['ls'] })
    expect(await shellRules.forRun(null)).toEqual({ projectId: null, prefixes: [] })
    await expect(t.deps.data.start()).resolves.toBeUndefined()
    await expect(t.deps.data.stop()).resolves.toBeUndefined()
  })

  it('startDeps creates <dataDir>/checkpoints with mode 0700 (not ensureDataDir)', async () => {
    const t = await createTestApp({ start: false })
    cleanups.push(() => t.close())
    expect(t.env.paths.checkpoints).toBe(join(t.env.dataDir, 'checkpoints'))
    expect(existsSync(t.env.paths.checkpoints)).toBe(false)
    await startDeps(t.deps)
    expect(statSync(t.env.paths.checkpoints).isDirectory()).toBe(true)
    if (process.platform !== 'win32')
      expect(statSync(t.env.paths.checkpoints).mode & 0o777).toBe(0o700)
    // Idempotent: a second boot keeps the folder.
    await t.deps.checkpoints.start()
    expect(statSync(t.env.paths.checkpoints).isDirectory()).toBe(true)
  })

  it('the journal writes for an unknown chat without a row: produce sees the before-state, the abort check runs before the write', async () => {
    const t = await createTestApp({ factories: { projects: createFakeProjectService } })
    cleanups.push(() => t.close())
    const project = await (t.deps.projects as FakeProjectService).add({ name: 'Journal', files: { 'notes.txt': 'old\n' } })
    const journal = t.deps.checkpoints.journal({ chatId: CHAT, messageId: 'msg_AAAAAAAAAAAAAAAA', projectId: project.id })
    expect(journal.scope).toEqual({ chatId: CHAT, messageId: 'msg_AAAAAAAAAAAAAAAA', projectId: project.id })
    const signal = new AbortController().signal

    const seen: string[] = []
    const updated = await journal.write({
      toolCallId: 'call_1',
      tool: 'edit_file',
      root: project.path,
      resolved: await resolveWorkspacePath(project.path, 'notes.txt', { allowMissing: true }),
      produce: (before) => {
        seen.push(before.state)
        return before.state === 'present' ? `${before.bytes.toString('utf8')}new\n` : 'unexpected'
      },
      signal,
    })
    expect(updated).toMatchObject({ recorded: false, before: { state: 'present', size: 4 }, written: { rel: 'notes.txt', created: false } })
    expect(readFileSync(join(project.path, 'notes.txt'), 'utf8')).toBe('old\nnew\n')

    const created = await journal.write({
      toolCallId: 'call_2',
      tool: 'write_file',
      root: project.path,
      resolved: await resolveWorkspacePath(project.path, 'src/new.txt', { allowMissing: true }),
      produce: (before) => {
        seen.push(before.state)
        return 'created\n'
      },
      signal,
    })
    expect(created).toMatchObject({ recorded: false, before: { state: 'missing' }, written: { rel: 'src/new.txt', created: true } })
    expect(seen).toEqual(['present', 'missing'])

    const controller = new AbortController()
    await expect(journal.write({
      toolCallId: 'call_3',
      tool: 'write_file',
      root: project.path,
      resolved: await resolveWorkspacePath(project.path, 'notes.txt', { allowMissing: true }),
      produce: () => {
        controller.abort(new Error('stopped'))
        return 'never written'
      },
      signal: controller.signal,
    })).rejects.toThrow('stopped')
    expect(readFileSync(join(project.path, 'notes.txt'), 'utf8')).toBe('old\nnew\n')
    await expect(journal.recordShell({ toolCallId: 'call_4', command: 'ls' })).resolves.toBeUndefined()
    await expect(journal.recordUntracked({ toolCallId: 'call_5', tool: 'plugin_tool' })).resolves.toBeUndefined()
    // P8-A: the before blob of the edit is stored; the row cannot be inserted for an unknown chat (foreign key), so
    // nothing is recorded and prune removes the orphan blob later.
    expect(await t.deps.checkpoints.summary()).toEqual({ bytes: 4, blobs: 1 })
  })

  it('a chat run still works: mock:workspace and mock:checkpoint in a project chat (auto, no shell)', async () => {
    const t = await createTestApp({ env: { HF_MOCK_PROVIDER: '1' }, workspaceShell: false, factories: { projects: createFakeProjectService } })
    cleanups.push(() => t.close())
    const project = await (t.deps.projects as FakeProjectService).add({ name: 'Runs' })

    const workspace = await readSse(await postChat(t, chatBody(testChatId(0x801), 'go', { modelRef: 'mock:workspace', toolMode: 'auto', projectId: project.id })))
    expect(streamedText(workspace.chunks)).toBe('Workspace done.')
    expect(readFileSync(join(project.path, 'mock-workspace.txt'), 'utf8')).toBe('Hello from the workspace agent.\n')

    const checkpoint = await readSse(await postChat(t, chatBody(testChatId(0x802), 'first turn', { modelRef: 'mock:checkpoint', toolMode: 'auto', projectId: project.id })))
    expect(streamedText(checkpoint.chunks)).toBe('Checkpoint done.')
    expect(readFileSync(join(project.path, 'checkpoint.txt'), 'utf8')).toBe('Turn 1\n')
    await runnerOf(t).idle()
  })

  it('startDeps order: projects -> checkpoints -> installer -> plugins -> catalog -> mcp -> data (last)', async () => {
    const order: string[] = []
    const wrap = <K extends 'projects' | 'checkpoints' | 'plugins' | 'catalog' | 'mcp' | 'data'>(name: K, make: (d: AppDeps) => AppDeps[K]) => (d: AppDeps): AppDeps[K] => {
      const real = make(d) as AppDeps[K] & { start: () => Promise<void> }
      return { ...real, start: async () => {
        order.push(name)
        await real.start()
      } }
    }
    const t = await createTestApp({
      start: false,
      factories: {
        projects: wrap('projects', createProjectService),
        checkpoints: wrap('checkpoints', createCheckpointService),
        installer: (d) => {
          const real = createPluginInstaller(d)
          return { ...real, recover: async () => {
            order.push('installer')
            await real.recover()
          } }
        },
        data: wrap('data', createDataService),
      },
    })
    cleanups.push(() => t.close())
    const plugins = t.deps.plugins.start
    const catalog = t.deps.catalog.start
    const mcp = t.deps.mcp.start
    // The plugin host, catalog and MCP manager are frozen objects of their own: watch them through a proxy of deps.
    const watched = (name: string, start: () => Promise<void>) => async (): Promise<void> => {
      order.push(name)
      await start()
    }
    const deps = new Proxy(t.deps, {
      get(target, key, receiver) {
        if (key === 'plugins')
          return { ...target.plugins, start: watched('plugins', plugins) }
        if (key === 'catalog')
          return { ...target.catalog, start: watched('catalog', catalog) }
        if (key === 'mcp')
          return { ...target.mcp, start: watched('mcp', mcp) }
        return Reflect.get(target, key, receiver)
      },
    })
    await startDeps(deps)
    expect(order).toEqual(['projects', 'checkpoints', 'installer', 'plugins', 'catalog', 'mcp', 'data'])
  })

  it('stopDeps order: data (first) -> runs -> projectFiles -> checkpoints -> plugins -> mcp -> catalog -> events; a failing step still lets the next run', async () => {
    const t = await createTestApp()
    cleanups.push(() => t.close())
    const order: string[] = []
    const step = (name: string, fail = false) => async (): Promise<void> => {
      order.push(name)
      if (fail)
        throw new Error(`${name} failed`)
    }
    const deps = new Proxy(t.deps, {
      get(target, key, receiver) {
        switch (key) {
          case 'data': return { ...target.data, stop: step('data', true) }
          case 'runs': return { ...target.runs, stopAll: step('runs') }
          // Phase 9: a synchronous `stop()` that throws is a failed step like an async one.
          case 'projectFiles': return { ...target.projectFiles, stop: () => {
            order.push('projectFiles')
            throw new Error('projectFiles failed')
          } }
          case 'checkpoints': return { ...target.checkpoints, stop: step('checkpoints', true) }
          case 'plugins': return { ...target.plugins, stop: step('plugins') }
          case 'mcp': return { ...target.mcp, stop: step('mcp') }
          case 'catalog': return { ...target.catalog, stop: step('catalog') }
          case 'events': return { ...target.events, stop: step('events') }
          default: return Reflect.get(target, key, receiver)
        }
      },
    })
    await expect(stopDeps(deps)).resolves.toBeUndefined()
    expect(order).toEqual(['data', 'runs', 'projectFiles', 'checkpoints', 'plugins', 'mcp', 'catalog', 'events'])
    expect(order).toEqual([...SHUTDOWN_STEPS])
    const failures = t.logs.records.filter(record => record.msg === 'shutdown step failed').map(record => record.step)
    expect(failures).toEqual(['data', 'projectFiles', 'checkpoints'])
  })

  it('startDeps logs HF_TEST_FILE_SWEEP_DELAY_MS without HF_MOCK_PROVIDER=1 as a warning (ignored)', async () => {
    const ignored = await createTestApp({ env: { HF_TEST_FILE_SWEEP_DELAY_MS: '2000' } })
    cleanups.push(() => ignored.close())
    expect(ignored.env.testFileSweepDelayMs).toBeNull()
    const warning = 'the test-only automatic file sweep delay is ignored: it is honored only with HF_MOCK_PROVIDER=1'
    expect(ignored.logs.records.filter(record => record.level === 'warn').map(record => record.msg)).toContain(warning)
    const honored = await createTestApp({ env: { HF_TEST_FILE_SWEEP_DELAY_MS: '2000', HF_MOCK_PROVIDER: '1' } })
    cleanups.push(() => honored.close())
    expect(honored.env.testFileSweepDelayMs).toBe(2000)
    expect(honored.logs.text()).not.toContain('file sweep delay')
  })

  it('createTestApp accepts the Phase 8 fakes (checkpoints, shellRules) and ready services; factories win', async () => {
    const t = await createTestApp({ checkpoints: 'fake', shellRules: 'fake' })
    cleanups.push(() => t.close())
    const checkpoints = t.deps.checkpoints as FakeCheckpointService
    expect(checkpoints.started()).toBe(true)
    expect(await checkpoints.listChanges(CHAT)).toMatchObject({ available: false, reason: 'no-project' })
    const rules = t.deps.shellRules as FakeShellRuleService
    expect(await rules.create({ projectId: null, prefix: 'ls' })).toMatchObject({ projectId: null, prefix: 'ls' })
    expect(await rules.forRun(null)).toEqual({ projectId: null, prefixes: [] })

    const ready: ShellRuleService = { ...rules, forRun: async projectId => ({ projectId, prefixes: ['make'] }) }
    const override: CheckpointService = createCheckpointService(t.deps)
    const u = await createTestApp({ start: false, shellRules: ready, checkpoints: 'fake', overrides: { checkpoints: override } })
    cleanups.push(() => u.close())
    expect(u.deps.shellRules).toBe(ready)
    expect(u.deps.checkpoints).toBe(override)
  })

  it('a second boot keeps what checkpoints/ holds (the skeleton start only creates the folder)', async () => {
    const t = await createTestApp({ start: false })
    cleanups.push(() => t.close())
    await t.deps.checkpoints.start()
    const marker = join(t.env.paths.checkpoints, 'marker')
    writeFileSync(marker, 'keep')
    await startDeps(t.deps)
    expect(readFileSync(marker, 'utf8')).toBe('keep')
  })
})

describe('phase 9 skeleton (project files, the steer queue members, the stop order)', () => {
  const PROJECT = 'prj_AAAAAAAAAAAAAAAA'

  it('wires projectFiles: search and attach answer not_found for an unknown project; invalidate and stop are no-ops', async () => {
    const t = await createTestApp()
    cleanups.push(() => t.close())
    expect(SERVICE_NAMES).toContain('projectFiles')
    const { projectFiles } = t.deps
    await expect(projectFiles.search(PROJECT, { q: '', limit: 50 })).rejects.toMatchObject({ code: 'not_found' })
    await expect(projectFiles.attach(PROJECT, { path: 'a.txt' })).rejects.toMatchObject({ code: 'not_found' })
    expect(projectFiles.invalidate(PROJECT)).toBeUndefined()
    expect(projectFiles.stop()).toBeUndefined()
    expect(projectFiles.stop()).toBeUndefined()
    // The stub factory has the final signature and the production factory is it.
    expect(SERVICE_FACTORIES.projectFiles).toBe(createProjectFileService)
  })

  it('the project file index has no boot step: startDeps never touches projectFiles', async () => {
    const touched: string[] = []
    const watched = (d: AppDeps): ProjectFileService => {
      const real = createProjectFileService(d)
      return new Proxy(real, {
        get(target, key, receiver) {
          touched.push(String(key))
          return Reflect.get(target, key, receiver)
        },
      })
    }
    const t = await createTestApp({ factories: { projectFiles: watched } })
    cleanups.push(() => t.close())
    expect(touched).toEqual([])
    await t.close()
    expect(touched).toEqual(['stop'])
  })

  it('the stop order: the runs (queues first, inside stopAll) -> the file index -> checkpoints', async () => {
    expect(SHUTDOWN_STEPS).toEqual(['data', 'runs', 'projectFiles', 'checkpoints', 'plugins', 'mcp', 'catalog', 'events'])
    expect(SHUTDOWN_STEPS.indexOf('projectFiles')).toBe(SHUTDOWN_STEPS.indexOf('runs') + 1)
    // A runner's stopAll runs to its end (queues cleared, runs stopped) before the index is dropped.
    const t = await createTestApp()
    cleanups.push(() => t.close())
    const order: string[] = []
    const deps = new Proxy(t.deps, {
      get(target, key, receiver) {
        if (key === 'runs') {
          return { ...target.runs, stopAll: async () => {
            order.push('queues')
            await Promise.resolve()
            order.push('runs')
          } }
        }
        if (key === 'projectFiles')
          return { ...target.projectFiles, stop: () => void order.push('projectFiles') }
        if (key === 'checkpoints')
          return { ...target.checkpoints, stop: async () => void order.push('checkpoints') }
        return Reflect.get(target, key, receiver)
      },
    })
    await stopDeps(deps)
    expect(order).toEqual(['queues', 'runs', 'projectFiles', 'checkpoints'])
  })

  it('createTestApp accepts projectFiles: the fake and ready services; overrides and factories win', async () => {
    const t = await createTestApp({ projectFiles: 'fake' })
    cleanups.push(() => t.close())
    const files = t.deps.projectFiles as FakeProjectFileService
    files.files.set(PROJECT, ['src/app.ts'])
    expect(await files.search(PROJECT, { q: 'app', limit: 50 })).toMatchObject({ items: [{ path: 'src/app.ts', kind: 'file' }], truncated: false })
    expect(files.calls.search).toBe(1)

    const ready = createFakeProjectFileService()
    const u = await createTestApp({ start: false, projectFiles: ready })
    cleanups.push(() => u.close())
    expect(u.deps.projectFiles).toBe(ready)

    const override = createFakeProjectFileService()
    const v = await createTestApp({ start: false, projectFiles: 'fake', overrides: { projectFiles: override } })
    cleanups.push(() => v.close())
    expect(v.deps.projectFiles).toBe(override)

    const w = await createTestApp({ start: false, projectFiles: 'fake', factories: { projectFiles: createProjectFileService } })
    cleanups.push(() => w.close())
    await expect(w.deps.projectFiles.search(PROJECT, { q: '', limit: 1 })).rejects.toMatchObject({ code: 'not_found' })
  })

  it('the ChatRunner has the steer queue members', async () => {
    const t = await createTestApp({ start: false })
    cleanups.push(() => t.close())
    for (const member of ['queueList', 'enqueue', 'dequeue', 'clearQueue', 'stop', 'stopAll'] as const)
      expect(typeof t.deps.runs[member], member).toBe('function')
  })
})
