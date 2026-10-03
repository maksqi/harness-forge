// The `@` menu state of one composer (docs/UI.md 7.26, 11.6; ADR-042). The token under the caret comes from
// `mentionTokenAt` of `@harness-forge/shared` (`util/mentions.ts`, the only implementation of the mention grammar); the
// matches from `useProjectFiles().search`. Signature frozen from Gate P9-0b (C25); W9.8 implements it: an 80 ms
// debounce, the previous search aborted, the last 20 queries cached per project, "Searching files…" only after 150 ms,
// Esc remembered for the token until it changes, and `apply(entry)` replacing the token (a file: its mention and a
// space; a folder: `@dir/`, keeping the menu open).
// Inert in P9-0b: `token` follows the text, but the menu never opens and `apply` changes nothing.
import type { HarnessError, ProjectFileEntry } from '@harness-forge/shared'
import type { ComputedRef, Ref } from 'vue'
import { mentionTokenAt } from '@harness-forge/shared'
import { computed, readonly, ref } from 'vue'

export interface FileMentionsOptions {
  /** The chat's project; null = never opens. */
  projectId: Ref<string | null>
  text: Ref<string>
  caret: Ref<number>
}

/** What `apply` produces: the new text and caret, and whether the menu stays open (a folder was picked). */
export interface FileMentionApplied {
  text: string
  caret: number
  keepOpen: boolean
}

export interface FileMentions {
  /** The `@` token under the caret (`mentionTokenAt(text, caret)`), or null. */
  token: ComputedRef<{ start: number, end: number, query: string } | null>
  /** A token, a project, and not dismissed. */
  open: ComputedRef<boolean>
  items: Readonly<Ref<readonly ProjectFileEntry[]>>
  state: Readonly<Ref<'loading' | 'ready' | 'error'>>
  error: Readonly<Ref<HarnessError | null>>
  truncated: Readonly<Ref<boolean>>
  /** Esc: the menu stays closed for this token until it changes. */
  dismiss: () => void
  /** The text after picking `entry`. */
  apply: (entry: ProjectFileEntry) => FileMentionApplied
}

/** The mention menu state of one composer. */
export function useFileMentions(opts: FileMentionsOptions): FileMentions {
  const token = computed(() => {
    const found = mentionTokenAt(opts.text.value, opts.caret.value)
    return found ? { start: found.start, end: found.end, query: found.query } : null
  })
  const items = ref<readonly ProjectFileEntry[]>([])
  const state = ref<'loading' | 'ready' | 'error'>('ready')
  const error = ref<HarnessError | null>(null)
  const truncated = ref(false)
  return {
    token,
    open: computed(() => false),
    items: readonly(items),
    state: readonly(state),
    error: readonly(error) as Readonly<Ref<HarnessError | null>>,
    truncated: readonly(truncated),
    dismiss: () => {},
    apply: () => ({ text: opts.text.value, caret: opts.caret.value, keepOpen: false }),
  }
}
