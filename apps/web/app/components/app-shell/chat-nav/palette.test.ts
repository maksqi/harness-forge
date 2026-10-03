import type { PaletteInput, PaletteModel } from './palette'
import { describe, expect, it } from 'vitest'
import { chatId, chatSummary, projectId } from '~/utils/testing/fixtures'
import { ADD_PROJECT_ROUTE, buildPaletteSections, CHAT_RESULTS_LIMIT, matchesQuery, MODEL_RESULTS_LIMIT, RECENT_CHATS_LIMIT } from './palette'

const NOW = 1_790_600_000_000

function chats(count: number) {
  return Array.from({ length: count }, (_, index) => chatSummary({
    id: chatId(index + 1),
    title: `Chat ${index + 1}`,
    updatedAt: NOW - index,
  }))
}

function model(overrides: Partial<PaletteModel> = {}): PaletteModel {
  return {
    ref: 'anthropic:claude-sonnet-5',
    name: 'Claude Sonnet 5',
    providerId: 'anthropic',
    providerName: 'Anthropic (Claude)',
    icon: null,
    ...overrides,
  }
}

function input(overrides: Partial<PaletteInput> = {}): PaletteInput {
  return {
    query: '',
    chats: chats(3),
    searchResults: null,
    models: [],
    defaultModelRef: null,
    theme: 'dark',
    canToggleSidebar: true,
    ...overrides,
  }
}

function values(sections: ReturnType<typeof buildPaletteSections>) {
  return sections.map(section => [section.id, section.items.map(item => item.value)])
}

