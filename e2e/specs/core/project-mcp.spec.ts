// Project MCP servers (docs/UI.md 2.18, 7.33; ADR-050) with `mock:hooks` (`mcp?` answers `MCP tools: <the offered
// mcp__ tools>`, docs/PROVIDERS.md 8). The project's `.mcp.json` names the dependency-free stdio fixture `mcp-min.mjs`
// (copied into the folder, run as `node tools/mcp-min.mjs --marker`: it writes `.mcp-started-<pid>` with whether `TOKEN`
// reached it, never its value) with `env: { TOKEN: "${TOKEN}" }`.
// - The MCP dialog from the chat project chip: the server waits for approval ("Needs approval", Review… opens the trust
//   dialog on its item); approved it needs its variable ("Set 1 variable"); a value saved in the variables panel
//   (write-only, "•••• · stored") makes it idle ("Starts with the first chat"); the first `mcp?` of a project chat starts
//   it and lists its tools; the dialog then reads "Connected · 3 tools" and Reconnect starts a new process. A chat outside
//   the project never gets them.
// - A project server whose id equals a global server's id replaces it in the project's chats ("Replaces your server
//   {id} …"); an HTTP server needs approval like a stdio one (Review…, the private-network warning).
// - Phase 14 (ADR-059; W14.11): an approved `.mcp.json` HTTP server with `oauth` (the OAuth MCP fixture on `127.0.0.1`,
//   its pre-registered client) asks for a sign-in once it starts; **Sign in** in the MCP dialog leaves for the fixture's
//   authorization page and the callback page returns to the chat ("Signed in to docs."); the row then reads "Connected · 4
//   tools · Signed in" with **Sign out…** (confirmed). A pending server keeps Review… and never offers Sign in.
import type { Page } from '@playwright/test'
import type { HarnessApi } from '../../helpers/index.ts'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import {
  approveProjectItems,
  byTestId,
  expect,
  expectMessageStatus,
  FIXTURE_CLIENT_ID,
  lastAssistantMessage,
  mcpVariable,
  MOCK_HOOKS_MODEL,
  projectMcp,
  REPO_ROOT,
  seedProjectChat,
  sendMessage,
  startOAuthFixture,
  test,
  testIds,
  toastWith,
  trustItem,
  uniqueId,
} from '../../helpers/index.ts'

const MCP_MIN_SOURCE = join(REPO_ROOT, 'apps/server/src/mcp/__fixtures__/mcp-min.mjs')
const MCP_ECHO_SERVER = join(REPO_ROOT, 'e2e/fixtures/mcp-echo-server.mjs')

/** The `mcp-min.mjs` stdio server of a `.mcp.json`, with extra fields (`env`). */
function minServer(extra: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return { command: 'node', args: ['tools/mcp-min.mjs', '--marker'], ...extra }
}

/** The markers the fixture wrote in the folder (one per start). */
async function mcpMarkers(folder: string): Promise<Array<{ pid: number, token: string }>> {
  const names = (await readdir(folder)).filter(name => name.startsWith('.mcp-started-'))
  return Promise.all(names.map(async name => JSON.parse(await readFile(join(folder, name), 'utf8')) as { pid: number, token: string }))
}

/**
 * Sends a message from the composer, waits for the finished reply and returns its stored text (the page types a finished
 * reply out over a few frames, so the stored text is the stable one).
 */
async function ask(page: Page, api: HarnessApi, chatId: string, text: string): Promise<string> {
  const count = await page.getByTestId(testIds.messageAssistant).count()
  await sendMessage(page, text)
  await expect(page.getByTestId(testIds.messageAssistant)).toHaveCount(count + 1)
  await expectMessageStatus(lastAssistantMessage(page), 'done')
  const last = (await api.getChat(chatId)).messages.at(-1)
  expect(last?.role).toBe('assistant')
  return (last?.parts ?? []).map(part => (part.type === 'text' ? part.text : '')).join('')
}

