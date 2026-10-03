// The agent's todo list in the UI (docs/UI.md 7.25, 11.6; ADR-041): pure helpers over `latestTodos` of
// `@harness-forge/shared` (`util/agent-state.ts`, the only implementation of the todo rule). No Vue, no stores.
// Signatures frozen from Gate P9-0b (C25); the session's `todos` and the dock's TodoStrip read them.
import type { HarnessUIMessage, TodoItem } from '@harness-forge/shared'
import { latestTodos } from '@harness-forge/shared'
import { currentTodo, todoLabel } from './agent-tools'

/** The todo list of the shown path, as the strip and the session show it. */
export interface TodoState {
  todos: readonly TodoItem[]
  /** Items with status `completed`. */
  done: number
  total: number
  /** The first `in_progress` item. */
  current: TodoItem | null
  /** The message holding the `todo_write` call. */
  messageId: string
  /** That message is the last assistant message of the path. */
  live: boolean
}

/**
 * The todo state of a path: the last finished `todo_write` call (`latestTodos`: branch-aware, errored, denied and
 * still-running calls skipped), with its counts, the current item and whether it belongs to the latest reply. Null
 * when the path has no list.
 */
export function todoState(messages: readonly HarnessUIMessage[]): TodoState | null {
  const latest = latestTodos(messages)
  if (latest === null)
    return null
  const message = messages[latest.messageIndex]
  if (!message)
    return null
  let live = true
  for (let index = latest.messageIndex + 1; index < messages.length; index++) {
    if (messages[index]?.role === 'assistant') {
      live = false
      break
    }
  }
  return {
    todos: latest.todos,
    done: latest.counts.completed,
    total: latest.counts.total,
    current: currentTodo(latest.todos),
    messageId: message.id,
    live,
  }
}

/** The strip shows a non-empty list while a run is active, or while the latest reply's list is unfinished. */
export function todoStripVisible(state: TodoState | null, running: boolean): boolean {
  if (state === null || state.total === 0)
    return false
  return running || (state.live && state.done < state.total)
}

/** The collapsed strip's text: "3/7 · Running the parser tests" ("3/7" without a current item), or "All tasks done". */
export function todoSummary(state: TodoState): string {
  if (state.total > 0 && state.done >= state.total)
    return 'All tasks done'
  const count = `${state.done}/${state.total}`
  const current = state.current ? todoLabel(state.current) : ''
  return current ? `${count} · ${current}` : count
}
