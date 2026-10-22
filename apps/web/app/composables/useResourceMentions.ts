// MCP resources in `@` mentions (Phase 14, ADR-061; docs/UI.md 7.35, 11.10): the resources of the connected MCP servers
// for the composer's mention menu, in every chat with tools on (also without a project; a project chat adds the
// project's servers). The token is the file mentions' one (`mentionTokenAt` of `@harness-forge/shared`).
// - `GET /mcp/resources?projectId=&q=&limit=50`, 80 ms after the last keystroke, the previous request aborted; answers
//   younger than 15 s are reused; `refresh()` when the menu opens.
// - `attach(entry)`: `POST /mcp/resources/attach { serverId, uri, projectId? }` → the upload's `FileRef` (the composer adds
//   it with `useComposerAttachments().addResource`); 413 and 409 `needs-auth` are thrown for the composer's messages.
// The only caller of the resource routes. Signature from C54 (P14-0b, frozen from Gate P14-0b); W14.8 implements the
// listing and `attach` (until then nothing is listed and `attach` refuses with `not_implemented`).
import type { FileRef, McpResourceEntry, McpResourceList, MentionToken } from '@harness-forge/shared'
import type { ComputedRef, MaybeRefOrGetter, Ref } from 'vue'
import { HarnessError, mentionTokenAt } from '@harness-forge/shared'
import { computed, toValue } from 'vue'

export type ResourceMentionsState = 'idle' | 'loading' | 'ready' | 'error'

export interface ResourceMentionsOptions {
  /** The chat's project (its servers join the list); null = global servers only. */
  projectId: MaybeRefOrGetter<string | null>
  text: Ref<string>
  caret: Ref<number>
  /** Tools are available and the tool mode is not `off`. */
  enabled: MaybeRefOrGetter<boolean>
}

export interface ResourceMentions {
  /** `mentionTokenAt(text, caret)`; null while disabled. */
  token: ComputedRef<MentionToken | null>
  items: ComputedRef<readonly McpResourceEntry[]>
  state: ComputedRef<ResourceMentionsState>
  /** More resources matched than were listed. */
  truncated: ComputedRef<boolean>
  /** Servers whose resources are missing (not connected, sign-in needed). */
  unavailable: ComputedRef<McpResourceList['unavailable']>
  /** Attaches a resource as an upload. */
  attach: (entry: McpResourceEntry) => Promise<FileRef>
  /** Lists again (the menu opened); an answer younger than 15 s is reused. */
  refresh: () => Promise<void>
}

const NO_ITEMS: readonly McpResourceEntry[] = Object.freeze([])
const NO_UNAVAILABLE: McpResourceList['unavailable'] = []

export function useResourceMentions(opts: ResourceMentionsOptions): ResourceMentions {
  const token = computed<MentionToken | null>(() => (toValue(opts.enabled) ? mentionTokenAt(opts.text.value, opts.caret.value) : null))
  const items = computed(() => NO_ITEMS)
  const state = computed<ResourceMentionsState>(() => 'idle')
  const truncated = computed(() => false)
  const unavailable = computed(() => NO_UNAVAILABLE)

  async function attach(_entry: McpResourceEntry): Promise<FileRef> {
    throw new HarnessError({ code: 'not_implemented', message: 'Attaching MCP resources is not available yet.' })
  }

  async function refresh(): Promise<void> {}

  return { token, items, state, truncated, unavailable, attach, refresh }
}