async function seedMcpProject(api: HarnessApi, cleanup: Parameters<typeof seedProjectChat>[1], servers: Record<string, unknown>) {
  return seedProjectChat(api, cleanup, {
    modelRef: MOCK_HOOKS_MODEL,
    prefix: 'mcp',
    files: {
      'tools/mcp-min.mjs': await readFile(MCP_MIN_SOURCE, 'utf8'),
      '.mcp.json': `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`,
    },
  })
}

test.describe('project MCP servers', () => {
  test('approve, set the variable, connect on the first chat, reconnect; the tools stay in the project @smoke', async ({ page, api, cleanup }) => {
    const server = 'pmin'
    const tools = ['echo', 'env', 'pid'].map(tool => `mcp__${server}__${tool}`)
    const { project, folder, chatId } = await seedMcpProject(api, cleanup, { [server]: minServer({ env: { TOKEN: mcpVariable('TOKEN') } }) })
    await page.goto(`/chat/${chatId}`)
    await expect(page.getByTestId(testIds.projectTrustChip)).toHaveAttribute('data-count', '1')

    await page.getByTestId(testIds.chatProjectChip).click()
    await page.getByTestId(testIds.chatProjectMcp).click()
    const dialog = page.getByTestId(testIds.projectMcpDialog)
    await expect(dialog.getByRole('heading', { level: 2 })).toHaveText(`MCP servers in ${project.name}`)
    const row = byTestId(dialog, testIds.projectMcpServer, { 'data-server-id': server })
    await expect(row).toHaveAttribute('data-state', 'pending')
    await expect(row).toHaveAttribute('data-transport', 'stdio')
    await expect(row.locator('[data-slot="project-mcp-status"]')).toHaveText('Needs approval')
    await expect(row.locator('[data-slot="project-mcp-command"]')).toHaveText('node tools/mcp-min.mjs --marker')
    const variables = dialog.getByTestId(testIds.projectMcpVariables)
    await expect(variables).toHaveAttribute('data-count', '1')
    const token = byTestId(variables, testIds.projectMcpVariable, { 'data-name': 'TOKEN' })
    await expect(token).toHaveAttribute('data-state', 'missing')

    // Review… opens the trust dialog on the server's item.
    await row.getByTestId(testIds.projectMcpReview).click()
    const review = page.getByTestId(testIds.projectTrustDialog)
    const item = trustItem(review, { 'data-kind': 'mcp', 'data-state': 'new' })
    await expect(item.getByTestId(testIds.projectTrustSelect)).toBeFocused()
    await expect(item.locator('[data-slot="project-trust-details"]')).toContainText('Environment: TOKEN')
    await expect(item.locator('[data-slot="project-trust-details"]')).toContainText('Variables: TOKEN (not set)')
    await item.getByTestId(testIds.projectTrustSelect).click()
    await review.getByTestId(testIds.projectTrustApprove).click()
    await expect(toastWith(page, `Approved 1 item in ${project.name}`)).toBeVisible()
    await review.locator('[data-action="close"]').click()
    await expect(review).toBeHidden()

    // Approved, it still needs its variable.
    await expect(row).toHaveAttribute('data-state', 'needs-variables')
    await expect(row.locator('[data-slot="project-mcp-status"]')).toHaveText('Set 1 variable')
    const value = token.locator('[data-field="variable-value"]')
    await expect(value).toHaveAttribute('type', 'password')
    await value.fill(`secret-${uniqueId('token')}`)
    await dialog.getByTestId(testIds.projectMcpVariablesSave).click()
    await expect(toastWith(page, 'Variables saved')).toBeVisible()
    await expect(token).toHaveAttribute('data-state', 'set')
    await expect(value).toHaveValue('')
    await expect(value).toHaveAttribute('placeholder', '•••• · stored')
    await expect(row).toHaveAttribute('data-state', 'idle')
    await expect(row.locator('[data-slot="project-mcp-status"]')).toHaveText('Starts with the first chat')
    expect(await mcpMarkers(folder.path), 'nothing started yet').toEqual([])
    await dialog.locator('[data-action="close"]').click()
    await expect(dialog).toBeHidden()
    await expect(page.getByTestId(testIds.projectTrustChip)).toHaveCount(0)

    // The first project chat turn starts it: its tools are offered, and the variable reached the process.
    expect(await ask(page, api, chatId, 'mcp?')).toBe(`MCP tools: ${tools.join(', ')}`)
    const started = await mcpMarkers(folder.path)
    expect(started).toHaveLength(1)
    expect(started[0]!.token).toBe('set')

    // The dialog: connected, the tools behind the row's toggle; Reconnect starts a new process.
    await page.getByTestId(testIds.chatProjectChip).click()
    await page.getByTestId(testIds.chatProjectMcp).click()
    await expect(row).toHaveAttribute('data-state', 'connected')
    await expect(row.locator('[data-slot="project-mcp-status"]')).toHaveText('Connected · 3 tools')
    await row.locator('[data-action="toggle"]').click()
    await expect(row.locator('[data-slot="project-mcp-tools"]').getByRole('listitem')).toHaveText(tools)
    await row.getByTestId(testIds.projectMcpReconnect).click()
    await expect.poll(async () => (await mcpMarkers(folder.path)).length, { message: 'a second process started' }).toBe(2)
    await expect(row).toHaveAttribute('data-state', 'connected')
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()

    // A chat outside the project never gets the project's tools.
    const other = await api.createChat({ title: `No project ${uniqueId('mcp')}`, modelRef: MOCK_HOOKS_MODEL })
    cleanup(api => api.removeChat(other.id))
    await page.goto(`/chat/${other.id}`)
    expect(await ask(page, api, other.id, 'mcp?')).not.toContain(`mcp__${server}__`)
  })

  test('a project server replaces a global server with its id; an HTTP server needs approval too', async ({ page, api, cleanup }) => {
    const shadow = uniqueId('shadow')
    cleanup(async (api) => {
      try {
        await api.client.mcp.remove({ params: { id: shadow } })
      }
      catch (error) {
        if ((error as { code?: unknown }).code !== 'not_found')
          throw error
      }
    })
    await api.client.mcp.create({ body: { id: shadow, name: 'Global echo', enabled: false, transport: { type: 'stdio', command: process.execPath, args: [MCP_ECHO_SERVER] } } })
    const { project } = await seedMcpProject(api, cleanup, {
      [shadow]: minServer(),
      docs: { type: 'http', url: 'http://127.0.0.1:9/mcp' },
    })
    await approveProjectItems(api, project.id, item => item.kind === 'mcp' && item.detail.transport === 'stdio')
    expect((await projectMcp(api, project.id)).items.find(item => item.id === shadow)?.shadows).toBe(shadow)

    // From Settings -> Projects.
    await page.goto('/settings/projects')
    const projectRow = page.getByTestId(testIds.projectRow).filter({ hasText: project.name })
    await expect(projectRow.getByTestId(testIds.projectTrustPending)).toHaveAttribute('data-count', '1')
    await projectRow.getByTestId(testIds.projectRowMenu).click()
    await page.getByRole('menu').getByTestId(testIds.projectMcp).click()
    const dialog = page.getByTestId(testIds.projectMcpDialog)
    const shadowRow = byTestId(dialog, testIds.projectMcpServer, { 'data-server-id': shadow })
    await expect(shadowRow).toHaveAttribute('data-state', 'idle')
    await expect(shadowRow.locator('[data-slot="project-mcp-shadows"]')).toHaveText(`Replaces your server ${shadow} in this project's chats.`)
    const http = byTestId(dialog, testIds.projectMcpServer, { 'data-server-id': 'docs' })
    await expect(http).toHaveAttribute('data-state', 'pending')
    await expect(http).toHaveAttribute('data-transport', 'http')
    await expect(http.locator('[data-slot="project-mcp-command"]')).toHaveText('http://127.0.0.1:9/mcp')
    await expect(http.locator('[data-slot="project-mcp-shadows"]')).toHaveCount(0)
    await http.getByTestId(testIds.projectMcpReview).click()
    const review = page.getByTestId(testIds.projectTrustDialog)
    const item = trustItem(review, { 'data-kind': 'mcp', 'data-state': 'new' })
    await expect(item.getByTestId(testIds.projectTrustSelect)).toBeFocused()
    await expect(item).toHaveAccessibleName('MCP server docs, New')
    await expect(item.locator('[data-slot="project-trust-warnings"] [data-value="private-network"]')).toHaveText('Connects to a private network address.')
    await review.locator('[data-action="close"]').click()
    await expect(review).toBeHidden()
    await expect(dialog).toBeVisible()
  })

  test('an approved .mcp.json server with oauth signs in from the MCP dialog; a pending one only offers Review…', async ({ page, api, cleanup }) => {
    const fixture = await startOAuthFixture({}, cleanup)
    const { project, chatId } = await seedMcpProject(api, cleanup, {
      docs: { type: 'http', url: fixture.url, oauth: { clientId: FIXTURE_CLIENT_ID } },
      wiki: { type: 'http', url: fixture.url, oauth: { clientId: FIXTURE_CLIENT_ID, scopes: 'mcp:read' } },
    })
    await approveProjectItems(api, project.id, item => item.kind === 'mcp' && item.detail.id === 'docs')
    await page.goto(`/chat/${chatId}`)
    const dialog = page.getByTestId(testIds.projectMcpDialog)
    const openDialog = async () => {
      await page.getByTestId(testIds.chatProjectChip).click()
      await page.getByTestId(testIds.chatProjectMcp).click()
      await expect(dialog).toBeVisible()
    }
    await openDialog()
    const docs = byTestId(dialog, testIds.projectMcpServer, { 'data-server-id': 'docs' })
    const wiki = byTestId(dialog, testIds.projectMcpServer, { 'data-server-id': 'wiki' })
    await expect(wiki).toHaveAttribute('data-state', 'pending')
    await expect(wiki.getByTestId(testIds.projectMcpReview)).toBeVisible()
    await expect(wiki.getByTestId(testIds.projectMcpSignIn)).toHaveCount(0)

    // The approved server starts (Reconnect) and asks for a sign-in; nothing was signed in before.
    await expect(docs).toHaveAttribute('data-state', 'idle')
    await expect(docs.getByTestId(testIds.projectMcpSignIn)).toHaveCount(0)
    await docs.getByTestId(testIds.projectMcpReconnect).click()
    await expect(docs).toHaveAttribute('data-state', 'needs-auth')
    await expect(docs.locator('[data-slot="project-mcp-status"]')).toHaveText('Sign in required')
    await expect(docs.getByTestId(testIds.projectMcpReconnect)).toHaveCount(0)
    const signIn = docs.getByTestId(testIds.projectMcpSignIn)
    await expect(signIn).toHaveAccessibleName('Sign in to docs')
    await expect(wiki.getByTestId(testIds.projectMcpSignIn)).toHaveCount(0)

    // Sign in: the fixture (its pre-registered client, auto-approved), the callback page, back in the chat.
    await signIn.click()
    await expect(page).toHaveURL(new RegExp(`/chat/${chatId}$`))
    await expect(toastWith(page, 'Signed in to docs.')).toBeVisible()
    expect(fixture.counters().registrations, 'the configured client needs no registration').toBe(0)
    expect((await projectMcp(api, project.id)).items.find(item => item.id === 'docs')?.auth).toMatchObject({ signedIn: true, client: 'configured' })
    await openDialog()
    await expect(docs).toHaveAttribute('data-state', 'connected')
    await expect(docs.locator('[data-slot="project-mcp-status"]')).toHaveText('Connected · 4 tools · Signed in')
    await expect(wiki).toHaveAttribute('data-state', 'pending')
    await expect(wiki.getByTestId(testIds.projectMcpSignIn)).toHaveCount(0)

    // Sign out (confirmed): the server asks for a sign-in again.
    await docs.getByTestId(testIds.projectMcpSignOut).click()
    await expect(page.getByRole('alertdialog')).toContainText('Sign out of docs?')
    await page.locator('[data-action="project-mcp-sign-out-confirm"]').click()
    await expect(toastWith(page, 'Signed out of docs.')).toBeVisible()
    await expect(docs).toHaveAttribute('data-state', 'needs-auth')
    await expect(docs.getByTestId(testIds.projectMcpSignIn)).toBeVisible()
  })
})
