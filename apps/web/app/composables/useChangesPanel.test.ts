// The changes panel state (docs/UI.md 7.21, 11.5): one app-wide state, closed / This chat / 440px by default, kept in
// localStorage (open '1' / '0', the view, the width in px clamped to 320-720), in memory when storage is blocked. The
// open state is written only on an explicit open, toggle or close: a narrow viewport hides the panel without changing it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isReadonly } from 'vue'
import { stubLocalStorage } from '~/utils/testing/storage'

/** A fresh copy of the module: its app-wide state is created again from localStorage. */
async function freshModule(): Promise<typeof import('./useChangesPanel')> {
  vi.resetModules()
  return import('./useChangesPanel')
}

let storage: Storage

beforeEach(() => {
  storage = stubLocalStorage()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useChangesPanel', () => {
  it('starts closed on This chat at 440px, with read-only open and focusRequest, and is one shared state', async () => {
    const { CHANGES_SHORTCUT, CHANGES_SHORTCUT_KEYS, CHANGES_WIDTH, useChangesPanel } = await freshModule()
    const panel = useChangesPanel()
    expect(panel.open.value).toBe(false)
    expect(panel.view.value).toBe('chat')
    expect(panel.width.value).toBe(440)
    expect(panel.focusRequest.value).toBe(0)
    expect(isReadonly(panel.open)).toBe(true)
    expect(isReadonly(panel.focusRequest)).toBe(true)
    expect(useChangesPanel()).toBe(panel)
    expect(CHANGES_WIDTH).toEqual({ default: 440, min: 320, max: 720 })
    expect(CHANGES_SHORTCUT).toBe('toggle-changes')
    expect(CHANGES_SHORTCUT_KEYS).toBe('alt+code:KeyC')
  })

  it('reads the stored state and clamps the stored width', async () => {
    storage.setItem('hf-changes-open', '1')
    storage.setItem('hf-changes-view', 'git')
    storage.setItem('hf-changes-width', '9000')
    const { useChangesPanel } = await freshModule()
    const panel = useChangesPanel()
    expect(panel.open.value).toBe(true)
    expect(panel.view.value).toBe('git')
    expect(panel.width.value).toBe(720)
  })

  it('ignores unreadable stored values', async () => {
    storage.setItem('hf-changes-view', 'files')
    storage.setItem('hf-changes-width', 'wide')
    const { useChangesPanel } = await freshModule()
    const panel = useChangesPanel()
    expect(panel.view.value).toBe('chat')
    expect(panel.width.value).toBe(440)
  })

  it('persists open, view and the clamped width', async () => {
    const { CHANGES_OPEN_KEY, CHANGES_VIEW_KEY, CHANGES_WIDTH_KEY, useChangesPanel } = await freshModule()
    const panel = useChangesPanel()
    panel.setOpen(true)
    expect(storage.getItem(CHANGES_OPEN_KEY)).toBe('1')
    panel.toggle()
    expect(panel.open.value).toBe(false)
    expect(storage.getItem(CHANGES_OPEN_KEY)).toBe('0')
    panel.view.value = 'git'
    expect(storage.getItem(CHANGES_VIEW_KEY)).toBe('git')
    panel.width.value = 100
    expect(panel.width.value).toBe(320)
    expect(storage.getItem(CHANGES_WIDTH_KEY)).toBe('320')
    panel.width.value = 500.4
    expect(storage.getItem(CHANGES_WIDTH_KEY)).toBe('500')
  })

  it('raises focusRequest only when a focusing call opens the panel', async () => {
    const { useChangesPanel } = await freshModule()
    const panel = useChangesPanel()
    panel.toggle()
    expect(panel.focusRequest.value).toBe(0)
    panel.toggle({ focus: true })
    expect(panel.open.value).toBe(false)
    expect(panel.focusRequest.value).toBe(0)
    panel.toggle({ focus: true })
    expect(panel.open.value).toBe(true)
    expect(panel.focusRequest.value).toBe(1)
    panel.setOpen(true, { focus: true })
    expect(panel.focusRequest.value).toBe(2)
  })

  it('keeps the saved open state while the viewport is narrow, and shows it again when wide (Phase 9)', async () => {
    storage.setItem('hf-changes-open', '1')
    const { CHANGES_OPEN_KEY, setChangesPanelNarrow, useChangesPanel } = await freshModule()
    const panel = useChangesPanel()
    expect(panel.open.value).toBe(true)
    const setItem = vi.spyOn(storage, 'setItem')

    // Below 1024px the panel reads closed (the sheet never opens by itself), and nothing is written.
    setChangesPanelNarrow(true)
    expect(panel.open.value).toBe(false)
    expect(isReadonly(panel.open)).toBe(true)
    setChangesPanelNarrow(false)
    expect(panel.open.value).toBe(true)
    setChangesPanelNarrow(true)
    setChangesPanelNarrow(true)
    expect(panel.open.value).toBe(false)
    expect(setItem).not.toHaveBeenCalled()
    expect(storage.getItem(CHANGES_OPEN_KEY)).toBe('1')

    // An explicit open while narrow shows the sheet (focus request included) ...
    panel.toggle({ focus: true })
    expect(panel.open.value).toBe(true)
    expect(panel.focusRequest.value).toBe(1)
    expect(storage.getItem(CHANGES_OPEN_KEY)).toBe('1')
    // ... it stays open while the viewport keeps its class, and is the saved choice when wide.
    setChangesPanelNarrow(false)
    expect(panel.open.value).toBe(true)

    // An explicit close is saved in either class.
    setChangesPanelNarrow(true)
    panel.setOpen(true)
    panel.setOpen(false)
    expect(storage.getItem(CHANGES_OPEN_KEY)).toBe('0')
    setChangesPanelNarrow(false)
    expect(panel.open.value).toBe(false)
  })

  it('writes the open state only on an explicit open, toggle or close', async () => {
    const { CHANGES_OPEN_KEY, setChangesPanelNarrow, useChangesPanel } = await freshModule()
    const panel = useChangesPanel()
    const setItem = vi.spyOn(storage, 'setItem')
    panel.view.value = 'git'
    panel.width.value = 500
    setChangesPanelNarrow(true)
    setChangesPanelNarrow(false)
    expect(setItem.mock.calls.map(([key]) => key)).not.toContain(CHANGES_OPEN_KEY)
    panel.toggle()
    expect(setItem).toHaveBeenLastCalledWith(CHANGES_OPEN_KEY, '1')
    panel.setOpen(false)
    expect(setItem).toHaveBeenLastCalledWith(CHANGES_OPEN_KEY, '0')
  })

  it('keeps the state in memory when storage is blocked', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    })
    const { setChangesPanelNarrow, useChangesPanel } = await freshModule()
    const panel = useChangesPanel()
    expect(panel.open.value).toBe(false)
    panel.setOpen(true)
    panel.view.value = 'git'
    expect(panel.open.value).toBe(true)
    expect(panel.view.value).toBe('git')
    // The saved choice survives a narrow viewport in memory too.
    setChangesPanelNarrow(true)
    expect(panel.open.value).toBe(false)
    setChangesPanelNarrow(false)
    expect(panel.open.value).toBe(true)
  })
})
