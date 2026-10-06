import { DEFAULT_SETTINGS } from '@harness-forge/shared'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockApi } from '~/utils/testing/mock-api'
import { stubLocalStorage } from '~/utils/testing/storage'
import { useChatsStore } from './chats'
import { useSettingsStore } from './settings'
import { OPEN_PALETTE_EVENT, OPEN_SHORTCUTS_EVENT, useUiStore } from './ui'

const mock = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))

let pinia: ReturnType<typeof createPinia>

beforeEach(() => {
  mock.api = createMockApi()
  pinia = createPinia()
  setActivePinia(pinia)
  stubLocalStorage()
})

afterEach(() => {
  disposePinia(pinia)
  vi.unstubAllGlobals()
})

describe('ui store', () => {
  it('opens the palette and tells the app-shell stubs through their window event', () => {
    const ui = useUiStore()
    const listener = vi.fn()
    window.addEventListener(OPEN_PALETTE_EVENT, listener)
    ui.openPalette()
    expect(ui.paletteOpen).toBe(true)
    expect(listener).toHaveBeenCalledTimes(1)
    ui.togglePalette()
    expect(ui.paletteOpen).toBe(false)
    window.removeEventListener(OPEN_PALETTE_EVENT, listener)
  })

  it('mirrors the stub events into its state without echoing them', () => {
    const ui = useUiStore()
    const echo = vi.fn()
    window.addEventListener(OPEN_SHORTCUTS_EVENT, echo)
    window.dispatchEvent(new CustomEvent(OPEN_PALETTE_EVENT))
    expect(ui.paletteOpen).toBe(true)
    window.dispatchEvent(new CustomEvent(OPEN_SHORTCUTS_EVENT))
    expect(ui.shortcutsOpen).toBe(true)
    expect(echo).toHaveBeenCalledTimes(1)
    window.removeEventListener(OPEN_SHORTCUTS_EVENT, echo)
  })

  it('does not loop when a listener calls openShortcuts() again', () => {
    const ui = useUiStore()
    const reopen = vi.fn(() => ui.openShortcuts())
    window.addEventListener(OPEN_SHORTCUTS_EVENT, reopen)
    ui.openPalette()
    ui.openShortcuts()
    expect(reopen).toHaveBeenCalledTimes(1)
    expect(ui.shortcutsOpen).toBe(true)
    expect(ui.paletteOpen).toBe(false)
    window.removeEventListener(OPEN_SHORTCUTS_EVENT, reopen)
  })

  it('opens the install dialog on a source tab', () => {
    const ui = useUiStore()
    ui.openInstall()
    expect(ui.installDialogOpen).toBe(true)
    expect(ui.installSource).toBe('zip')
    ui.openInstall('npm')
    expect(ui.installSource).toBe('npm')
    // Phase 12 (ADR-054): the GitHub tab.
    ui.openInstall('github')
    expect(ui.installSource).toBe('github')
  })

  it('opens the share dialog for one chat at a time and closes it', () => {
    const ui = useUiStore()
    expect(ui.shareChatId).toBeNull()
    ui.openShare('chat-a')
    expect(ui.shareChatId).toBe('chat-a')
    ui.openShare('chat-b')
    expect(ui.shareChatId).toBe('chat-b')
    ui.closeShare()
    expect(ui.shareChatId).toBeNull()
    ui.closeShare()
    expect(ui.shareChatId).toBeNull()
  })

  it('shows thinking from the setting until the chat menu overrides it', () => {
    const ui = useUiStore()
    const settings = useSettingsStore()
    expect(ui.showThinking).toBe(false)
    settings.settings = { ...DEFAULT_SETTINGS, showThinking: true }
    expect(ui.showThinking).toBe(true)
    ui.toggleShowThinking()
    expect(ui.showThinkingOverride).toBe(false)
    expect(ui.showThinking).toBe(false)
  })

  it('counts composer focus requests', () => {
    const ui = useUiStore()
    ui.requestComposerFocus()
    ui.requestComposerFocus()
    expect(ui.composerFocusRequest).toBe(2)
  })

  it('clears the unread dot of the chat it opens', () => {
    const ui = useUiStore()
    const chats = useChatsStore()
    chats.unread = { a: true, b: true }
    ui.setActiveChat('a')
    expect(ui.activeChatId).toBe('a')
    expect(chats.unread).toEqual({ b: true })
    ui.setActiveChat(null)
    expect(ui.activeChatId).toBeNull()
  })

  it('applies appearance attributes and caches them', () => {
    const ui = useUiStore()
    ui.applyAppearance({ density: 'compact', textSize: 'sm', readingFont: 'serif' })
    expect(document.documentElement.dataset.density).toBe('compact')
    expect(document.documentElement.dataset.textSize).toBe('sm')
    expect(document.documentElement.dataset.readingFont).toBe('serif')
    expect(localStorage.getItem('hf-appearance')).toContain('compact')
  })
})
