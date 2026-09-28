// MCP manager (W3.5-T1, T2; PLUGINS.md 5 / 10 / 14, API.md 5.13): one `@ai-sdk/mcp` client per enabled MCP server
// declared in the registry. Declarations come from plugin manifests (`contributes.mcpServers`), `ctx.mcp.register` and
// the user servers of the MCP panel (`mcp_servers` + secrets `mcp:<id>`). The manager declares the user servers as
// contributions of the builtin `core-mcp` while that plugin is active: it follows `PluginHost.onStateChange` (and checks
// the state at `start()`), and the host removes them with every other `core-mcp` contribution when it is disabled,
// reloaded or stopped.
//
// Lifecycle: `start()` (after the plugin host) connects the declared servers in the background and then follows
// registry changes (20 s connect timeout, never blocking boot); a failed or dropped connection retries with backoff; a
// removed declaration (plugin disabled / reloaded / uninstalled, settings change, user edit or delete) closes its
// client, which terminates a stdio child. Connected servers' tools are registered as `mcp__<serverId>__<tool>` owned
// by the declaring plugin (`mcpServerId` set) with the policy from their annotations; they are unregistered on
// disconnect and listed as `available: false` by the tool service. Status changes emit `plugin.changed` for the owner.
import type { MCPClient, MCPClientConfig } from '@ai-sdk/mcp'
import type { Disposable, McpServerDecl, ToolCallContext, ToolDefinition } from '@harness-forge/plugin-sdk'
import type { HarnessErrorInit, LogLevel, McpServer, McpStatus, ToolPolicy } from '@harness-forge/shared'
import type { RegisteredMcpServer, RegistryChange } from '../registry/types.ts'
import type { AppDeps } from '../types.ts'
import type { McpManagerInternals, OfflineMcpTool } from './internal.ts'
import type { McpListedTool } from './mcp-tools.ts'
import type { StdioExit } from './stdio-transport.ts'
import type { ResolvedMcpTransport } from './templating.ts'
import type { McpManager } from './types.ts'
import type { UserServerRecord } from './user-servers.ts'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createMCPClient } from '@ai-sdk/mcp'
import { HarnessError } from '@harness-forge/shared'
import { appVersion } from '../paths.ts'
import { connectionErrorInit, errorMessage, isConnectionFailure, isPermanentMcpError, mcpConfigError } from './errors.ts'
import { CORE_MCP_PLUGIN_ID } from './internal.ts'
import { mcpToolDefinition, mcpToolTitle, offlineToolOf } from './mcp-tools.ts'
import { DEFAULT_MCP_POLICY } from './policy.ts'
import { createStdioTransport } from './stdio-transport.ts'
import { resolveDeclTransport } from './templating.ts'
import { createUserServerStore, ENV_SECRET_PREFIX, HEADER_SECRET_PREFIX, secretStateOf, transportChanged } from './user-servers.ts'

export { CORE_MCP_PLUGIN_ID } from './internal.ts'

/** Delays of the automatic reconnect attempts after a failure; then the server stays in `error` until a reconnect. */
export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [2000, 5000, 15_000, 30_000, 60_000, 120_000, 300_000]
/** Connect timeout (PLUGINS.md 11 "Guards": MCP connect 20 s); `core-mcp` setting `connectTimeoutSeconds`. */
export const MCP_CONNECT_TIMEOUT_MS = 20_000
/** `POST /mcp/:id/reconnect` waits at most this long for the attempt. */
export const MCP_RECONNECT_WAIT_MS = 10_000
/** Timeout of one `tools/list` page. */
const TOOL_LIST_TIMEOUT_MS = 20_000
const MAX_TOOL_PAGES = 50
const MAX_TOOLS = 1000
/** stderr lines forwarded per server and minute. */
const STDERR_LINES_PER_MINUTE = 100

export interface McpManagerOptions {
  /** Automatic reconnect delays (tests use short ones). */
  retryDelaysMs?: readonly number[]
  /** Overrides the `core-mcp` connect timeout setting. */
  connectTimeoutMs?: number
  reconnectWaitMs?: number
  /** Coalescing delay of `plugin.changed` events (default 25 ms). */
  eventDelayMs?: number
  /** SIGTERM -> SIGKILL grace of stdio children. */
  killGraceMs?: number
  /** `createMCPClient` (tests may wrap it). */
  createClient?: (config: MCPClientConfig) => Promise<MCPClient>
}

type RuntimeStatus = 'idle' | 'connecting' | 'connected' | 'error'

