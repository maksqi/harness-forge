// The project MCP manager (Phase 11, ADR-050; ARCHITECTURE.md 6.30; API.md 4.32 / 5.33) behind `ProjectMcpManager`
// (./types.ts). Owner: W11.4 (C36 landed the stub with the final factory signature).
//
// C36 stub (P11-0b): nothing starts. `toolsFor` answers no tools, nothing shadowed, nothing unavailable; `list` answers
// the servers of the project's config snapshot (`projectConfig.snapshot`) as `pending` with no tools and no variables
// (an unknown project is `not_found`); `setVariables` and `reconnect` reject with `not_implemented`; `stopProject` and
// `stop` are no-ops. W11.4 implements the runtimes (lazy start after approval and verify-before-run, variables from the
// secret scope `project:<projectId>`, stdio in its own process group, idle stop, `project-mcp.changed`).
import type { ProjectMcpList, ProjectMcpServer } from '@harness-forge/shared'
import type { ProjectConfigSnapshot } from '../services/project-config/types.ts'
import type { AppDeps } from '../types.ts'
import type { ProjectMcpManager, ProjectMcpTools } from './types.ts'
import { noopAsync, rejectsNotImplemented } from '../not-implemented.ts'

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

export function createProjectMcpManager(deps: AppDeps): ProjectMcpManager {
  async function list(projectId: string): Promise<ProjectMcpList> {
    // `not_found` for an unknown project (the route answers 404).
    await deps.projects.get(projectId)
    const snapshot = await deps.projectConfig.snapshot(projectId)
    return { items: pendingProjectMcpServers(snapshot), variables: [] }
  }

  return {
    toolsFor: async (_projectId, options) => {
      options.signal.throwIfAborted()
      return noProjectMcpTools()
    },
    list,
    setVariables: rejectsNotImplemented('Setting project MCP variables'),
    reconnect: rejectsNotImplemented('Reconnecting a project MCP server'),
    stopProject: noopAsync,
    stop: noopAsync,
  }
}
