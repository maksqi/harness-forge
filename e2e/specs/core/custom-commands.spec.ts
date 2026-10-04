// Custom commands in the chat (docs/UI.md 2.17, 7.8, 7.28; ADR-045) with `mock:agents` (docs/PROVIDERS.md 8: any other
// turn answers `Agents mock: <user text>`, so the expansion the model got is visible).
// - The slash menu of a project chat lists its commands in groups, in order App · Project · Personal · Plugins (headings
//   and rows carry `data-group`): `/remember` in App, a project command with its argument hint, a project command from
//   a subfolder with its namespace on the right, a personal command and a plugin command with the plugin's name on the
//   right. Typing the command and a blank shows the ghost argument hint until the first argument character.
// - Outside the project the project's commands are not listed (the personal and plugin ones are).
// - `$ARGUMENTS` expands on the server: the bubble keeps the typed text, the model gets the expansion. A command with
//   `model: mock:agents` sent from a `mock:echo` chat runs on Mock Agents (the chat keeps its model); its badge names
//   the model and its tooltip the source, the model and the tool limit.
import type { Page } from '@playwright/test'
import {
  assistantMessages,
  byTestId,
  composer,
  createCustomizationPlugin,
  createPersonalDefinition,
  customizationPluginManifest,
  definitionFile,
  expect,
  expectMessageStatus,
  lastAssistantMessage,
  MOCK_AGENTS_MODEL,
  openNewChat,
  seedProjectChat,
  sendMessage,
  test,
  testIds,
  uniqueId,
  userMessages,
} from '../../helpers/index.ts'

function slashMenu(page: Page) {
  return page.getByTestId(testIds.slashMenu)
}

/** The group headings of the open slash menu, in display order (`data-group` on the headings, docs/UI.md 13.11). */
async function groupHeadings(page: Page): Promise<string[]> {
  return slashMenu(page).locator('[data-group]:not([data-testid])').evaluateAll(items => items.map(item => item.getAttribute('data-group') ?? ''))
}

