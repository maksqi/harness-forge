// Hooks (docs/UI.md 2.18, 7.31, 9.13; ADR-048) with `mock:hooks` (docs/PROVIDERS.md 8 "Hook mocks (Phase 11)").
// - The Hooks tab on a password server of its own (`dedicated: true`: the "Run hooks" switch and personal hooks are
//   global state, so the shared server never sees them): New hook (the warning, PreToolUse by default, the matcher
//   preview with the Claude Code aliases, an unknown name, an invalid matcher), Save asks for the password 11 minutes
//   after the login (the browser clock moves forward) and the row shows. The hook blocks a `run` turn of a project chat
//   (its script lives in the project); "Run hooks" off makes the row "Off on this server" and the same turn runs, on
//   again blocks it; Turn off (no password) shows "Off"; Delete asks first, "Deleted hook", the empty state again and
//   focus on New hook.
// - The chat side on the shared server with approved project hooks (they run only in that project's chats): PreToolUse
//   exit 2 -> "Blocked by hook" in the row and the note "Blocked by a PreToolUse hook: nope" from a "Project hook";
//   `updatedInput` -> the rewritten badge, the row keeps the model's input, the note's details show the input the tool
//   ran with and the reply its output; `ask` in Auto -> the approval card's hook banner, Allow runs it; `allow` in Ask ->
//   `write_file` runs without a card (allowed badge). PostToolUse: `additionalContext` -> "Hook added context ·
//   PostToolUse" (Show context) and the agent reads it; exit 1 -> "A PostToolUse hook failed: exit 1" (Show output);
//   a hook that outlives its 1 s timeout -> "A PostToolUse hook timed out after 1s".
// - Phase 12 (W12.14, docs/UI.md 9.14; ADR-057): the editor's Event select lists the 13 events in order with their
//   descriptions; the Type toggle's Prompt works only for its seven events ("Prompt hooks work only for …", Save keeps
//   the editor open), a matcher-less event hides Tools, and a prompt-capable one clears the error. Nothing is saved.
import type { Locator, Page } from '@playwright/test'
import type { PasswordServer } from '../../helpers/index.ts'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { HOOK_EVENTS, PROMPT_HOOK_EVENTS } from '../../../packages/shared/src/index.ts'
import {
  byTestId,
  expect,
  expectMessageStatus,
  HarnessApi,
  HOOK_SCRIPT_TEXT,
  hookGroup,
  hookNote,
  hookRow,
  lastAssistantMessage,
  MOCK_HOOKS_MODEL,
  seedHookProjectChat,
  seedProject,
  selectPermissionMode,
  sendMessage,
  startPasswordServer,
  test,
  testIds,
  toastWith,
  toolRowHook,
  uniqueId,
  writeHookScript,
} from '../../helpers/index.ts'

/** The row of a tool call in a reply. */
function toolRow(reply: Locator, tool: string): Locator {
  return byTestId(reply, testIds.toolRow, { 'data-tool-name': tool })
}

/** The part around a tool row (its body holds the hook notes once expanded). */
function toolPart(row: Locator): Locator {
  return row.locator('xpath=ancestor::*[@data-slot="tool-part"][1]')
}

/** Expands a tool row and returns its part. */
async function expandRow(row: Locator): Promise<Locator> {
  await row.getByRole('button').first().click()
  const part = toolPart(row)
  await expect(part.getByTestId(testIds.toolRowOutput)).toBeVisible()
  return part
}

/** Sends one `mock:hooks` line and waits for the finished reply. */
async function turn(page: Page, text: string): Promise<Locator> {
  const before = await page.getByTestId(testIds.messageAssistant).count()
  await sendMessage(page, text)
  await expect(page.getByTestId(testIds.messageAssistant)).toHaveCount(before + 1)
  const reply = lastAssistantMessage(page)
  return reply
}

