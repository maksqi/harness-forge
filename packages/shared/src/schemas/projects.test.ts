import { describe, expect, it } from 'vitest'
import { projectChangedDataSchema, serverEventSchema } from '../events.ts'
import { LIMITS } from '../limits.ts'
import { chatExportAnySchema, chatExportV1Schema, chatExportV2Schema } from './chats.ts'
import { projectParamsSchema } from './params.ts'
import {
  folderNameSchema,
  PROJECT_INSTRUCTIONS_FILES,
  projectBrowseQuerySchema,
  projectBrowseSchema,
  projectCreateSchema,
  projectNameSchema,
  projectSummarySchema,
  projectUpdateSchema,
  workspacePathSchema,
} from './projects.ts'

const PROJECT_ID = 'prj_ABCdef0123456789'
const CHAT_ID = '0199a8f0-0000-7000-8000-000000000001'
const MESSAGE_A = 'msg_A000000000000001'
const MESSAGE_B = 'msg_B000000000000001'
const EMPTY_TOTALS = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null }

const project = {
  id: PROJECT_ID,
  name: 'Website',
  path: '/srv/workspaces/website',
  instructions: null,
  available: true,
  issue: null,
  instructionsFile: 'AGENTS.md',
  chatCount: 3,
  outputStyle: null,
  createdAt: 1,
  updatedAt: 2,
}

describe('projects (ADR-031)', () => {
  it('parses summaries', () => {
    expect(projectSummarySchema.parse(project)).toEqual(project)
    const missing = { ...project, available: false, issue: 'The folder does not exist.', instructionsFile: null, instructions: 'Use pnpm.' }
    expect(projectSummarySchema.parse(missing)).toEqual(missing)
    expect(PROJECT_INSTRUCTIONS_FILES).toEqual(['AGENTS.md', 'CLAUDE.md'])
    for (const change of [{ id: 'prj_short' }, { instructionsFile: 'README.md' }, { chatCount: -1 }, { issue: undefined }, { available: 'yes' }])
      expect(projectSummarySchema.safeParse({ ...project, ...change }).success, JSON.stringify(change)).toBe(false)
  })

  it('validates paths: 1..4096 characters without NUL or control characters', () => {
    for (const path of ['/srv/workspaces/site', 'C:\\work\\site', '/srv/with space/ünïcode', 'x'.repeat(LIMITS.workspacePathMaxChars)])
      expect(workspacePathSchema.safeParse(path).success, path.slice(0, 40)).toBe(true)
    for (const path of ['', '/srv/a\0b', '/srv/a\nb', '/srv/a\u001Bb', '/srv/a\u007Fb', '/srv/a\u0085b', 'x'.repeat(LIMITS.workspacePathMaxChars + 1)])
      expect(workspacePathSchema.safeParse(path).success, JSON.stringify(path.slice(0, 40))).toBe(false)
  })

  it('validates new folder names', () => {
    for (const name of ['site', 'my site', 'a.b', 'v1.2.0', '_drafts', 'x'.repeat(255), 'ünïcode'])
      expect(folderNameSchema.safeParse(name).success, name.slice(0, 40)).toBe(true)
    const refused: Record<string, string> = {
      'empty': '',
      'leading space': ' site',
      'trailing space': 'site ',
      'slash': 'a/b',
      'backslash': 'a\\b',
      'NUL': 'a\0b',
      'newline': 'a\nb',
      'tab': 'a\tb',
      'dot': '.',
      'dot dot': '..',
      'hidden': '.git',
      'too long': 'x'.repeat(256),
    }
    for (const [label, name] of Object.entries(refused))
      expect(folderNameSchema.safeParse(name).success, label).toBe(false)
    // Already trimmed: the schema refuses, it never trims.
    expect(folderNameSchema.safeParse('  site  ').error?.issues[0]?.message).toMatch(/space/)
    expect(folderNameSchema.safeParse('..').error?.issues).toHaveLength(1)
  })

  it('validates creates strictly', () => {
    expect(projectCreateSchema.parse({ name: '  Website ', path: '/srv/workspaces/website' })).toEqual({ name: 'Website', path: '/srv/workspaces/website' })
    expect(projectCreateSchema.parse({ name: 'New', path: '/srv/workspaces', newFolder: 'new-site' })).toEqual({ name: 'New', path: '/srv/workspaces', newFolder: 'new-site' })
    for (const body of [
      {},
      { name: 'x' },
      { path: '/srv/workspaces' },
      { name: '   ', path: '/srv/workspaces' },
      { name: 'x'.repeat(LIMITS.projectNameMaxChars + 1), path: '/srv/workspaces' },
      { name: 'x', path: '' },
      { name: 'x', path: '/srv/a\0b' },
      { name: 'x', path: '/srv', newFolder: '../escape' },
      { name: 'x', path: '/srv', newFolder: '.hidden' },
      { name: 'x', path: '/srv', instructions: 'no' },
    ])
      expect(projectCreateSchema.safeParse(body).success, JSON.stringify(body).slice(0, 80)).toBe(false)
    expect(projectNameSchema.parse(' A ')).toBe('A')
  })

  it('validates updates strictly, at least one key, the path never changes', () => {
    expect(projectUpdateSchema.parse({ name: ' Renamed ' })).toEqual({ name: 'Renamed' })
    expect(projectUpdateSchema.parse({ instructions: null })).toEqual({ instructions: null })
    expect(projectUpdateSchema.parse({ instructions: 'Use pnpm.' })).toEqual({ instructions: 'Use pnpm.' })
    for (const body of [{}, { path: '/srv/other' }, { name: '' }, { instructions: 'x'.repeat(LIMITS.instructionsMaxChars + 1) }, { name: 'x', extra: 1 }])
      expect(projectUpdateSchema.safeParse(body).success, JSON.stringify(body).slice(0, 80)).toBe(false)
  })

  it('validates the browse query and result', () => {
    expect(projectBrowseQuerySchema.parse({})).toEqual({})
    expect(projectBrowseQuerySchema.parse({ path: '/srv/workspaces' })).toEqual({ path: '/srv/workspaces' })
    expect(projectBrowseQuerySchema.safeParse({ path: '/srv/a\0b' }).success).toBe(false)
    expect(projectBrowseQuerySchema.safeParse({ path: '' }).success).toBe(false)
    const roots = [{ path: '/srv/workspaces', available: true }, { path: '/mnt/missing', available: false }]
    const listing = {
      path: '/srv/workspaces',
      parent: null,
      roots,
      entries: [{ name: 'site', path: '/srv/workspaces/site', projectId: PROJECT_ID }, { name: 'api', path: '/srv/workspaces/api', projectId: null }],
      truncated: false,
    }
    expect(projectBrowseSchema.parse(listing)).toEqual(listing)
    expect(projectBrowseSchema.parse({ path: null, parent: null, roots, entries: [], truncated: false }).path).toBeNull()
    expect(projectBrowseSchema.safeParse({ ...listing, roots: ['/srv/workspaces'] }).success).toBe(false)
    expect(projectBrowseSchema.safeParse({ ...listing, entries: Array.from({ length: LIMITS.browseEntriesMax + 1 }).fill(listing.entries[1]) }).success).toBe(false)
  })

  it('validates params and the project.changed event', () => {
    expect(projectParamsSchema.parse({ id: PROJECT_ID })).toEqual({ id: PROJECT_ID })
    expect(projectParamsSchema.safeParse({ id: 'browse' }).success).toBe(false)
    expect(projectChangedDataSchema.parse({ id: PROJECT_ID, project })).toEqual({ id: PROJECT_ID, project })
    expect(serverEventSchema.parse({ type: 'project.changed', data: { id: PROJECT_ID, project: null }, at: 1 })).toEqual({ type: 'project.changed', data: { id: PROJECT_ID, project: null }, at: 1 })
    expect(serverEventSchema.safeParse({ type: 'project.changed', data: { id: PROJECT_ID }, at: 1 }).success).toBe(false)
    expect(serverEventSchema.safeParse({ type: 'project.changed', data: { id: PROJECT_ID, project: null, action: 'deleted' }, at: 1 }).data).toEqual({ type: 'project.changed', data: { id: PROJECT_ID, project: null }, at: 1 })
  })
})

