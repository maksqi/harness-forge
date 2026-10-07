// Import from Claude Code (Phase 12, ADR-055; docs/UI.md 2.19, 6, 9.14; docs/API.md 4.35, 5.35) with a fake Claude Code
// home (`e2e/helpers/claude-home.ts`: agents, nested commands, a skill, an output style, `settings.json` with a command,
// a prompt and an http hook, Bash allow rules and a deny rule, `CLAUDE.md`, and `.claude.json` with a stdio and an http
// MCP server) written into a temp folder outside the repository. `GET /api/claude-import/home` is stubbed in the browser
// and the server-side scan is never triggered.
// - The entry points on the shared server: Customize's header action and Settings -> Data's link (`?import=claude`) open
//   the dialog on its source step; the scan option is off ("Scanning is turned off on this server (HF_CLAUDE_HOME=0).");
//   Continue waits for a source; Cancel closes the dialog and drops the query. Nothing is imported there.
// - The import on a password server of its own (everything it creates is global state): the folder upload (+ the
//   `.claude.json`) previews "Found 18 items" in groups with their statuses (New, Unsupported); unchecking one command
//   makes the Commands group's Select all mixed (`aria-checked="mixed"`), and checking it picks both again; the
//   executable items read "Imported turned off: …" with Turn on after import off; turning `deploy` on and filling
//   `DOCS_TOKEN`, Import 14 items asks for the password (the browser clock 11 minutes past the login: "Importing hooks and
//   commands that run on this server needs your password."); the result reads "Imported 14 items" with "1 command turned
//   off (it runs shell lines)" and "1 MCP server turned off". Open Customize shows the agents; the commands (`deploy`
//   on), the hooks (the command hook off, the prompt hook on), the MCP servers (stdio off) and the shell rules are there.
//   A re-import of the folder with the reviewer changed shows "Replaces yours" for it (Keep mine by default: not picked;
//   Replace picks it) and "Unchanged" for the rest (no checkbox); Escape asks "Discard this import?".
import type { Locator, Page } from '@playwright/test'
import {
  chooseClaudeFolder,
  claudeImportDialog,
  claudeImportEnable,
  claudeImportGroup,
  claudeImportItem,
  claudeImportStatus,
  continueToPreview,
  FAKE_HOME,
  fakeClaudeHomeTree,
  openClaudeImport,
  seedFakeClaudeHome,
} from '../../helpers/claude-home.ts'
import {
  byTestId,
  customizationRow,
  expect,
  HarnessApi,
  hookRow,
  startPasswordServer,
  stubClaudeHome,
  test,
  testIds,
} from '../../helpers/index.ts'

/** The Select all checkbox of a group. */
function selectAll(group: Locator): Locator {
  return group.getByTestId(testIds.claudeImportSelectAll)
}

/** The item checkbox (named "{kind} {name}"). */
function itemCheckbox(item: Locator): Locator {
  return item.getByTestId(testIds.claudeImportSelect)
}

async function expectStatus(scope: Locator, kind: Parameters<typeof claudeImportItem>[1], name: string, status: string): Promise<void> {
  await expect(claudeImportStatus(claudeImportItem(scope, kind, name)), `${kind} ${name}`).toHaveText(status)
}

/** The dialog's source step on Customize, opened through `?import=claude`. */
async function expectSourceStep(page: Page): Promise<Locator> {
  const dialog = claudeImportDialog(page)
  await expect(dialog).toHaveAttribute('data-step', 'source')
  await expect(dialog.locator('[data-slot="claude-import-step"]')).toHaveText('Step 1 of 3 · Choose what to read')
  await expect(dialog.locator('[data-slot="claude-import-step"]')).toBeFocused()
  const scan = dialog.getByTestId(testIds.claudeImportScan)
  await expect(scan).toHaveAttribute('data-state', 'disabled')
  await expect(scan).toHaveText('Scanning is turned off on this server (HF_CLAUDE_HOME=0).')
  await expect(byTestId(dialog, testIds.claudeImportSource, { 'data-value': 'server' })).toBeDisabled()
  await expect(dialog.getByTestId(testIds.claudeImportContinue)).toBeDisabled()
  return dialog
}

