// The changes panel's state (docs/UI.md 7.21, 11.5; ADR-037): open or closed, the view (This chat | Git) and the pane
// width, one shared state for the whole app (per browser, not per chat), remembered in localStorage:
// `hf-changes-open` ('1' / '0', default closed), `hf-changes-view` ('chat' | 'git', default 'chat') and
// `hf-changes-width` (px, default 440, clamped to 320-720 when read and written; not reka's `autoSaveId`, which stores
// percentages, so the pane would drift whenever the window is resized). Storage that is missing, full or blocked keeps
// the state in memory. `focusRequest` increases when Alt+C or the palette opens the panel: the panel then moves focus to
// its active view tab. Signature frozen from Gate P8-0b (C20).
import type { Ref } from 'vue'
import type { ChangesView } from '~/components/workspace/changes/changes-rows'
import { effectScope, readonly, ref, watch } from 'vue'

export const CHANGES_OPEN_KEY = 'hf-changes-open'
export const CHANGES_VIEW_KEY = 'hf-changes-view'
export const CHANGES_WIDTH_KEY = 'hf-changes-width'
/** The pane width in px: the default, the minimum and the maximum. */
export const CHANGES_WIDTH = { default: 440, min: 320, max: 720 } as const
/** The shortcut id of Alt+C and the palette item value (docs/UI.md 12). */
export const CHANGES_SHORTCUT = 'toggle-changes'

export interface ChangesPanelState {
  /** The panel is open (it renders only in project chats). */
  open: Readonly<Ref<boolean>>
  /** The shown view; writing it persists it. */
  view: Ref<ChangesView>
  /** The pane width in px; writing it clamps and persists it. */
  width: Ref<number>
  /** Increases when Alt+C or the palette opens the panel: focus the active view tab. */
  focusRequest: Readonly<Ref<number>>
  /** Opens or closes the panel; `focus` (Alt+C, the palette) also asks the panel to take focus when it opens. */
  setOpen: (value: boolean, opts?: { focus?: boolean }) => void
  toggle: (opts?: { focus?: boolean }) => void
}

function readItem(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null
  }
  catch {
    return null
  }
}

function writeItem(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value)
  }
  catch {
    // Blocked or full storage: the state stays in memory.
  }
}

/** A width in px clamped to 320-720; anything that is not a finite number gives the default. */
export function clampChangesWidth(value: unknown): number {
  const width = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN
  if (!Number.isFinite(width))
    return CHANGES_WIDTH.default
  return Math.round(Math.min(CHANGES_WIDTH.max, Math.max(CHANGES_WIDTH.min, width)))
}

function createChangesPanel(): ChangesPanelState {
  const open = ref(readItem(CHANGES_OPEN_KEY) === '1')
  const view = ref<ChangesView>(readItem(CHANGES_VIEW_KEY) === 'git' ? 'git' : 'chat')
  const width = ref(clampChangesWidth(readItem(CHANGES_WIDTH_KEY)))
  const focusRequest = ref(0)

  watch(open, value => writeItem(CHANGES_OPEN_KEY, value ? '1' : '0'), { flush: 'sync' })
  watch(view, (value) => {
    if (value !== 'chat' && value !== 'git') {
      view.value = 'chat'
      return
    }
    writeItem(CHANGES_VIEW_KEY, value)
  }, { flush: 'sync' })
  watch(width, (value) => {
    const clamped = clampChangesWidth(value)
    if (clamped !== value) {
      width.value = clamped
      return
    }
    writeItem(CHANGES_WIDTH_KEY, String(clamped))
  }, { flush: 'sync' })

  function setOpen(value: boolean, opts: { focus?: boolean } = {}): void {
    if (value && opts.focus)
      focusRequest.value++
    open.value = value
  }

  return {
    open: readonly(open),
    view,
    width,
    focusRequest: readonly(focusRequest),
    setOpen,
    toggle: opts => setOpen(!open.value, opts),
  }
}

let shared: ChangesPanelState | undefined

/**
 * The app-wide changes panel state (created on first use from localStorage, in a detached effect scope so its watchers
 * outlive the component that asked first).
 */
export function useChangesPanel(): ChangesPanelState {
  shared ??= effectScope(true).run(createChangesPanel)!
  return shared
}
