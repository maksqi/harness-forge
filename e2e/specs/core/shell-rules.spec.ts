// Shell rules (docs/UI.md 2.15, 7.3, 7.23, 9.10; docs/API.md `shellRules`; ADR-038) with `mock:shell`, which runs the
// user text as one `shell` command and answers "Shell done: <stdout>" (docs/PROVIDERS.md 8).
// - The approval card's "Always allow commands starting with" suggests the command word, checks an edited prefix (no
//   match, a command runner), saves the rule with Run; the next matching command runs without a card and its row shows
//   the rule (`tool-row-rule`, "Allowed by rule: echo" in the terminal output).
// - "All projects" saves a global rule that another project's chat uses; a combined command offers one rule per part
//   and a redirection none.
// - Settings -> Projects: "Allowed commands…" of a project row and "Allowed in every project" add, refuse (validation,
//   409 "This rule already exists.") and remove rules.
// Global rules apply to every project of the server: the specs use unique prefixes and remove them through `cleanup`.
import type { Locator, Page } from '@playwright/test'
import type { HarnessApi } from '../../helpers/index.ts'
import {
  byTestId,
  composer,
  expect,
  expectMessageStatus,
  lastAssistantMessage,
  seedProject,
  selectPermissionMode,
  sendMessage,
  test,
  testIds,
  uniqueId,
} from '../../helpers/index.ts'

const MODEL = 'mock:shell'

/** Opens a project chat with `mock:shell` in Ask. */
async function openShellChat(page: Page, chatId: string): Promise<void> {
  await page.goto(`/chat/${chatId}`)
  await expect(page.getByTestId(testIds.chatProjectChip)).toBeVisible()
  await expect(composer(page).getByTestId(testIds.modelPickerTrigger)).toHaveAttribute('data-model-ref', MODEL)
  await selectPermissionMode(page, 'ask')
}

function shellCard(page: Page): Locator {
  return byTestId(lastAssistantMessage(page), testIds.toolApproval, { 'data-tool-name': 'shell' })
}

function shellRow(page: Page): Locator {
  return byTestId(lastAssistantMessage(page), testIds.toolRow, { 'data-tool-name': 'shell' })
}

/** The expanded body of a tool row. */
function rowBody(row: Locator): Locator {
  return row.locator('xpath=ancestor::*[@data-slot="tool-part"][1]').getByTestId(testIds.toolRowOutput)
}

/** Removes every global rule with this prefix (for `cleanup`; a rule made through the UI has no known id). */
async function removeGlobalRules(api: HarnessApi, prefix: string): Promise<void> {
  for (const rule of (await api.client.shellRules.list()).items) {
    if (rule.projectId === null && rule.prefix === prefix) {
      try {
        await api.client.shellRules.remove({ params: { id: rule.id } })
      }
      catch (error) {
        if ((error as { code?: unknown }).code !== 'not_found')
          throw error
      }
    }
  }
}

async function rulesOf(api: HarnessApi, projectId: string | null): Promise<string[]> {
  return (await api.client.shellRules.list()).items.filter(rule => rule.projectId === projectId).map(rule => rule.prefix)
}

