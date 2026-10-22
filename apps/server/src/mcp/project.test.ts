// Tests of the project MCP manager (Phase 11, ADR-050; W11.4-T1 – T5): the lazy runtimes behind `toolsFor` (approval,
// variables, verify-before-run, safe mode, the wait), the stdio and http transports (fixtures on loopback only), the
// stored variables (ciphertext, never `process.env`), the tools and shadowing, the stop paths (every pid and process
// group dead) and `project-mcp.changed`. Project config and trust are the C36 fakes.
import type { ToolDefinition } from '@harness-forge/plugin-sdk'
import type { ProjectMcpServer, ProjectMcpState } from '@harness-forge/shared'
import type { RegisteredTool } from '../registry/types.ts'
import type { HttpEchoServer } from './__fixtures__/harness.ts'
import type { ProjectMcpTestApp } from './project-testing.ts'
import type { ProjectMcpTools } from './types.ts'
import { Buffer } from 'node:buffer'
import { readdir, readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { HarnessError, projectMcpChangedDataSchema, projectMcpListSchema } from '@harness-forge/shared'
import { jsonSchema } from 'ai'
import { and, eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { secrets } from '../db/schema.ts'
import { createFakeElicitationBroker } from '../testing/fake-elicitations.ts'
import { createFakeMcpAuthService, fakeMcpAuthInfo, mcpAuthTargetKey } from '../testing/fake-mcp-auth.ts'
import { outputJson, outputText, processAlive, readMcpPids, runToolExecute, spyMcpCaches, startElicitServer, startHttpEchoServer, startStatusServer, toolContext, waitFor } from './__fixtures__/harness.ts'
import { HEADER_REJECTED_MESSAGE, NEEDS_AUTH_MESSAGE } from './errors.ts'
import { createProjectMcpTestApp, killAll, minServerItem, remoteServerItem } from './project-testing.ts'
import { createProjectVariableStore } from './project-variables.ts'
import { noProjectMcpTools } from './project.ts'

let h: ProjectMcpTestApp | null = null
const strays: Array<number | null> = []
const servers: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await h?.close()
  h = null
  killAll(strays.splice(0))
  for (const server of servers.splice(0))
    await server.close()
})

async function open(options: Parameters<typeof createProjectMcpTestApp>[0] = {}): Promise<ProjectMcpTestApp> {
  h = await createProjectMcpTestApp(options)
  return h
}

function tools(app: ProjectMcpTestApp, waitMs = 15_000, projectId = app.project.id): Promise<ProjectMcpTools> {
  return app.t.deps.projectMcp.toolsFor(projectId, { signal: new AbortController().signal, waitMs })
}

function toolNames(result: ProjectMcpTools): string[] {
  return result.tools.map(tool => tool.definition.name)
}

function tool(result: ProjectMcpTools, name: string): RegisteredTool {
  const found = result.tools.find(entry => entry.definition.name === name)
  if (found === undefined)
    throw new Error(`no tool ${name} in ${toolNames(result).join(', ')}`)
  return found
}

async function call(result: ProjectMcpTools, name: string, input: Record<string, unknown> = {}): Promise<unknown> {
  return (await runToolExecute(tool(result, name).definition.execute(input, toolContext()))).output
}

async function server(app: ProjectMcpTestApp, id: string): Promise<ProjectMcpServer> {
  const list = await app.t.deps.projectMcp.list(app.project.id)
  const found = list.items.find(item => item.id === id)
  if (found === undefined)
    throw new Error(`no server ${id}`)
  return found
}

async function stateOf(app: ProjectMcpTestApp, id: string): Promise<ProjectMcpState> {
  return (await server(app, id)).state
}

async function pidsOf(file: string): Promise<{ pid: number, grandchild: number | null }> {
  const pids = await readMcpPids(file)
  strays.push(pids.pid, pids.grandchild)
  return pids
}

async function expectDead(...pids: Array<number | null>): Promise<void> {
  for (const pid of pids) {
    if (pid !== null)
      await waitFor(() => !processAlive(pid), 8000)
  }
}

async function markers(folder: string): Promise<string[]> {
  return (await readdir(folder)).filter(name => name.startsWith('.mcp-started-'))
}

