// MCP sign-in (Phase 14, ADR-059; docs/UI.md 8.14, 11.10): starts, finishes and ends the OAuth sign-in of a remote MCP
// server of any origin (a personal or plugin server: `kind: 'global'`; an approved `.mcp.json` server: `kind:
// 'project'`). No store of its own: it calls the sign-in actions of the `plugins` / `project-mcp` stores and is their only
// caller.
// - `start(target, { returnTo?, name? })`: the store's sign-in action, called directly (no Phase 14 route needs fresh
//   auth; phase-14 doc, design reconciliation); `returnTo` = `opts.returnTo` or the current location (the SPA's
//   `route.fullPath`), kept only when `safeRedirectPath` and `isSafeReturnTo` accept it and it is not the callback page
//   itself; an answer without an `authorizationUrl` (the stored tokens still work) shows the toast "Signed in to {name}."
//   and resolves `authorized`; otherwise, after checking that it is an http(s) URL, the page goes there in the same tab
//   (`assignLocation` of `components/oauth/location.ts`, a mockable module) and it resolves `redirected`. Never a popup
//   (COOP `same-origin` and a cross-origin authorization server cut `window.opener`).
// - `signOut(target, name?)`: the store's sign-out action; toast "Signed out of {name}.".
// - `complete(body)`: `POST /mcp/oauth/callback` (the callback page), then `plugins.fetchMcp()` or
//   `projectMcp.fetch(projectId)` for the answer's target (best effort: the answer is returned either way).
// - `busyKey`: `global:<serverId>` / `project:<projectId>:<serverId>` while a start runs (the row shows "Signing in…");
//   after a redirect it stays set until the page leaves (a page restored from the back-forward cache clears it).
// The authorization URL, the code and the state are never logged, stored or shown.
// Signature from C54 (P14-0b, frozen from Gate P14-0b); W14.7 implements it. Nuxt-free on purpose (no `#imports`), so
// every component that mounts it stays testable without Nuxt.
import type { McpAuthCallbackBody, McpAuthCallbackResult, McpAuthStart } from '@harness-forge/shared'
import type { Ref } from 'vue'
import { HarnessError, isSafeReturnTo } from '@harness-forge/shared'
import { readonly, ref } from 'vue'
import { toast } from 'vue-sonner'
import { assignLocation } from '~/components/oauth/location'
import { useApi } from '~/composables/useApi'
import { usePluginsStore } from '~/stores/plugins'
import { useProjectMcpStore } from '~/stores/project-mcp'
import { withHarnessErrors } from '~/utils/errors'
import { safeRedirectPath } from '~/utils/redirect'

/** The server a sign-in is for. */
export type McpSignInTarget
  = | { kind: 'global', serverId: string }
    | { kind: 'project', projectId: string, serverId: string }

export interface McpSignIn {
  /** Starts a sign-in: `authorized` (nothing to do, the server reconnected) or `redirected` (the page leaves). */
  start: (target: McpSignInTarget, opts?: { returnTo?: string, name?: string }) => Promise<'redirected' | 'authorized'>
  /** Forgets the server's tokens (the server stays configured). */
  signOut: (target: McpSignInTarget, name?: string) => Promise<void>
  /** Finishes a sign-in from the callback page's query. */
  complete: (body: McpAuthCallbackBody) => Promise<McpAuthCallbackResult>
  /** The target of the start in flight (`global:<id>` / `project:<projectId>:<id>`), else null. */
  busyKey: Readonly<Ref<string | null>>
}

/** The `busyKey` of a target. */
export function mcpSignInKey(target: McpSignInTarget): string {
  return target.kind === 'global' ? `global:${target.serverId}` : `project:${target.projectId}:${target.serverId}`
}

/** The path of the callback page: a sign-in never returns there. */
const CALLBACK_PATH = '/oauth/callback'

/** The current in-app location (`route.fullPath` of the SPA), or null outside a browser. */
function currentPath(): string | null {
  if (typeof window === 'undefined')
    return null
  const { pathname, search, hash } = window.location
  return `${pathname}${search}${hash}`
}

/**
 * The `returnTo` of a start: the given path or the current location, when it is a safe in-app path the server accepts
 * (`safeRedirectPath`, `isSafeReturnTo`: `/`-relative, not `//`, no whitespace, at most 512 characters) and not the
 * callback page; else undefined (the server's default page).
 */
export function signInReturnTo(value: string | undefined, fallback: string | null = currentPath()): string | undefined {
  const path = safeRedirectPath(value ?? fallback)
  if (path === null || !isSafeReturnTo(path))
    return undefined
  const bare = path.split(/[?#]/, 1)[0]!.toLowerCase()
  return bare === CALLBACK_PATH || bare.startsWith(`${CALLBACK_PATH}/`) ? undefined : path
}

/** The authorization URL when it is an absolute http(s) URL (the only kind the page navigates to), else null. */
export function safeAuthorizationUrl(url: string | null | undefined): string | null {
  if (!url)
    return null
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null
  }
  catch {
    return null
  }
}

export function useMcpSignIn(): McpSignIn {
  // Created in the caller's setup: the stores and the API client need the app context.
  const api = useApi()
  const plugins = usePluginsStore()
  const projectMcp = useProjectMcpStore()
  const busyKey = ref<string | null>(null)

  function requestStart(target: McpSignInTarget, returnTo: string | undefined): Promise<McpAuthStart> {
    return target.kind === 'global'
      ? plugins.signInMcp(target.serverId, returnTo)
      : projectMcp.signIn(target.projectId, target.serverId, returnTo)
  }

  /** A page restored from the back-forward cache (the user came back from the authorization server) is idle again. */
  function clearOnReturn(key: string): void {
    if (typeof window === 'undefined')
      return
    window.addEventListener('pageshow', () => {
      if (busyKey.value === key)
        busyKey.value = null
    }, { once: true })
  }

  async function start(target: McpSignInTarget, opts: { returnTo?: string, name?: string } = {}): Promise<'redirected' | 'authorized'> {
    const key = mcpSignInKey(target)
    const name = opts.name ?? target.serverId
    busyKey.value = key
    try {
      const answer = await requestStart(target, signInReturnTo(opts.returnTo))
      if (answer.authorizationUrl === null) {
        if (busyKey.value === key)
          busyKey.value = null
        toast.success(`Signed in to ${name}.`)
        return 'authorized'
      }
      const url = safeAuthorizationUrl(answer.authorizationUrl)
      if (url === null)
        throw new HarnessError({ code: 'provider_error', message: `${name} sent a sign-in page that is not a web address.` })
      clearOnReturn(key)
      assignLocation(url)
      return 'redirected'
    }
    catch (error) {
      if (busyKey.value === key)
        busyKey.value = null
      throw error
    }
  }

  async function signOut(target: McpSignInTarget, name?: string): Promise<void> {
    if (target.kind === 'global')
      await plugins.signOutMcp(target.serverId)
    else
      await projectMcp.signOut(target.projectId, target.serverId)
    toast.success(`Signed out of ${name ?? target.serverId}.`)
  }

  async function complete(body: McpAuthCallbackBody): Promise<McpAuthCallbackResult> {
    const result = await withHarnessErrors(api.mcpAuth.callback({ body }))
    try {
      if (result.target.kind === 'global')
        await plugins.fetchMcp()
      else
        await projectMcp.fetch(result.target.projectId)
    }
    catch {
      // Best effort: the lists refetch on their next use and on `plugin.changed` / `project-mcp.changed`.
    }
    return result
  }

  return { start, signOut, complete, busyKey: readonly(busyKey) }
}
