// Projects (Phase 7, ADR-031, ARCHITECTURE.md 6.13): `createProjectService(deps)` implements `ProjectService`
// (./types.ts). P7-0b stub (C14): `start()` creates the default root `<dataDir>/workspaces` (mode 0700) when it is one
// of the roots and `roots()` answers the roots (realpaths where they exist); every other member rejects with
// `not_implemented` (HTTP 501). Owner of the implementation: W7.1 (the root checks of `start()`, create, update,
// remove, browse, `openWorkspace`, the project file, the summaries).
import type { AppDeps } from '../../types.ts'
import type { ProjectService } from './types.ts'
import { mkdir, realpath } from 'node:fs/promises'
import { rejectsNotImplemented } from '../../not-implemented.ts'

/** Mode of the default root (and of the data dir): only the server user may enter it. */
export const DEFAULT_ROOT_MODE = 0o700

/** The realpath of `path`, or `path` itself when it cannot be resolved (a missing root; `start()` refuses it in W7.1). */
async function realpathOrSelf(path: string): Promise<string> {
  try {
    return await realpath(path)
  }
  catch {
    return path
  }
}

export function createProjectService(deps: AppDeps): ProjectService {
  const { env } = deps
  let checked: readonly string[] | null = null

  async function resolveRoots(): Promise<readonly string[]> {
    return Object.freeze(await Promise.all(env.workspaceRoots.map(realpathOrSelf)))
  }

  return {
    start: async () => {
      if (env.workspaceRoots.includes(env.paths.workspaces))
        await mkdir(env.paths.workspaces, { recursive: true, mode: DEFAULT_ROOT_MODE })
      // W7.1: realpath every root and refuse a missing explicit root, the data dir and folders inside it (EnvError).
      checked = await resolveRoots()
    },
    roots: async () => checked ?? resolveRoots(),
    list: rejectsNotImplemented('projects.list'),
    get: rejectsNotImplemented('projects.get'),
    create: rejectsNotImplemented('projects.create'),
    update: rejectsNotImplemented('projects.update'),
    remove: rejectsNotImplemented('projects.remove'),
    browse: rejectsNotImplemented('projects.browse'),
    openWorkspace: rejectsNotImplemented('projects.openWorkspace'),
  }
}