describe('buildPaletteSections', () => {
  it('orders an empty query as recent chats, actions, pages, theme (no models)', () => {
    const sections = buildPaletteSections(input({ chats: chats(8), models: [model()] }))
    expect(sections.map(section => section.heading)).toEqual(['Recent chats', 'Actions', 'Go to', 'Theme'])
    expect(values(sections)).toEqual([
      ['chats', chats(RECENT_CHATS_LIMIT).map(chat => `chat:${chat.id}`)],
      ['actions', ['new-chat', 'show-shortcuts', 'toggle-sidebar']],
      ['navigation', ['go-plugins', 'go-settings-providers', 'go-settings-models', 'go-settings-media', 'go-settings-projects', 'go-settings-general', 'go-settings-appearance', 'go-settings-data', 'go-settings-about']],
      ['theme', ['theme-dark', 'theme-light', 'theme-system']],
    ])
    const labels = sections.flatMap(section => section.items.map(item => item.label))
    expect(labels).toEqual(expect.arrayContaining(['New chat', 'Keyboard shortcuts', 'Plugins', 'Settings: Models', 'Theme: Dark', 'Theme: Light', 'Theme: System']))
  })

  it('shows the shortcut hints and checks the current theme', () => {
    const sections = buildPaletteSections(input({ theme: 'system' }))
    const items = sections.flatMap(section => section.items)
    expect(items.find(item => item.value === 'new-chat')?.keys).toBe('mod+shift+o')
    expect(items.find(item => item.value === 'show-shortcuts')?.keys).toBe('mod+/')
    expect(items.filter(item => item.checked).map(item => item.value)).toEqual(['theme-system'])
  })

  it('leaves out "Toggle sidebar" without a sidebar', () => {
    const items = buildPaletteSections(input({ canToggleSidebar: false })).flatMap(section => section.items)
    expect(items.some(item => item.value === 'toggle-sidebar')).toBe(false)
  })

  it('puts matching chats first while searching: local title matches until server results arrive', () => {
    const list = [
      chatSummary({ id: chatId(1), title: 'Auth flow', updatedAt: NOW }),
      chatSummary({ id: chatId(2), title: 'Dinner plans', updatedAt: NOW - 1 }),
      chatSummary({ id: chatId(3), title: 'OAuth tokens', updatedAt: NOW - 2 }),
    ]
    const local = buildPaletteSections(input({ query: 'auth', chats: list }))
    expect(local[0]).toMatchObject({ id: 'chats', heading: 'Chats' })
    expect(local[0]!.items.map(item => item.label)).toEqual(['Auth flow', 'OAuth tokens'])

    // Server results win, including body matches with their snippet.
    const server = buildPaletteSections(input({
      query: 'auth',
      chats: list,
      searchResults: [chatSummary({ id: chatId(2), title: 'Dinner plans', updatedAt: NOW - 1, snippet: '...the auth cookie...' })],
    }))
    expect(server[0]!.items).toEqual([expect.objectContaining({
      value: `chat:${chatId(2)}`,
      label: 'Dinner plans',
      detail: '...the auth cookie...',
      command: { type: 'open-chat', chatId: chatId(2) },
    })])
    // An empty server answer means no chat matches.
    expect(buildPaletteSections(input({ query: 'auth', chats: list, searchResults: [] }))[0]?.id).not.toBe('chats')
  })

  it('caps chat results and labels untitled chats', () => {
    const many = chats(CHAT_RESULTS_LIMIT + 4)
    const sections = buildPaletteSections(input({ query: 'chat', chats: many }))
    expect(sections[0]!.items).toHaveLength(CHAT_RESULTS_LIMIT)

    const untitled = buildPaletteSections(input({ chats: [chatSummary({ id: chatId(9), title: null, titleSource: null })] }))
    expect(untitled[0]!.items[0]).toMatchObject({ label: 'New chat', placeholder: true })
    expect(buildPaletteSections(input({ query: 'new chat', chats: [chatSummary({ id: chatId(9), title: null })] }))[0]!.items[0]?.value).toBe(`chat:${chatId(9)}`)
  })

  it('offers "Settings: Projects" from the settings links (Phase 7)', () => {
    const items = buildPaletteSections(input({ chats: [] })).flatMap(section => section.items)
    expect(items.find(item => item.value === 'go-settings-projects')).toMatchObject({
      label: 'Settings: Projects',
      command: { type: 'navigate', to: '/settings/projects' },
    })
    expect(values(buildPaletteSections(input({ query: 'settings proj', chats: [] })))).toEqual([['navigation', ['go-settings-projects']]])
  })

  it('filters actions, pages and themes by label and keywords', () => {
    expect(values(buildPaletteSections(input({ query: 'dark', chats: [] })))).toEqual([['theme', ['theme-dark']]])
    expect(values(buildPaletteSections(input({ query: 'hotkeys', chats: [] })))).toEqual([['actions', ['show-shortcuts']]])
    expect(values(buildPaletteSections(input({ query: 'settings appear', chats: [] })))).toEqual([['navigation', ['go-settings-appearance']]])
    expect(buildPaletteSections(input({ query: 'zzz-no-match', chats: [] }))).toEqual([])
  })

  it('offers matching models as the default model only while searching', () => {
    const models = [
      model(),
      model({ ref: 'openai:gpt-6', name: 'GPT-6', providerId: 'openai', providerName: 'OpenAI' }),
      ...Array.from({ length: MODEL_RESULTS_LIMIT + 2 }, (_, index) => model({ ref: `ollama:llama-${index}`, name: `Llama ${index}`, providerId: 'ollama', providerName: 'Ollama' })),
    ]
    expect(buildPaletteSections(input({ models })).some(section => section.id === 'models')).toBe(false)

    const sections = buildPaletteSections(input({ query: 'sonnet', chats: [], models, defaultModelRef: 'anthropic:claude-sonnet-5' }))
    expect(sections.map(section => section.id)).toEqual(['models'])
    expect(sections[0]).toMatchObject({ heading: 'Default model' })
    expect(sections[0]!.items[0]).toMatchObject({
      value: 'model:anthropic:claude-sonnet-5',
      label: 'Claude Sonnet 5',
      detail: 'Anthropic (Claude)',
      checked: true,
      command: { type: 'default-model', modelRef: 'anthropic:claude-sonnet-5' },
    })
    // Provider names and refs match too; results are capped.
    expect(buildPaletteSections(input({ query: 'openai', chats: [], models }))[0]!.items.map(item => item.label)).toEqual(['GPT-6'])
    expect(buildPaletteSections(input({ query: 'ollama', chats: [], models }))[0]!.items).toHaveLength(MODEL_RESULTS_LIMIT)
  })

  it('keeps the section order while searching: chats, actions, pages, models, theme', () => {
    const sections = buildPaletteSections(input({
      query: 'mo',
      chats: [chatSummary({ id: chatId(1), title: 'Mortgage math' })],
      models: [model({ ref: 'mock:echo', name: 'Mock echo', providerId: 'mock', providerName: 'Mock' })],
    }))
    expect(sections.map(section => section.id)).toEqual(['chats', 'navigation', 'models', 'theme'])
  })
})