test.describe('import from Claude Code', () => {
  test('Customize and Settings -> Data open the dialog; the server scan is off; Cancel drops the query @smoke', async ({ page }) => {
    const home = await stubClaudeHome(page)

    await page.goto('/settings/customize')
    await page.getByTestId(testIds.customizeImportClaude).click()
    let dialog = await expectSourceStep(page)
    await expect(dialog).toContainText('Import from Claude Code')
    await expect(byTestId(dialog, testIds.claudeImportSource, { 'data-value': 'folder' })).toHaveAttribute('data-state', 'checked')
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toBeHidden()

    // Settings -> Data links to the same dialog (`/settings/customize?import=claude`); closing it removes the query.
    await page.goto('/settings/data')
    const link = page.getByTestId(testIds.dataImportClaude)
    await expect(link).toHaveText('Import from Claude Code…')
    await link.click()
    await expect(page).toHaveURL(/\/settings\/customize\?import=claude$/)
    dialog = await expectSourceStep(page)
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(page).toHaveURL(/\/settings\/customize$/)
    expect(home.count(), 'the dialog asked for the server home (stubbed)').toBeGreaterThanOrEqual(2)
    expect(home.scans(), 'no server-side scan').toBe(0)
  })

  test('a folder upload previews every group; the import asks for the password and turns executables off; a re-import shows Unchanged and Replaces yours @smoke', async ({ page, cleanup }) => {
    test.setTimeout(90_000)
    const server = await startPasswordServer({ dedicated: true, label: 'hf-e2e-claude-import' })
    cleanup(() => server.stop())
    const fake = await seedFakeClaudeHome(cleanup)
    const stub = await stubClaudeHome(page)
    // Fake timers from the first document on, so the browser clock can pass the 10-minute fresh-auth window.
    await page.clock.install()
    const session = new HarnessApi(page.request, server.baseURL)
    await session.client.auth.login({ body: { password: server.password } })

    // Step 1: the folder and `.claude.json`.
    const dialog = await openClaudeImport(page, server.baseURL)
    await chooseClaudeFolder(dialog, fake)
    await expect(dialog.locator('[data-slot="claude-import-picked"]')).toHaveText('8 files picked · .claude.json added')
    const preview = await continueToPreview(dialog)

    // Step 2: the groups in order, the statuses, the notes.
    await expect(dialog.locator('[data-slot="claude-import-step"]')).toHaveText('Step 2 of 3 · Choose what to import')
    await expect(preview).toHaveAttribute('data-count', String(FAKE_HOME.items))
    await expect(preview.getByRole('status').first()).toHaveText(`Found ${FAKE_HOME.items} items`)
    await expect(preview.getByTestId(testIds.claudeImportGroup)).toHaveCount(10)
    expect(await preview.getByTestId(testIds.claudeImportGroup).evaluateAll(groups => groups.map(group => group.getAttribute('data-kind')))).toEqual([
      'agent',
      'command',
      'skill',
      'style',
      'hook',
      'mcp-server',
      'shell-rule',
      'tool-deny',
      'instructions',
      'unsupported',
    ])
    for (const name of FAKE_HOME.agents)
      await expectStatus(preview, 'agent', name, 'New')
    await expect(claudeImportItem(preview, 'agent', 'reviewer')).toContainText('Claude model names use the model aliases of the settings.')
    await expectStatus(preview, 'hook', FAKE_HOME.hooks.http, 'Unsupported')
    const unsupported = claudeImportGroup(preview, 'unsupported')
    await expect(unsupported).toHaveAttribute('data-count', '4')
    await expect(selectAll(unsupported)).toHaveCount(0)
    await expect(unsupported.getByTestId(testIds.claudeImportSelect)).toHaveCount(0)
    await expect(claudeImportItem(preview, 'setting', 'statusLine')).toContainText('statusLine runs a command; harness-forge never runs it.')
    await expect(claudeImportItem(preview, 'shell-rule', 'git status')).toContainText('Becomes a prefix rule')
    const submit = dialog.getByTestId(testIds.claudeImportSubmit)
    await expect(submit).toHaveAttribute('data-count', String(FAKE_HOME.selectable))
    await expect(submit).toHaveText(`Import ${FAKE_HOME.selectable} items`)
    await expect(dialog.locator('[data-slot="claude-import-executables"]')).toHaveText('Includes 3 items that run commands on this server.')

    // The mixed group checkbox: one command unchecked, then Select all picks both again.
    const commands = claudeImportGroup(preview, 'command')
    await expect(commands.getByRole('heading')).toContainText('Commands · 2')
    await expect(selectAll(commands)).toHaveAttribute('aria-checked', 'true')
    await itemCheckbox(claudeImportItem(commands, 'command', 'frontend-component')).click()
    await expect(selectAll(commands)).toHaveAttribute('aria-checked', 'mixed')
    await expect(selectAll(commands)).toHaveAttribute('data-state', 'indeterminate')
    await expect(submit).toHaveText(`Import ${FAKE_HOME.selectable - 1} items`)
    await selectAll(commands).click()
    await expect(selectAll(commands)).toHaveAttribute('aria-checked', 'true')
    await expect(itemCheckbox(claudeImportItem(commands, 'command', 'frontend-component'))).toHaveAttribute('aria-checked', 'true')

    // Executable items: turned off by default; `deploy` is turned on; the http server gets its variable.
    const deploy = claudeImportItem(commands, 'command', 'deploy')
    await expect(deploy.locator('[data-slot="claude-import-turned-off"]')).toHaveText('Imported turned off: it runs shell lines.')
    await expect(claudeImportEnable(deploy)).toHaveAttribute('aria-checked', 'false')
    await claudeImportEnable(deploy).click()
    await expect(claudeImportEnable(deploy)).toHaveAttribute('aria-checked', 'true')
    const commandHook = claudeImportItem(preview, 'hook', FAKE_HOME.hooks.command)
    await expect(commandHook.locator('[data-slot="claude-import-turned-off"]')).toHaveText('Imported turned off: it runs shell lines.')
    await expect(claudeImportEnable(commandHook)).toHaveAttribute('aria-checked', 'false')
    await expect(claudeImportItem(preview, 'hook', FAKE_HOME.hooks.prompt).locator('[data-slot="claude-import-turned-off"]')).toHaveCount(0)
    const stdio = claudeImportItem(preview, 'mcp-server', FAKE_HOME.mcpServers.stdio)
    await expect(stdio.locator('[data-slot="claude-import-turned-off"]')).toHaveText('Imported turned off: it starts a program.')
    const http = claudeImportItem(preview, 'mcp-server', FAKE_HOME.mcpServers.http)
    await expect(http).toContainText(`Needs ${FAKE_HOME.mcpVariable}`)
    await http.locator(`[data-action="variable"][data-name="${FAKE_HOME.mcpVariable}"]`).fill('e2e-docs-token')
    await expect(byTestId(preview, testIds.claudeImportInstructionsMode)).toHaveAttribute('data-value', 'append')

    // Import: the login is 11 minutes old in the browser, so the password comes first.
    await page.clock.fastForward('11:00')
    await submit.click()
    const prompt = page.getByTestId(testIds.confirmPasswordDialog)
    await expect(prompt).toBeVisible()
    await expect(prompt).toContainText('Importing hooks and commands that run on this server needs your password.')
    await prompt.getByTestId(testIds.confirmPasswordInput).fill(server.password)
    await prompt.getByTestId(testIds.confirmPasswordSubmit).click()
    await expect(prompt).toBeHidden()

    // Step 3: the result lines.
    await expect(dialog).toHaveAttribute('data-step', 'result')
    const result = dialog.getByTestId(testIds.claudeImportResult)
    await expect(result).toHaveAttribute('data-count', String(FAKE_HOME.selectable))
    await expect(result.locator('[data-slot="claude-import-headline"]')).toHaveText(`Imported ${FAKE_HOME.selectable} items`)
    await expect(result.locator('[data-slot="claude-import-turned-off"]')).toHaveText(['1 command turned off (it runs shell lines)', '1 MCP server turned off'])
    await expect(dialog.locator('[data-action="open-mcp"]')).toBeVisible()

    // Open Customize: the Agents tab with the imported agents.
    await dialog.locator('[data-action="open-customize"]').click()
    await expect(dialog).toBeHidden()
    await expect(page).toHaveURL(/\/settings\/customize\?tab=agents$/)
    for (const name of FAKE_HOME.agents)
      await expect(customizationRow(page, { 'data-source': 'user', 'data-kind': 'agent', 'data-name': name })).toBeVisible()
    await expect(customizationRow(page, { 'data-source': 'user', 'data-name': 'reviewer' }).locator('[data-slot="customization-color-dot"]')).toHaveAttribute('data-value', 'green')

    // The commands (`deploy` was turned on), the hooks (the command hook off, the prompt hook on).
    await page.goto(`${server.baseURL}/settings/customize?tab=commands`)
    for (const name of FAKE_HOME.commands)
      await expect(customizationRow(page, { 'data-source': 'user', 'data-kind': 'command', 'data-name': name, 'data-state': 'active' })).toBeVisible()
    await page.goto(`${server.baseURL}/settings/customize?tab=hooks`)
    const personal = byTestId(page, testIds.hooksSection, { 'data-source': 'personal' })
    await expect(hookRow(personal, { 'data-event': 'PreToolUse', 'data-state': 'off' })).toBeVisible()
    await expect(hookRow(personal, { 'data-event': 'Stop', 'data-kind': 'prompt', 'data-state': 'active' })).toBeVisible()

    // The MCP servers (stdio off) and the shell rules.
    const servers = (await session.client.mcp.list()).items
    expect(servers.find(item => item.name === FAKE_HOME.mcpServers.stdio)).toMatchObject({ enabled: false })
    expect(servers.some(item => item.name === FAKE_HOME.mcpServers.http)).toBe(true)
    const rules = await session.client.shellRules.list()
    expect(rules.items.map(rule => rule.prefix).sort()).toEqual([...FAKE_HOME.shellRules].sort())

    // A re-import with the reviewer changed: "Replaces yours" (resolution Replace), the rest "Unchanged".
    await fake.writeClaudeFile('agents/reviewer.md', fakeClaudeHomeTree({ reviewerDescription: 'Reviews code and tests, again.' })['.claude/agents/reviewer.md'] as string)
    const again = await openClaudeImport(page, server.baseURL)
    await chooseClaudeFolder(again, fake)
    const second = await continueToPreview(again)
    const reviewer = claudeImportItem(second, 'agent', 'reviewer')
    await expect(claudeImportStatus(reviewer)).toHaveText('Replaces yours')
    // An update defaults to Keep mine (not picked); Replace picks it.
    const resolution = reviewer.getByTestId(testIds.claudeImportResolution)
    await expect(resolution).toHaveAttribute('data-value', 'skip')
    await expect(itemCheckbox(reviewer)).toHaveAttribute('aria-checked', 'false')
    await expect(again.getByTestId(testIds.claudeImportSubmit)).toBeDisabled()
    await resolution.selectOption('overwrite')
    await expect(resolution).toHaveAttribute('data-value', 'overwrite')
    await expect(itemCheckbox(reviewer)).toHaveAttribute('aria-checked', 'true')
    await expectStatus(second, 'agent', 'planner', 'Unchanged')
    await expect(claudeImportItem(second, 'agent', 'planner').getByTestId(testIds.claudeImportSelect)).toHaveCount(0)
    await expectStatus(second, 'command', 'frontend-component', 'Unchanged')
    await expectStatus(second, 'skill', 'pdf', 'Unchanged')
    await expectStatus(second, 'shell-rule', 'npm run test', 'Unchanged')
    await expect(again.getByTestId(testIds.claudeImportSubmit)).toHaveText('Import 1 item')
    await page.keyboard.press('Escape')
    const discard = page.getByRole('alertdialog').filter({ hasText: 'Discard this import?' })
    await expect(discard).toBeVisible()
    await discard.getByRole('button', { name: 'Discard' }).click()
    await expect(again).toBeHidden()
    expect(stub.scans(), 'no server-side scan').toBe(0)
  })
})
