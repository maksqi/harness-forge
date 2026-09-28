import type { McpServer, McpServerInput } from '@harness-forge/shared'
import type { MockApi } from '~/utils/testing/mock-api'
import { HarnessError } from '@harness-forge/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAuthStore } from '~/stores/auth'
import { testIds } from '~/utils/testids'
import { authStatus } from '~/utils/testing/fixtures'
import { createMockApi } from '~/utils/testing/mock-api'
import McpServerDialog from './McpServerDialog.vue'

const mock = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('~/composables/useApi', () => ({ useApi: () => mock.api }))

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('vue-sonner', () => ({ toast: Object.assign(vi.fn(), toasts) }))

const STORED_HINT = 'ghp_…9fQ2'

function mcpServer(overrides: Partial<McpServer> = {}): McpServer {
  return {
    id: 'github',
    name: 'GitHub',
    pluginId: 'core-mcp',
    editable: true,
    transport: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: { set: true, hint: STORED_HINT, source: 'stored' } } },
    policy: 'ask',
    enabled: true,
    status: 'connected',
    error: null,
    tools: [],
    connectedAt: 1_759_000_000_000,
    ...overrides,
  }
}

/** What the server answers for a created server. */
function created(input: McpServerInput): McpServer {
  const transport: McpServer['transport'] = input.transport.type === 'stdio'
    ? { type: 'stdio', command: input.transport.command, args: input.transport.args ?? [], env: {} }
    : { type: input.transport.type, url: input.transport.url, headers: {} }
  return mcpServer({ id: input.id, name: input.name, transport, policy: input.policy ?? 'ask', status: 'connecting' })
}

let pinia: ReturnType<typeof createPinia>
let api: MockApi

beforeEach(() => {
  api = createMockApi()
  mock.api = api
  pinia = createPinia()
  setActivePinia(pinia)
  toasts.success.mockReset()
  toasts.error.mockReset()
})

afterEach(() => {
  disposePinia(pinia)
  document.body.replaceChildren()
})

function mountDialog(server: McpServer | null = null) {
  const open = ref(true)
  const saved = vi.fn()
  const Host = defineComponent({
    setup: () => () => h(TooltipProvider, null, {
      default: () => h(McpServerDialog, {
        'open': open.value,
        server,
        'onUpdate:open': (value: boolean) => {
          open.value = value
        },
        'onSaved': saved,
      }),
    }),
  })
  const wrapper = mount(Host, { attachTo: document.body, global: { plugins: [pinia] } })
  return { wrapper, open, saved }
}

async function settle(rounds = 3) {
  for (let round = 0; round < rounds; round++) {
    await flushPromises()
    await nextTick()
  }
}

function one<T extends HTMLElement = HTMLElement>(selector: string, root: ParentNode = document.body): T | null {
  return root.querySelector<T>(selector)
}

function all<T extends HTMLElement = HTMLElement>(selector: string, root: ParentNode = document.body): T[] {
  return [...root.querySelectorAll<T>(selector)]
}

function dialog(): HTMLElement {
  return one(`[data-testid="${testIds.mcpDialog}"]`)!
}

function field<T extends HTMLElement = HTMLInputElement>(name: string): T {
  const element = one<T>(`[data-field="${name}"]`, dialog())
  if (!element)
    throw new Error(`no field ${name}`)
  return element
}

async function type(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
}

async function chooseTransport(value: 'stdio' | 'http' | 'sse') {
  const tab = one(`[data-testid="${testIds.mcpTransportTab}"][data-value="${value}"]`, dialog())!
  tab.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }))
  await settle()
}

async function addRow(kind: 'headers' | 'env') {
  one(`[data-action="add-${kind}"]`, dialog())!.click()
  await settle()
}

function rows(kind: 'headers' | 'env'): HTMLElement[] {
  return all(`[data-slot="${kind === 'env' ? 'mcp-env-row' : 'mcp-header-row'}"]`, dialog())
}

async function save() {
  one(`[data-testid="${testIds.mcpSave}"]`, dialog())!.click()
  await settle(5)
}

function passwordDialog(): HTMLElement | null {
  return one(`[data-testid="${testIds.confirmPasswordDialog}"]`)
}

