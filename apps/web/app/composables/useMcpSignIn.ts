// MCP sign-in (Phase 14, ADR-059; docs/UI.md 8.14, 11.10): starts, finishes and ends the OAuth sign-in of a remote MCP
// server of any origin (a personal or plugin server: `kind: 'global'`; an approved `.mcp.json` server: `kind:
// 'project'`). No store of its own: it calls the sign-in actions of the `plugins` / `project-mcp` stores and is their only
// caller.
// - `start(target, { returnTo?, name? })`: the store's sign-in action through `useFreshAuth().run` (the routes are not
//   fresh; it works either way); `returnTo` = `safeRedirectPath(returnTo ?? route.fullPath)`; an answer without an
//   `authorizationUrl` (the stored tokens still work) shows the toast "Signed in to {name}." and resolves `authorized`;
//   otherwise, after checking that it is an http(s) URL, the page goes there in the same tab (`assignLocation` of
//   `components/oauth/location.ts`, a mockable module) and it resolves `redirected`. Never a popup (COOP `same-origin`
//   and a cross-origin authorization server cut `window.opener`).
// - `signOut(target, name?)`: the store's sign-out action; toast "Signed out of {name}.".
// - `complete(body)`: `POST /mcp/oauth/callback` (the callback page), then `plugins.fetchMcp()` or
//   `projectMcp.fetch(projectId)` for the answer's target.
// - `busyKey`: `global:<serverId>` / `project:<projectId>:<serverId>` while a start runs (the row shows "Signing in…").
// Signature from C54 (P14-0b, frozen from Gate P14-0b); W14.7 implements it. Until then every action refuses with
// `not_implemented`.
import type { McpAuthCallbackBody, McpAuthCallbackResult } from '@harness-forge/shared'
import type { Ref } from 'vue'
import { HarnessError } from '@harness-forge/shared'
import { readonly, ref } from 'vue'

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

function notImplemented(): HarnessError {
  return new HarnessError({ code: 'not_implemented', message: 'Signing in to MCP servers is not available yet.' })
}

export function useMcpSignIn(): McpSignIn {
  const busyKey = ref<string | null>(null)

  async function start(_target: McpSignInTarget, _opts: { returnTo?: string, name?: string } = {}): Promise<'redirected' | 'authorized'> {
    throw notImplemented()
  }

  async function signOut(_target: McpSignInTarget, _name?: string): Promise<void> {
    throw notImplemented()
  }

  async function complete(_body: McpAuthCallbackBody): Promise<McpAuthCallbackResult> {
    throw notImplemented()
  }

  return { start, signOut, complete, busyKey: readonly(busyKey) }
}