test.describe('hooks in the chat', () => {
  test('PreToolUse: exit 2 blocks, updatedInput rewrites, ask adds the card banner, allow skips the card @smoke', async ({ page, api, cleanup }) => {
    const { chatId, folder } = await seedHookProjectChat(api, cleanup, {
      prefix: 'hooks-pre',
      scripts: ['exit2', 'rewrite', 'ask', 'allow'],
      files: { 'secret.txt': 'secret\n' },
      hooks: commands => ({
        PreToolUse: [
          hookGroup(commands.exit2!, { matcher: 'Read' }),
          hookGroup(commands.rewrite!, { matcher: 'Bash' }),
          hookGroup(commands.ask!, { matcher: 'LS' }),
          hookGroup(commands.allow!, { matcher: 'Write' }),
        ],
      }),
    })
    await page.goto(`/chat/${chatId}`)
    await selectPermissionMode(page, 'auto')

    // updatedInput: the tool ran with the hook's input, the row keeps the model's.
    let reply = await turn(page, 'run echo original')
    await expectMessageStatus(reply, 'done')
    await expect(reply).toContainText('Called shell: ok')
    await expect(reply).toContainText('stdout: rewritten')
    let row = toolRow(reply, 'shell')
    await expect(toolRowHook(row, { 'data-value': 'rewritten' })).toBeVisible()
    await expect(row).toContainText(', input changed by hook')
    await expect(row).toContainText('"echo original"')
    let part = await expandRow(row)
    const rewritten = hookNote(part, { 'data-outcome': 'rewritten', 'data-variant': 'tool', 'data-event': 'PreToolUse', 'data-source': 'project' })
    await expect(rewritten.locator('[data-slot="hook-note-line"]')).toHaveText('Input changed by a PreToolUse hook')
    await expect(rewritten.locator('[data-slot="hook-note-source"]')).toHaveText('· Project hook')
    await rewritten.getByTestId(testIds.hookNoteToggle).click()
    await expect(rewritten.getByTestId(testIds.hookNoteToggle)).toHaveAttribute('data-state', 'open')
    await expect(rewritten.locator('[data-slot="hook-updated-input"]')).toContainText(HOOK_SCRIPT_TEXT.rewriteCommand)
    await expect(rewritten.locator('[data-slot="hook-source"]')).toContainText('Project hook')

    // exit 2: blocked, the reason in the note; "Blocked by hook" replaces "Denied".
    reply = await turn(page, 'call read_file {"path":"secret.txt"}')
    await expectMessageStatus(reply, 'done')
    await expect(reply).toContainText('Called read_file: denied')
    await expect(reply).toContainText(HOOK_SCRIPT_TEXT.exit2)
    row = toolRow(reply, 'read_file')
    await expect(row).toHaveAttribute('data-status', 'denied')
    await expect(toolRowHook(row, { 'data-value': 'denied' })).toContainText('Blocked by hook')
    await expect(row).not.toContainText('Denied')
    part = await expandRow(row)
    const denied = hookNote(part, { 'data-outcome': 'denied', 'data-variant': 'tool' })
    await expect(denied).toHaveAccessibleName(`Hook PreToolUse: Blocked by a PreToolUse hook: ${HOOK_SCRIPT_TEXT.exit2}`)
    await expect(denied.locator('[data-slot="hook-note-line"]')).toHaveText(`Blocked by a PreToolUse hook: ${HOOK_SCRIPT_TEXT.exit2}`)

    // ask (in Auto): the approval card carries the hook's banner; Allow runs the call.
    reply = await turn(page, 'call list_directory {"path":"."}')
    const card = byTestId(reply, testIds.toolApproval, { 'data-tool-name': 'list_directory' })
    await expect(card).toBeVisible()
    await expect(card.getByTestId(testIds.toolApprovalHook)).toHaveText(`A hook asks you to confirm this call: ${HOOK_SCRIPT_TEXT.ask}`)
    await card.getByTestId(testIds.toolApprovalAllow).click()
    await expect(card).toBeHidden()
    await expect(lastAssistantMessage(page)).toContainText('Called list_directory: ok')
    await expectMessageStatus(lastAssistantMessage(page), 'done')

    // allow (in Ask): write_file runs without a card.
    await selectPermissionMode(page, 'ask')
    reply = await turn(page, 'call write_file {"path":"allowed.txt","content":"allowed\\n"}')
    await expectMessageStatus(reply, 'done')
    await expect(reply).toContainText('Called write_file: ok')
    await expect(reply.getByTestId(testIds.toolApproval)).toHaveCount(0)
    row = toolRow(reply, 'write_file')
    await expect(toolRowHook(row, { 'data-value': 'allowed' })).toBeVisible()
    await expect(row).toContainText(', allowed by hook')
    expect(existsSync(join(folder.path, 'allowed.txt')), 'the allowed write ran').toBe(true)
  })

  test('PostToolUse: added context, a failed hook and a timed-out hook show as notes in the row @smoke', async ({ page, api, cleanup }) => {
    const { chatId } = await seedHookProjectChat(api, cleanup, {
      prefix: 'hooks-post',
      scripts: ['context', 'error', ['sleep', { seconds: 30 }]],
      files: { 'notes.txt': 'notes\n' },
      hooks: commands => ({
        PostToolUse: [
          hookGroup(commands.context!, { matcher: 'LS' }),
          hookGroup(commands.error!, { matcher: 'Read' }),
          hookGroup(commands.sleep!, { matcher: 'current_time', timeout: 1 }),
        ],
      }),
    })
    await page.goto(`/chat/${chatId}`)
    await selectPermissionMode(page, 'auto')

    // additionalContext: the agent reads it at its next step; the note opens to the context.
    let reply = await turn(page, 'call list_directory {"path":"."}')
    await expectMessageStatus(reply, 'done')
    await expect(reply).toContainText(`Called list_directory: ok`)
    await expect(reply).toContainText(`hooks: ${HOOK_SCRIPT_TEXT.context}`)
    let part = await expandRow(toolRow(reply, 'list_directory'))
    const context = hookNote(part, { 'data-outcome': 'context', 'data-event': 'PostToolUse', 'data-variant': 'tool' })
    await expect(context.locator('[data-slot="hook-note-line"]')).toHaveText('Hook added context · PostToolUse')
    const toggle = context.getByTestId(testIds.hookNoteToggle)
    await expect(toggle).toHaveText(/Show context/)
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await toggle.click()
    await expect(toggle).toHaveText(/Hide context/)
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(context.locator('[data-slot="hook-context"]')).toHaveText(HOOK_SCRIPT_TEXT.context)

    // exit 1: a non-blocking error; the call stays done.
    reply = await turn(page, 'call read_file {"path":"notes.txt"}')
    await expectMessageStatus(reply, 'done')
    await expect(reply).toContainText('Called read_file: ok')
    let row = toolRow(reply, 'read_file')
    await expect(row).toHaveAttribute('data-status', 'done')
    part = await expandRow(row)
    const failed = hookNote(part, { 'data-outcome': 'error', 'data-event': 'PostToolUse' })
    await expect(failed.locator('[data-slot="hook-note-line"]')).toHaveText('A PostToolUse hook failed: exit 1')
    await failed.getByTestId(testIds.hookNoteToggle).click()
    await expect(failed.locator('pre[data-slot="hook-output"]')).toContainText(HOOK_SCRIPT_TEXT.error)

    // A hook that outlives its timeout is killed and reported.
    reply = await turn(page, 'call current_time {}')
    await expectMessageStatus(reply, 'done', 20_000)
    await expect(reply).toContainText('Called current_time: ok')
    row = toolRow(reply, 'current_time')
    part = await expandRow(row)
    await expect(hookNote(part, { 'data-outcome': 'error' }).locator('[data-slot="hook-note-line"]')).toHaveText('A PostToolUse hook timed out after 1s')
  })
})

