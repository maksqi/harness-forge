// MCP prompts as slash commands (Phase 14, ADR-061; docs/UI.md 2.20, 7.35; docs/API.md 4.38): the prompts of a connected
// MCP server (the OAuth fixture without OAuth, a personal HTTP server) are the commands `/mcp__<server>__<prompt>`.
// - `/` lists them in the slash menu's MCP group (heading "MCP", between Plugins and Skills) with the argument hint
//   (`<name> [greeting]`) and the server's name; typing a segment of the name finds a prompt.
// - `/mcp__<server>__greet Ada` with `mock:echo` (it streams the user text back) shows the expansion "Hello, Ada!": the
//   prompt ran once on the server and its text went to the model; the user bubble keeps the typed command with the badge
//   "MCP · {server}".
// - Without the required argument the reply fails with "Missing argument: name. Usage: …" and no model call.
import type { Page } from '@playwright/test'
import {
  addHttpMcpServer,
  byTestId,
  CHAT_URL_PATTERN,
  chatIdFromUrl,
  composer,
  expect,
  expectMessageStatus,
  lastAssistantMessage,
  openNewChat,
  selectModel,
  sendMessage,
  startOAuthFixture,
  test,
  testIds,
  uniqueId,
  userMessages,
  waitForMcpStatus,
} from '../../helpers/index.ts'

/** The slash menu's row of a command. */
function slashRow(page: Page, name: string) {
  return byTestId(page.getByTestId(testIds.slashMenu), testIds.slashMenuItem, { 'data-value': name })
}

test.describe('MCP prompts', () => {
  test('the slash menu lists the prompts in the MCP group; /mcp__<server>__greet Ada shows the expansion @smoke', async ({ page, api, cleanup }) => {
    const fixture = await startOAuthFixture({ noAuth: true }, cleanup)
    const serverId = uniqueId('pr')
    const serverName = `Prompts ${serverId}`
    await addHttpMcpServer(api, cleanup, { id: serverId, name: serverName, url: fixture.url })
    await waitForMcpStatus(api, serverId, 'connected')
    const greet = `mcp__${serverId}__greet`
    await expect.poll(async () => (await api.client.commands.list({ query: {} })).items.find(item => item.name === greet), { message: 'the prompt is a command' })
      .toMatchObject({ source: 'mcp', argumentHint: '<name> [greeting]', mcpServer: { id: serverId, name: serverName } })

    await openNewChat(page)
    await selectModel(page, 'mock:echo')
    const input = page.getByTestId(testIds.composerInput)
    await input.fill('/')
    const menu = page.getByTestId(testIds.slashMenu)
    await expect(menu).toBeVisible()
    await expect(menu.locator('[data-group="mcp"]:not([data-testid])')).toHaveText('MCP')
    const row = slashRow(page, greet)
    await expect(row).toHaveAttribute('data-group', 'mcp')
    await expect(row.locator('[data-slot="slash-menu-hint"]')).toHaveText('<name> [greeting]')
    await expect(row.locator('[data-slot="slash-menu-detail"]')).toHaveText(serverName)
    for (const prompt of ['review', 'with_resource', 'with_image'])
      await expect(slashRow(page, `mcp__${serverId}__${prompt}`)).toHaveAttribute('data-group', 'mcp')
    // The groups keep their order: the MCP group comes after the app's own commands.
    const groups = await menu.locator('[role="group"] > [data-group]:not([data-testid])').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-group')))
    expect(groups.indexOf('mcp')).toBeGreaterThan(groups.indexOf('app'))

    // A segment of the name finds the prompt.
    await input.fill(`/${serverId}__gre`)
    await expect(menu.getByTestId(testIds.slashMenuItem)).toHaveCount(1)
    await expect(row).toBeVisible()
    await input.fill('')
    await expect(menu).toBeHidden()

    // The expansion goes to the model; the bubble keeps the typed command.
    const promptsGet = fixture.counters().promptsGet
    await sendMessage(page, `/${greet} Ada`)
    await expect(page).toHaveURL(CHAT_URL_PATTERN)
    const chatId = chatIdFromUrl(page)
    cleanup(api => api.removeChat(chatId))
    await expectMessageStatus(lastAssistantMessage(page), 'done')
    await expect(lastAssistantMessage(page)).toContainText('Hello, Ada!')
    await expect(userMessages(page).last()).toContainText(`/${greet} Ada`)
    await expect(userMessages(page).last()).not.toContainText('Hello, Ada!')
    expect(fixture.counters().promptsGet - promptsGet, 'prompts/get ran once').toBe(1)
    await expect(composer(page).getByTestId(testIds.composerInput)).toHaveValue('')

    // The badge comes with the stored message (after a reload): an MCP prompt names its server.
    await page.reload()
    const badge = userMessages(page).last().locator('[data-slot="command-badge"]')
    await expect(badge).toHaveAttribute('data-source', 'mcp')
    await expect(badge).toContainText(`/${greet}`)
    await expect(badge).toHaveAccessibleName(new RegExp(`MCP · ${serverName}`))
  })

  test('a missing required argument fails the reply with the usage', async ({ page, api, cleanup }) => {
    const fixture = await startOAuthFixture({ noAuth: true }, cleanup)
    const serverId = uniqueId('pr')
    await addHttpMcpServer(api, cleanup, { id: serverId, name: `Prompts ${serverId}`, url: fixture.url })
    await waitForMcpStatus(api, serverId, 'connected')
    const greet = `mcp__${serverId}__greet`
    await expect.poll(async () => (await api.client.commands.list({ query: {} })).items.some(item => item.name === greet)).toBe(true)

    await openNewChat(page)
    await selectModel(page, 'mock:echo')
    await sendMessage(page, `/${greet}`)
    await expect(page).toHaveURL(CHAT_URL_PATTERN)
    const chatId = chatIdFromUrl(page)
    cleanup(api => api.removeChat(chatId))
    const reply = lastAssistantMessage(page)
    await expect(reply).toContainText(`Missing argument: name. Usage: /${greet} <name> [greeting]`)
    await expect(reply).not.toContainText('Hello')
    expect(fixture.counters().promptsGet, 'no prompts/get without the argument').toBe(0)
  })
})
