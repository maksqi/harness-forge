// The project MCP manager (Phase 11, ADR-050; ARCHITECTURE.md 6.30; API.md 4.32 / 5.33) behind `ProjectMcpManager`
// (./types.ts). Owner: W11.4.
//
// The servers of a project's `.mcp.json` (read through `projectConfig.snapshot`, parsed by the shared `parseMcpJson`) are
// offered only in that project's chats. One runtime per (project, server id) with a generation (callbacks of an older
// connect, a stopped client or an older tool binding are ignored), created lazily by `toolsFor`:
//
// - A server starts only while its trust hash is approved (`projectTrust.approved`), its variables resolve and
//   `HF_SAFE_MODE` is off. Right before a start the folder is read again (`snapshot` with `refresh`) and the item is
//   verified (`projectConfig.verify`: the script files it names are hashed again); a mismatch skips it as pending.
// - Variables (`${VAR}` / `${VAR:-default}`) are expanded only from the values stored for the project (secret scope
//   `project:<projectId>`, names `mcp.var.<NAME>`, ./project-variables.ts); `process.env` is never read.
// - stdio servers run through `createStdioTransport` (`ChildProcessMcpTransport`, own process group) in the project root
//   with the minimal stdio environment plus the expanded declared env; http / sse servers go to `@ai-sdk/mcp` with
//   `redirect: 'error'` and an http(s) URL only (checked again after the expansion). The connect timeout (the `core-mcp`
//   setting) and the `tools/list` caps are the global manager's.
// - Tools are `mcpToolDefinition(tool, { serverId: id, pluginId: 'core-mcp', serverPolicy: 'ask', call })` (the policy
//   from the annotations), never registered in the global registry. A project server whose id equals a global server id
//   shadows it in that project's chats (approved servers only).
// - Stops: `LIMITS.projectMcpIdleMs` (10 min) after the last run or tool call without an active run of the project; on
//   `project-trust.changed` (revoked or changed hash; a running server whose new hash is approved restarts); on a hash
//   or folder change found by any later read (`toolsFor`, `list`, `reconnect`, `workspace.changed` of the project, and a
//   re-read every 15 s while a server of the project runs); on a variables change (the affected servers restart); on project deletion (`project.changed { project: null }`: `stopProject` and
//   the secret scope deleted); at shutdown (`stop`). Every state change emits `project-mcp.changed` (coalesced).
// - Variable values, resolved env / args / headers and URLs are never logged; connection errors are logged with their
//   code only (the redacted message at `debug`), stderr lines of stdio servers at `debug` in the `core-mcp` plugin log.
import type { MCPClient, MCPClientConfig, MCPTransport } from '@ai-sdk/mcp'
import type { Disposable, ToolCallContext } from '@harness-forge/plugin-sdk'
import type { HarnessErrorInit, ProjectMcpList, ProjectMcpServer, ProjectMcpState, ServerEvent } from '@harness-forge/shared'
import type { RegisteredTool } from '../registry/types.ts'
import type { ProjectConfigSnapshot, ProjectMcpServerItem } from '../services/project-config/types.ts'
import type { AppDeps } from '../types.ts'
import type { McpListedTool } from './mcp-tools.ts'
import type { ResolvedProjectTransport } from './project-view.ts'
import type { StdioExit } from './stdio-transport.ts'
import type { ProjectMcpManager, ProjectMcpTools, ProjectMcpToolsOptions } from './types.ts'
import { createMCPClient } from '@ai-sdk/mcp'
import { HarnessError, isHarnessError, LIMITS } from '@harness-forge/shared'
import { appVersion } from '../paths.ts'
import { connectionErrorInit, errorMessage, isConnectionFailure, mcpConfigError } from './errors.ts'
import { MCP_CONNECT_TIMEOUT_MS, MCP_RECONNECT_WAIT_MS } from './index.ts'
import { CORE_MCP_PLUGIN_ID } from './internal.ts'
import { mcpToolDefinition, mcpToolTitle } from './mcp-tools.ts'
import { DEFAULT_MCP_POLICY } from './policy.ts'
import { createProjectVariableStore } from './project-variables.ts'
import { expandTransport, missingVariables, projectMcpVariables, referencedVariables } from './project-view.ts'
import { createStdioTransport } from './stdio-transport.ts'

/** Timeout of one `tools/list` page (the global manager's). */
const TOOL_LIST_TIMEOUT_MS = 20_000
const MAX_TOOL_PAGES = 50
/** stderr lines forwarded per server and minute. */
const STDERR_LINES_PER_MINUTE = 100
/** Coalescing delay of `workspace.changed` re-reads of a project with running servers. */
const RECONCILE_DELAY_MS = 250
/** While a server of a project runs, its folder is read again this often (an edit outside the agent tools). */
const CHANGE_POLL_MS = 15_000

export interface ProjectMcpManagerOptions {
  /** Idle stop (default `LIMITS.projectMcpIdleMs`). */
  idleMs?: number
  /** Overrides the `core-mcp` connect timeout setting. */
  connectTimeoutMs?: number
  /** `reconnect` waits at most this long (default `MCP_RECONNECT_WAIT_MS`, 10 s). */
  reconnectWaitMs?: number
  /** SIGTERM -> SIGKILL grace of stdio process groups. */
  killGraceMs?: number
  /** Coalescing delay of `project-mcp.changed` (default 25 ms). */
  eventDelayMs?: number
  /** Coalescing delay of the re-read after `workspace.changed` (default 250 ms). */
  reconcileDelayMs?: number
  /** Re-read interval of a project with running servers (default 15 s). */
  changePollMs?: number
  /** `createMCPClient` (tests may wrap it). */
  createClient?: (config: MCPClientConfig) => Promise<MCPClient>
}