test.describe('the Hooks tab', () => {
  let server: PasswordServer | undefined

  test.beforeAll(async () => {
    server = await startPasswordServer({ dedicated: true, label: 'hf-e2e-hooks' })
  })

  test.afterAll(async () => {
    await server?.stop()
  })

  test('a personal hook: the editor, the password prompt, Run hooks off, Turn off and Delete @smoke', async ({ page, cleanup }) => {
    test.setTimeout(90_000)
    const { baseURL, password } = server!
    const marker = uniqueId('tab')
    // Fake timers from the first document on, so the browser clock can move past the 10-minute fresh login.
    await page.clock.install()
    const session = new HarnessApi(page.request, baseURL)
    await session.client.auth.login({ body: { password } })

    // A project whose folder holds the script; a chat in it to run turns through the API.
    const { project, folder } = await seedProject(session, cleanup, { prefix: 'hooks-tab' })
    const command = await writeHookScript(folder.path, 'exit2', { file: marker, text: `blocked ${marker}` })
    const chat = await session.createChat({ title: `Hooks ${marker}`, projectId: project.id, modelRef: MOCK_HOOKS_MODEL })
    const runTurn = async () => (await session.sendChat({ chatId: chat.id, text: 'run echo through', modelRef: MOCK_HOOKS_MODEL, toolMode: 'auto' })).text

    await page.goto(`${baseURL}/settings/customize?tab=hooks`)
    const panel = page.getByTestId(testIds.hooksPanel)
    await expect(panel).toBeVisible()
    await expect(byTestId(page, testIds.customizeTab, { 'data-value': 'hooks' })).toHaveAttribute('data-state', 'active')
    const runHooks = panel.getByTestId(testIds.hooksEnabled)
    await expect(runHooks).toHaveAttribute('data-state', 'checked')
    const personal = byTestId(panel, testIds.hooksSection, { 'data-source': 'personal' })
    await expect(personal).toHaveAttribute('data-count', '0')
    await expect(byTestId(personal, testIds.hooksEmpty, { 'data-source': 'personal' })).toBeVisible()

    // New hook: the warning, PreToolUse, the matcher preview.
    const newButton = page.getByTestId(testIds.customizeNew)
    await expect(newButton).toHaveAttribute('data-kind', 'hook')
    await expect(newButton).toHaveText('New hook')
    await newButton.click()
    const editor = page.getByTestId(testIds.hookEditor)
    await expect(editor).toHaveAttribute('data-mode', 'new')
    await expect(editor.getByTestId(testIds.hookWarning)).toContainText('Hooks run shell commands on your server')
    await expect(editor.getByTestId(testIds.hookEvent)).toHaveAttribute('data-value', 'PreToolUse')
    await expect(editor.getByTestId(testIds.hookEvent)).toBeFocused()
    const matcher = editor.getByTestId(testIds.hookMatcher)
    const preview = editor.getByTestId(testIds.hookMatcherPreview)
    await matcher.fill('Bash|Edit|Nope')
    await expect(preview).toContainText('shell (Bash)')
    await expect(preview).toContainText('edit_file (Edit)')
    await expect(preview).toContainText('No tool is named Nope now.')
    await expect(preview).toHaveAttribute('data-count', '2')
    await matcher.fill('^Bash')
    await expect(preview).toHaveText('Use tool names, | and * only.')
    await matcher.fill('Bash|Edit')
    await expect(preview).toHaveText(/^Matches (shell \(Bash\), edit_file \(Edit\)|edit_file \(Edit\), shell \(Bash\))$/)
    await editor.getByTestId(testIds.hookCommand).fill(command)
    await editor.getByTestId(testIds.hookTimeout).fill('30')

    // 11 minutes after the login, Save asks for the password first.
    await page.clock.fastForward('11:00')
    await editor.getByTestId(testIds.hookSave).click()
    const prompt = page.getByTestId(testIds.confirmPasswordDialog)
    await expect(prompt).toBeVisible()
    await expect(prompt).toContainText('Saving a hook needs your password.')
    await prompt.getByTestId(testIds.confirmPasswordInput).fill(password)
    await prompt.getByTestId(testIds.confirmPasswordSubmit).click()
    await expect(prompt).toBeHidden()
    await expect(toastWith(page, 'Hook saved')).toBeVisible()
    await expect(editor).toBeHidden()

    const row = hookRow(personal, { 'data-source': 'personal', 'data-event': 'PreToolUse', 'data-kind': 'command' })
    await expect(row).toHaveAttribute('data-state', 'active')
    await expect(personal).toHaveAttribute('data-count', '1')
    await expect(row.locator('[data-slot="hook-row-matcher"]')).toHaveText('Bash|Edit')
    await expect(row.locator('[data-slot="hook-row-command"]')).toHaveAttribute('title', command)
    await expect(row).toContainText('timeout 30s')
    const hookId = await row.getAttribute('data-hook-id')
    expect(hookId).toMatch(/^hok_/)

    // The hook blocks the project chat's shell call.
    expect(await runTurn()).toContain(`Called shell: denied | Blocked by hook: blocked ${marker}`)

    // Run hooks off: the row is off on this server and the call runs; on again blocks it.
    await runHooks.click()
    await expect(runHooks).toHaveAttribute('data-state', 'unchecked')
    await expect(row).toHaveAttribute('data-state', 'blocked')
    await expect(row.locator('[data-slot="hook-row-state"]')).toHaveText('Off on this server')
    await expect.poll(async () => (await session.getSettings()).hooksEnabled).toBe(false)
    expect(await runTurn()).toContain('Called shell: ok | Exit code: 0 stdout: through')
    await runHooks.click()
    await expect(runHooks).toHaveAttribute('data-state', 'checked')
    await expect(row).toHaveAttribute('data-state', 'active')
    expect(await runTurn()).toContain('Called shell: denied')

    // Turn off (no password): "Off".
    await row.getByTestId(testIds.hookRowMenu).click()
    const toggle = page.getByRole('menu').getByTestId(testIds.hookToggle)
    await expect(toggle).toHaveAttribute('data-state', 'on')
    await expect(toggle).toHaveText('Turn off')
    await toggle.click()
    await expect(row).toHaveAttribute('data-state', 'off')
    await expect(row.locator('[data-slot="hook-row-state"]')).toHaveText('Off')
    await expect(page.getByTestId(testIds.confirmPasswordDialog)).toHaveCount(0)
    expect(await runTurn()).toContain('Called shell: ok')

    // Delete asks first; the section is empty again and focus goes to New hook.
    await row.getByTestId(testIds.hookRowMenu).click()
    await page.getByRole('menu').getByTestId(testIds.hookDelete).click()
    const confirm = page.getByTestId(testIds.hookDeleteConfirm)
    await expect(confirm).toHaveText('Delete hook')
    await expect(page.getByRole('alertdialog')).toContainText('Delete this hook?')
    await expect(page.getByRole('alertdialog')).toContainText('It stops running at once.')
    await confirm.click()
    await expect(toastWith(page, 'Deleted hook')).toBeVisible()
    await expect(row).toHaveCount(0)
    await expect(byTestId(personal, testIds.hooksEmpty, { 'data-source': 'personal' })).toBeVisible()
    await expect(newButton).toBeFocused()
    expect((await session.client.hooks.list({ query: {} })).items.filter(item => item.source === 'personal')).toEqual([])
  })
})

