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
import type { ProjectMcpList, ToolPolicy } from '@harness-forge/shared'
import type { ProjectMcpManager, ProjectMcpTools } from '../mcp/types.ts'
import type { RegisteredTool } from '../registry/types.ts'
import { HarnessError } from '@harness-forge/shared'
import { CORE_MCP_PLUGIN_ID } from '../mcp/internal.ts'
import { mcpToolDefinition } from '../mcp/mcp-tools.ts'
import { noProjectMcpTools } from '../mcp/project.ts'

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
  /** Number of calls of each member. */
  readonly calls: Record<keyof ProjectMcpManager, number>
}

export function createFakeProjectMcpManager(options: FakeProjectMcpManagerOptions = {}): FakeProjectMcpManager {
  const tools = new Map(Object.entries(options.tools ?? {}))
  const lists = new Map(Object.entries(options.lists ?? {}))
  const variables = new Map<string, Map<string, string>>()
  const toolsCalls: Array<{ projectId: string, waitMs: number }> = []
  const stoppedProjects: string[] = []
  const calls: Record<keyof ProjectMcpManager, number> = { toolsFor: 0, list: 0, setVariables: 0, reconnect: 0, stopProject: 0, stop: 0 }

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
  }
}