describe('project MCP manager: lazy start, variables, tools', () => {
  it('no process before approval and variables; the first toolsFor connects; stored values only; My_Server.v2 mapped', async () => {
    vi.stubEnv('MCP_TOKEN', 'env-leak')
    const app = await open()
    const pidFile = join(app.scratch, 'pids')
    // eslint-disable-next-line no-template-curly-in-string -- `.mcp.json` variable references are test data
    const item = minServerItem('My_Server.v2', ['--name', '${LABEL:-proj}', '--marker', '--pid-file', pidFile], { TOKEN: '${MCP_TOKEN}' })
    app.setServers([item])

    let list = await app.t.deps.projectMcp.list(app.project.id)
    expect(projectMcpListSchema.parse(list)).toEqual({
      items: [{ id: 'my-server-v2', name: 'My_Server.v2', transport: 'stdio', state: 'pending', sha256: item.sha256, tools: [], missingVariables: ['MCP_TOKEN'], auth: null }],
      variables: [
        { name: 'LABEL', set: false, hint: 'proj', usedBy: ['my-server-v2'] },
        { name: 'MCP_TOKEN', set: false, hint: null, usedBy: ['my-server-v2'] },
      ],
    })
    // Pending: nothing starts, nothing is unavailable, and with nothing approved the folder is not even read.
    const reads = app.config.reads.length
    expect(await tools(app)).toEqual(noProjectMcpTools())
    expect(app.config.reads).toHaveLength(reads)
    await app.approve(item)
    expect(await stateOf(app, 'my-server-v2')).toBe('needs-variables')
    expect(await tools(app)).toEqual(noProjectMcpTools())
    expect(await markers(app.project.path)).toEqual([])

    list = await app.t.deps.projectMcp.setVariables(app.project.id, { MCP_TOKEN: 'stored-token-1' })
    expect(list.items[0]).toMatchObject({ state: 'idle', missingVariables: [] })
    expect(list.variables.find(variable => variable.name === 'MCP_TOKEN')).toEqual({ name: 'MCP_TOKEN', set: true, hint: null, usedBy: ['my-server-v2'] })
    expect(JSON.stringify(list)).not.toContain('stored-token-1')
    expect(await markers(app.project.path)).toEqual([])

    const result = await tools(app)
    expect(toolNames(result)).toEqual(['mcp__my-server-v2__echo', 'mcp__my-server-v2__env', 'mcp__my-server-v2__pid'])
    expect(result.names).toEqual(new Map([['my-server-v2', 'My_Server.v2']]))
    expect(result.unavailable).toEqual([])
    expect(result.shadowed).toEqual(new Set())
    expect(result.tools.every(entry => entry.pluginId === 'core-mcp' && entry.mcpServerId === 'my-server-v2')).toBe(true)
    // The policy comes from the annotations (`readOnlyHint` -> safe).
    expect(tool(result, 'mcp__my-server-v2__echo').definition.policy).toBe('safe')
    const { pid } = await pidsOf(pidFile)

    // `${LABEL:-proj}` used its default; the env value is the stored one, never the server's environment.
    expect(outputText(await call(result, 'mcp__my-server-v2__echo', { text: 'hi' }))).toBe('proj echo: hi')
    expect(outputJson(await call(result, 'mcp__my-server-v2__env', { name: 'TOKEN' }))).toEqual({ value: 'stored-token-1' })
    expect(outputJson(await call(result, 'mcp__my-server-v2__env', { name: 'MCP_TOKEN' }))).toEqual({ value: null })
    const names = outputJson<{ names: string[] }>(await call(result, 'mcp__my-server-v2__env')).names
    expect(names.filter(name => name.startsWith('HF_') || name === 'MCP_TOKEN')).toEqual([])
    // cwd = the project root.
    expect(await markers(app.project.path)).toEqual([`.mcp-started-${pid}`])

    const connected = await server(app, 'my-server-v2')
    expect(connected).toMatchObject({ state: 'connected', tools: toolNames(result) })
    await waitFor(() => app.events.ofType('project-mcp.changed').some(event => event.data.servers[0]?.state === 'connected'))
    for (const event of app.events.ofType('project-mcp.changed'))
      expect(projectMcpChangedDataSchema.parse(event.data).projectId).toBe(app.project.id)

    // The tools are offered only for that project.
    expect(await tools(app, 1000, app.other.id)).toEqual(noProjectMcpTools())
    // Nothing logs the values.
    expect(JSON.stringify(app.t.logs.records)).not.toContain('stored-token-1')

    await app.close()
    await expectDead(pid)
  })

  it('stores the variables encrypted; null clears; at most 50; fresh auth first; deleted with the project', async () => {
    const app = await open()
    const { projectMcp } = app.t.deps
    const refused = new HarnessError({ code: 'forbidden', message: 'not fresh', action: 'login' })
    await expect(projectMcp.setVariables(app.project.id, { MCP_TOKEN: 'never-stored-1' }, { requireFreshAuth: () => {
      throw refused
    } })).rejects.toBe(refused)
    const rows = () => app.t.db.select().from(secrets).where(eq(secrets.scope, `project:${app.project.id}`))
    expect(await rows()).toEqual([])

    await projectMcp.setVariables(app.project.id, { MCP_TOKEN: 'secret-value-123', OTHER: 'other-value-456' }, { requireFreshAuth: () => {} })
    const stored = await rows()
    expect(stored.map(row => row.name).sort()).toEqual(['mcp.var.MCP_TOKEN', 'mcp.var.OTHER'])
    for (const row of stored) {
      expect(Buffer.from(row.ciphertext).toString('utf8')).not.toContain('secret-value-123')
      expect(Buffer.from(row.ciphertext).toString('latin1')).not.toContain('other-value-456')
    }
    // Stored but unused variables are listed (so they can be removed), without a value.
    const list = await projectMcp.list(app.project.id)
    expect(list.variables).toEqual([
      { name: 'MCP_TOKEN', set: true, hint: null, usedBy: [] },
      { name: 'OTHER', set: true, hint: null, usedBy: [] },
    ])

    await projectMcp.setVariables(app.project.id, { OTHER: null })
    expect((await rows()).map(row => row.name)).toEqual(['mcp.var.MCP_TOKEN'])

    const many = Object.fromEntries(Array.from({ length: 50 }, (_, index) => [`V${index}`, `value-${index}`]))
    await expect(projectMcp.setVariables(app.project.id, many)).rejects.toMatchObject({ code: 'conflict', details: { reason: 'exists' } })
    expect(await rows()).toHaveLength(1)
    await expect(projectMcp.setVariables('prj_ZZZZZZZZZZZZZZZZ', { A: 'b' })).rejects.toMatchObject({ code: 'not_found' })

    await app.t.deps.projects.remove(app.project.id)
    await waitFor(async () => (await rows()).length === 0)
    // The other project's scope is untouched.
    await projectMcp.setVariables(app.other.id, { KEEP: 'kept-value-1' })
    expect(await app.t.db.select().from(secrets).where(and(eq(secrets.scope, `project:${app.other.id}`), eq(secrets.name, 'mcp.var.KEEP')))).toHaveLength(1)
  })

  it('follows the events only after the first use, which also removes the variables of deleted projects', async () => {
    const app = await open()
    const subscribers = app.t.deps.events.subscriberCount()
    const orphan = 'prj_AAAAAAAAAAAAAAAA'
    const store = createProjectVariableStore(app.t.deps)
    await store.apply(orphan, { LEFT: 'left-over-value-1' })
    await store.apply(app.project.id, { KEEP: 'kept-value-1' })
    expect(await store.projectIds()).toEqual([orphan, app.project.id].sort())
    await app.t.deps.projectMcp.list(app.project.id)
    expect(app.t.deps.events.subscriberCount()).toBe(subscribers + 1)
    await waitFor(async () => (await store.projectIds()).length === 1)
    expect(await store.projectIds()).toEqual([app.project.id])
    expect(await store.values(app.project.id, ['KEEP'])).toEqual({ KEEP: 'kept-value-1' })
    await app.t.deps.projectMcp.stop()
    expect(app.t.deps.events.subscriberCount()).toBe(subscribers)
  })

  it('http: headers and URL expanded from the stored values; a redirect is refused; an invalid expanded URL is an error', async () => {
    vi.stubEnv('MCP_TOKEN', 'env-leak')
    const echo: HttpEchoServer = await startHttpEchoServer()
    servers.push(echo)
    // A server that only redirects to the echo server: `redirect: 'error'` never follows it.
    const redirects: string[] = []
    const redirector = createServer((req, res) => {
      redirects.push(req.method ?? '')
      res.writeHead(307, { location: echo.url }).end()
    })
    await new Promise<void>(resolve => redirector.listen(0, '127.0.0.1', resolve))
    const port = (redirector.address() as { port: number }).port
    servers.push({ close: () => new Promise<void>(resolve => redirector.close(() => resolve())) })

    const app = await open()
    // eslint-disable-next-line no-template-curly-in-string -- `.mcp.json` variable references are test data
    const docs = remoteServerItem('Docs', '${DOCS_URL}', { Authorization: 'Bearer ${MCP_TOKEN}' })
    const moved = remoteServerItem('Moved', `http://127.0.0.1:${port}/mcp`)
    // eslint-disable-next-line no-template-curly-in-string -- `.mcp.json` variable references are test data
    const bad = remoteServerItem('Bad', '${BAD_URL}')
    app.setServers([docs, moved, bad])
    await app.approve(docs, moved, bad)
    await app.t.deps.projectMcp.setVariables(app.project.id, { DOCS_URL: echo.url, MCP_TOKEN: 'header-secret-1', BAD_URL: 'ftp://127.0.0.1/x' })

    const result = await tools(app)
    expect(result.names).toEqual(new Map([['docs', 'Docs']]))
    expect(result.unavailable.sort()).toEqual(['Bad', 'Moved'])
    expect(toolNames(result)).toContain('mcp__docs__echo')
    const { headers } = outputJson<{ headers: Record<string, string> }>(await call(result, 'mcp__docs__headers'))
    expect(headers.authorization).toBe('Bearer header-secret-1')
    expect(echo.requests.every(request => request.authorization === 'Bearer header-secret-1')).toBe(true)
    // Unannotated tools ask; destructive ones always ask.
    expect(tool(result, 'mcp__docs__plain').definition.policy).toBe('ask')
    expect(tool(result, 'mcp__docs__wipe').definition.policy).toBe('always')

    expect(redirects.length).toBeGreaterThan(0)
    expect(echo.requests.filter(request => request.authorization === undefined)).toEqual([])
    const movedView = await server(app, 'moved')
    expect(movedView.state).toBe('error')
    const badView = await server(app, 'bad')
    expect(badView).toMatchObject({ state: 'error', error: { code: 'validation_error' } })
    expect(JSON.stringify(await app.t.deps.projectMcp.list(app.project.id))).not.toContain('header-secret-1')
  })

  it('waits at most waitMs (then unavailable); a failing server is unavailable with its error; concurrent runs share one start', async () => {
    const app = await open()
    const pidFile = join(app.scratch, 'pids')
    const slow = minServerItem('Slow', ['--pid-file', pidFile])
    const broken = minServerItem('Broken', ['--fail-init'])
    app.setServers([slow, broken])
    await app.approve(slow, broken)

    const [first, second] = await Promise.all([tools(app, 0), tools(app, 0)])
    expect(first.unavailable.sort()).toEqual(['Broken', 'Slow'])
    expect(second.unavailable.sort()).toEqual(['Broken', 'Slow'])
    expect(first.tools).toEqual([])
    const later = await tools(app)
    expect(later.names).toEqual(new Map([['slow', 'Slow']]))
    expect(later.unavailable).toEqual(['Broken'])
    const pids = (await readFile(pidFile, 'utf8')).trim().split('\n')
    strays.push(...pids.map(line => Number.parseInt(line, 10)))
    expect(pids).toHaveLength(1)
    expect(await server(app, 'broken')).toMatchObject({ state: 'error', error: { message: expect.stringContaining('refuses to initialize') } })
  })

  it('verify-before-run: an item whose files changed is skipped as pending (no process, not unavailable)', async () => {
    const app = await open()
    const pidFile = join(app.scratch, 'pids')
    const item = minServerItem('Checked', ['--pid-file', pidFile])
    app.setServers([item])
    await app.approve(item)
    app.config.changed.add(item.sha256)
    const result = await tools(app)
    expect(result).toEqual(noProjectMcpTools())
    expect(app.config.verified).toContainEqual({ projectId: app.project.id, sha256: item.sha256 })
    expect(await stateOf(app, 'checked')).toBe('pending')
    await expect(readFile(pidFile, 'utf8')).rejects.toThrow()
    // A start reads the folder again first.
    expect(app.config.reads.some(read => read.refresh)).toBe(true)

    app.config.changed.clear()
    expect((await tools(app)).names).toEqual(new Map([['checked', 'Checked']]))
    await pidsOf(pidFile)
  })

  it('shadows a global server of the same id in that project only, and only once approved', async () => {
    const app = await open()
    // A global MCP tool of the server `docs` (no connection needed: the registry knows the id).
    app.t.deps.registry.tools.register('core-mcp', remoteToolDefinition(), { mcpServerId: 'docs' })
    const docs = minServerItem('Docs')
    app.setServers([docs])
    expect((await tools(app)).shadowed).toEqual(new Set())
    expect((await server(app, 'docs')).shadows).toBeUndefined()
    await app.approve(docs)
    const result = await tools(app)
    expect(result.shadowed).toEqual(new Set(['docs']))
    expect(toolNames(result)).toContain('mcp__docs__echo')
    expect((await server(app, 'docs')).shadows).toBe('docs')
    expect((await tools(app, 1000, app.other.id)).shadowed).toEqual(new Set())
  })

  it('safe mode starts nothing: disabled, no tools, reconnect 409', async () => {
    const app = await open({ env: { HF_SAFE_MODE: '1' } })
    const pidFile = join(app.scratch, 'pids')
    const item = minServerItem('Local', ['--pid-file', pidFile])
    app.setServers([item])
    await app.approve(item)
    expect(await tools(app)).toEqual(noProjectMcpTools())
    expect(await server(app, 'local')).toMatchObject({ state: 'disabled' })
    await expect(app.t.deps.projectMcp.reconnect(app.project.id, 'local')).rejects.toMatchObject({ code: 'conflict', details: { reason: 'disabled' } })
    await expect(readFile(pidFile, 'utf8')).rejects.toThrow()
  })

  it('toolsFor rejects only when the run aborts', async () => {
    const app = await open()
    const item = minServerItem('Local')
    app.setServers([item])
    await app.approve(item)
    const aborted = new AbortController()
    aborted.abort(new Error('stopped'))
    await expect(app.t.deps.projectMcp.toolsFor(app.project.id, { signal: aborted.signal, waitMs: 1000 })).rejects.toThrow('stopped')
    const during = new AbortController()
    const pending = app.t.deps.projectMcp.toolsFor(app.project.id, { signal: during.signal, waitMs: 60_000 })
    during.abort(new Error('user stop'))
    await expect(pending).rejects.toThrow('user stop')
    // The server keeps connecting for later runs.
    expect((await tools(app)).names.get('local')).toBe('Local')
  })
})

