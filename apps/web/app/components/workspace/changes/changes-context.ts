// Shared state of the changes panel components (docs/UI.md 7.21) that is not part of their frozen props / emits:
// - the panel context (provide / inject): ChangesFileDiff reports each loaded diff, so the panel knows the `currentSha`
//   the user saw (RevertFileDialog's `expectedSha`); RevertFileDialog reports a 409 `stale`, so the panel opens the row
//   and its diff reloads ("Check it again");
// - the changes target: ChatWorkspace publishes the project chat it shows, so the command palette offers "Show changes" /
//   "Hide changes" exactly where Alt+C works (project chat pages).
import type { FileDiff } from '@harness-forge/shared'
import type { InjectionKey, ShallowRef } from 'vue'
import type { ChangesView } from './changes-rows'
import { readonly, shallowRef } from 'vue'

export interface ChangesPanelContext {
  /** A row's diff loaded (or reloaded). */
  diffLoaded: (view: ChangesView, path: string, diff: FileDiff) => void
  /** A revert answered 409 `stale`: the file changed since its diff was loaded. */
  revertStale: (view: ChangesView, path: string) => void
}

export const CHANGES_PANEL_CONTEXT: InjectionKey<ChangesPanelContext> = Symbol('changes-panel')

/** The project chat whose ChatWorkspace shows the changes panel (a chat page with a project). */
export interface ChangesTarget {
  chatId: string
  projectId: string
}

const target = shallowRef<ChangesTarget | null>(null)
let owner: symbol | null = null

/** The current changes target (null outside project chat pages). */
export function useChangesTarget(): Readonly<ShallowRef<ChangesTarget | null>> {
  return readonly(target) as Readonly<ShallowRef<ChangesTarget | null>>
}

/** Publishes (or clears, with null) the target of one ChatWorkspace; `token` identifies it. */
export function setChangesTarget(token: symbol, value: ChangesTarget | null): void {
  if (value) {
    owner = token
    if (target.value?.chatId !== value.chatId || target.value.projectId !== value.projectId)
      target.value = value
    return
  }
  if (owner === token) {
    owner = null
    target.value = null
  }
}