describe('chat exports stay compatible (projects are never exported, ADR-031)', () => {
  const message = { id: MESSAGE_A, role: 'user', metadata: { modelRef: 'mock:echo', startedAt: 1 }, parts: [{ type: 'text', text: 'hi' }] }
  const reply = { id: MESSAGE_B, role: 'assistant', metadata: { modelRef: 'mock:echo', startedAt: 2 }, parts: [{ type: 'text', text: 'hello' }] }
  // Chats as v1.0 - v1.2 wrote them: no `projectId` key anywhere.
  const oldChat = {
    id: CHAT_ID,
    title: 'Trip',
    titleSource: 'user',
    modelRef: 'mock:echo',
    pinned: false,
    archived: false,
    running: false,
    pendingApproval: false,
    createdAt: 1,
    updatedAt: 2,
    settings: { toolMode: 'auto' },
    totals: EMPTY_TOTALS,
  }
  const v1 = { format: 'harness-forge.chat', version: 1, exportedAt: 5, chat: { ...oldChat, messages: [message, reply] } }
  const v2 = { format: 'harness-forge.chat', version: 2, exportedAt: 5, chat: { ...oldChat, messages: [message, reply], parentIds: [null, MESSAGE_A], activeLeafId: MESSAGE_B } }

  it('imports version 1 and 2 exports written before Phase 7', () => {
    expect(chatExportV1Schema.parse(v1)).toEqual(v1)
    expect(chatExportV2Schema.parse(v2)).toEqual(v2)
    expect(chatExportAnySchema.parse(v1)).toEqual(v1)
    expect(chatExportAnySchema.parse(v2)).toEqual(v2)
  })

  it('drops a projectId found in an upload (imports never set a project)', () => {
    for (const projectId of [PROJECT_ID, null, 'garbage']) {
      expect(chatExportV1Schema.parse({ ...v1, chat: { ...v1.chat, projectId } }).chat).not.toHaveProperty('projectId')
      expect(chatExportV2Schema.parse({ ...v2, chat: { ...v2.chat, projectId } }).chat).not.toHaveProperty('projectId')
    }
  })

  it('never types a projectId into the export', () => {
    expect(Object.keys(chatExportV2Schema.shape.chat.shape)).not.toContain('projectId')
    expect(Object.keys(chatExportV1Schema.shape.chat.shape)).not.toContain('projectId')
  })
})
