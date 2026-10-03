// Command palette content (docs/UI.md 5.3, 4.2, 12): which sections and items show for a query, in which order.
// Pure: CommandPalette.vue feeds it the store data and runs the chosen item's command.
//
// Order: chats first (recent chats for an empty query, search results otherwise), then Actions, Projects (Phase 7,
// docs/UI.md 7.20; only while searching), Go to, Default model (only while searching: the catalog is long) and Theme.
// Items keep their definition order; sections without matches are left out. Phase 8 (docs/UI.md 7.21, 12): on a project
// chat page the Actions end with "Show changes" / "Hide changes" (`toggle-changes`, Alt+C).
import type { ChatSummary } from '@harness-forge/shared'
import type { Component } from 'vue'
import type { ThemePreference } from '../theme'
import {
  BlocksIcon,
  FolderIcon,
  FolderInputIcon,
  FolderOutputIcon,
  FolderPlusIcon,
  FoldersIcon,
  KeyboardIcon,
  MessageSquareIcon,
  PanelLeftIcon,
  PanelRightIcon,
  SquarePenIcon,
} from '@lucide/vue'
import { CHANGES_SHORTCUT, CHANGES_SHORTCUT_KEYS } from '~/composables/useChangesPanel'
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
    | { type: 'project-filter', filter: string }
    | { type: 'move-chat', chatId: string, projectId: string | null }
    | { type: 'toggle-changes' }

export type PaletteSectionId = 'chats' | 'actions' | 'projects' | 'navigation' | 'models' | 'theme'

/** The Add project dialog of Settings -> Projects (docs/UI.md 6, 9.10). */
export const ADD_PROJECT_ROUTE = '/settings/projects?add=1'

/** A project the palette can filter by or move the open chat to. */
export interface PaletteProject {
  id: string
  name: string
}

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
  /** Phase 7: the projects by name (default none). */
  projects?: readonly PaletteProject[]
  /** Phase 7: the chat list's project filter (`all`, `none` or a project id; default `all`). */
  projectFilter?: string
  /** Phase 7: the open chat and its project (its "Move chat…" items); null or omitted without one. */
  openChat?: { id: string, projectId: string | null } | null
  /**
   * Phase 8: on a project chat page, the changes panel's state ("Show changes" / "Hide changes"; `shortcut`: the Alt+C
   * hint shows, i.e. Alt shortcuts are on); null or omitted elsewhere.
   */
  changesPanel?: { open: boolean, shortcut: boolean } | null
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

const CHANGES_KEYWORDS = ['changes', 'diff', 'git', 'files', 'panel', 'revert']

function actionItems(canToggleSidebar: boolean, changesPanel: PaletteInput['changesPanel']): StaticItem[] {
  const items: StaticItem[] = [
    { value: 'new-chat', label: 'New chat', icon: SquarePenIcon, keys: 'mod+shift+o', command: { type: 'new-chat' }, keywords: ['start', 'create', 'conversation'] },
    { value: 'show-shortcuts', label: 'Keyboard shortcuts', icon: KeyboardIcon, keys: 'mod+/', command: { type: 'show-shortcuts' }, keywords: ['help', 'keys', 'hotkeys'] },
  ]
  if (canToggleSidebar)
    items.push({ value: 'toggle-sidebar', label: 'Toggle sidebar', icon: PanelLeftIcon, keys: 'mod+b', command: { type: 'toggle-sidebar' }, keywords: ['collapse', 'expand', 'hide', 'show'] })
  if (changesPanel) {
    items.push({
      value: CHANGES_SHORTCUT,
      label: changesPanel.open ? 'Hide changes' : 'Show changes',
      icon: PanelRightIcon,
      keys: changesPanel.shortcut ? CHANGES_SHORTCUT_KEYS : undefined,
      command: { type: 'toggle-changes' },
      keywords: CHANGES_KEYWORDS,
    })
  }
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

const PROJECT_KEYWORDS = ['project', 'projects', 'filter', 'folder']

function projectItems(input: PaletteInput, query: string): StaticItem[] {
  if (!query)
    return []
  const projects = input.projects ?? []
  const filter = input.projectFilter ?? 'all'
  const items: StaticItem[] = [
    { value: 'project-filter-all', label: 'Show all chats', icon: FoldersIcon, command: { type: 'project-filter', filter: 'all' }, checked: filter === 'all', keywords: PROJECT_KEYWORDS },
  ]
  if (projects.length > 0) {
    items.push({ value: 'project-filter-none', label: 'Show chats without a project', icon: FolderIcon, command: { type: 'project-filter', filter: 'none' }, checked: filter === 'none', keywords: PROJECT_KEYWORDS })
    for (const project of projects)
      items.push({ value: `project-filter-${project.id}`, label: `Show ${project.name}`, icon: FolderIcon, command: { type: 'project-filter', filter: project.id }, checked: filter === project.id, keywords: PROJECT_KEYWORDS })
  }
  items.push({ value: 'project-add', label: 'Add project…', icon: FolderPlusIcon, command: { type: 'navigate', to: ADD_PROJECT_ROUTE }, keywords: [...PROJECT_KEYWORDS, 'new', 'create', 'workspace'] })
  const chat = input.openChat
  if (chat) {
    for (const project of projects) {
      if (project.id !== chat.projectId)
        items.push({ value: `project-move-${project.id}`, label: `Move chat to ${project.name}`, icon: FolderInputIcon, command: { type: 'move-chat', chatId: chat.id, projectId: project.id }, keywords: ['move', 'project'] })
    }
    if (chat.projectId !== null)
      items.push({ value: 'project-move-none', label: 'Move chat out of project', icon: FolderOutputIcon, command: { type: 'move-chat', chatId: chat.id, projectId: null }, keywords: ['move', 'project', 'remove'] })
  }
  return items
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
    { id: 'actions', heading: 'Actions', items: filterStatic(query, actionItems(input.canToggleSidebar, input.changesPanel)) },
    { id: 'projects', heading: 'Projects', items: filterStatic(query, projectItems(input, query)) },
    { id: 'navigation', heading: 'Go to', items: filterStatic(query, navigationItems()) },
    { id: 'models', heading: 'Default model', items: modelItems(input, query) },
    { id: 'theme', heading: 'Theme', items: filterStatic(query, themeItems(input.theme)) },
  ]
  return sections.filter(section => section.items.length > 0)
}
