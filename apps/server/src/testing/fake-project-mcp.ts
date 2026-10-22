// Test double of the project MCP manager (Phase 11, C36-T10), so the chat seam (`modelStream` → `toolsFor`,
// `assembleTools({ extraTools, shadowedMcpServers })`, the notice `project-mcp-unavailable`), hook aliases and the
// project MCP routes can be tested without MCP servers:
//
//   const t = await createTestApp({ projectMcp: 'fake' })   // or overrides: { projectMcp: createFakeProjectMcpManager() }
//   const fake = t.deps.projectMcp as FakeProjectMcpManager
//   fake.tools.set(projectId, fakeProjectMcpTools([fakeProjectMcpTool('docs', 'search')], { shadowed: ['docs'], names: { docs: 'Docs' } }))
//   fake.lists.set(projectId, { items: [...], variables: [...] })
//
// `toolsFor` records the call and answers the scripted tools of the project (else none); an aborted signal rejects with
// its reason. `list` answers the scripted list (else empty) with `variables[].set` from the stored values. `setVariables`
// calls `requireFreshAuth` first when given, stores or clears the values in memory and answers the list. `reconnect`
// answers the listed server (`not_found` otherwise). `stopProject` / `stop` are recorded. Any id is a project.
//
// Phase 14 (C50-T6): the prompt and resource members. `prompts` / `resources` answer the scripted listing of the project
// (`promptLists` / `resourceLists`, else empty); `getPrompt` / `readResource` record the call and answer the scripted
// result (`promptResults` keyed `<projectId>/<serverId>/<name>`, `resourceContents` keyed `<projectId>/<serverId>/<uri>`)
// or `not_found`; an aborted signal rejects with its reason. `authTarget` is the real naming (`project:<projectId>`,
// `mcp-oauth.<serverId>`). Hand-written global `McpManager` doubles spread `inertMcpManagerMembers()` (./fake-mcp.ts).
import type { ProjectMcpList, ToolPolicy } from '@harness-forge/shared'
import type {
  McpPromptInfo,
  McpPromptResult,
  McpResourceContents,
  McpResourceInfo,
  ProjectMcpListing,
  ProjectMcpManager,
  ProjectMcpTools,
} from '../mcp/types.ts'
import type { RegisteredTool } from '../registry/types.ts'
import { HarnessError } from '@harness-forge/shared'
import { CORE_MCP_PLUGIN_ID } from '../mcp/internal.ts'
import { mcpToolDefinition } from '../mcp/mcp-tools.ts'
import { noProjectMcpTools } from '../mcp/project.ts'
import { emptyProjectMcpListing, projectMcpAuthStorage } from './fake-mcp.ts'

/**
 * A project MCP tool (`mcp__<serverId>__<tool>`, owner `core-mcp`, `mcpServerId` set) whose call answers `text` (default
 * `<tool> ok`); `policy` = the server policy of a tool without annotations (default `ask`).
 */
export function fakeProjectMcpTool(serverId: string, toolName: string, options: { readonly text?: string, readonly policy?: ToolPolicy } = {}): RegisteredTool {
  const definition = mcpToolDefinition(
    { name: toolName, description: `The ${toolName} tool of ${serverId}.`, inputSchema: { type: 'object', properties: {} } },
    {
      serverId,
      pluginId: CORE_MCP_PLUGIN_ID,
      serverPolicy: options.policy ?? 'ask',
      call: async () => ({ content: [{ type: 'text', text: options.text ?? `${toolName} ok` }] }),
    },
  )
  return Object.freeze({ pluginId: CORE_MCP_PLUGIN_ID, definition, mcpServerId: serverId, title: null })
}

/** The `toolsFor` answer of `tools`, with shadowed global ids, unavailable server names and server names by id. */
export function fakeProjectMcpTools(tools: readonly RegisteredTool[], fields: { readonly shadowed?: readonly string[], readonly unavailable?: readonly string[], readonly names?: Readonly<Record<string, string>> } = {}): ProjectMcpTools {
  return {
    tools: [...tools].sort((a, b) => (a.definition.name < b.definition.name ? -1 : a.definition.name > b.definition.name ? 1 : 0)),
    shadowed: new Set(fields.shadowed ?? []),
    unavailable: [...(fields.unavailable ?? [])],
    names: new Map(Object.entries(fields.names ?? {})),
  }
}

export interface FakeProjectMcpManagerOptions {
  /** `toolsFor` answers per project id. */
  tools?: Readonly<Record<string, ProjectMcpTools>>
  /** `list` answers per project id. */
  lists?: Readonly<Record<string, ProjectMcpList>>
  /** Phase 14: `prompts` answers per project id. */
  promptLists?: Readonly<Record<string, ProjectMcpListing<McpPromptInfo>>>
  /** Phase 14: `resources` answers per project id. */
  resourceLists?: Readonly<Record<string, ProjectMcpListing<McpResourceInfo>>>
}

/** A `getPrompt` / `readResource` call of the fake (Phase 14). */
export interface FakeProjectMcpCall {
  readonly projectId: string
  readonly serverId: string
  /** The prompt name (`getPrompt`) or the resource URI (`readResource`). */
  readonly target: string
  /** `getPrompt` only: the bound arguments. */
  readonly args?: Readonly<Record<string, string>>
}

