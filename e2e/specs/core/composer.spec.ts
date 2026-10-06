// Composer slash menu (docs/UI.md 7.8): `/` at the start of the composer lists the client-only commands and every
// server command from `GET /api/commands`, filters by prefix and closes on Escape.
import { byTestId, expect, openNewChat, test, testIds } from '../../helpers/index.ts'

const CLIENT_COMMANDS = ['new', 'model', 'effort', 'mode', 'help', 'remember', 'output-style']

test.describe('composer', () => {
  test('the slash menu lists the app and server commands @smoke', async ({ page, api }) => {
    const serverCommands = (await api.client.commands.list()).items.map(command => command.name)
    expect(serverCommands).toContain('explain')

    await openNewChat(page)
    const input = page.getByTestId(testIds.composerInput)
    await input.fill('/')
    const menu = page.getByTestId(testIds.slashMenu)
    await expect(menu).toBeVisible()

    const items = menu.getByTestId(testIds.slashMenuItem)
    await expect(items).toHaveCount(CLIENT_COMMANDS.length + serverCommands.length)
    for (const name of CLIENT_COMMANDS)
      await expect(byTestId(menu, testIds.slashMenuItem, { 'data-value': name, 'data-kind': 'client' })).toHaveCount(1)
    for (const name of serverCommands)
      await expect(byTestId(menu, testIds.slashMenuItem, { 'data-value': name, 'data-kind': 'server' })).toHaveCount(1)
    await expect(items.first()).toHaveAttribute('data-value', CLIENT_COMMANDS[0]!)

    // Typing filters by prefix.
    await input.fill('/expl')
    await expect(items).toHaveCount(serverCommands.filter(name => name.startsWith('expl')).length)
    await expect(byTestId(menu, testIds.slashMenuItem, { 'data-value': 'explain' })).toContainText('/explain')
    await expect(byTestId(menu, testIds.slashMenuItem, { 'data-value': 'new' })).toHaveCount(0)

    await input.press('Escape')
    await expect(menu).toBeHidden()
    await expect(input).toHaveValue('/expl')
  })
})