async function confirmPassword(password: string) {
  const input = one<HTMLInputElement>(`[data-testid="${testIds.confirmPasswordInput}"]`)!
  await type(input, password)
  one(`[data-testid="${testIds.confirmPasswordSubmit}"]`)!.click()
  await settle(6)
}

async function fillStdio() {
  await type(field('name'), 'Everything')
  await type(field('command'), 'npx')
  await type(field<HTMLTextAreaElement>('args'), '-y\n@modelcontextprotocol/server-everything')
}

describe('mcpServerDialog: create', () => {
  it('creates an HTTP server with a header; the id follows the name until edited', async () => {
    api.mcp.create.mockImplementation(async ({ body }: { body: McpServerInput }) => created(body))
    const { open, saved } = mountDialog()
    await settle()
    expect(dialog().dataset.mode).toBe('create')
    await type(field('name'), 'GitHub MCP')
    expect(field('id').value).toBe('github-mcp')
    await type(field('id'), 'gh')
    await type(field('name'), 'GitHub MCP server')
    expect(field('id').value).toBe('gh')

    await chooseTransport('http')
    await type(field('url'), 'https://mcp.example.com/mcp')
    await addRow('headers')
    const [header] = rows('headers')
    await type(one<HTMLInputElement>('[data-field="row-name"]', header)!, 'Authorization')
    const value = one<HTMLInputElement>('[data-field="row-value"]', header)!
    expect(value.type).toBe('password')
    await type(value, 'Bearer ghp_new_secret')
    await save()

    expect(api.mcp.create).toHaveBeenCalledWith({
      body: {
        id: 'gh',
        name: 'GitHub MCP server',
        transport: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer ghp_new_secret' } },
        policy: 'ask',
        enabled: true,
      },
    })
    expect(saved).toHaveBeenCalledWith(expect.objectContaining({ id: 'gh' }))
    expect(toasts.success).toHaveBeenCalledWith('Added GitHub MCP server')
    expect(open.value).toBe(false)
  })

  it('shows validation errors and sends nothing while the form is invalid', async () => {
    mountDialog()
    await settle()
    await chooseTransport('sse')
    await addRow('headers')
    await type(one<HTMLInputElement>('[data-field="row-name"]', rows('headers')[0])!, 'Bad Header')
    await save()
    expect(api.mcp.create).not.toHaveBeenCalled()
    const text = dialog().textContent ?? ''
    expect(text).toContain('Enter a name.')
    expect(text).toContain('Enter an id.')
    expect(text).toContain('Enter the server URL.')
    expect(text).toContain('Header names use')
    expect(field('url').getAttribute('aria-invalid')).toBe('true')
  })

  it('maps an id conflict to the id field', async () => {
    api.mcp.create.mockRejectedValue(new HarnessError({ code: 'conflict', message: 'The MCP server "everything" exists.', details: { reason: 'exists' } }))
    mountDialog()
    await settle()
    await fillStdio()
    await save()
    expect(api.mcp.create).toHaveBeenCalledTimes(1)
    expect(field('id').getAttribute('aria-invalid')).toBe('true')
    expect(dialog().textContent).toContain('This id is already used by another MCP server.')
    // Editing the form clears the server message.
    await type(field('id'), 'everything-2')
    expect(dialog().textContent).not.toContain('This id is already used by another MCP server.')
  })

  it('asks for the password first when a stdio server is saved with a stale session', async () => {
    const auth = useAuthStore()
    auth.status = authStatus({ enabled: true, source: 'settings', freshUntil: Date.now() - 60_000 })
    api.auth.login.mockResolvedValue(authStatus({ enabled: true, source: 'settings', freshUntil: Date.now() + 600_000 }))
    api.mcp.create.mockImplementation(async ({ body }: { body: McpServerInput }) => created(body))
    const { saved } = mountDialog()
    await settle()
    expect(one('[data-slot="mcp-stdio-note"]', dialog())!.textContent).toContain('Runs a local command on your server.')
    await fillStdio()
    await addRow('env')
    const [env] = rows('env')
    await type(one<HTMLInputElement>('[data-field="row-name"]', env)!, 'API_KEY')
    await type(one<HTMLInputElement>('[data-field="row-value"]', env)!, 'sk-local-secret')
    await save()

    expect(api.mcp.create).not.toHaveBeenCalled()
    expect(passwordDialog()).not.toBeNull()
    api.auth.login.mockRejectedValueOnce(new HarnessError({ code: 'unauthorized', message: 'Wrong password.' }))
    await confirmPassword('nope')
    expect(passwordDialog()!.textContent).toContain('Wrong password')
    expect(api.mcp.create).not.toHaveBeenCalled()

    await confirmPassword('correct horse battery staple')
    expect(api.auth.login).toHaveBeenLastCalledWith({ body: { password: 'correct horse battery staple' } })
    expect(api.mcp.create).toHaveBeenCalledWith({
      body: {
        id: 'everything',
        name: 'Everything',
        transport: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-everything'], env: { API_KEY: 'sk-local-secret' } },
        policy: 'ask',
        enabled: true,
      },
    })
    expect(saved).toHaveBeenCalledTimes(1)
    expect(passwordDialog()).toBeNull()
  })

  it('answers a 403 login with one password prompt and one retry', async () => {
    api.auth.login.mockResolvedValue(authStatus({ enabled: true, source: 'settings', freshUntil: Date.now() + 600_000 }))
    const freshAuth = new HarnessError({ code: 'forbidden', message: 'Confirm your password to continue.', action: 'login' })
    api.mcp.create
      .mockRejectedValueOnce(freshAuth)
      .mockImplementationOnce(async ({ body }: { body: McpServerInput }) => created(body))
    const { saved, open } = mountDialog()
    await settle()
    await fillStdio()
    await save()
    expect(api.mcp.create).toHaveBeenCalledTimes(1)
    expect(passwordDialog()).not.toBeNull()
    await confirmPassword('correct horse battery staple')
    expect(api.mcp.create).toHaveBeenCalledTimes(2)
    expect(saved).toHaveBeenCalledTimes(1)
    expect(open.value).toBe(false)
  })

  it('does not prompt twice when the retry is refused again', async () => {
    api.auth.login.mockResolvedValue(authStatus({ enabled: true, source: 'settings', freshUntil: Date.now() + 600_000 }))
    const freshAuth = new HarnessError({ code: 'forbidden', message: 'Confirm your password to continue.', action: 'login' })
    api.mcp.create.mockRejectedValue(freshAuth)
    mountDialog()
    await settle()
    await fillStdio()
    await save()
    await confirmPassword('correct horse battery staple')
    expect(api.mcp.create).toHaveBeenCalledTimes(2)
    expect(passwordDialog()).toBeNull()
    expect(one('[data-field="form-error"]', dialog())!.textContent).toContain('Confirm your password to continue.')
  })

  it('keeps the form and sends nothing when the password prompt is cancelled', async () => {
    const auth = useAuthStore()
    auth.status = authStatus({ enabled: true, source: 'settings', freshUntil: null })
    const { open, saved } = mountDialog()
    await settle()
    await fillStdio()
    await save()
    const prompt = passwordDialog()!
    const cancel = [...prompt.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Cancel')!
    cancel.click()
    await settle(5)

    expect(passwordDialog()).toBeNull()
    expect(api.mcp.create).not.toHaveBeenCalled()
    expect(api.auth.login).not.toHaveBeenCalled()
    expect(saved).not.toHaveBeenCalled()
    expect(open.value).toBe(true)
    expect(field('command').value).toBe('npx')
    expect(one('[data-field="form-error"]', dialog())).toBeNull()
    expect(one<HTMLButtonElement>(`[data-testid="${testIds.mcpSave}"]`, dialog())!.disabled).toBe(false)
  })

  it('drops typed secrets when the dialog closes', async () => {
    const { open } = mountDialog()
    await settle()
    await addRow('env')
    await type(one<HTMLInputElement>('[data-field="row-name"]', rows('env')[0])!, 'API_KEY')
    await type(one<HTMLInputElement>('[data-field="row-value"]', rows('env')[0])!, 'sk-typed-secret')
    open.value = false
    await settle()
    open.value = true
    await settle()
    expect(rows('env')).toHaveLength(0)
    expect(document.body.innerHTML).not.toContain('sk-typed-secret')
  })
})

describe('mcpServerDialog: edit', () => {
  it('keeps a stored header with `null` and never renders its value', async () => {
    const server = mcpServer()
    api.mcp.update.mockImplementation(async ({ body }: { body: { name?: string } }) => ({ ...server, name: body.name ?? server.name }))
    const { saved } = mountDialog(server)
    await settle()
    expect(dialog().dataset.mode).toBe('edit')
    expect(field('id').readOnly).toBe(true)
    const save = one<HTMLButtonElement>(`[data-testid="${testIds.mcpSave}"]`, dialog())!
    expect(save.disabled).toBe(true)

    const [stored] = rows('headers')
    expect(stored!.dataset.stored).toBe('true')
    const name = one<HTMLInputElement>('[data-field="row-name"]', stored)!
    const value = one<HTMLInputElement>('[data-field="row-value"]', stored)!
    expect(name.value).toBe('Authorization')
    expect(name.readOnly).toBe(true)
    expect(value.value).toBe('')
    expect(value.placeholder).toBe(`${STORED_HINT} · stored`)

    await addRow('headers')
    const added = rows('headers')[1]!
    await type(one<HTMLInputElement>('[data-field="row-name"]', added)!, 'X-Team')
    await type(one<HTMLInputElement>('[data-field="row-value"]', added)!, 'blue')
    await type(field('name'), 'GitHub (work)')
    expect(save.disabled).toBe(false)
    save.click()
    await settle(5)

    expect(api.mcp.update).toHaveBeenCalledWith({
      params: { id: 'github' },
      body: {
        name: 'GitHub (work)',
        transport: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { 'Authorization': null, 'X-Team': 'blue' } },
      },
    })
    expect(saved).toHaveBeenCalledTimes(1)
    expect(toasts.success).toHaveBeenCalledWith('Saved GitHub (work)')
  })

  it('sends a replaced value and removes a deleted row', async () => {
    const server = mcpServer({
      transport: {
        type: 'http',
        url: 'https://mcp.example.com/mcp',
        headers: {
          'Authorization': { set: true, hint: STORED_HINT, source: 'stored' },
          'X-Old': { set: true, hint: null, source: 'stored' },
        },
      },
    })
    api.mcp.update.mockResolvedValue(server)
    mountDialog(server)
    await settle()
    const [authorization, old] = rows('headers')
    expect(one<HTMLInputElement>('[data-field="row-value"]', old)!.placeholder).toBe('Stored')
    await type(one<HTMLInputElement>('[data-field="row-value"]', authorization)!, 'Bearer rotated')
    one('[data-action="remove-row"]', old)!.click()
    await settle()
    await save()
    expect(api.mcp.update).toHaveBeenCalledWith({
      params: { id: 'github' },
      body: { transport: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer rotated' } } },
    })
  })

  it('needs no password for a change that keeps the stdio transport', async () => {
    const auth = useAuthStore()
    auth.status = authStatus({ enabled: true, source: 'settings', freshUntil: Date.now() - 60_000 })
    const server = mcpServer({ id: 'everything', name: 'Everything', transport: { type: 'stdio', command: 'npx', args: ['-y'], env: {} } })
    api.mcp.update.mockResolvedValue({ ...server, name: 'Everything 2' })
    mountDialog(server)
    await settle()
    await type(field('name'), 'Everything 2')
    await save()
    expect(passwordDialog()).toBeNull()
    expect(api.mcp.update).toHaveBeenCalledWith({ params: { id: 'everything' }, body: { name: 'Everything 2' } })
  })

  it('asks for the password when switching a server to stdio', async () => {
    const auth = useAuthStore()
    auth.status = authStatus({ enabled: true, source: 'settings', freshUntil: Date.now() - 60_000 })
    api.auth.login.mockResolvedValue(authStatus({ enabled: true, source: 'settings', freshUntil: Date.now() + 600_000 }))
    const server = mcpServer()
    api.mcp.update.mockResolvedValue({ ...server, transport: { type: 'stdio', command: 'npx', args: [], env: {} } })
    mountDialog(server)
    await settle()
    await chooseTransport('stdio')
    await type(field('command'), 'npx')
    await save()
    expect(api.mcp.update).not.toHaveBeenCalled()
    expect(passwordDialog()).not.toBeNull()
    await confirmPassword('correct horse battery staple')
    expect(api.mcp.update).toHaveBeenCalledWith({ params: { id: 'github' }, body: { transport: { type: 'stdio', command: 'npx' } } })
  })
})