export interface FakeProjectMcpManager extends ProjectMcpManager {
  /** `toolsFor` answers per project id; tests may edit them. */
  readonly tools: Map<string, ProjectMcpTools>
  /** `list` answers per project id; tests may edit them. */
  readonly lists: Map<string, ProjectMcpList>
  /** Stored variable values per project id. */
  readonly variables: Map<string, Map<string, string>>
  /** Every `toolsFor` call, in order. */
  readonly toolsCalls: Array<{ projectId: string, waitMs: number }>
  /** Every `stopProject` argument, in order. */
  readonly stoppedProjects: string[]
  /** Phase 14: `prompts` answers per project id; tests may edit them. */
  readonly promptLists: Map<string, ProjectMcpListing<McpPromptInfo>>
  /** Phase 14: `resources` answers per project id; tests may edit them. */
  readonly resourceLists: Map<string, ProjectMcpListing<McpResourceInfo>>
  /** Phase 14: `getPrompt` answers keyed `<projectId>/<serverId>/<name>`; tests may edit them. */
  readonly promptResults: Map<string, McpPromptResult>
  /** Phase 14: `readResource` answers keyed `<projectId>/<serverId>/<uri>`; tests may edit them. */
  readonly resourceContents: Map<string, McpResourceContents>
  /** Phase 14: every `getPrompt` call, in order. */
  readonly promptCalls: FakeProjectMcpCall[]
  /** Phase 14: every `readResource` call, in order. */
  readonly resourceCalls: FakeProjectMcpCall[]
  /** Number of calls of each member. */
  readonly calls: Record<keyof ProjectMcpManager, number>
}

export function createFakeProjectMcpManager(options: FakeProjectMcpManagerOptions = {}): FakeProjectMcpManager {
  const tools = new Map(Object.entries(options.tools ?? {}))
  const lists = new Map(Object.entries(options.lists ?? {}))
  const variables = new Map<string, Map<string, string>>()
  const toolsCalls: Array<{ projectId: string, waitMs: number }> = []
  const stoppedProjects: string[] = []
  const promptLists = new Map(Object.entries(options.promptLists ?? {}))
  const resourceLists = new Map(Object.entries(options.resourceLists ?? {}))
  const promptResults = new Map<string, McpPromptResult>()
  const resourceContents = new Map<string, McpResourceContents>()
  const promptCalls: FakeProjectMcpCall[] = []
  const resourceCalls: FakeProjectMcpCall[] = []
  const calls: Record<keyof ProjectMcpManager, number> = {
    toolsFor: 0,
    list: 0,
    setVariables: 0,
    reconnect: 0,
    stopProject: 0,
    stop: 0,
    prompts: 0,
    getPrompt: 0,
    resources: 0,
    readResource: 0,
    authTarget: 0,
  }

  function listOf(projectId: string): ProjectMcpList {
    const list = lists.get(projectId) ?? { items: [], variables: [] }
    const stored = variables.get(projectId) ?? new Map<string, string>()
    return { items: list.items, variables: list.variables.map(variable => ({ ...variable, set: stored.has(variable.name) })) }
  }

  return {
    tools,
    lists,
    variables,
    toolsCalls,
    stoppedProjects,
    promptLists,
    resourceLists,
    promptResults,
    resourceContents,
    promptCalls,
    resourceCalls,
    calls,
    toolsFor: async (projectId, toolsOptions) => {
      calls.toolsFor += 1
      toolsCalls.push({ projectId, waitMs: toolsOptions.waitMs })
      toolsOptions.signal.throwIfAborted()
      return tools.get(projectId) ?? noProjectMcpTools()
    },
    list: async (projectId) => {
      calls.list += 1
      return listOf(projectId)
    },
    setVariables: async (projectId, values, sensitive) => {
      calls.setVariables += 1
      sensitive?.requireFreshAuth()
      let stored = variables.get(projectId)
      if (stored === undefined) {
        stored = new Map()
        variables.set(projectId, stored)
      }
      for (const [name, value] of Object.entries(values)) {
        if (value === null)
          stored.delete(name)
        else
          stored.set(name, value)
      }
      return listOf(projectId)
    },
    reconnect: async (projectId, serverId) => {
      calls.reconnect += 1
      const server = listOf(projectId).items.find(item => item.id === serverId)
      if (server === undefined)
        throw new HarnessError({ code: 'not_found', message: `Project MCP server ${serverId} not found.` })
      return server
    },
    stopProject: async (projectId) => {
      calls.stopProject += 1
      stoppedProjects.push(projectId)
    },
    stop: async () => {
      calls.stop += 1
    },
    prompts: async (projectId, listOptions) => {
      calls.prompts += 1
      listOptions?.signal?.throwIfAborted()
      return promptLists.get(projectId) ?? emptyProjectMcpListing<McpPromptInfo>()
    },
    getPrompt: async (projectId, serverId, name, args, signal) => {
      calls.getPrompt += 1
      promptCalls.push({ projectId, serverId, target: name, args: { ...args } })
      signal.throwIfAborted()
      const result = promptResults.get(`${projectId}/${serverId}/${name}`)
      if (result === undefined)
        throw new HarnessError({ code: 'not_found', message: `The MCP prompt "${name}" of "${serverId}" was not found.` })
      return result
    },
    resources: async (projectId, listOptions) => {
      calls.resources += 1
      listOptions?.signal?.throwIfAborted()
      return resourceLists.get(projectId) ?? emptyProjectMcpListing<McpResourceInfo>()
    },
    readResource: async (projectId, serverId, uri, signal) => {
      calls.readResource += 1
      resourceCalls.push({ projectId, serverId, target: uri })
      signal.throwIfAborted()
      const contents = resourceContents.get(`${projectId}/${serverId}/${uri}`)
      if (contents === undefined)
        throw new HarnessError({ code: 'not_found', message: `The MCP resource was not found on "${serverId}".` })
      return contents
    },
    authTarget: (projectId, serverId) => {
      calls.authTarget += 1
      return projectMcpAuthStorage(projectId, serverId)
    },
  }
}