describe('project MCP manager: reconnect and stops (pid and group dead)', () => {
  async function running(app: ProjectMcpTestApp, name: string, extra: string[] = [], env: Record<string, string> = {}) {
    const pidFile = join(app.scratch, `${name}.pids`)
    const item = minServerItem(name, ['--grandchild', '--pid-file', pidFile, ...extra], env)
    return { item, pidFile }
  }

  it('reconnect restarts an approved server; a pending one stays pending; unknown ids are not_found', async () => {
    const app = await open()
    const { item, pidFile } = await running(app, 'Local')
    const pending = minServerItem('Later')
    app.setServers([item, pending])
    await app.approve(item)
    await tools(app)
    const first = await pidsOf(pidFile)
    const view = await app.t.deps.projectMcp.reconnect(app.project.id, 'local')
    expect(view).toMatchObject({ id: 'local', state: 'connected' })
    await expectDead(first.pid, first.grandchild)
    const lines = (await readFile(pidFile, 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(2)
    strays.push(...lines.flatMap(line => line.split(' ').map(word => Number.parseInt(word, 10))))
    expect(await app.t.deps.projectMcp.reconnect(app.project.id, 'later')).toMatchObject({ state: 'pending' })
    await expect(app.t.deps.projectMcp.reconnect(app.project.id, 'nope')).rejects.toMatchObject({ code: 'not_found' })
    await expect(app.t.deps.projectMcp.reconnect('prj_ZZZZZZZZZZZZZZZZ', 'local')).rejects.toMatchObject({ code: 'not_found' })
  })

  it('revoke stops the server and its group', async () => {
    const app = await open()
    const { item, pidFile } = await running(app, 'Local')
    app.setServers([item])
    await app.approve(item)
    await tools(app)
    const { pid, grandchild } = await pidsOf(pidFile)
    expect(processAlive(grandchild!)).toBe(true)
    await app.revoke(item)
    await expectDead(pid, grandchild)
    await waitFor(async () => (await stateOf(app, 'local')) === 'pending')
    expect(await tools(app)).toEqual(noProjectMcpTools())
  })

  it('a changed item (a new hash) stops the server; it is pending until approved again', async () => {
    const app = await open()
    const { item, pidFile } = await running(app, 'Local')
    app.setServers([item])
    await app.approve(item)
    await tools(app)
    const { pid, grandchild } = await pidsOf(pidFile)
    const changed = minServerItem('Local', ['--grandchild', '--pid-file', pidFile, '--marker'])
    app.setServers([changed])
    // Any later read finds the new hash (here the list; also toolsFor and `project-trust.changed`).
    expect(await stateOf(app, 'local')).toBe('pending')
    await expectDead(pid, grandchild)
    expect(await tools(app)).toEqual(noProjectMcpTools())
  })

  it('an agent write in the project folder (workspace.changed) re-reads it: a changed item stops at once', async () => {
    const app = await open()
    const { item, pidFile } = await running(app, 'Local')
    app.setServers([item])
    await app.approve(item)
    await tools(app)
    const { pid, grandchild } = await pidsOf(pidFile)
    app.setServers([minServerItem('Local', ['--grandchild', '--pid-file', pidFile, '--name', 'edited'])])
    app.t.deps.events.emit('workspace.changed', { projectId: app.project.id, chatId: null, batchId: null, source: 'tool', paths: ['.mcp.json'] })
    await expectDead(pid, grandchild)
    expect(await stateOf(app, 'local')).toBe('pending')
  })

  it('a .mcp.json edited outside the agent tools stops the server at the next periodic re-read', async () => {
    const app = await open({ manager: { changePollMs: 50 } })
    const { item, pidFile } = await running(app, 'Local')
    app.setServers([item])
    await app.approve(item)
    await tools(app)
    const { pid, grandchild } = await pidsOf(pidFile)
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(processAlive(pid)).toBe(true)
    app.setServers([minServerItem('Local', ['--grandchild', '--pid-file', pidFile, '--name', 'edited'])])
    await expectDead(pid, grandchild)
    expect(await stateOf(app, 'local')).toBe('pending')
  })

  it('a variables change restarts the servers that use it with the new value', async () => {
    const app = await open()
    // eslint-disable-next-line no-template-curly-in-string -- `.mcp.json` variable references are test data
    const { item, pidFile } = await running(app, 'Local', [], { TOKEN: '${MCP_TOKEN}' })
    const untouched = minServerItem('Untouched')
    app.setServers([item, untouched])
    await app.approve(item, untouched)
    await app.t.deps.projectMcp.setVariables(app.project.id, { MCP_TOKEN: 'first-value-1' })
    const before = await tools(app)
    const { pid, grandchild } = await pidsOf(pidFile)
    const untouchedPid = outputJson<{ pid: number }>(await call(before, 'mcp__untouched__pid')).pid
    strays.push(untouchedPid)
    await app.t.deps.projectMcp.setVariables(app.project.id, { MCP_TOKEN: 'second-value-2' })
    await expectDead(pid, grandchild)
    await waitFor(async () => (await stateOf(app, 'local')) === 'connected')
    const after = await tools(app)
    expect(outputJson(await call(after, 'mcp__local__env', { name: 'TOKEN' }))).toEqual({ value: 'second-value-2' })
    expect(outputJson<{ pid: number }>(await call(after, 'mcp__untouched__pid')).pid).toBe(untouchedPid)
    // The old binding is dead: its tools fail instead of reaching the new process.
    await expect(call(before, 'mcp__local__echo', { text: 'x' })).rejects.toThrow('not connected')
    const lines = (await readFile(pidFile, 'utf8')).trim().split('\n')
    strays.push(...lines.flatMap(line => line.split(' ').map(word => Number.parseInt(word, 10))))
    // Removing the variable stops it for good (needs variables).
    await app.t.deps.projectMcp.setVariables(app.project.id, { MCP_TOKEN: null })
    expect(await stateOf(app, 'local')).toBe('needs-variables')
  })

  it('project deletion stops the servers and deletes the variables; no event for the deleted project', async () => {
    const app = await open()
    const { item, pidFile } = await running(app, 'Local')
    app.setServers([item])
    await app.approve(item)
    await app.t.deps.projectMcp.setVariables(app.project.id, { UNUSED: 'unused-value-1' })
    await tools(app)
    const { pid, grandchild } = await pidsOf(pidFile)
    await new Promise(resolve => setTimeout(resolve, 30))
    app.events.clear()
    await app.t.deps.projects.remove(app.project.id)
    await expectDead(pid, grandchild)
    await waitFor(async () => (await app.t.db.select().from(secrets).where(eq(secrets.scope, `project:${app.project.id}`))).length === 0)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(app.events.ofType('project-mcp.changed')).toEqual([])
  })

  it('shutdown stops every server and its group (also one that ignores SIGTERM)', async () => {
    const app = await open({ manager: { killGraceMs: 200 } })
    const { item, pidFile } = await running(app, 'Stubborn', ['--ignore-term'])
    app.setServers([item])
    await app.approve(item)
    await tools(app)
    const { pid, grandchild } = await pidsOf(pidFile)
    await app.close()
    await expectDead(pid, grandchild)
  })

  it('stops after the idle time without a run, and starts again for the next run', async () => {
    const app = await open({ manager: { idleMs: 150 } })
    const { item, pidFile } = await running(app, 'Local')
    app.setServers([item])
    await app.approve(item)
    await tools(app)
    const { pid, grandchild } = await pidsOf(pidFile)
    await expectDead(pid, grandchild)
    await waitFor(async () => (await stateOf(app, 'local')) === 'idle')
    expect((await server(app, 'local')).tools).toEqual(['mcp__local__echo', 'mcp__local__env', 'mcp__local__pid'])
    expect((await tools(app)).names.get('local')).toBe('Local')
    const lines = (await readFile(pidFile, 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(2)
    strays.push(...lines.flatMap(line => line.split(' ').map(word => Number.parseInt(word, 10))))
  })

  it('stopProject stops the runtimes of one project only', async () => {
    const app = await open()
    const { item, pidFile } = await running(app, 'Local')
    app.setServers([item])
    await app.approve(item)
    await tools(app)
    const { pid, grandchild } = await pidsOf(pidFile)
    await app.t.deps.projectMcp.stopProject(app.other.id)
    expect(processAlive(pid)).toBe(true)
    await app.t.deps.projectMcp.stopProject(app.project.id)
    await expectDead(pid, grandchild)
    expect(await stateOf(app, 'local')).toBe('idle')
  })
})

/** A registry tool standing in for a global MCP server's tool. */
function remoteToolDefinition(): ToolDefinition {
  return {
    name: 'mcp__docs__search',
    description: 'Searches the global docs.',
    inputSchema: jsonSchema({ type: 'object', properties: {} }),
    policy: 'safe',
    execute: async () => ({ ok: true }),
  }
}

// ---------- Phase 14 seams (C51) ----------

describe('project MCP manager: Phase 14 seams', () => {
  it('a 401 is needs-auth (auth_invalid, unavailable to runs) and no run restarts it; a reconnect tries once more', async () => {
    const endpoint = await startStatusServer(401)
    servers.push(endpoint)
    const mcpAuth = createFakeMcpAuthService()
    const app = await open({ overrides: { mcpAuth } })
    const item = remoteServerItem('Locked', endpoint.url)
    const keyed = remoteServerItem('Keyed', endpoint.url, { authorization: 'Bearer wrong-key-1234' })
    app.setServers([item, keyed])
    await app.approve(item, keyed)
    const result = await tools(app, 5000)
    expect(result.tools).toEqual([])
    expect(result.unavailable.sort()).toEqual(['Keyed', 'Locked'])
    const locked = await server(app, 'locked')
    expect(projectMcpListSchema.parse({ items: [locked], variables: [] }).items[0]).toMatchObject({
      state: 'needs-auth',
      error: { code: 'auth_invalid', status: 401, message: NEEDS_AUTH_MESSAGE },
      auth: null,
    })
    expect((await server(app, 'keyed')).error).toEqual({ code: 'auth_invalid', status: 401, message: HEADER_REJECTED_MESSAGE })
    const initializes = (): number => endpoint.methods.filter(method => method === 'initialize').length
    expect(initializes()).toBe(2)
    // The provider of the transport without an Authorization header, with the project target.
    expect(mcpAuth.providers).toEqual([{ target: { kind: 'project', projectId: app.project.id, serverId: 'locked' }, mode: 'connect' }])

    // Later runs do not restart a needs-auth server.
    expect((await tools(app, 5000)).unavailable.sort()).toEqual(['Keyed', 'Locked'])
    expect(initializes()).toBe(2)
    expect(await app.t.deps.projectMcp.reconnect(app.project.id, 'locked')).toMatchObject({ state: 'needs-auth' })
    expect(initializes()).toBe(3)

    // The sign-in state of an approved remote server (W14.1 implements `info`).
    mcpAuth.infos.set(mcpAuthTargetKey({ kind: 'project', projectId: app.project.id, serverId: 'locked' }), fakeMcpAuthInfo())
    expect((await server(app, 'locked')).auth).toEqual(fakeMcpAuthInfo())
    expect(app.t.deps.projectMcp.authTarget(app.project.id, 'locked')).toEqual({ kind: 'project', scope: `project:${app.project.id}`, name: 'mcp-oauth.locked' })

    // Listings name it unavailable; a request is refused with needs-auth.
    expect(await app.t.deps.projectMcp.prompts(app.project.id)).toMatchObject({ items: [], unavailable: [{ serverId: 'locked', status: 'needs-auth' }, { serverId: 'keyed', status: 'needs-auth' }] })
    await expect(app.t.deps.projectMcp.getPrompt(app.project.id, 'locked', 'greet', {}, new AbortController().signal))
      .rejects
      .toMatchObject({ code: 'conflict', details: { reason: 'needs-auth' } })
  })

  it('declares the elicitation capability, hands requests to the broker and fills the caches; listings and requests', async () => {
    const endpoint = await startElicitServer()
    servers.push(endpoint)
    const fake = createFakeElicitationBroker()
    fake.handlerAnswer = { action: 'accept', content: { name: 'Ada' } }
    const caches = spyMcpCaches()
    const app = await open({ overrides: { elicitations: fake }, manager: { createPromptCache: caches.prompts, createResourceCache: caches.resources } })
    const item = remoteServerItem('Elicit', endpoint.url)
    const pending = minServerItem('Later')
    app.setServers([item, pending])
    await app.approve(item)
    const result = await tools(app)
    expect(JSON.parse(outputText(await call(result, 'mcp__elicit__ask')))).toEqual({ action: 'accept', content: { name: 'Ada' } })
    expect(fake.handled[0]?.runtimeKey).toMatch(new RegExp(`^project:${app.project.id}/elicit#\\d+$`))
    await waitFor(() => caches.refreshed.length === 2)
    expect(caches.refreshed).toEqual(expect.arrayContaining([
      { kind: 'prompts', key: `${app.project.id}/elicit`, serverName: 'Elicit', projectId: app.project.id },
      { kind: 'resources', key: `${app.project.id}/elicit`, serverName: 'Elicit', projectId: app.project.id },
    ]))

    // The pending server is not named; the connected one lists through the (empty) caches.
    expect(await app.t.deps.projectMcp.prompts(app.project.id)).toEqual({ items: [], truncated: false, unavailable: [], shadowed: new Set() })
    expect(await app.t.deps.projectMcp.resources(app.project.id, { waitMs: 100 })).toEqual({ items: [], truncated: false, unavailable: [], shadowed: new Set() })
    await expect(app.t.deps.projectMcp.prompts('prj_ZZZZZZZZZZZZZZZZ')).rejects.toMatchObject({ code: 'not_found' })
    const signal = new AbortController().signal
    // W14.2: the caches are real (the server lists no prompt and cannot read resources).
    await expect(app.t.deps.projectMcp.getPrompt(app.project.id, 'elicit', 'greet', {}, signal)).rejects.toMatchObject({ code: 'not_found' })
    await expect(app.t.deps.projectMcp.readResource(app.project.id, 'elicit', 'file:///a', signal)).rejects.toMatchObject({ code: 'provider_error' })
    await expect(app.t.deps.projectMcp.getPrompt(app.project.id, 'later', 'greet', {}, signal)).rejects.toMatchObject({ code: 'conflict', details: { reason: 'untrusted' } })
    await expect(app.t.deps.projectMcp.readResource(app.project.id, 'nope', 'file:///a', signal)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('a UI listing (waitMs 0) never starts a server (lazy start for a run, ADR-050) and lists it once a run started it', async () => {
    const endpoint = await startElicitServer()
    servers.push(endpoint)
    const app = await open()
    const item = remoteServerItem('Elicit', endpoint.url)
    app.setServers([item])
    await app.approve(item)
    expect(await stateOf(app, 'elicit')).toBe('idle')
    const first = await app.t.deps.projectMcp.prompts(app.project.id)
    expect(first.unavailable).toEqual([{ serverId: 'elicit', status: 'idle' }])
    expect((await app.t.deps.projectMcp.resources(app.project.id, { waitMs: 0 })).unavailable).toEqual([{ serverId: 'elicit', status: 'idle' }])
    expect(await stateOf(app, 'elicit')).toBe('idle')
    await app.t.deps.projectMcp.toolsFor(app.project.id, { signal: new AbortController().signal, waitMs: 5000 })
    await waitFor(async () => (await stateOf(app, 'elicit')) === 'connected')
    expect((await app.t.deps.projectMcp.resources(app.project.id)).unavailable).toEqual([])
  })

  it('a listing that may wait (a typed command on send) starts the approved servers and waits for them', async () => {
    const endpoint = await startElicitServer()
    servers.push(endpoint)
    const app = await open()
    const item = remoteServerItem('Elicit', endpoint.url)
    app.setServers([item])
    await app.approve(item)
    expect(await stateOf(app, 'elicit')).toBe('idle')
    const listing = await app.t.deps.projectMcp.prompts(app.project.id, { waitMs: 5000 })
    expect(listing.unavailable).toEqual([])
    expect(await stateOf(app, 'elicit')).toBe('connected')
  })
})