/** Connection state of one declared server id. */
interface ServerRuntime {
  readonly id: string
  pluginId: string
  /** Incremented by every connect / close: callbacks of older attempts are ignored. */
  generation: number
  status: RuntimeStatus
  error: HarnessErrorInit | null
  connectedAt: number | null
  client: MCPClient | null
  controller: AbortController | null
  /** Server policy used for the registered tools. */
  policy: ToolPolicy
  tools: Disposable[]
  /** Last successful listing (kept while disconnected). */
  lastTools: OfflineMcpTool[]
  /** Automatic reconnect attempts since the last success. */
  attempt: number
  retryTimer: NodeJS.Timeout | null
  stderr: { windowStart: number, count: number, muted: boolean }
}

interface ConnectTarget {
  id: string
  pluginId: string
  policy: ToolPolicy
  transport: ResolvedMcpTransport
  cwd: string | undefined
}

interface CoreSettings {
  autoReconnect: boolean
  connectTimeoutMs: number
}

function notFound(id: string): HarnessError {
  return new HarnessError({ code: 'not_found', message: `Unknown MCP server "${id}".` })
}

function pluginDeclared(id: string, pluginId: string): HarnessError {
  return new HarnessError({
    code: 'forbidden',
    message: `The MCP server "${id}" is declared by the plugin "${pluginId}" and cannot be changed here.`,
  })
}

function idTaken(id: string, pluginId: string): HarnessErrorInit {
  return {
    code: 'conflict',
    message: `The id "${id}" is already used by an MCP server of the plugin "${pluginId}".`,
    details: { reason: 'exists' },
  }
}

function describeExit(exit: StdioExit): string {
  if (exit.signal)
    return `signal ${exit.signal}`
  return `code ${exit.code ?? 'unknown'}`
}

/** A registry declaration for a user server: the manager reads the real transport from the row and its secrets. */
function userDecl(row: UserServerRecord): McpServerDecl {
  const name = row.name.slice(0, 64).trim() || row.id
  const transport: McpServerDecl['transport'] = row.transport.type === 'stdio'
    ? { type: 'stdio', command: row.transport.command.replaceAll('{{', '{ {') }
    : { type: row.transport.type, url: row.transport.url.replaceAll('{', '%7B').replaceAll('}', '%7D') }
  return { id: row.id, name, policy: row.policy, transport }
}

export function createMcpManager(deps: AppDeps): McpManager {
  return createMcpManagerCore(deps)
}