test.describe('the hook editor (Phase 12)', () => {
  test('the 13 events with their descriptions; the Prompt type only for its seven events @smoke', async ({ page }) => {
    await page.goto('/settings/customize?tab=hooks')
    await expect(page.getByTestId(testIds.hooksPanel)).toBeVisible()
    await page.getByTestId(testIds.customizeNew).click()
    const editor = page.getByTestId(testIds.hookEditor)
    await expect(editor).toHaveAttribute('data-mode', 'new')
    const event = editor.getByTestId(testIds.hookEvent)
    await expect(event).toHaveAttribute('data-value', 'PreToolUse')

    // The Event select: every event in order, each with its description.
    await event.click()
    const options = page.getByRole('option')
    await expect(options).toHaveCount(HOOK_EVENTS.length)
    expect(await options.evaluateAll(items => items.map(item => item.getAttribute('data-value')))).toEqual([...HOOK_EVENTS])
    for (const name of ['PostToolUseFailure', 'PermissionRequest', 'SubagentStart', 'PostCompact', 'SessionEnd'])
      await expect(page.getByRole('option').and(page.locator(`[data-value="${name}"]`)).locator('.text-muted-foreground'), `${name} has a description`).toHaveText(/\w{3,}/)
    await page.getByRole('option').and(page.locator('[data-value="SessionEnd"]')).click()
    await expect(event).toHaveAttribute('data-value', 'SessionEnd')
    await expect(editor.getByTestId(testIds.hookMatcher)).toHaveCount(0)

    // Prompt on an event that takes none: the rule shows once a save is tried, and the editor stays open.
    await editor.getByTestId(testIds.hookType).locator('[data-value="prompt"]').click()
    await editor.getByTestId(testIds.hookPrompt).fill('Is the session done?')
    await editor.getByTestId(testIds.hookSave).click()
    const rule = editor.locator('[data-field="hook-event-error"]')
    await expect(rule).toHaveText(`Prompt hooks work only for ${PROMPT_HOOK_EVENTS.slice(0, -1).join(', ')} and ${PROMPT_HOOK_EVENTS.at(-1)}.`)
    await expect(editor).toBeVisible()

    // A prompt-capable event clears it; Cancel asks before the edits are dropped.
    await event.click()
    await page.getByRole('option').and(page.locator('[data-value="Stop"]')).click()
    await expect(event).toHaveAttribute('data-value', 'Stop')
    await expect(rule).toHaveCount(0)
    await editor.getByRole('button', { name: 'Cancel' }).click()
    await page.getByTestId(testIds.hookDiscardConfirm).click()
    await expect(editor).toBeHidden()
  })
})
