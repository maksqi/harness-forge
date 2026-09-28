// MCP servers (docs/UI.md 8.12, docs/PLUGINS.md 5 and 10, docs/API.md 5.12-5.13): the stdio echo server fixture is
// added in the MCP panel of `core-mcp` (Overview), connects, and its tools are registered as
// `mcp__<serverId>__<tool>` with the policy of their annotations (`echo` is read-only, so `safe`). A chat on the mock
// OpenAI server then calls `echo` without an approval card and the tool row carries the server badge. Deleting the
// server from the panel removes its tools.
import type { MockOpenAIServer } from '../../fixtures/mock-openai-server.ts'
import process from 'node:process'
import { expect, test } from '@playwright/test'
import { startMockOpenAI } from '../../fixtures/mock-openai-server.ts'
import { fixtureManifest, MCP_ECHO_SERVER_PATH, withBaseURL } from '../../fixtures/plugins.ts'
import { listTools, recreateDeclarativePlugin, removeChat, removeMcpServer, removePlugin, toolNames } from './_support/api.ts'
import { testIds } from './_support/testids.ts'
import { byTestId, lastAssistantMessage, selectModel, sendMessage, startNewChatInApp, toolRow } from './_support/ui.ts'

const SERVER_ID = 'e2e-echo'
const SERVER_NAME = 'E2E Echo'
const ECHO_TOOL = `mcp__${SERVER_ID}__echo`
const REVERSE_TOOL = `mcp__${SERVER_ID}__reverse`
const LLM_PLUGIN = 'e2e-tools-llm'
const MODEL_REF = `${LLM_PLUGIN}:tool-caller`

test.describe('MCP servers @plugins', () => {
  let mock: MockOpenAIServer
  /** Chats a test opened; deleted after it. */
  const chats: string[] = []

  test.beforeAll(async ({ request }) => {
    mock = await startMockOpenAI()
    await removeMcpServer(request, SERVER_ID)
    await recreateDeclarativePlugin(request, fixtureManifest(LLM_PLUGIN, withBaseURL(mock.baseURL)))
  })

  test.afterEach(async ({ request }) => {
    for (const id of chats.splice(0))
      await removeChat(request, id)
  })

  test.afterAll(async ({ request }) => {
    await removeMcpServer(request, SERVER_ID)
    await removePlugin(request, LLM_PLUGIN)
    await mock?.close()
  })

  test('adds a stdio server in the MCP panel whose tool is called in chat @smoke', async ({ page, request }) => {
    await page.goto('/plugins/core-mcp')
    const panel = page.getByTestId(testIds.mcpPanel)
    await expect(panel).toBeVisible()
    await panel.getByTestId(testIds.mcpAdd).click()

    const dialog = page.getByTestId(testIds.mcpDialog)
    await expect(dialog).toBeVisible()
    await dialog.locator('[data-field="name"]').fill(SERVER_NAME)
    await expect(dialog.locator('[data-field="id"]')).toHaveValue(SERVER_ID)
    await byTestId(dialog, testIds.mcpTransportTab, { 'data-value': 'stdio' }).click()
    await expect(dialog).toContainText('Runs a local command on your server.')
    await dialog.locator('[data-field="command"]').fill(process.execPath)
    await dialog.locator('[data-field="args"]').fill(MCP_ECHO_SERVER_PATH)
    await expect(dialog.locator('[data-field="policy"]')).toHaveAttribute('data-value', 'ask')
    await dialog.getByTestId(testIds.mcpSave).click()
    await expect(dialog).toBeHidden()

    const server = byTestId(panel, testIds.mcpServerRow, { 'data-server-id': SERVER_ID })
    await expect(server).toHaveAttribute('data-status', 'connected', { timeout: 20_000 })
    await expect(server).toContainText(SERVER_NAME)
    await expect(server.getByTestId(testIds.mcpStatus)).toHaveText('Connected · 2 tools')

    const tools = await listTools(request)
    expect(tools.find(tool => tool.name === ECHO_TOOL)).toMatchObject({ pluginId: 'core-mcp', mcpServerId: SERVER_ID, policy: 'safe', enabled: true, available: true })
    expect(tools.find(tool => tool.name === REVERSE_TOOL)).toMatchObject({ pluginId: 'core-mcp', mcpServerId: SERVER_ID, policy: 'ask', available: true })

    // The mock model calls the echo tool: read-only, so it runs without an approval card. The chat is opened in-app:
    // the server badge takes its name from the MCP list the panel loaded (after a reload it shows the id).
    await startNewChatInApp(page)
    await selectModel(page, MODEL_REF)
    mock.reset()
    chats.push(await sendMessage(page, `Echo it [[tool:${ECHO_TOOL} {"text":"hello from the echo server"}]]`))
    const row = toolRow(page, ECHO_TOOL)
    await expect(row).toHaveAttribute('data-state', 'output-available')
    await expect(row).toContainText('echo')
    await expect(row).toContainText(SERVER_NAME)
    await expect(page.getByTestId(testIds.toolApproval)).toHaveCount(0)
    expect(mock.chatRequests()[0]?.toolNames).toEqual(expect.arrayContaining([ECHO_TOOL, REVERSE_TOOL]))
    await row.click()
    await expect(page.getByTestId(testIds.toolRowOutput).first()).toContainText('hello from the echo server')
    const reply = lastAssistantMessage(page)
    await expect(reply).toHaveAttribute('data-status', 'done')
    await expect(reply).toContainText('Tool result:')
    await expect(reply).toContainText('hello from the echo server')

    // Deleting the server removes its tools.
    await page.goto('/plugins/core-mcp')
    await page.locator(`[data-action="mcp-menu"][data-server-id="${SERVER_ID}"]`).click()
    await byTestId(page, testIds.mcpDelete, { 'data-server-id': SERVER_ID }).click()
    await page.locator('[data-action="mcp-delete-confirm"]').click()
    await expect(server).toHaveCount(0)
    await expect.poll(async () => toolNames(request)).not.toContain(ECHO_TOOL)
  })
})
