// Command palette content (docs/UI.md 5.3, 4.2, 12): which sections and items show for a query, in which order.
// Pure: CommandPalette.vue feeds it the store data and runs the chosen item's command.
//
// Order: chats first (recent chats for an empty query, search results otherwise), then Actions, Go to, Default
// model (only while searching: the catalog is long) and Theme. Items keep their definition order; sections
// without matches are left out.
import type { ChatSummary } from '@harness-forge/shared'
import type { Component } from 'vue'
import type { ThemePreference } from '../theme'
import { BlocksIcon, KeyboardIcon, MessageSquareIcon, PanelLeftIcon, SquarePenIcon } from '@lucide/vue'
import { SETTINGS_LINKS } from '../navigation'
import { THEME_OPTIONS } from '../theme'

export const RECENT_CHATS_LIMIT = 5
export const CHAT_RESULTS_LIMIT = 8
export const MODEL_RESULTS_LIMIT = 6

export type PaletteCommand
  = | { type: 'open-chat', chatId: string }
    | { type: 'new-chat' }
    | { type: 'show-shortcuts' }
    | { type: 'toggle-sidebar' }
    | { type: 'navigate', to: string }
    | { type: 'default-model', modelRef: string }
    | { type: 'theme', value: ThemePreference }

export type PaletteSectionId = 'chats' | 'actions' | 'navigation' | 'models' | 'theme'

/** A model the palette can offer as the default model. */
export interface PaletteModel {
  ref: string
  name: string
  providerId: string
  providerName: string
  icon: { color?: string, mono?: string } | null
}

export interface PaletteItem {
  /** Unique within the palette; also the item's `data-value`. */
  value: string
  label: string
  command: PaletteCommand
  /** Lucide icon; model items show their provider icon instead. */
  icon?: Component
  /** Shortcut hint (useShortcuts syntax). */
  keys?: string
  /** Muted text after the label: a search snippet or the provider name. */
  detail?: string
  /** Shows the check mark (current theme, current default model). */
  checked?: boolean
  /** Untitled chat: the label is the "New chat" placeholder. */
  placeholder?: boolean
  /** Chat items: `updatedAt`. */
  updatedAt?: number
  model?: PaletteModel
}

export interface PaletteSection {
  id: PaletteSectionId
  heading: string
  items: PaletteItem[]
}

export interface PaletteInput {
  query: string
  /** The loaded chat list, newest first. */
  chats: readonly ChatSummary[]
  /** Server search results for `query`; null while they are not available (local title matches show instead). */
  searchResults: readonly ChatSummary[] | null
  models: readonly PaletteModel[]
  defaultModelRef: string | null
  theme: ThemePreference
  /** A sidebar is mounted (the "Toggle sidebar" action needs one). */
  canToggleSidebar: boolean
}

interface StaticItem extends PaletteItem {
  keywords?: string[]
}

const UNTITLED = 'New chat'

/** Lowercase, accents removed, whitespace collapsed. */
export function normalizeSearchText(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim()
}

/** Every word of the query appears in one of the texts (case and accent insensitive). */
export function matchesQuery(query: string, ...texts: Array<string | null | undefined>): boolean {
  const words = normalizeSearchText(query).split(' ').filter(Boolean)
  if (words.length === 0)
    return true
  const haystack = normalizeSearchText(texts.filter(Boolean).join(' '))
  return words.every(word => haystack.includes(word))
}

function chatItem(chat: ChatSummary, withSnippet: boolean): PaletteItem {
  const title = chat.title?.trim() ?? ''
  const item: PaletteItem = {
    value: `chat:${chat.id}`,
    label: title || UNTITLED,
    command: { type: 'open-chat', chatId: chat.id },
    icon: MessageSquareIcon,
    updatedAt: chat.updatedAt,
  }
  if (!title)
    item.placeholder = true
  const snippet = chat.snippet?.trim()
  if (withSnippet && snippet)
    item.detail = snippet
  return item
}

function actionItems(canToggleSidebar: boolean): StaticItem[] {
  const items: StaticItem[] = [
    { value: 'new-chat', label: 'New chat', icon: SquarePenIcon, keys: 'mod+shift+o', command: { type: 'new-chat' }, keywords: ['start', 'create', 'conversation'] },
    { value: 'show-shortcuts', label: 'Keyboard shortcuts', icon: KeyboardIcon, keys: 'mod+/', command: { type: 'show-shortcuts' }, keywords: ['help', 'keys', 'hotkeys'] },
  ]
  if (canToggleSidebar)
    items.push({ value: 'toggle-sidebar', label: 'Toggle sidebar', icon: PanelLeftIcon, keys: 'mod+b', command: { type: 'toggle-sidebar' }, keywords: ['collapse', 'expand', 'hide', 'show'] })
  return items
}

function navigationItems(): StaticItem[] {
  return [
    { value: 'go-plugins', label: 'Plugins', icon: BlocksIcon, command: { type: 'navigate', to: '/plugins' }, keywords: ['extensions', 'tools', 'mcp', 'install'] },
    ...SETTINGS_LINKS.map(link => ({
      value: `go-settings-${link.key}`,
      label: `Settings: ${link.label}`,
      icon: link.icon,
      command: { type: 'navigate', to: link.to } as const,
      keywords: ['preferences', 'options'],
    })),
  ]
}

function themeItems(current: ThemePreference): StaticItem[] {
  return THEME_OPTIONS.map(option => ({
    value: `theme-${option.value}`,
    label: `Theme: ${option.label}`,
    icon: option.icon,
    command: { type: 'theme', value: option.value } as const,
    checked: option.value === current,
    keywords: ['appearance', 'color', 'mode'],
  }))
}

function filterStatic(query: string, items: StaticItem[]): PaletteItem[] {
  return items
    .filter(item => matchesQuery(query, item.label, ...(item.keywords ?? [])))
    .map(({ keywords: _keywords, ...item }) => item)
}

function chatItems(input: PaletteInput, query: string): PaletteItem[] {
  if (!query)
    return input.chats.slice(0, RECENT_CHATS_LIMIT).map(chat => chatItem(chat, false))
  const matches = input.searchResults
    ?? input.chats.filter(chat => matchesQuery(query, chat.title?.trim() || UNTITLED))
  return matches.slice(0, CHAT_RESULTS_LIMIT).map(chat => chatItem(chat, true))
}

function modelItems(input: PaletteInput, query: string): PaletteItem[] {
  if (!query)
    return []
  return input.models
    .filter(model => matchesQuery(query, model.name, model.ref, model.providerName))
    .slice(0, MODEL_RESULTS_LIMIT)
    .map(model => ({
      value: `model:${model.ref}`,
      label: model.name,
      detail: model.providerName,
      command: { type: 'default-model', modelRef: model.ref },
      checked: model.ref === input.defaultModelRef,
      model,
    }))
}

/** The palette sections for `input`, in display order, without empty sections. */
export function buildPaletteSections(input: PaletteInput): PaletteSection[] {
  const query = input.query.trim()
  const sections: PaletteSection[] = [
    { id: 'chats', heading: query ? 'Chats' : 'Recent chats', items: chatItems(input, query) },
    { id: 'actions', heading: 'Actions', items: filterStatic(query, actionItems(input.canToggleSidebar)) },
    { id: 'navigation', heading: 'Go to', items: filterStatic(query, navigationItems()) },
    { id: 'models', heading: 'Default model', items: modelItems(input, query) },
    { id: 'theme', heading: 'Theme', items: filterStatic(query, themeItems(input.theme)) },
  ]
  return sections.filter(section => section.items.length > 0)
}