describe('buildPaletteSections: projects (Phase 7)', () => {
  const projects = [{ id: projectId(1), name: 'API' }, { id: projectId(2), name: 'Website' }]

  function projectSection(overrides: Partial<PaletteInput>) {
    return buildPaletteSections(input({ chats: [], ...overrides })).find(section => section.id === 'projects')
  }

  it('shows the Projects section only while searching, after Actions', () => {
    expect(projectSection({ projects })).toBeUndefined()
    const sections = buildPaletteSections(input({ query: 'filter', chats: [], projects }))
    expect(sections.map(section => section.id)).toEqual(['projects'])
    // "Settings: Projects" stays in Go to.
    expect(buildPaletteSections(input({ query: 'project', chats: [], projects })).map(section => section.id)).toEqual(['projects', 'navigation'])
    expect(sections[0]!.heading).toBe('Projects')
    expect(buildPaletteSections(input({ query: 'new', chats: [], projects })).map(section => section.id)).toEqual(['actions', 'projects'])
  })

  it('offers every filter (the current one checked) and Add project…', () => {
    const section = projectSection({ query: 'project', projects, projectFilter: projectId(2) })!
    expect(section.items.map(item => [item.value, item.label, item.checked ?? false])).toEqual([
      ['project-filter-all', 'Show all chats', false],
      ['project-filter-none', 'Show chats without a project', false],
      [`project-filter-${projectId(1)}`, 'Show API', false],
      [`project-filter-${projectId(2)}`, 'Show Website', true],
      ['project-add', 'Add project…', false],
    ])
    expect(section.items[2]!.command).toEqual({ type: 'project-filter', filter: projectId(1) })
    expect(section.items[4]!.command).toEqual({ type: 'navigate', to: ADD_PROJECT_ROUTE })
    expect(ADD_PROJECT_ROUTE).toBe('/settings/projects?add=1')
    // Without any project: all chats and Add project… only.
    expect(projectSection({ query: 'project', projects: [] })!.items.map(item => item.value)).toEqual(['project-filter-all', 'project-add'])
  })

  it('moves the open chat to another project or out of its project', () => {
    const section = projectSection({ query: 'move', projects, openChat: { id: chatId(1), projectId: projectId(1) } })!
    expect(section.items.map(item => [item.value, item.label])).toEqual([
      [`project-move-${projectId(2)}`, 'Move chat to Website'],
      ['project-move-none', 'Move chat out of project'],
    ])
    expect(section.items[0]!.command).toEqual({ type: 'move-chat', chatId: chatId(1), projectId: projectId(2) })
    expect(section.items[1]!.command).toEqual({ type: 'move-chat', chatId: chatId(1), projectId: null })
    // A chat without a project can only move into one; no open chat, no move items.
    expect(projectSection({ query: 'move', projects, openChat: { id: chatId(1), projectId: null } })!.items.map(item => item.value))
      .toEqual([`project-move-${projectId(1)}`, `project-move-${projectId(2)}`])
    expect(projectSection({ query: 'move chat', projects })).toBeUndefined()
  })

  it('matches projects by name', () => {
    expect(projectSection({ query: 'website', projects, openChat: { id: chatId(1), projectId: null } })!.items.map(item => item.value))
      .toEqual([`project-filter-${projectId(2)}`, `project-move-${projectId(2)}`])
  })
})

describe('matchesQuery', () => {
  it('matches every word, ignoring case and accents', () => {
    expect(matchesQuery('théme DARK', 'Theme: Dark')).toBe(true)
    expect(matchesQuery('dark light', 'Theme: Dark')).toBe(false)
    expect(matchesQuery('  ', 'anything')).toBe(true)
    expect(matchesQuery('cafe', 'Café notes')).toBe(true)
  })
})