/** Internal states; `stale` = the item failed verify-before-run (listed as `pending`, never `unavailable`). */
type RuntimeStatus = 'idle' | 'connecting' | 'connected' | 'error' | 'stale'

interface Runtime {
  readonly projectId: string
  readonly id: string
  /** The item the runtime was (or will be) started with. */
  item: ProjectMcpServerItem
  /** Incremented by every start and stop. */
  generation: number
  status: RuntimeStatus
  error: HarnessErrorInit | null
  client: MCPClient | null
  /** The stdio transport of the current attempt (closed by a stop even before the client exists). */
  transport: MCPTransport | null
  controller: AbortController | null
  attempt: Promise<void> | null
  tools: RegisteredTool[]
  /** Tool names of the last successful listing (kept while stopped). */
  lastToolNames: string[]
  /** Tool calls in progress. */
  inflight: number
  idleTimer: NodeJS.Timeout | null
  stderr: { windowStart: number, count: number, muted: boolean }
}

/** What a read of the project decides for one run. */
interface RunPlan {
  /** Approved servers (they shadow a global server of the same id). */
  approved: ProjectMcpServerItem[]
  /** Approved servers whose variables resolve: their tools are wanted. */
  wanted: ProjectMcpServerItem[]
  /** Wanted servers without a running or connecting runtime of the same hash. */
  toStart: ProjectMcpServerItem[]
}

function isOpen(runtime: Runtime): boolean {
  return runtime.status === 'connected' || runtime.status === 'connecting'
}

function describeExit(exit: StdioExit): string {
  return exit.signal ? `signal ${exit.signal}` : `code ${exit.code ?? 'unknown'}`
}

function byName(a: RegisteredTool, b: RegisteredTool): number {
  return a.definition.name < b.definition.name ? -1 : a.definition.name > b.definition.name ? 1 : 0
}

/** The answer of `toolsFor` when no project server is ready (or none exists). */
export function noProjectMcpTools(): ProjectMcpTools {
  return { tools: [], shadowed: new Set<string>(), unavailable: [], names: new Map<string, string>() }
}

/** The servers of a config snapshot as they are listed before anything starts: `pending`, no tools. */
export function pendingProjectMcpServers(snapshot: ProjectConfigSnapshot): ProjectMcpServer[] {
  return snapshot.mcpServers.map(item => ({
    id: item.server.id,
    name: item.server.name,
    transport: item.server.transport.type,
    state: 'pending',
    sha256: item.sha256,
    tools: [],
    missingVariables: [],
  }))
}

function notFoundServer(serverId: string): HarnessError {
  return new HarnessError({ code: 'not_found', message: `Unknown project MCP server "${serverId}".` })
}

function safeModeConflict(): HarnessError {
  return new HarnessError({
    code: 'conflict',
    message: 'Project MCP servers do not start in safe mode.',
    details: { reason: 'disabled' },
  })
}

export function createProjectMcpManager(deps: AppDeps): ProjectMcpManager {
  return createProjectMcpManagerCore(deps)
}