test.describe('custom commands', () => {
  test('the slash menu groups App, Project, Personal and Plugins; the hint and the namespace; project commands stay in the project @smoke', async ({ page, api, cleanup }) => {
    const review = uniqueId('review')
    const lint = uniqueId('lint')
    const standup = uniqueId('standup')
    const tldr = uniqueId('tldr')
    const pluginId = uniqueId('e2e-cmds')
    const pluginName = `Summaries ${pluginId.slice(-6)}`
    await createPersonalDefinition(api, cleanup, { kind: 'command', name: standup, content: definitionFile({ name: standup, description: 'Draft my standup notes' }, 'Draft my standup notes from $ARGUMENTS.\n') })
    await createCustomizationPlugin(api, cleanup, customizationPluginManifest(pluginId, pluginName, {
      commands: [{ name: tldr, description: 'Summarize the text', template: 'Summarize: {{input}}' }],
    }))
    const { chatId } = await seedProjectChat(api, cleanup, {
      modelRef: MOCK_AGENTS_MODEL,
      prefix: 'commands',
      files: {
        [`.harness/commands/${review}.md`]: definitionFile({ 'description': 'Review a file for bugs', 'argument-hint': '<file> [focus]' }, 'Review $1 with a focus on $2.\n'),
        [`.harness/commands/frontend/${lint}.md`]: definitionFile({ description: 'Lint the frontend' }, 'Lint the frontend.\n'),
      },
    })

    await page.goto(`/chat/${chatId}`)
    const input = page.getByTestId(testIds.composerInput)
    await expect(input).toBeEditable()
    await input.fill('/')
    const menu = slashMenu(page)
    await expect(menu).toBeVisible()
    await expect(byTestId(menu, testIds.slashMenuItem, { 'data-value': review })).toBeAttached()
    expect(await groupHeadings(page)).toEqual(['app', 'project', 'personal', 'plugin'])

    await expect(byTestId(menu, testIds.slashMenuItem, { 'data-value': 'remember', 'data-group': 'app', 'data-kind': 'client' })).toBeAttached()
    await expect(byTestId(menu, testIds.slashMenuItem, { 'data-value': 'compact', 'data-group': 'app', 'data-kind': 'server' })).toBeAttached()
    const reviewRow = byTestId(menu, testIds.slashMenuItem, { 'data-value': review, 'data-group': 'project', 'data-kind': 'server' })
    await expect(reviewRow.locator('[data-slot="slash-menu-hint"]')).toHaveText('<file> [focus]')
    await expect(reviewRow).toHaveAccessibleName(`/${review}, Review a file for bugs, arguments <file> [focus]`)
    const lintRow = byTestId(menu, testIds.slashMenuItem, { 'data-value': lint, 'data-group': 'project' })
    await expect(lintRow.locator('[data-slot="slash-menu-detail"]')).toHaveText('frontend')
    await expect(byTestId(menu, testIds.slashMenuItem, { 'data-value': standup, 'data-group': 'personal' })).toContainText('Draft my standup notes')
    // The plugin's name on the right comes from the plugins store (checked by the next test).
    const pluginRow = byTestId(menu, testIds.slashMenuItem, { 'data-value': tldr, 'data-group': 'plugin' })
    await expect(pluginRow.locator('[data-slot="slash-menu-detail"]')).toHaveText(/\S/)

    // A prefix keeps one group.
    await input.fill(`/${review.slice(0, 10)}`)
    await expect(menu.getByTestId(testIds.slashMenuItem)).toHaveCount(1)
    expect(await groupHeadings(page)).toEqual(['project'])

    // The ghost hint after the command and a blank, gone at the first argument character.
    await input.fill(`/${review} `)
    await expect(menu).toBeHidden()
    const hint = composer(page).getByTestId(testIds.slashArgumentHint)
    await expect(hint).toBeVisible()
    await expect(hint).toContainText('<file> [focus]')
    await expect(input).toHaveAccessibleDescription(/Arguments: <file> \[focus\]/)
    await input.pressSequentially('s')
    await expect(hint).toHaveCount(0)
    await input.fill('')

    // Outside the project: no project commands; personal and plugin commands stay.
    await openNewChat(page)
    await page.getByTestId(testIds.composerInput).fill('/')
    await expect(menu).toBeVisible()
    await expect(byTestId(menu, testIds.slashMenuItem, { 'data-value': standup, 'data-group': 'personal' })).toBeAttached()
    await expect(byTestId(menu, testIds.slashMenuItem, { 'data-value': tldr, 'data-group': 'plugin' })).toBeAttached()
    await expect(byTestId(menu, testIds.slashMenuItem, { 'data-value': review })).toHaveCount(0)
    await expect(byTestId(menu, testIds.slashMenuItem, { 'data-value': lint })).toHaveCount(0)
    expect(await groupHeadings(page)).toEqual(['app', 'personal', 'plugin'])
    await page.getByTestId(testIds.composerInput).press('Escape')
    await page.getByTestId(testIds.composerInput).fill('')
  })

  test('$ARGUMENTS expands on the server; a command\'s model runs the turn and its badge names the source and the model @smoke', async ({ page, api, cleanup }) => {
    const greet = uniqueId('greet')
    const onAgents = uniqueId('on-agents')
    const { chatId } = await seedProjectChat(api, cleanup, {
      modelRef: 'mock:echo',
      prefix: 'commands',
      files: {
        [`.harness/commands/${greet}.md`]: definitionFile({ 'description': 'Say hello', 'argument-hint': '<name>' }, 'Say hello to $ARGUMENTS.\n'),
        [`.harness/commands/${onAgents}.md`]: definitionFile({ 'description': 'Runs on Mock Agents', 'model': MOCK_AGENTS_MODEL, 'allowed-tools': 'Read' }, 'On agents: $ARGUMENTS\n'),
      },
    })

    await page.goto(`/chat/${chatId}`)
    await expect(composer(page).getByTestId(testIds.modelPickerTrigger)).toHaveAttribute('data-model-ref', 'mock:echo')

    // A command with a model: the reply comes from Mock Agents, which shows the expansion it got.
    await sendMessage(page, `/${onAgents} hi there`)
    const reply = lastAssistantMessage(page)
    await expectMessageStatus(reply, 'done')
    await expect(reply).toContainText('Agents mock: On agents: hi there')
    await expect(userMessages(page).last()).toContainText(`/${onAgents} hi there`)

    // $ARGUMENTS on the chat's own model: Mock Echo answers with the expansion.
    await sendMessage(page, `/${greet} Ada`)
    await expect(assistantMessages(page)).toHaveCount(2)
    await expectMessageStatus(lastAssistantMessage(page), 'done')
    await expect(lastAssistantMessage(page)).toContainText('Say hello to Ada.')
    await expect(userMessages(page).last()).not.toContainText('Say hello to')

    // The badges come with the stored messages (`metadata.command`): after a reload.
    await page.reload()
    await expect(userMessages(page)).toHaveCount(2)
    const badge = userMessages(page).first().locator('[data-slot="command-badge"]')
    await expect(badge.locator('[data-slot="command-badge-model"]')).toHaveText('· Mock Agents')
    await expect(badge).toContainText(`/${onAgents}`)
    await badge.focus()
    await expect(page.locator('[data-slot="command-badge-source"]')).toHaveText('Project command')
    await expect(page.locator('[data-slot="command-badge-runs-on"]')).toHaveText('Runs on Mock Agents')
    await expect(page.locator('[data-slot="command-badge-tools"]')).toHaveText('Tools limited to read_file')
    // Screen readers get the same lines from the badge's sr-only text.
    await expect(badge).toContainText('Project command')
    await expect(badge).toContainText('Runs on Mock Agents')
    await page.keyboard.press('Escape')
    // The chat keeps its own model.
    await expect(composer(page).getByTestId(testIds.modelPickerTrigger)).toHaveAttribute('data-model-ref', 'mock:echo')
    const detail = await api.getChat(chatId)
    expect(detail.modelRef).toBe('mock:echo')
    expect(detail.messages[1]?.metadata?.modelRef).toBe(MOCK_AGENTS_MODEL)
    expect(detail.messages[0]?.metadata?.command).toMatchObject({ name: onAgents, source: 'project', modelRef: MOCK_AGENTS_MODEL })
    expect(detail.messages[3]?.metadata?.modelRef).toBe('mock:echo')

    const greetBadge = userMessages(page).last().locator('[data-slot="command-badge"]')
    await expect(greetBadge).toContainText(`/${greet}`)
    await expect(greetBadge.locator('[data-slot="command-badge-model"]')).toHaveCount(0)
    await expect(greetBadge).toContainText('Project command')
  })

  // Fixed at the final gate: ChatView loads the plugins store, so a freshly loaded chat page names the plugin.
  test('the slash menu names the plugin of a plugin command on a freshly loaded chat page', async ({ page, api, cleanup }) => {
    const tldr = uniqueId('tldr')
    const pluginId = uniqueId('e2e-cmds')
    const pluginName = `Summaries ${pluginId.slice(-6)}`
    await createCustomizationPlugin(api, cleanup, customizationPluginManifest(pluginId, pluginName, {
      commands: [{ name: tldr, description: 'Summarize the text', template: 'Summarize: {{input}}' }],
    }))
    await openNewChat(page)
    await page.getByTestId(testIds.composerInput).fill(`/${tldr}`)
    const row = byTestId(slashMenu(page), testIds.slashMenuItem, { 'data-value': tldr, 'data-group': 'plugin' })
    await expect(row.locator('[data-slot="slash-menu-detail"]')).toHaveText(pluginName)
  })
})