test.describe('shell rules', () => {
  test('the card saves a project rule; the next matching command runs without asking @smoke', async ({ page, api, cleanup }) => {
    // Deleting the project also deletes its rules.
    const { project } = await seedProject(api, cleanup, { name: `Rules ${uniqueId('rules')}` })
    const chat = await api.createChat({ title: `Shell rules ${uniqueId('chat')}`, projectId: project.id, modelRef: MODEL })
    cleanup(api => api.removeChat(chat.id))
    const first = uniqueId('first')
    const second = uniqueId('second')

    await openShellChat(page, chat.id)
    await sendMessage(page, `echo ${first}`)
    const card = shellCard(page)
    await expect(card).toContainText('Run this command?')
    const allowRule = card.getByTestId(testIds.toolApprovalAllowRule)
    await expect(allowRule).toHaveAttribute('data-state', 'unchecked')
    await expect(card).toContainText('Always allow commands starting with')
    await expect(card.getByTestId(testIds.toolApprovalRulePrefix)).toHaveCount(0)

    // Checked: the suggested prefix, the scope (This project) and the hint.
    await allowRule.click()
    await expect(allowRule).toHaveAttribute('data-state', 'checked')
    const prefix = card.getByTestId(testIds.toolApprovalRulePrefix)
    await expect(prefix).toHaveValue('echo')
    await expect(prefix).toHaveAttribute('data-value', 'echo')
    const scope = card.getByTestId(testIds.toolApprovalRuleScope)
    await expect(scope).toHaveAttribute('data-value', 'project')
    await expect(scope).toHaveAccessibleName('Where the rule applies')
    await expect(card).toContainText('Combined commands run only when every part matches a rule.')

    // An edited prefix is checked against the command; Run waits for a valid one.
    const run = card.getByTestId(testIds.toolApprovalAllow)
    const error = card.getByTestId(testIds.toolApprovalRuleError)
    await prefix.fill('ls')
    await expect(error).toHaveAttribute('data-code', 'no-match')
    await expect(error).toHaveText('This doesn\'t match the command.')
    await expect(prefix).toHaveAttribute('aria-invalid', 'true')
    await expect(run).toBeDisabled()
    await prefix.fill('sudo')
    await expect(error).toHaveAttribute('data-code', 'command-runner')
    await expect(error).toHaveText('sudo runs other commands, so it can\'t be allowed by a rule.')
    await expect(run).toBeDisabled()
    await prefix.fill('echo')
    await expect(error).toHaveCount(0)
    await expect(run).toBeEnabled()

    // Run saves the rule first, then the command runs.
    await run.click()
    const reply = lastAssistantMessage(page)
    await expect(reply).toContainText(`Shell done: ${first}`)
    await expectMessageStatus(reply)
    await expect.poll(() => rulesOf(api, project.id), { message: 'the project rule' }).toEqual(['echo'])

    // The next `echo` runs without a card; the row and the terminal output name the rule.
    await sendMessage(page, `echo ${second}`)
    const next = lastAssistantMessage(page)
    await expect(next).toContainText(`Shell done: ${second}`)
    await expectMessageStatus(next)
    await expect(shellCard(page)).toHaveCount(0)
    const row = shellRow(page)
    await expect(row).toHaveAttribute('data-state', 'output-available')
    const badge = row.getByTestId(testIds.toolRowRule)
    await expect(badge).toHaveAttribute('data-value', 'echo')
    await expect(badge).toContainText('allowed by rule echo')
    await row.getByRole('button').first().click()
    const terminal = rowBody(row).getByTestId(testIds.terminalOutput)
    await expect(terminal).toBeVisible()
    await expect(terminal.locator('[data-slot="terminal-rule"]')).toHaveText('Allowed by rule: echo')
  })

  test('All projects saves a global rule another project uses; combined commands get one rule per part @smoke', async ({ page, api, cleanup }) => {
    const token = uniqueId('global')
    const command = `echo ${token}`
    cleanup(api => removeGlobalRules(api, command))
    const { project } = await seedProject(api, cleanup, { name: `Global ${uniqueId('rules')}` })
    const chat = await api.createChat({ title: `Global rule ${uniqueId('chat')}`, projectId: project.id, modelRef: MODEL })
    cleanup(api => api.removeChat(chat.id))

    await openShellChat(page, chat.id)
    // A combined command: one read-only chip per part that needs a rule, and the note.
    await sendMessage(page, `echo ${token} && pwd`)
    let card = shellCard(page)
    await card.getByTestId(testIds.toolApprovalAllowRule).click()
    await expect(card.getByTestId(testIds.toolApprovalRulePrefix)).toHaveCount(2)
    await expect(card.getByTestId(testIds.toolApprovalRulePrefix).nth(0)).toHaveAttribute('data-value', 'echo')
    await expect(card.getByTestId(testIds.toolApprovalRulePrefix).nth(1)).toHaveAttribute('data-value', 'pwd')
    await expect(card).toContainText('This command has several parts: one rule is added for each.')
    // Deny ignores the option: no rule is saved.
    await card.getByTestId(testIds.toolApprovalDeny).click()
    await expect(lastAssistantMessage(page)).toContainText('The tool call was denied.')
    await expectMessageStatus(lastAssistantMessage(page))
    expect(await rulesOf(api, project.id)).toEqual([])

    // A redirection always asks: the card has a note instead of the option.
    await sendMessage(page, `echo ${token} > out.txt`)
    card = shellCard(page)
    await expect(card.locator('[data-slot="allow-rule-note"]')).toHaveText('Commands with redirections, substitutions or other shell syntax always ask.')
    await expect(card.getByTestId(testIds.toolApprovalAllowRule)).toHaveCount(0)
    await card.getByTestId(testIds.toolApprovalDeny).click()
    await expectMessageStatus(lastAssistantMessage(page))

    // The narrowed prefix for every project.
    await sendMessage(page, command)
    card = shellCard(page)
    await card.getByTestId(testIds.toolApprovalAllowRule).click()
    await card.getByTestId(testIds.toolApprovalRulePrefix).fill(command)
    const scopeOption = card.getByTestId(testIds.toolApprovalRuleScope).locator('[data-value="global"]')
    await expect(scopeOption).toHaveText('All projects')
    await scopeOption.click()
    await expect(card.getByTestId(testIds.toolApprovalRuleScope)).toHaveAttribute('data-value', 'global')
    await card.getByTestId(testIds.toolApprovalAllow).click()
    await expect(lastAssistantMessage(page)).toContainText(`Shell done: ${token}`)
    await expect.poll(() => rulesOf(api, null), { message: 'the global rule' }).toContain(command)
    expect(await rulesOf(api, project.id)).toEqual([])

    // Another project's chat runs the same command without asking.
    const elsewhere = await seedProject(api, cleanup, { name: `Elsewhere ${uniqueId('rules')}` })
    const otherChat = await api.createChat({ title: `Elsewhere ${uniqueId('chat')}`, projectId: elsewhere.project.id, modelRef: MODEL })
    cleanup(api => api.removeChat(otherChat.id))
    const { text } = await api.sendChat({ chatId: otherChat.id, modelRef: MODEL, toolMode: 'ask', text: command })
    expect(text).toBe(`Shell done: ${token}`)
  })

  test('Settings: a project\'s allowed commands and the global list add, refuse and remove rules @smoke', async ({ page, api, cleanup }) => {
    const token = uniqueId('settings')
    const globalPrefix = `echo ${token}`
    cleanup(api => removeGlobalRules(api, globalPrefix))
    const { project } = await seedProject(api, cleanup, { name: `Allowlist ${uniqueId('rules')}` })

    await page.goto('/settings/projects')
    const projectRow = byTestId(page, testIds.projectRow, { 'data-project-id': project.id })
    await expect(projectRow).toBeVisible()
    await expect(projectRow).not.toContainText('allowed command')
    await projectRow.getByTestId(testIds.projectRowMenu).click()
    await page.getByTestId(testIds.projectAllowlist).click()
    const dialog = page.getByTestId(testIds.allowlistDialog)
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText(`Allowed commands in ${project.name}`)
    await expect(dialog.getByTestId(testIds.allowlistEmpty)).toHaveText('No allowed commands yet.')
    const input = dialog.getByTestId(testIds.allowlistInput)
    await expect(input).toBeFocused()

    // Add with Enter: the rule shows, the input clears and keeps focus.
    await input.fill('pnpm test')
    await page.keyboard.press('Enter')
    await expect(byTestId(dialog, testIds.allowlistRule, { 'data-value': 'pnpm test' })).toBeVisible()
    await expect(input).toHaveValue('')
    await expect(input).toBeFocused()

    // The same rule again: 409.
    const error = dialog.getByTestId(testIds.allowlistError)
    await input.fill('pnpm test')
    await dialog.getByTestId(testIds.allowlistAdd).click()
    await expect(error).toHaveAttribute('data-code', 'conflict')
    await expect(error).toHaveText('This rule already exists.')

    // A one-word rule warns but is saved; the list is sorted by prefix.
    await input.fill('make')
    await expect(dialog.locator('[data-slot="allowlist-warning"]')).toHaveText('This allows every make command.')
    await dialog.getByTestId(testIds.allowlistAdd).click()
    await expect(dialog.getByTestId(testIds.allowlistRule)).toHaveCount(2)
    await expect(dialog.getByTestId(testIds.allowlistRule).nth(0)).toHaveAttribute('data-value', 'make')
    await expect(dialog.getByTestId(testIds.allowlistRule).nth(1)).toHaveAttribute('data-value', 'pnpm test')

    // Refused before the request: syntax and empty.
    await input.fill('ls | wc -l')
    await dialog.getByTestId(testIds.allowlistAdd).click()
    await expect(error).toHaveAttribute('data-code', 'syntax')
    await expect(error).toHaveText('Use a plain command without |, ;, &&, redirections or substitutions.')
    await input.fill('')
    await dialog.getByTestId(testIds.allowlistAdd).click()
    await expect(error).toHaveAttribute('data-code', 'empty')
    await expect(error).toHaveText('Enter the start of a command.')

    // Remove "make": focus moves to the next rule's Remove.
    const removeMake = byTestId(dialog, testIds.allowlistRule, { 'data-value': 'make' }).getByTestId(testIds.allowlistRuleRemove)
    await expect(removeMake).toHaveAccessibleName('Remove make')
    await removeMake.click()
    await expect(dialog.getByTestId(testIds.allowlistRule)).toHaveCount(1)
    await expect(byTestId(dialog, testIds.allowlistRule, { 'data-value': 'pnpm test' }).getByTestId(testIds.allowlistRuleRemove)).toBeFocused()
    await expect.poll(() => rulesOf(api, project.id)).toEqual(['pnpm test'])
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(projectRow).toContainText('1 allowed command')

    // The global list ("Allowed in every project").
    const section = page.getByTestId(testIds.allowlistSection)
    await expect(section).toContainText('Allowed in every project')
    await expect(section).toContainText('Shell commands that start with one of these run without asking in every project.')
    const globalInput = section.getByTestId(testIds.allowlistInput)
    const globalError = section.getByTestId(testIds.allowlistError)
    for (const [prefix, code, text] of [
      ['node', 'interpreter', 'A rule for node alone would allow any code. Add what follows it, such as a script name.'],
      ['cd src', 'cd', 'cd needs no rule: changing into a project folder is always allowed.'],
      ['sudo ls', 'command-runner', 'sudo runs other commands, so it can\'t be allowed by a rule.'],
    ] as const) {
      await globalInput.fill(prefix)
      await section.getByTestId(testIds.allowlistAdd).click()
      await expect(globalError, prefix).toHaveAttribute('data-code', code)
      await expect(globalError, prefix).toHaveText(text)
    }
    await globalInput.fill(globalPrefix)
    await section.getByTestId(testIds.allowlistAdd).click()
    const globalRule = byTestId(section, testIds.allowlistRule, { 'data-value': globalPrefix })
    await expect(globalRule).toBeVisible()
    await expect.poll(() => rulesOf(api, null)).toContain(globalPrefix)
    await globalInput.fill(globalPrefix)
    await section.getByTestId(testIds.allowlistAdd).click()
    await expect(globalError).toHaveAttribute('data-code', 'conflict')
    await expect(globalError).toHaveText('This rule already exists.')

    // A reload keeps both lists; Remove takes the global rule away.
    await page.reload()
    await expect(byTestId(page.getByTestId(testIds.allowlistSection), testIds.allowlistRule, { 'data-value': globalPrefix })).toBeVisible()
    await expect(projectRow).toContainText('1 allowed command')
    await byTestId(page.getByTestId(testIds.allowlistSection), testIds.allowlistRule, { 'data-value': globalPrefix }).getByTestId(testIds.allowlistRuleRemove).click()
    await expect(byTestId(page.getByTestId(testIds.allowlistSection), testIds.allowlistRule, { 'data-value': globalPrefix })).toHaveCount(0)
    await expect.poll(() => rulesOf(api, null)).not.toContain(globalPrefix)
  })
})