/** The manager with test options. */
export function createProjectMcpManagerCore(deps: AppDeps, options: ProjectMcpManagerOptions = {}): ProjectMcpManager {
  const idleMs = options.idleMs ?? LIMITS.projectMcpIdleMs
  const createClient = options.createClient ?? createMCPClient
  const variables = createProjectVariableStore(deps)
  /** projectId -> server id -> runtime. */
  const projects = new Map<string, Map<string, Runtime>>()
  /** Projects deleted while this process runs: no more events, no new runtimes. */
  const deleted = new Set<string>()
  const attempts = new Set<Promise<void>>()
  const closing = new Set<Promise<void>>()
  /** Background work (event handling) that `stop()` waits for. */
  const background = new Set<Promise<void>>()
  const emitTimers = new Map<string, NodeJS.Timeout>()
  const reconcileTimers = new Map<string, NodeJS.Timeout>()
  /** Projects with running servers: their folder is read again every `changePollMs`. */
  const pollTimers = new Map<string, NodeJS.Timeout>()
  /** Per-project serialization of re-reads and variable changes. */
  const queues = new Map<string, Promise<void>>()
  let stopped = false
  let clientVersion: string | undefined

  const redact = (text: string): string => deps.redactor.redactText(text)

  function version(): string {
    if (clientVersion === undefined) {
      try {
        clientVersion = appVersion()
      }
      catch {
        clientVersion = '0.0.0'
      }
    }
    return clientVersion
  }

  async function connectTimeoutMs(): Promise<number> {
    if (options.connectTimeoutMs !== undefined)
      return options.connectTimeoutMs
    try {
      const values = await deps.plugins.settingsValues(CORE_MCP_PLUGIN_ID)
      const seconds = values.connectTimeoutSeconds
      if (typeof seconds === 'number' && Number.isFinite(seconds))
        return Math.min(Math.max(seconds, 5), 120) * 1000
    }
    catch {}
    return MCP_CONNECT_TIMEOUT_MS
  }

  function track(work: Promise<void>): void {
    const tracked = work.catch((error: unknown) => {
      deps.logger.warn('project MCP background work failed', { err: error })
    }).finally(() => {
      background.delete(tracked)
    })
    background.add(tracked)
  }

  /** Runs `fn` after the previous work of the project (re-reads, variable changes); never rejects the chain. */
  function serialized<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const previous = queues.get(projectId) ?? Promise.resolve()
    const run = previous.then(fn)
    const tail = run.then(() => undefined, () => undefined)
    queues.set(projectId, tail)
    void tail.then(() => {
      if (queues.get(projectId) === tail)
        queues.delete(projectId)
    })
    return run
  }

  // ---------- events ----------

  function scheduleEmit(projectId: string): void {
    if (stopped || deleted.has(projectId) || emitTimers.has(projectId))
      return
    const timer = setTimeout(() => {
      emitTimers.delete(projectId)
      track(emitChanged(projectId))
    }, options.eventDelayMs ?? 25)
    timer.unref?.()
    emitTimers.set(projectId, timer)
  }

  async function emitChanged(projectId: string): Promise<void> {
    if (stopped || deleted.has(projectId))
      return
    const snapshot = await deps.projectConfig.snapshot(projectId)
    const servers = await serverViews(projectId, snapshot)
    if (!stopped && !deleted.has(projectId))
      deps.events.emit('project-mcp.changed', { projectId, servers })
  }

  // ---------- runtimes ----------

  function runtimesOf(projectId: string): Map<string, Runtime> | undefined {
    return projects.get(projectId)
  }

  function runtimeFor(projectId: string, item: ProjectMcpServerItem): Runtime {
    let map = projects.get(projectId)
    if (map === undefined) {
      map = new Map()
      projects.set(projectId, map)
    }
    let runtime = map.get(item.server.id)
    if (runtime === undefined) {
      runtime = {
        projectId,
        id: item.server.id,
        item,
        generation: 0,
        status: 'idle',
        error: null,
        client: null,
        transport: null,
        controller: null,
        attempt: null,
        tools: [],
        lastToolNames: [],
        inflight: 0,
        idleTimer: null,
        stderr: { windowStart: 0, count: 0, muted: false },
      }
      map.set(item.server.id, runtime)
    }
    return runtime
  }

  /** The runtime of `item` when it was started with the same hash. */
  function currentRuntime(projectId: string, item: ProjectMcpServerItem): Runtime | undefined {
    const runtime = projects.get(projectId)?.get(item.server.id)
    return runtime !== undefined && runtime.item.sha256 === item.sha256 ? runtime : undefined
  }

  function trackClose(close: () => Promise<void>): void {
    let done: Promise<void>
    try {
      done = close()
    }
    catch (error) {
      done = Promise.reject(error)
    }
    const tracked = done
      .catch((error: unknown) => deps.logger.debug('project MCP client close failed', { err: error }))
      .finally(() => {
        closing.delete(tracked)
      })
    closing.add(tracked)
  }

  /** Cancels the attempt, closes the client (or the transport of an attempt) and drops the tools; keeps the names. */
  function detach(runtime: Runtime): void {
    runtime.generation += 1
    runtime.controller?.abort()
    runtime.controller = null
    if (runtime.idleTimer !== null) {
      clearTimeout(runtime.idleTimer)
      runtime.idleTimer = null
    }
    runtime.tools = []
    const client = runtime.client
    const transport = runtime.transport
    runtime.client = null
    runtime.transport = null
    if (client !== null)
      trackClose(() => client.close())
    else if (transport !== null)
      trackClose(() => transport.close())
  }

  function stopRuntime(runtime: Runtime, reason: string): void {
    const wasOpen = isOpen(runtime)
    detach(runtime)
    runtime.status = 'idle'
    runtime.error = null
    if (wasOpen)
      deps.logger.info('project MCP server stopped', { projectId: runtime.projectId, serverId: runtime.id, reason })
    scheduleEmit(runtime.projectId)
  }

  function armIdle(runtime: Runtime): void {
    if (runtime.idleTimer !== null)
      clearTimeout(runtime.idleTimer)
    runtime.idleTimer = null
    if (stopped || !isOpen(runtime))
      return
    const generation = runtime.generation
    runtime.idleTimer = setTimeout(() => {
      runtime.idleTimer = null
      track(onIdle(runtime, generation))
    }, idleMs)
    runtime.idleTimer.unref?.()
  }

  /** True while a run of a chat of the project is active. */
  async function projectBusy(projectId: string): Promise<boolean> {
    try {
      for (const run of deps.runs.active()) {
        const chat = await deps.chats.find(run.chatId).catch(() => null)
        if (chat?.projectId === projectId)
          return true
      }
    }
    catch {}
    return false
  }

  async function onIdle(runtime: Runtime, generation: number): Promise<void> {
    if (stopped || generation !== runtime.generation || !isOpen(runtime))
      return
    const busy = runtime.inflight > 0 || await projectBusy(runtime.projectId)
    if (stopped || generation !== runtime.generation)
      return
    if (busy) {
      armIdle(runtime)
      return
    }
    stopRuntime(runtime, 'idle')
  }

  // ---------- connecting ----------

  function onStderr(runtime: Runtime, line: string): void {
    const now = Date.now()
    const budget = runtime.stderr
    if (now - budget.windowStart > 60_000) {
      budget.windowStart = now
      budget.count = 0
      budget.muted = false
    }
    budget.count += 1
    if (budget.count > STDERR_LINES_PER_MINUTE) {
      budget.muted = true
      return
    }
    const message = `[project ${runtime.projectId} / ${runtime.id}] ${line}`
    try {
      deps.plugins.log(CORE_MCP_PLUGIN_ID, 'debug', message)
    }
    catch {
      deps.logger.debug(message)
    }
  }

  function onDisconnected(runtime: Runtime, generation: number, error: unknown): void {
    if (stopped || generation !== runtime.generation)
      return
    detach(runtime)
    const init = connectionErrorInit(error, redact)
    runtime.status = 'error'
    runtime.error = init
    deps.logger.warn('project MCP server disconnected', { projectId: runtime.projectId, serverId: runtime.id, code: init.code })
    deps.logger.debug('project MCP server disconnected (detail)', { projectId: runtime.projectId, serverId: runtime.id, message: init.message })
    scheduleEmit(runtime.projectId)
  }

  async function listAllTools(client: MCPClient, signal: AbortSignal | undefined): Promise<McpListedTool[]> {
    if (!client.initializeResult.capabilities.tools)
      return []
    const tools: McpListedTool[] = []
    let cursor: string | undefined
    for (let page = 0; page < MAX_TOOL_PAGES && tools.length < LIMITS.projectMcpToolsMax; page++) {
      const result = await client.listTools({
        ...(cursor === undefined ? {} : { params: { cursor } }),
        options: { ...(signal ? { signal } : {}), timeout: TOOL_LIST_TIMEOUT_MS },
      })
      tools.push(...result.tools)
      cursor = result.nextCursor
      if (!cursor)
        break
    }
    return tools.slice(0, LIMITS.projectMcpToolsMax)
  }

  async function callTool(runtime: Runtime, generation: number, name: string, input: Record<string, unknown>, c: ToolCallContext) {
    const client = generation === runtime.generation ? runtime.client : null
    if (client === null)
      throw new Error(`The project MCP server "${runtime.item.server.name}" is not connected.`)
    runtime.inflight += 1
    armIdle(runtime)
    try {
      return await client.callTool({ name, arguments: input, options: { signal: c.signal } })
    }
    catch (error) {
      if (!c.signal.aborted && isConnectionFailure(error))
        onDisconnected(runtime, generation, error)
      throw new Error(`The MCP tool "${name}" failed: ${redact(errorMessage(error))}`)
    }
    finally {
      runtime.inflight -= 1
      if (generation === runtime.generation)
        armIdle(runtime)
    }
  }

  function buildTools(runtime: Runtime, generation: number, listed: readonly McpListedTool[]): void {
    const binding = {
      serverId: runtime.id,
      pluginId: CORE_MCP_PLUGIN_ID,
      serverPolicy: DEFAULT_MCP_POLICY,
      call: (name: string, input: Record<string, unknown>, c: ToolCallContext) => callTool(runtime, generation, name, input, c),
    }
    const seen = new Set<string>()
    const tools: RegisteredTool[] = []
    for (const tool of listed) {
      const definition = mcpToolDefinition(tool, binding)
      if (seen.has(definition.name))
        continue
      seen.add(definition.name)
      tools.push(Object.freeze({ pluginId: CORE_MCP_PLUGIN_ID, definition, mcpServerId: runtime.id, title: mcpToolTitle(tool) }))
    }
    tools.sort(byName)
    runtime.tools = tools
    runtime.lastToolNames = tools.map(tool => tool.definition.name)
  }

  async function refreshTools(runtime: Runtime, generation: number): Promise<void> {
    const client = runtime.client
    if (client === null || generation !== runtime.generation)
      return
    try {
      const listed = await listAllTools(client, undefined)
      if (generation !== runtime.generation || runtime.client !== client)
        return
      buildTools(runtime, generation, listed)
      scheduleEmit(runtime.projectId)
    }
    catch (error) {
      deps.logger.debug('project MCP tool list refresh failed', { projectId: runtime.projectId, serverId: runtime.id, err: error })
    }
  }

  /** The expanded transport of an item, from the stored values only. */
  async function resolveTransport(runtime: Runtime, item: ProjectMcpServerItem): Promise<ResolvedProjectTransport> {
    const values = await variables.values(runtime.projectId, referencedVariables(item.server.transport))
    const expanded = expandTransport(item.server.transport, values)
    if (expanded.ok)
      return expanded.transport
    if (expanded.reason === 'missing')
      throw mcpConfigError('A variable of this server has no value. Set it in the project MCP servers.')
    throw mcpConfigError('The URL of this server is not an http or https URL after its variables are expanded.')
  }

  function createTransport(runtime: Runtime, generation: number, transport: ResolvedProjectTransport, root: string): MCPClientConfig['transport'] {
    if (transport.type !== 'stdio')
      return { type: transport.type, url: transport.url, headers: { ...transport.headers }, redirect: 'error' }
    const stdio = createStdioTransport({
      command: transport.command,
      args: transport.args,
      env: transport.env,
      cwd: root,
      ...(options.killGraceMs === undefined ? {} : { killGraceMs: options.killGraceMs }),
      onStderr: line => onStderr(runtime, redact(line)),
      onNotification: (method) => {
        if (method === 'notifications/tools/list_changed')
          void refreshTools(runtime, generation)
      },
      onExit: exit => onDisconnected(runtime, generation, new Error(`The MCP server process exited (${describeExit(exit)}).`)),
    })
    runtime.transport = stdio
    return stdio
  }

  async function runConnect(runtime: Runtime, generation: number, item: ProjectMcpServerItem, root: string, signal: AbortSignal): Promise<void> {
    const current = (): boolean => generation === runtime.generation && !stopped
    let client: MCPClient | null = null
    try {
      // Verify-before-run: the script files the item names are hashed again.
      if (!await deps.projectConfig.verify(runtime.projectId, item, signal)) {
        if (!current())
          return
        runtime.controller = null
        runtime.status = 'stale'
        runtime.error = null
        deps.projectConfig.invalidate(runtime.projectId)
        deps.logger.info('project MCP server changed since it was approved; not started', { projectId: runtime.projectId, serverId: runtime.id })
        scheduleEmit(runtime.projectId)
        return
      }
      if (!current())
        return
      const transport = await resolveTransport(runtime, item)
      if (!current())
        return
      const timeout = await connectTimeoutMs()
      if (!current())
        return
      client = await createClient({
        transport: createTransport(runtime, generation, transport, root),
        clientName: 'harness-forge',
        version: version(),
        onUncaughtError: (error) => {
          if (generation === runtime.generation)
            deps.logger.debug('project MCP client error', { projectId: runtime.projectId, serverId: runtime.id, message: redact(errorMessage(error)) })
        },
        initializationOptions: { signal, timeout },
      })
      if (!current()) {
        const stale = client
        trackClose(() => stale.close())
        return
      }
      const listed = await listAllTools(client, signal)
      if (!current()) {
        const stale = client
        trackClose(() => stale.close())
        return
      }
      runtime.client = client
      runtime.controller = null
      buildTools(runtime, generation, listed)
      runtime.status = 'connected'
      runtime.error = null
      armIdle(runtime)
      pollChanges(runtime.projectId)
      deps.logger.info('project MCP server connected', { projectId: runtime.projectId, serverId: runtime.id, transport: transport.type, tools: runtime.tools.length })
      scheduleEmit(runtime.projectId)
    }
    catch (error) {
      if (client !== null && runtime.client !== client) {
        const failed = client
        trackClose(() => failed.close())
      }
      if (!current())
        return
      // The transport of a failed start is closed by the client (or was never started); a stop closes it otherwise.
      if (runtime.transport !== null && runtime.client === null) {
        const transport = runtime.transport
        runtime.transport = null
        trackClose(() => transport.close())
      }
      runtime.controller = null
      const init = connectionErrorInit(error, redact)
      runtime.status = 'error'
      runtime.error = init
      deps.logger.warn('project MCP server failed to start', { projectId: runtime.projectId, serverId: runtime.id, code: init.code })
      deps.logger.debug('project MCP server failed to start (detail)', { projectId: runtime.projectId, serverId: runtime.id, message: init.message })
      scheduleEmit(runtime.projectId)
    }
  }

  /** Stops whatever runs and starts `item`; resolves when the attempt settled. */
  function startRuntime(runtime: Runtime, item: ProjectMcpServerItem, root: string): Promise<void> {
    detach(runtime)
    if (runtime.item.sha256 !== item.sha256)
      runtime.lastToolNames = []
    runtime.item = item
    const generation = runtime.generation
    const controller = new AbortController()
    runtime.controller = controller
    runtime.status = 'connecting'
    runtime.error = null
    scheduleEmit(runtime.projectId)
    const attempt: Promise<void> = runConnect(runtime, generation, item, root, controller.signal).finally(() => {
      attempts.delete(attempt)
      if (runtime.attempt === attempt)
        runtime.attempt = null
    })
    runtime.attempt = attempt
    attempts.add(attempt)
    return attempt
  }

  // ---------- reading a project ----------

  function canStart(item: ProjectMcpServerItem, approved: ReadonlySet<string>, stored: ReadonlySet<string>): boolean {
    return !deps.env.safeMode && approved.has(item.sha256) && missingVariables(item.server.transport, stored).length === 0
  }

  /**
   * Stops the runtimes whose item is gone (dropped), changed, no longer approved or no longer startable (missing
   * variables, safe mode); answers the ids of the runtimes that were open before.
   */
  function retire(projectId: string, snapshot: ProjectConfigSnapshot, approved: ReadonlySet<string>, stored: ReadonlySet<string>): Set<string> {
    const wasOpen = new Set<string>()
    const map = runtimesOf(projectId)
    if (map === undefined)
      return wasOpen
    const items = new Map(snapshot.mcpServers.map(item => [item.server.id, item]))
    for (const runtime of [...map.values()]) {
      if (isOpen(runtime))
        wasOpen.add(runtime.id)
      const item = items.get(runtime.id)
      if (item === undefined) {
        if (runtime.status !== 'idle')
          stopRuntime(runtime, 'removed')
        else
          detach(runtime)
        map.delete(runtime.id)
        scheduleEmit(projectId)
        continue
      }
      const changed = item.sha256 !== runtime.item.sha256
      if ((changed || !canStart(item, approved, stored)) && runtime.status !== 'idle')
        stopRuntime(runtime, changed ? 'changed' : 'not approved')
      if (changed) {
        runtime.item = item
        runtime.lastToolNames = []
      }
    }
    if (map.size === 0)
      projects.delete(projectId)
    return wasOpen
  }

  function plan(projectId: string, snapshot: ProjectConfigSnapshot, approved: ReadonlySet<string>, stored: ReadonlySet<string>): RunPlan {
    const result: RunPlan = { approved: [], wanted: [], toStart: [] }
    if (deps.env.safeMode)
      return result
    for (const item of snapshot.mcpServers) {
      if (!approved.has(item.sha256))
        continue
      result.approved.push(item)
      if (missingVariables(item.server.transport, stored).length > 0)
        continue
      result.wanted.push(item)
      const runtime = currentRuntime(projectId, item)
      if (runtime === undefined || runtime.status === 'idle' || runtime.status === 'error' || runtime.status === 'stale')
        result.toStart.push(item)
    }
    return result
  }

  /** Ids of the global MCP servers (declared in the registry, or owning registered tools). */
  function globalServerIds(): Set<string> {
    const ids = new Set<string>()
    try {
      for (const server of deps.registry.mcpServers.list())
        ids.add(server.decl.id)
      for (const tool of deps.registry.tools.list()) {
        if (tool.mcpServerId !== null)
          ids.add(tool.mcpServerId)
      }
    }
    catch {}
    return ids
  }

  function stateOf(item: ProjectMcpServerItem, approved: ReadonlySet<string>, missing: readonly string[], runtime: Runtime | undefined): ProjectMcpState {
    if (deps.env.safeMode)
      return 'disabled'
    if (!approved.has(item.sha256) || runtime?.status === 'stale')
      return 'pending'
    if (missing.length > 0)
      return 'needs-variables'
    return runtime?.status ?? 'idle'
  }

  async function serverViews(projectId: string, snapshot: ProjectConfigSnapshot, context?: { approved: ReadonlySet<string>, stored: ReadonlySet<string> }): Promise<ProjectMcpServer[]> {
    if (snapshot.mcpServers.length === 0)
      return []
    const approved = context?.approved ?? await deps.projectTrust.approved(projectId)
    const stored = context?.stored ?? await variables.names(projectId)
    const globals = globalServerIds()
    return snapshot.mcpServers.slice(0, LIMITS.projectMcpServersMax).map((item) => {
      const missing = missingVariables(item.server.transport, stored)
      const runtime = currentRuntime(projectId, item)
      const state = stateOf(item, approved, missing, runtime)
      const tools = runtime === undefined ? [] : (runtime.status === 'connected' ? runtime.tools.map(tool => tool.definition.name) : runtime.lastToolNames)
      const view: ProjectMcpServer = {
        id: item.server.id,
        name: item.server.name,
        transport: item.server.transport.type,
        state,
        sha256: item.sha256,
        tools: tools.slice(0, LIMITS.projectMcpToolsMax),
        missingVariables: missing.slice(0, LIMITS.projectMcpVariablesMax),
      }
      if (state === 'error' && runtime?.error)
        view.error = runtime.error
      if (state !== 'pending' && state !== 'disabled' && globals.has(item.server.id))
        view.shadows = item.server.id
      return view
    })
  }

  /** Reads the project again (fresh), stops what changed and restarts the open servers in `restart` that may start. */
  async function reconcile(projectId: string, restart: ReadonlySet<string> = new Set()): Promise<void> {
    if (stopped || deleted.has(projectId))
      return
    const snapshot = await deps.projectConfig.snapshot(projectId, { refresh: true })
    const approved = await deps.projectTrust.approved(projectId)
    const stored = await variables.names(projectId)
    if (stopped || deleted.has(projectId))
      return
    const wasOpen = retire(projectId, snapshot, approved, stored)
    for (const id of restart)
      wasOpen.add(id)
    const map = runtimesOf(projectId)
    if (snapshot.root !== null && map !== undefined) {
      for (const runtime of map.values()) {
        if (wasOpen.has(runtime.id) && (runtime.status === 'idle' || runtime.status === 'error') && canStart(runtime.item, approved, stored))
          void startRuntime(runtime, runtime.item, snapshot.root)
      }
    }
    if (snapshot.mcpServers.length > 0 || map !== undefined)
      scheduleEmit(projectId)
  }

  function queueReconcile(projectId: string): void {
    if (stopped || deleted.has(projectId))
      return
    track(serialized(projectId, () => reconcile(projectId)))
  }

  function scheduleReconcile(projectId: string): void {
    if (stopped || reconcileTimers.has(projectId))
      return
    const timer = setTimeout(() => {
      reconcileTimers.delete(projectId)
      queueReconcile(projectId)
    }, options.reconcileDelayMs ?? RECONCILE_DELAY_MS)
    timer.unref?.()
    reconcileTimers.set(projectId, timer)
  }

  /** Re-reads the folder of a project with open servers every `changePollMs` (a `.mcp.json` edited outside the agent). */
  function pollChanges(projectId: string): void {
    if (stopped || deleted.has(projectId) || pollTimers.has(projectId))
      return
    const timer = setTimeout(() => {
      pollTimers.delete(projectId)
      const open = [...(projects.get(projectId)?.values() ?? [])].some(isOpen)
      if (!open || stopped || deleted.has(projectId))
        return
      track(serialized(projectId, () => reconcile(projectId)).finally(() => {
        if ([...(projects.get(projectId)?.values() ?? [])].some(isOpen))
          pollChanges(projectId)
      }))
    }, options.changePollMs ?? CHANGE_POLL_MS)
    timer.unref?.()
    pollTimers.set(projectId, timer)
  }

  /** Detaches every runtime of the project; resolves when their attempts and closes settled. Never rejects. */
  async function stopRuntimes(projectId: string): Promise<void> {
    const map = projects.get(projectId)
    if (map === undefined)
      return
    projects.delete(projectId)
    const pending: Promise<void>[] = []
    for (const runtime of map.values()) {
      if (runtime.attempt !== null)
        pending.push(runtime.attempt)
      stopRuntime(runtime, 'project stopped')
    }
    await Promise.allSettled(pending)
    await Promise.allSettled([...closing])
  }

  /** The project was deleted: its runtimes stop and its variables are deleted. */
  async function forget(projectId: string): Promise<void> {
    deleted.add(projectId)
    const timer = emitTimers.get(projectId)
    if (timer !== undefined) {
      clearTimeout(timer)
      emitTimers.delete(projectId)
    }
    for (const timers of [reconcileTimers, pollTimers]) {
      const pending = timers.get(projectId)
      if (pending !== undefined) {
        clearTimeout(pending)
        timers.delete(projectId)
      }
    }
    await stopRuntimes(projectId)
    const count = await variables.deleteAll(projectId)
    if (count > 0)
      deps.logger.info('project MCP variables deleted with their project', { projectId, count })
  }

  function onEvent(event: ServerEvent): void {
    if (stopped)
      return
    switch (event.type) {
      case 'project-trust.changed':
        queueReconcile(event.data.projectId)
        break
      case 'project.changed':
        if (event.data.project === null)
          track(forget(event.data.id))
        else if (projects.has(event.data.id))
          queueReconcile(event.data.id)
        break
      case 'workspace.changed':
        if (projects.has(event.data.projectId))
          scheduleReconcile(event.data.projectId)
        break
      default:
        break
    }
  }

  /** Deletes the stored variables of projects that no longer exist (deleted while the manager was not following). */
  async function sweepOrphans(): Promise<void> {
    for (const projectId of await variables.projectIds()) {
      if (stopped)
        return
      try {
        await deps.projects.get(projectId)
      }
      catch (error) {
        if (!isHarnessError(error) || error.code !== 'not_found')
          continue
        deleted.add(projectId)
        const count = await variables.deleteAll(projectId)
        deps.logger.info('project MCP variables of a deleted project removed', { projectId, count })
      }
    }
  }

  // Subscribed lazily by the first use (no boot step, no listener while project MCP is unused); the first use also
  // removes the variables of projects deleted before (a project deleted while the manager followed the events loses
  // them right away).
  let subscription: Disposable | null = null
  let swept = false
  function follow(): void {
    if (stopped || subscription !== null)
      return
    try {
      subscription = deps.events.subscribe(onEvent)
    }
    catch (error) {
      deps.logger.warn('the project MCP manager cannot follow the server events', { err: error })
    }
    if (!swept) {
      swept = true
      track(sweepOrphans())
    }
  }

  // ---------- waiting ----------

  async function waitReady(waits: readonly Promise<void>[], waitMs: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (waits.length === 0 || waitMs <= 0)
      return
    let timer: NodeJS.Timeout | undefined
    let onAbort: (() => void) | undefined
    try {
      await Promise.race([
        Promise.allSettled(waits),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, waitMs)
        }),
        new Promise<void>((_, reject) => {
          onAbort = () => reject(signal.reason)
          signal.addEventListener('abort', onAbort, { once: true })
        }),
      ])
    }
    finally {
      clearTimeout(timer)
      if (onAbort !== undefined)
        signal.removeEventListener('abort', onAbort)
    }
  }

  async function toolsFor(projectId: string, toolsOptions: ProjectMcpToolsOptions): Promise<ProjectMcpTools> {
    const { signal } = toolsOptions
    signal.throwIfAborted()
    if (stopped || deleted.has(projectId) || deps.env.safeMode)
      return noProjectMcpTools()
    follow()
    try {
      // Nothing approved and nothing running: the folder is not read at all (no project config read per run).
      const approved = await deps.projectTrust.approved(projectId)
      if (approved.size === 0 && !projects.has(projectId))
        return noProjectMcpTools()
      let snapshot = await deps.projectConfig.snapshot(projectId, { signal })
      if (snapshot.mcpServers.length === 0 && !projects.has(projectId))
        return noProjectMcpTools()
      const stored = await variables.names(projectId)
      retire(projectId, snapshot, approved, stored)
      let decided = plan(projectId, snapshot, approved, stored)
      if (decided.toStart.length > 0 && snapshot.root !== null) {
        // Right before a start the folder is read again: a changed `.mcp.json` item is a new hash (pending).
        snapshot = await deps.projectConfig.snapshot(projectId, { signal, refresh: true })
        retire(projectId, snapshot, approved, stored)
        decided = plan(projectId, snapshot, approved, stored)
      }
      signal.throwIfAborted()
      if (stopped || deleted.has(projectId))
        return noProjectMcpTools()
      const waits: Promise<void>[] = []
      const root = snapshot.root
      // No await from here to the starts: a concurrent run sees `connecting` and waits for the same attempt.
      for (const item of decided.wanted) {
        const runtime = runtimeFor(projectId, item)
        const startable = runtime.item.sha256 !== item.sha256 || (!isOpen(runtime) && runtime.attempt === null)
        if (startable && root !== null)
          waits.push(startRuntime(runtime, item, root))
        else if (runtime.attempt !== null)
          waits.push(runtime.attempt)
      }
      await waitReady(waits, toolsOptions.waitMs, signal)

      const tools: RegisteredTool[] = []
      const names = new Map<string, string>()
      const unavailable: string[] = []
      for (const item of decided.wanted) {
        const runtime = currentRuntime(projectId, item)
        if (runtime?.status === 'connected') {
          tools.push(...runtime.tools)
          names.set(item.server.id, item.server.name)
          armIdle(runtime)
        }
        else if (runtime?.status !== 'stale') {
          unavailable.push(item.server.name)
        }
      }
      const globals = globalServerIds()
      const shadowed = new Set(decided.approved.map(item => item.server.id).filter(id => globals.has(id)))
      return { tools: tools.sort(byName), shadowed, unavailable, names }
    }
    catch (error) {
      // The run's abort is the only rejection.
      signal.throwIfAborted()
      deps.logger.warn('project MCP tools are not available', { projectId, err: isHarnessError(error) ? error.code : error })
      return noProjectMcpTools()
    }
  }

  async function list(projectId: string): Promise<ProjectMcpList> {
    // `not_found` for an unknown project (the route answers 404).
    await deps.projects.get(projectId)
    follow()
    const snapshot = await deps.projectConfig.snapshot(projectId, { refresh: true })
    const approved = await deps.projectTrust.approved(projectId)
    const stored = await variables.names(projectId)
    if (!stopped && !deleted.has(projectId))
      retire(projectId, snapshot, approved, stored)
    return {
      items: await serverViews(projectId, snapshot, { approved, stored }),
      variables: projectMcpVariables(snapshot.mcpServers, stored),
    }
  }

  return {
    toolsFor,
    list,

    setVariables: async (projectId, values, sensitive) => {
      sensitive?.requireFreshAuth()
      await deps.projects.get(projectId)
      follow()
      const changed = await serialized(projectId, async () => {
        const names = await variables.apply(projectId, values)
        if (names.size === 0)
          return names
        deps.logger.info('project MCP variables changed', { projectId, count: names.size })
        // The servers that use a changed variable restart (when they were running) with the new values.
        const restart = new Set<string>()
        for (const runtime of runtimesOf(projectId)?.values() ?? []) {
          if (!referencedVariables(runtime.item.server.transport).some(name => names.has(name)))
            continue
          if (isOpen(runtime))
            restart.add(runtime.id)
          if (runtime.status !== 'idle')
            stopRuntime(runtime, 'variables changed')
        }
        await reconcile(projectId, restart)
        return names
      })
      if (changed.size > 0)
        scheduleEmit(projectId)
      return list(projectId)
    },

    reconnect: async (projectId, serverId) => {
      await deps.projects.get(projectId)
      follow()
      const snapshot = await deps.projectConfig.snapshot(projectId, { refresh: true })
      const item = snapshot.mcpServers.find(entry => entry.server.id === serverId)
      if (item === undefined)
        throw notFoundServer(serverId)
      if (deps.env.safeMode)
        throw safeModeConflict()
      const approved = await deps.projectTrust.approved(projectId)
      const stored = await variables.names(projectId)
      if (!stopped && !deleted.has(projectId)) {
        retire(projectId, snapshot, approved, stored)
        if (canStart(item, approved, stored) && snapshot.root !== null) {
          deps.logger.info('project MCP server reconnecting', { projectId, serverId })
          const attempt = startRuntime(runtimeFor(projectId, item), item, snapshot.root)
          let timer: NodeJS.Timeout | undefined
          await Promise.race([attempt, new Promise<void>((resolve) => {
            timer = setTimeout(resolve, options.reconnectWaitMs ?? MCP_RECONNECT_WAIT_MS)
          })])
          clearTimeout(timer)
        }
      }
      const views = await serverViews(projectId, snapshot, { approved, stored })
      const view = views.find(entry => entry.id === serverId)
      if (view === undefined)
        throw notFoundServer(serverId)
      return view
    },

    stopProject: async (projectId) => {
      try {
        await stopRuntimes(projectId)
      }
      catch (error) {
        deps.logger.warn('stopping the project MCP servers failed', { projectId, err: error })
      }
    },

    stop: async () => {
      if (stopped)
        return
      stopped = true
      subscription?.dispose()
      subscription = null
      for (const timer of emitTimers.values())
        clearTimeout(timer)
      emitTimers.clear()
      for (const timers of [reconcileTimers, pollTimers]) {
        for (const timer of timers.values())
          clearTimeout(timer)
        timers.clear()
      }
      const pending = [...attempts]
      for (const map of projects.values()) {
        for (const runtime of map.values()) {
          detach(runtime)
          runtime.status = 'idle'
        }
      }
      projects.clear()
      await Promise.allSettled(pending)
      await Promise.allSettled([...background])
      await Promise.allSettled([...closing])
    },
  }
}