/** The manager with its internal extension (`mcpInternals`) and test options. */
export function createMcpManagerCore(deps: AppDeps, options: McpManagerOptions = {}): McpManager & McpManagerInternals {
  const store = createUserServerStore(deps)
  const retryDelays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS
  const createClient = options.createClient ?? createMCPClient
  const servers = new Map<string, ServerRuntime>()
  /** Cache of `mcp_servers` rows, maintained by the serialized user operations. */
  const userRows = new Map<string, UserServerRecord>()
  /** Registry declarations of user servers made by this manager (owner `core-mcp`). */
  const userDecls = new Map<string, Disposable>()
  /** Why a user server could not be declared (id taken by a plugin). */
  const userErrors = new Map<string, HarnessErrorInit>()
  const closing = new Set<Promise<void>>()
  const attempts = new Set<Promise<void>>()
  const emitTimers = new Map<string, NodeJS.Timeout>()
  let subscriptions: Disposable[] = []
  let userOps: Promise<unknown> = Promise.resolve()
  let started = false
  let stopped = false
  /** `core-mcp` is active: the user servers are declared as its contributions. */
  let coreActive = false
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

  function log(pluginId: string, level: LogLevel, message: string): void {
    try {
      deps.plugins.log(pluginId, level, message)
    }
    catch {
      deps.logger[level](message, { pluginId })
    }
  }

  /**
   * The owner may run servers: active (and not being disposed), or loading (its servers connect while its `setup`
   * finishes; a failed load removes them again). Unknown to the host (registered by server code) counts as usable.
   */
  function ownerUsable(pluginId: string): boolean {
    try {
      const state = deps.plugins.state(pluginId)
      return state === null || state === 'loading' || deps.plugins.isActive(pluginId)
    }
    catch {
      return true
    }
  }

  async function coreSettings(): Promise<CoreSettings> {
    let values: Record<string, unknown> = {}
    try {
      values = await deps.plugins.settingsValues(CORE_MCP_PLUGIN_ID)
    }
    catch {}
    const seconds = typeof values.connectTimeoutSeconds === 'number' && Number.isFinite(values.connectTimeoutSeconds)
      ? Math.min(Math.max(values.connectTimeoutSeconds, 5), 120)
      : MCP_CONNECT_TIMEOUT_MS / 1000
    return { autoReconnect: values.autoReconnect !== false, connectTimeoutMs: seconds * 1000 }
  }

  // ---------- events ----------

  async function emitChanged(pluginId: string): Promise<void> {
    if (stopped)
      return
    try {
      const plugin = await deps.plugins.summary(pluginId)
      if (!stopped)
        deps.events.emit('plugin.changed', { id: pluginId, plugin })
    }
    catch {
      // A plugin unknown to the host (direct registrations) has no summary to announce.
    }
  }

  /** Coalesced `plugin.changed` for the owner of a server. */
  function scheduleEmit(pluginId: string): void {
    if (stopped || emitTimers.has(pluginId))
      return
    const timer = setTimeout(() => {
      emitTimers.delete(pluginId)
      void emitChanged(pluginId)
    }, options.eventDelayMs ?? 25)
    timer.unref?.()
    emitTimers.set(pluginId, timer)
  }

  // ---------- runtimes ----------

  function ensureRuntime(id: string, pluginId: string): ServerRuntime {
    let runtime = servers.get(id)
    if (!runtime) {
      runtime = {
        id,
        pluginId,
        generation: 0,
        status: 'idle',
        error: null,
        connectedAt: null,
        client: null,
        controller: null,
        policy: DEFAULT_MCP_POLICY,
        tools: [],
        lastTools: [],
        attempt: 0,
        retryTimer: null,
        stderr: { windowStart: 0, count: 0, muted: false },
      }
      servers.set(id, runtime)
    }
    else if (runtime.pluginId !== pluginId) {
      detach(runtime)
      runtime.pluginId = pluginId
      runtime.lastTools = []
      runtime.attempt = 0
      runtime.status = 'idle'
      runtime.error = null
    }
    return runtime
  }

  function setStatus(runtime: ServerRuntime, status: RuntimeStatus, error: HarnessErrorInit | null): void {
    runtime.status = status
    runtime.error = error
    scheduleEmit(runtime.pluginId)
  }

  function trackClose(client: MCPClient): void {
    const done: Promise<void> = client.close()
      .catch((error: unknown) => deps.logger.debug('MCP client close failed', { err: error }))
      .finally(() => {
        closing.delete(done)
      })
    closing.add(done)
  }

  function disposeTools(runtime: ServerRuntime): void {
    const handles = runtime.tools
    runtime.tools = []
    for (const handle of handles) {
      try {
        handle.dispose()
      }
      catch (error) {
        deps.logger.warn('MCP tool unregister failed', { serverId: runtime.id, err: error })
      }
    }
  }

  /** Cancels the attempt / retry and closes the client (in the background); keeps the last listing. */
  function detach(runtime: ServerRuntime): void {
    runtime.generation += 1
    runtime.controller?.abort()
    runtime.controller = null
    if (runtime.retryTimer) {
      clearTimeout(runtime.retryTimer)
      runtime.retryTimer = null
    }
    disposeTools(runtime)
    const client = runtime.client
    runtime.client = null
    runtime.connectedAt = null
    if (client)
      trackClose(client)
  }

  /** The server is declared, its owner is active and (user servers) it is enabled. */
  function wanted(id: string): boolean {
    if (stopped)
      return false
    const registered = deps.registry.mcpServers.get(id)
    if (!registered || !ownerUsable(registered.pluginId))
      return false
    if (registered.pluginId === CORE_MCP_PLUGIN_ID)
      return userRows.get(id)?.enabled === true
    return true
  }

  // ---------- connecting ----------

  async function workDir(pluginId: string): Promise<string> {
    const dir = join(deps.env.paths.pluginData, pluginId)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    return dir
  }

  async function assertTrusted(pluginId: string, id: string): Promise<void> {
    let trusted = true
    try {
      const detail = await deps.plugins.get(pluginId)
      trusted = detail.builtin || !detail.trust.required || detail.trust.trusted
    }
    catch {
      // Unknown to the host: registered by server code, which is trusted.
    }
    if (!trusted)
      throw new HarnessError({ code: 'forbidden', message: `The plugin "${pluginId}" is not trusted, so its stdio MCP server "${id}" is not started.` })
  }

  async function resolveTarget(id: string): Promise<ConnectTarget> {
    const registered = deps.registry.mcpServers.get(id)
    if (!registered)
      throw mcpConfigError(`The MCP server "${id}" is not declared anymore.`)
    const { pluginId, decl } = registered
    if (pluginId === CORE_MCP_PLUGIN_ID) {
      const row = userRows.get(id) ?? await store.get(id)
      if (!row)
        throw mcpConfigError(`The MCP server "${id}" does not exist anymore.`)
      const transport = await store.resolveTransport(row)
      return { id, pluginId, policy: row.policy, transport, cwd: transport.type === 'stdio' ? await workDir(pluginId) : undefined }
    }
    if (decl.transport.type === 'stdio')
      await assertTrusted(pluginId, id)
    let settings: Record<string, unknown> = {}
    try {
      settings = await deps.plugins.settingsValues(pluginId)
    }
    catch {}
    const transport = resolveDeclTransport(id, decl.transport, settings)
    let cwd: string | undefined
    if (transport.type === 'stdio')
      cwd = (await deps.plugins.directory(pluginId).catch(() => null)) ?? await workDir(pluginId)
    return { id, pluginId, policy: decl.policy ?? DEFAULT_MCP_POLICY, transport, cwd }
  }

  function onStderr(runtime: ServerRuntime, line: string): void {
    const now = Date.now()
    const budget = runtime.stderr
    if (now - budget.windowStart > 60_000) {
      budget.windowStart = now
      budget.count = 0
      budget.muted = false
    }
    budget.count += 1
    if (budget.count > STDERR_LINES_PER_MINUTE) {
      if (!budget.muted) {
        budget.muted = true
        log(runtime.pluginId, 'warn', `[${runtime.id}] Too much stderr output: further lines are dropped for a minute.`)
      }
      return
    }
    log(runtime.pluginId, 'info', `[${runtime.id}] ${line}`)
  }

  function createTransport(target: ConnectTarget, runtime: ServerRuntime, generation: number): MCPClientConfig['transport'] {
    const transport = target.transport
    if (transport.type === 'stdio') {
      return createStdioTransport({
        command: transport.command,
        args: transport.args,
        env: transport.env,
        cwd: target.cwd,
        killGraceMs: options.killGraceMs,
        onStderr: line => onStderr(runtime, redact(line)),
        onNotification: (method) => {
          if (method === 'notifications/tools/list_changed')
            void refreshTools(runtime, generation)
        },
        onExit: exit => onDisconnected(runtime, generation, new Error(`The MCP server process exited (${describeExit(exit)}).`)),
      })
    }
    return { type: transport.type, url: transport.url, headers: { ...transport.headers }, redirect: 'error' }
  }

  async function listAllTools(client: MCPClient, signal: AbortSignal | undefined): Promise<McpListedTool[]> {
    if (!client.initializeResult.capabilities.tools)
      return []
    const tools: McpListedTool[] = []
    let cursor: string | undefined
    for (let page = 0; page < MAX_TOOL_PAGES && tools.length < MAX_TOOLS; page++) {
      const result = await client.listTools({
        ...(cursor === undefined ? {} : { params: { cursor } }),
        options: { ...(signal ? { signal } : {}), timeout: TOOL_LIST_TIMEOUT_MS },
      })
      tools.push(...result.tools)
      cursor = result.nextCursor
      if (!cursor)
        break
    }
    return tools.slice(0, MAX_TOOLS)
  }

  async function callTool(runtime: ServerRuntime, generation: number, name: string, input: Record<string, unknown>, c: ToolCallContext) {
    const client = generation === runtime.generation ? runtime.client : null
    if (!client)
      throw new Error(`The MCP server "${runtime.id}" is not connected.`)
    try {
      return await client.callTool({ name, arguments: input, options: { signal: c.signal } })
    }
    catch (error) {
      if (!c.signal.aborted && isConnectionFailure(error))
        onDisconnected(runtime, generation, error)
      throw new Error(`The MCP tool "${name}" failed: ${redact(errorMessage(error))}`)
    }
  }

  function registerTools(runtime: ServerRuntime, generation: number, listed: readonly McpListedTool[]): void {
    const binding = {
      serverId: runtime.id,
      pluginId: runtime.pluginId,
      serverPolicy: runtime.policy,
      call: (name: string, input: Record<string, unknown>, c: ToolCallContext) => callTool(runtime, generation, name, input, c),
    }
    const seen = new Set<string>()
    const offline: OfflineMcpTool[] = []
    for (const tool of listed) {
      const definition = mcpToolDefinition(tool, binding)
      if (seen.has(definition.name)) {
        log(runtime.pluginId, 'warn', `[${runtime.id}] The tool "${tool.name}" is skipped: its name collides with another tool of this server.`)
        continue
      }
      seen.add(definition.name)
      const title = mcpToolTitle(tool)
      try {
        runtime.tools.push(deps.registry.tools.register(runtime.pluginId, definition as ToolDefinition, {
          mcpServerId: runtime.id,
          ...(title === null ? {} : { title }),
        }))
        offline.push(offlineToolOf(tool, binding))
      }
      catch (error) {
        log(runtime.pluginId, 'warn', `[${runtime.id}] The tool "${tool.name}" is skipped: ${errorMessage(error)}`)
      }
    }
    runtime.lastTools = offline
  }

  async function refreshTools(runtime: ServerRuntime, generation: number): Promise<void> {
    const client = runtime.client
    if (!client || generation !== runtime.generation)
      return
    try {
      const listed = await listAllTools(client, undefined)
      if (generation !== runtime.generation || runtime.client !== client)
        return
      disposeTools(runtime)
      registerTools(runtime, generation, listed)
      scheduleEmit(runtime.pluginId)
    }
    catch (error) {
      log(runtime.pluginId, 'warn', `[${runtime.id}] Refreshing the tool list failed: ${redact(errorMessage(error))}`)
    }
  }

  async function scheduleRetry(runtime: ServerRuntime): Promise<void> {
    const generation = runtime.generation
    if (stopped || runtime.attempt >= retryDelays.length)
      return
    const settings = await coreSettings()
    if (!settings.autoReconnect || stopped || generation !== runtime.generation || runtime.retryTimer !== null)
      return
    const delay = retryDelays[runtime.attempt] ?? 0
    runtime.attempt += 1
    log(runtime.pluginId, 'info', `[${runtime.id}] Reconnecting in ${Math.max(1, Math.round(delay / 1000))} s.`)
    runtime.retryTimer = setTimeout(() => {
      runtime.retryTimer = null
      if (generation === runtime.generation && wanted(runtime.id))
        void connect(runtime)
    }, delay)
    runtime.retryTimer.unref?.()
  }

  /** A connected (or connecting) client failed: close it, report the error and retry with backoff. */
  function onDisconnected(runtime: ServerRuntime, generation: number, error: unknown): void {
    if (stopped || generation !== runtime.generation)
      return
    detach(runtime)
    const init = connectionErrorInit(error, redact)
    setStatus(runtime, 'error', init)
    log(runtime.pluginId, 'warn', `[${runtime.id}] Disconnected: ${init.message}`)
    void scheduleRetry(runtime)
  }

  async function runConnect(runtime: ServerRuntime, generation: number, signal: AbortSignal): Promise<void> {
    const current = (): boolean => generation === runtime.generation && !stopped
    let client: MCPClient | null = null
    try {
      const target = await resolveTarget(runtime.id)
      if (!current())
        return
      const settings = await coreSettings()
      if (!current())
        return
      runtime.policy = target.policy
      client = await createClient({
        transport: createTransport(target, runtime, generation),
        clientName: 'harness-forge',
        version: version(),
        onUncaughtError: (error) => {
          if (generation === runtime.generation)
            log(runtime.pluginId, 'debug', `[${runtime.id}] ${redact(errorMessage(error))}`)
        },
        initializationOptions: { signal, timeout: options.connectTimeoutMs ?? settings.connectTimeoutMs },
      })
      if (!current()) {
        trackClose(client)
        return
      }
      const listed = await listAllTools(client, signal)
      if (!current()) {
        trackClose(client)
        return
      }
      runtime.client = client
      runtime.controller = null
      registerTools(runtime, generation, listed)
      runtime.attempt = 0
      runtime.connectedAt = Date.now()
      setStatus(runtime, 'connected', null)
      const count = runtime.tools.length
      log(runtime.pluginId, 'info', `[${runtime.id}] Connected (${count} ${count === 1 ? 'tool' : 'tools'}).`)
    }
    catch (error) {
      if (client !== null && runtime.client !== client)
        trackClose(client)
      if (!current())
        return
      runtime.controller = null
      const init = connectionErrorInit(error, redact)
      setStatus(runtime, 'error', init)
      log(runtime.pluginId, 'warn', `[${runtime.id}] Connection failed: ${init.message}`)
      if (!isPermanentMcpError(error))
        await scheduleRetry(runtime)
    }
  }

  /** Closes any previous client and connects; resolves when the attempt settled. */
  function connect(runtime: ServerRuntime): Promise<void> {
    detach(runtime)
    const generation = runtime.generation
    const controller = new AbortController()
    runtime.controller = controller
    setStatus(runtime, 'connecting', null)
    const attempt: Promise<void> = runConnect(runtime, generation, controller.signal).finally(() => {
      attempts.delete(attempt)
    })
    attempts.add(attempt)
    return attempt
  }

  // ---------- following the registry and the plugin host ----------

  function onRegistryChange(change: RegistryChange): void {
    if (change.kind !== 'mcpServer' || stopped)
      return
    const id = change.key
    if (change.action === 'added') {
      const runtime = ensureRuntime(id, change.pluginId)
      if (wanted(id) && runtime.status !== 'connecting' && runtime.status !== 'connected')
        void connect(runtime)
      else
        scheduleEmit(change.pluginId)
      return
    }
    if (change.pluginId === CORE_MCP_PLUGIN_ID)
      userDecls.delete(id)
    const runtime = servers.get(id)
    if (runtime && runtime.pluginId === change.pluginId) {
      const wasOpen = runtime.status === 'connected' || runtime.status === 'connecting'
      detach(runtime)
      runtime.status = 'idle'
      runtime.error = null
      runtime.attempt = 0
      if (wasOpen)
        log(runtime.pluginId, 'info', `[${id}] Closed.`)
      // Forget the runtime unless the id is declared again right away (a settings change or an edit re-declares it
      // synchronously and keeps the last listing).
      queueMicrotask(() => {
        if (servers.get(id) === runtime && runtime.status === 'idle' && deps.registry.mcpServers.get(id) === undefined)
          servers.delete(id)
      })
    }
    scheduleEmit(change.pluginId)
    // A plugin server that held the id of a user server went away: the user server can be declared now.
    if (change.pluginId !== CORE_MCP_PLUGIN_ID && userRows.has(id))
      syncInBackground()
  }

  // ---------- user servers ----------

  /** Serializes user server operations (row cache + declarations); the caller handles the outcome. */
  function runUserOp<T>(fn: () => Promise<T>): Promise<T> {
    const run = userOps.then(fn)
    userOps = run.then(() => undefined, () => undefined)
    return run
  }

  /** Re-declares the user servers in the background (after `core-mcp` or a conflicting plugin changed). */
  function syncInBackground(): void {
    runUserOp(syncUserServers).catch((error: unknown) => {
      deps.logger.warn('MCP user server sync failed', { err: error })
    })
  }

  /** Declares (or re-declares) a user server as a contribution of `core-mcp`; records a failure as its error. */
  function registerUserDecl(row: UserServerRecord): void {
    const previous = userDecls.get(row.id)
    userDecls.delete(row.id)
    previous?.dispose()
    if (!coreActive || stopped)
      return
    try {
      const handle = deps.registry.mcpServers.register(CORE_MCP_PLUGIN_ID, userDecl(row))
      userDecls.set(row.id, handle)
      userErrors.delete(row.id)
    }
    catch (error) {
      const registered = deps.registry.mcpServers.get(row.id)
      const init = registered && registered.pluginId !== CORE_MCP_PLUGIN_ID ? idTaken(row.id, registered.pluginId) : connectionErrorInit(error, redact)
      userErrors.set(row.id, init)
      log(CORE_MCP_PLUGIN_ID, 'warn', `[${row.id}] Not started: ${init.message}`)
      scheduleEmit(CORE_MCP_PLUGIN_ID)
    }
  }

  /** Declares every stored server that is not declared yet (after attaching, or when a conflicting id went away). */
  async function syncUserServers(): Promise<void> {
    const rows = await store.list()
    userRows.clear()
    for (const row of rows)
      userRows.set(row.id, row)
    for (const [id, handle] of [...userDecls]) {
      if (!userRows.has(id)) {
        userDecls.delete(id)
        handle.dispose()
      }
    }
    for (const row of rows) {
      if (!(userDecls.has(row.id) && deps.registry.mcpServers.get(row.id)?.pluginId === CORE_MCP_PLUGIN_ID))
        registerUserDecl(row)
    }
  }

  /** Removes the user server declarations (usually already removed by the host with the other `core-mcp` ones). */
  function disposeUserDecls(): void {
    const handles = [...userDecls.values()]
    userDecls.clear()
    for (const handle of handles) {
      try {
        handle.dispose()
      }
      catch {}
    }
  }

  /** `core-mcp` became active (declare the stored servers) or left `active` (drop them). */
  function followCore(active: boolean): void {
    if (stopped || active === coreActive)
      return
    coreActive = active
    if (active)
      syncInBackground()
    else
      disposeUserDecls()
  }

  function coreIsActive(): boolean {
    try {
      return deps.plugins.isActive(CORE_MCP_PLUGIN_ID)
    }
    catch {
      return false
    }
  }

  // ---------- DTOs ----------

  function registeredToolNames(id: string): string[] {
    return deps.registry.tools.list().filter(tool => tool.mcpServerId === id).map(tool => tool.definition.name)
  }

  function runtimeView(runtime: ServerRuntime | undefined): { status: McpStatus, error: HarnessErrorInit | null } {
    if (runtime?.status === 'connected')
      return { status: 'connected', error: null }
    if (runtime?.status === 'error')
      return { status: 'error', error: runtime.error }
    return { status: 'connecting', error: null }
  }

  function userView(row: UserServerRecord): { status: McpStatus, error: HarnessErrorInit | null } {
    if (!row.enabled || !coreActive)
      return { status: 'disabled', error: null }
    const registered = deps.registry.mcpServers.get(row.id)
    if (registered?.pluginId !== CORE_MCP_PLUGIN_ID) {
      const error = userErrors.get(row.id) ?? (registered ? idTaken(row.id, registered.pluginId) : null)
      if (error)
        return { status: 'error', error }
    }
    return runtimeView(servers.get(row.id))
  }

  async function userDto(row: UserServerRecord): Promise<McpServer> {
    const entries = await store.secretEntries(row.id)
    const view = userView(row)
    const transport: McpServer['transport'] = row.transport.type === 'stdio'
      ? {
          type: 'stdio',
          command: row.transport.command,
          args: [...row.transport.args],
          env: Object.fromEntries(row.transport.envNames.map(name => [name, secretStateOf(entries.get(`${ENV_SECRET_PREFIX}${name}`))])),
        }
      : {
          type: row.transport.type,
          url: row.transport.url,
          headers: Object.fromEntries(row.transport.headerNames.map(name => [name, secretStateOf(entries.get(`${HEADER_SECRET_PREFIX}${name}`))])),
        }
    const connected = view.status === 'connected'
    return {
      id: row.id,
      name: row.name,
      pluginId: CORE_MCP_PLUGIN_ID,
      editable: true,
      transport,
      policy: row.policy,
      enabled: row.enabled,
      status: view.status,
      error: view.error,
      tools: connected ? registeredToolNames(row.id) : [],
      connectedAt: connected ? servers.get(row.id)?.connectedAt ?? null : null,
    }
  }

  function pluginDto(registered: RegisteredMcpServer): McpServer {
    const { decl, pluginId } = registered
    const state = (template: string) => (template === '' ? secretStateOf(undefined) : { set: true, hint: null, source: 'stored' as const })
    const transport: McpServer['transport'] = decl.transport.type === 'stdio'
      ? {
          type: 'stdio',
          command: decl.transport.command,
          args: [...(decl.transport.args ?? [])],
          env: Object.fromEntries(Object.entries(decl.transport.env ?? {}).map(([name, value]) => [name, state(value)])),
        }
      : {
          type: decl.transport.type,
          url: decl.transport.url,
          headers: Object.fromEntries(Object.entries(decl.transport.headers ?? {}).map(([name, value]) => [name, state(value)])),
        }
    const view = runtimeView(servers.get(decl.id))
    const connected = view.status === 'connected'
    return {
      id: decl.id,
      name: decl.name,
      pluginId,
      editable: false,
      transport,
      policy: decl.policy ?? DEFAULT_MCP_POLICY,
      enabled: true,
      status: view.status,
      error: view.error,
      tools: connected ? registeredToolNames(decl.id) : [],
      connectedAt: connected ? servers.get(decl.id)?.connectedAt ?? null : null,
    }
  }

  async function requireUserRow(id: string): Promise<UserServerRecord> {
    const row = await store.get(id)
    if (row)
      return row
    const registered = deps.registry.mcpServers.get(id)
    if (registered)
      throw pluginDeclared(id, registered.pluginId)
    throw notFound(id)
  }

  async function get(id: string): Promise<McpServer> {
    const row = await store.get(id)
    if (row)
      return userDto(row)
    const registered = deps.registry.mcpServers.get(id)
    if (registered && registered.pluginId !== CORE_MCP_PLUGIN_ID)
      return pluginDto(registered)
    throw notFound(id)
  }

  async function waitAtMost(promise: Promise<void>, ms: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined
    await Promise.race([promise, new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms)
    })])
    clearTimeout(timer)
  }

  // ---------- the manager ----------

  // Follows `core-mcp` from construction on (the host starts before `start()`), in-process: no event-bus subscription.
  let coreSubscription: Disposable | undefined
  try {
    coreSubscription = deps.plugins.onStateChange?.((change) => {
      if (change.id === CORE_MCP_PLUGIN_ID)
        followCore(change.state === 'active')
    })
  }
  catch (error) {
    deps.logger.warn('the MCP manager cannot follow the plugin host', { err: error })
  }

  return {
    start: async () => {
      if (started || stopped)
        return
      started = true
      // Nothing here may fail the boot: a broken registry or MCP configuration only leaves servers unconnected.
      try {
        subscriptions = [deps.registry.onChange(onRegistryChange)]
        // A host without state notifications, or a manager created after `core-mcp` became active.
        followCore(coreIsActive())
        for (const { pluginId, decl } of deps.registry.mcpServers.list()) {
          const runtime = ensureRuntime(decl.id, pluginId)
          if (runtime.status === 'idle' && wanted(decl.id))
            void connect(runtime)
        }
      }
      catch (error) {
        deps.logger.error('the MCP manager could not follow the registry', { err: error })
      }
    },

    stop: async () => {
      if (stopped)
        return
      stopped = true
      for (const subscription of subscriptions)
        subscription.dispose()
      subscriptions = []
      for (const timer of emitTimers.values())
        clearTimeout(timer)
      emitTimers.clear()
      const pending = [...attempts]
      for (const runtime of servers.values())
        detach(runtime)
      coreSubscription?.dispose()
      coreActive = false
      disposeUserDecls()
      await Promise.allSettled(pending)
      await Promise.allSettled([...closing])
    },

    list: async () => {
      const rows = await store.list()
      const userIds = new Set(rows.map(row => row.id))
      const users = await Promise.all(rows.map(row => userDto(row)))
      const declared = deps.registry.mcpServers.list()
        .filter(server => server.pluginId !== CORE_MCP_PLUGIN_ID && !userIds.has(server.decl.id))
        .map(pluginDto)
      return [...users, ...declared]
    },

    get,

    create: (input, sensitive) => runUserOp(async () => {
      if (input.transport.type === 'stdio')
        sensitive?.requireFreshAuth()
      const registered = deps.registry.mcpServers.get(input.id)
      if (registered)
        throw new HarnessError(idTaken(input.id, registered.pluginId))
      const row = await store.insert(input)
      userRows.set(row.id, row)
      log(CORE_MCP_PLUGIN_ID, 'info', `[${row.id}] Added (${row.transport.type}).`)
      registerUserDecl(row)
      scheduleEmit(CORE_MCP_PLUGIN_ID)
      return userDto(row)
    }),

    update: (id, patch, sensitive) => runUserOp(async () => {
      const current = await requireUserRow(id)
      if (patch.transport?.type === 'stdio' && transportChanged(current.transport, patch.transport))
        sensitive?.requireFreshAuth()
      const next = await store.update(current, patch)
      userRows.set(id, next)
      log(CORE_MCP_PLUGIN_ID, 'info', `[${id}] Updated.`)
      registerUserDecl(next)
      scheduleEmit(CORE_MCP_PLUGIN_ID)
      return userDto(next)
    }),

    remove: id => runUserOp(async () => {
      await requireUserRow(id)
      const handle = userDecls.get(id)
      userDecls.delete(id)
      handle?.dispose()
      const runtime = servers.get(id)
      if (runtime && runtime.pluginId === CORE_MCP_PLUGIN_ID) {
        detach(runtime)
        servers.delete(id)
      }
      userRows.delete(id)
      userErrors.delete(id)
      await store.remove(id)
      log(CORE_MCP_PLUGIN_ID, 'info', `[${id}] Deleted.`)
      scheduleEmit(CORE_MCP_PLUGIN_ID)
    }),

    reconnect: async (id) => {
      const row = await store.get(id)
      const registered = deps.registry.mcpServers.get(id)
      if (!row && !registered)
        throw notFound(id)
      if (row && registered && registered.pluginId !== CORE_MCP_PLUGIN_ID)
        throw new HarnessError(idTaken(id, registered.pluginId))
      if (!registered || !wanted(id))
        throw new HarnessError({ code: 'conflict', message: `The MCP server "${id}" is disabled.`, details: { reason: 'disabled' } })
      const runtime = ensureRuntime(id, registered.pluginId)
      runtime.attempt = 0
      log(registered.pluginId, 'info', `[${id}] Reconnecting.`)
      await waitAtMost(connect(runtime), options.reconnectWaitMs ?? MCP_RECONNECT_WAIT_MS)
      return get(id)
    },

    offlineTools: () => {
      const tools: OfflineMcpTool[] = []
      for (const runtime of servers.values()) {
        if (runtime.status === 'connected' || runtime.lastTools.length === 0)
          continue
        if (deps.registry.mcpServers.get(runtime.id)?.pluginId !== runtime.pluginId)
          continue
        tools.push(...runtime.lastTools)
      }
      return tools
    },

    serverStatus: (id) => {
      const registered = deps.registry.mcpServers.get(id)
      if (!registered)
        return null
      if (!wanted(id))
        return 'disabled'
      return runtimeView(servers.get(id)).status
    },
  }
}
