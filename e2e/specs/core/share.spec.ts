// Read-only share links (docs/UI.md 2.8, 2.9, 7.14, 7.15; docs/API.md 4.17, 5.20; ADR-025) on a password-protected
// server (`startPasswordServer`): "Share…" in the chat header menu opens the Share dialog, "Create link" adds a link,
// and a browser context without cookies (no session) opens its URL as the read-only transcript of the snapshot: the
// title and the messages, no sidebar, composer, message actions or version switchers. Revoking the link in the dialog
// makes a reload of that page show "This link is unavailable".
// Phase 8 (W8.12), parity of the share page with the chat: a `mock:checkpoint` run in Accept edits whose shell calls the
// project's rules allowed shows, with tool details, the same rule badges (`tool-row-rule`), spoken row labels and
// terminal output (the working folder before `$`, "Now in mock-dir", "Allowed by rule: …") as the chat itself.
// Phase 9 (W9.13, docs/UI.md 7.15, 7.25 – 7.27): a project chat with a steered `mock:steer` turn, a `mock:todo` turn, two
// `mock:subagent` sub-agents, an approved `mock:plan` plan and a `/compact` shows, with tool details, the steer as a user
// message between the two parts of its reply, the todo list ("3/3"), the sub-agents' steps and reports and the plan
// ("Approved · Accept edits"); the `/compact` exchange and its summary are left out.
import type { Locator, Page } from '@playwright/test'
import type { PasswordServer } from '../../helpers/index.ts'
import {
  assistantMessages,
  byTestId,
  createProject,
  expect,
  HarnessApi,
  MOCK_CHECKPOINT_DIR,
  MOCK_CHECKPOINT_DONE,
  MOCK_CHECKPOINT_LS,
  MOCK_CHECKPOINT_MKDIR,
  MOCK_PLAN_FILE,
  MOCK_SUBAGENT_TASKS,
  MOCK_TODO_DONE,
  mockPlanDone,
  mockSteerFinished,
  removeProject,
  seedWorkspaceFolder,
  sendMessage,
  startPasswordServer,
  test,
  testIds,
  uniqueId,
  useAgentSettings,
  waitForTestId,
} from '../../helpers/index.ts'

/** What a shell row shows, in the chat (`tool-row`) and on the share page (`share-tool-row`). */
interface ShellRowView {
  rule: string
  command: string
  cwd: string | null
  nowIn: string | null
}

/** Expands a shell row and checks its rule badge, spoken summary and terminal output. */
async function expectShellRow(row: Locator, body: Locator, view: ShellRowView): Promise<void> {
  await expect(row.getByTestId(testIds.toolRowRule).first()).toHaveAttribute('data-value', view.rule)
  await expect(row.getByText(`, allowed by rule ${view.rule}`).first()).toBeAttached()
  await expect(row.getByText('Exit code 0', { exact: true }).first()).toBeAttached()
  await row.getByRole('button').first().click()
  const terminal = body.getByTestId(testIds.terminalOutput)
  await expect(terminal).toBeVisible()
  await expect(terminal.getByTestId(testIds.terminalCommand)).toHaveText(`${view.cwd ? `${view.cwd} ` : ''}$ ${view.command}`)
  if (view.nowIn)
    await expect(terminal.getByTestId(testIds.terminalCwdChange)).toHaveText(`Now in ${view.nowIn}`)
  else
    await expect(terminal.getByTestId(testIds.terminalCwdChange)).toHaveCount(0)
  await expect(terminal.locator('[data-slot="terminal-rule"]')).toHaveText(`Allowed by rule: ${view.rule}`)
}

const SHELL_ROWS: readonly ShellRowView[] = [
  { rule: 'mkdir', command: MOCK_CHECKPOINT_MKDIR, cwd: null, nowIn: MOCK_CHECKPOINT_DIR },
  { rule: 'ls', command: MOCK_CHECKPOINT_LS, cwd: MOCK_CHECKPOINT_DIR, nowIn: null },
]

/** The shell rows of the chat page and their expanded bodies. */
function chatShellRows(page: Page): { row: (index: number) => Locator, body: (index: number) => Locator } {
  const rows = byTestId(assistantMessages(page).last(), testIds.toolRow, { 'data-tool-name': 'shell' })
  return {
    row: index => rows.nth(index),
    body: index => rows.nth(index).locator('xpath=ancestor::*[@data-slot="tool-part"][1]').getByTestId(testIds.toolRowOutput),
  }
}

/** `<origin>/share/<token>` with the token format of DECISIONS.md (`^[0-9A-Za-z]{16}[\w-]{22}$`). */
function shareUrlPattern(baseURL: string): RegExp {
  const origin = new URL(baseURL).origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${origin}/share/[0-9A-Za-z]{16}[\\w-]{22}$`)
}

test.describe('share', () => {
  let server: PasswordServer | undefined
  let owner: HarnessApi | undefined
  let chat: { id: string, title: string, turns: string[] } | undefined

  test.beforeAll(async () => {
    server = await startPasswordServer()
    owner = await HarnessApi.create(server.baseURL)
    await owner.client.auth.login({ body: { password: server.password } })
    const token = uniqueId('share')
    const created = await owner.createChat({ title: `Shared chat ${token}` })
    chat = { id: created.id, title: created.title ?? '', turns: [`Share first ${token}`, `Share second ${token}`] }
    for (const text of chat.turns)
      await owner.sendChat({ chatId: chat.id, text, modelRef: 'mock:echo' })
  })

  test.afterAll(async () => {
    // Deleting the chat also deletes its links (a server from E2E_AUTH_BASE_URL keeps running).
    if (owner && chat)
      await owner.removeChat(chat.id)
    await owner?.dispose()
    await server?.stop()
  })

  test('a link from the Share dialog opens the read-only transcript without a session until it is revoked @smoke', async ({ page, browser }) => {
    const { baseURL, password } = server!
    const { id: chatId, title, turns } = chat!
    await new HarnessApi(page.request, baseURL).client.auth.login({ body: { password } })
    await page.goto(`${baseURL}/chat/${chatId}`)
    await expect(page.getByTestId(testIds.chatTitle)).toHaveText(title)
    await expect(assistantMessages(page)).toHaveCount(turns.length)

    // "Share…" in the chat header menu opens the dialog of this chat. It has no link yet, so "Create link" has focus;
    // a password is set, so there is no "No password set" warning.
    await page.getByTestId(testIds.chatMenuTrigger).click()
    await page.getByTestId(testIds.chatMenuShare).click()
    const dialog = page.getByTestId(testIds.shareDialog)
    await expect(dialog).toBeVisible()
    await expect(dialog).toHaveAttribute('data-chat-id', chatId)
    const create = dialog.getByTestId(testIds.shareCreate)
    await expect(create).toBeFocused()
    await expect(dialog.getByTestId(testIds.shareLink)).toHaveCount(0)
    await expect(dialog.getByTestId(testIds.sharePasswordlessWarning)).toHaveCount(0)
    // A new link includes attachments, but neither reasoning nor tool details.
    const form = dialog.getByTestId(testIds.shareCreateForm)
    await expect(byTestId(form, testIds.shareOption, { 'data-value': 'attachments' })).toBeChecked()
    await expect(byTestId(form, testIds.shareOption, { 'data-value': 'reasoning' })).not.toBeChecked()
    await expect(byTestId(form, testIds.shareOption, { 'data-value': 'tool-details' })).not.toBeChecked()

    // "Create link": the new card shows the absolute URL, focused, for the snapshot of the whole chat.
    await create.click()
    const card = dialog.getByTestId(testIds.shareLink)
    await expect(card).toHaveCount(1)
    await expect(card).toHaveAttribute('data-share-id', /^shr_[0-9A-Za-z]{16}$/)
    await expect(card).toHaveAttribute('data-outdated', 'false')
    await expect(card).toHaveAttribute('data-expired', 'false')
    await expect(card).toContainText(`${turns.length * 2} messages`)
    const urlField = card.getByTestId(testIds.shareUrl)
    await expect(urlField).toBeFocused()
    await expect(urlField).toHaveValue(shareUrlPattern(baseURL))
    const url = await urlField.inputValue()

    // A browser without cookies opens the link: the read-only transcript of the snapshot, and nothing else of the app.
    const visitor = await browser.newContext()
    try {
      const guest = await visitor.newPage()
      await guest.goto(url)
      const sharePage = guest.getByTestId(testIds.sharePage)
      await expect(sharePage).toHaveAttribute('data-state', 'ready')
      await expect(guest.getByTestId(testIds.shareTitle)).toHaveText(title)
      await expect(guest.getByTestId(testIds.shareMeta)).toContainText('Read-only snapshot')
      const messages = guest.getByTestId(testIds.shareTranscript).getByTestId(testIds.shareMessage)
      await expect(messages).toHaveCount(turns.length * 2)
      for (const [index, text] of turns.entries()) {
        await expect(messages.nth(index * 2)).toHaveAttribute('data-role', 'user')
        await expect(messages.nth(index * 2)).toContainText(text)
        await expect(messages.nth(index * 2 + 1)).toHaveAttribute('data-role', 'assistant')
        await expect(messages.nth(index * 2 + 1)).toHaveAttribute('data-status', 'done')
        await expect(messages.nth(index * 2 + 1)).toContainText(text)
      }
      for (const id of [testIds.sidebar, testIds.composer, testIds.messageUser, testIds.messageAssistant, testIds.messageCopy, testIds.messageEdit, testIds.messageRegenerate, testIds.messageBranch])
        await expect(guest.getByTestId(id), `no ${id} on the share page`).toHaveCount(0)
      // The visitor has no session: the rest of the app still asks for the password.
      expect(await new HarnessApi(guest.request, baseURL).client.auth.status()).toMatchObject({ enabled: true, authenticated: false })

      // "Revoke…" in the dialog, then "Revoke": the card goes away.
      await card.getByTestId(testIds.shareRevoke).click()
      const confirm = page.getByTestId(testIds.shareRevokeConfirm)
      await expect(confirm).toBeVisible()
      await confirm.click()
      await expect(confirm).toBeHidden()
      await expect(dialog.getByTestId(testIds.shareLink)).toHaveCount(0)
      await expect(create).toBeFocused()

      // The visitor reloads: the link is unavailable, the transcript is gone.
      await guest.reload()
      await expect(sharePage).toHaveAttribute('data-state', 'unavailable')
      await expect(guest.getByTestId(testIds.shareUnavailable)).toContainText('This link is unavailable')
      await expect(guest.getByTestId(testIds.shareTranscript)).toHaveCount(0)
    }
    finally {
      await visitor.close()
    }
  })

  test('the share page shows the rule badges and the working folder like the chat @smoke', async ({ page, browser, cleanup }) => {
    const { baseURL, password } = server!
    const api = owner!
    // A project with the rules `mkdir` and `ls`: in Accept edits the whole `mock:checkpoint` plan runs without a card.
    // `mock-dir` exists beforehand: a `cd` needs no rule only into a folder that exists when the command is checked.
    const folder = await seedWorkspaceFolder(api, { prefix: 'share', files: { [`${MOCK_CHECKPOINT_DIR}/.keep`]: '' } })
    cleanup(() => folder.remove())
    const project = await createProject(api, { name: `Share parity ${uniqueId('share')}`, path: folder.path })
    cleanup(() => removeProject(api, project.id))
    for (const prefix of ['mkdir', 'ls'])
      await api.client.shellRules.create({ body: { projectId: project.id, prefix } })
    const parity = await api.createChat({ title: `Share parity ${uniqueId('chat')}`, projectId: project.id, modelRef: 'mock:checkpoint' })
    cleanup(() => api.removeChat(parity.id))
    const { text } = await api.sendChat({ chatId: parity.id, modelRef: 'mock:checkpoint', toolMode: 'edits', text: 'Write the checkpoint.' })
    expect(text).toBe(MOCK_CHECKPOINT_DONE)
    const share = await api.client.shares.create({ body: { chatId: parity.id, options: { toolDetails: true } } })

    // The chat.
    await new HarnessApi(page.request, baseURL).client.auth.login({ body: { password } })
    await page.goto(`${baseURL}/chat/${parity.id}`)
    await expect(assistantMessages(page).last()).toContainText(MOCK_CHECKPOINT_DONE)
    const chatRows = chatShellRows(page)
    for (const [index, view] of SHELL_ROWS.entries())
      await expectShellRow(chatRows.row(index), chatRows.body(index), view)
    const writeRow = byTestId(assistantMessages(page).last(), testIds.toolRow, { 'data-tool-name': 'write_file' })
    await expect(writeRow.getByTestId(testIds.toolRowSummary)).toHaveText('New · 1 line')
    await expect(writeRow.getByText('New file, 1 line', { exact: true })).toBeAttached()

    // The share page, in a browser without a session.
    const visitor = await browser.newContext()
    try {
      const guest = await visitor.newPage()
      await guest.goto(`${baseURL}${share.path}`)
      await expect(guest.getByTestId(testIds.sharePage)).toHaveAttribute('data-state', 'ready')
      const shellRows = byTestId(guest, testIds.shareToolRow, { 'data-tool-name': 'shell' })
      await expect(shellRows).toHaveCount(2)
      for (const [index, view] of SHELL_ROWS.entries())
        await expectShellRow(shellRows.nth(index), shellRows.nth(index).getByTestId(testIds.shareToolRowOutput), view)
      const shareWrite = byTestId(guest, testIds.shareToolRow, { 'data-tool-name': 'write_file' })
      await expect(shareWrite.getByTestId(testIds.toolRowSummary)).toHaveText('New · 1 line')
      await expect(shareWrite.getByText('New file, 1 line', { exact: true })).toBeAttached()
    }
    finally {
      await visitor.close()
    }
  })

  test('the share page shows steers as user messages and the agent tools, without the compaction @smoke', async ({ page, browser, cleanup }) => {
    test.setTimeout(90_000)
    const { baseURL } = server!
    const api = owner!
    await useAgentSettings(api, cleanup, { subagentModelRef: 'mock:subagent' })
    const folder = await seedWorkspaceFolder(api, { prefix: 'share-agent', files: { 'src/app.ts': 'export {}\n' } })
    cleanup(() => folder.remove())
    const project = await createProject(api, { name: `Share agent ${uniqueId('share')}`, path: folder.path })
    cleanup(() => removeProject(api, project.id))
    const chat = await api.createChat({ title: `Share agent ${uniqueId('chat')}`, projectId: project.id, modelRef: 'mock:steer' })
    cleanup(() => api.removeChat(chat.id))

    // A steered turn, from the chat page: a message sent once the first step ran reaches the model at the next step.
    const steer = `Use the vitest filter ${uniqueId('steer')}`
    await new HarnessApi(page.request, baseURL).client.auth.login({ body: { password: server!.password } })
    await page.goto(`${baseURL}/chat/${chat.id}`)
    await sendMessage(page, 'steps 3')
    await waitForTestId(page, testIds.toolRow, { 'data-tool-name': 'current_time' })
    await page.getByTestId(testIds.composerInput).fill(steer)
    await page.keyboard.press('Enter')
    await expect(assistantMessages(page).last().getByTestId(testIds.steerNote)).toContainText(steer)
    await expect(assistantMessages(page).last()).toContainText(mockSteerFinished(3, [steer]), { timeout: 15_000 })
    await expect(assistantMessages(page).last()).toHaveAttribute('data-status', 'done')
    expect((await api.sendChat({ chatId: chat.id, modelRef: 'mock:todo', toolMode: 'ask', text: 'Do the three tasks.' })).text).toContain(MOCK_TODO_DONE)
    await api.sendChat({ chatId: chat.id, modelRef: 'mock:subagent', toolMode: 'ask', text: 'Explore the project.' })
    await api.sendChat({ chatId: chat.id, modelRef: 'mock:plan', toolMode: 'plan', text: 'Plan the notes file.' })
    expect((await api.answerApprovals({ chatId: chat.id, approved: true, modelRef: 'mock:plan', toolMode: 'edits' })).text).toContain(mockPlanDone('edits'))
    await api.sendChat({ chatId: chat.id, modelRef: 'mock:compact', toolMode: 'ask', text: '/compact' })
    // `mock:compact` answers `seen?` with whether the model got the summary (an echo would repeat the summary).
    expect((await api.sendChat({ chatId: chat.id, modelRef: 'mock:compact', toolMode: 'ask', text: 'seen?' })).text).toContain('summary:yes')
    const detail = await api.getChat(chat.id)
    expect(detail.messages.flatMap(message => message.parts).some(part => part.type === 'data-compaction'), 'the chat holds the compaction').toBe(true)
    const share = await api.client.shares.create({ body: { chatId: chat.id, options: { toolDetails: true } } })

    const visitor = await browser.newContext()
    try {
      const guest = await visitor.newPage()
      await guest.goto(`${baseURL}${share.path}`)
      await expect(guest.getByTestId(testIds.sharePage)).toHaveAttribute('data-state', 'ready')
      const messages = guest.getByTestId(testIds.shareTranscript).getByTestId(testIds.shareMessage)

      // The steer is a user message between the two parts of its reply; `/compact` and its summary are gone.
      const roles = await messages.evaluateAll(items => items.map(item => item.getAttribute('data-role')))
      const texts = await messages.allTextContents()
      const steerAt = texts.findIndex((text, index) => roles[index] === 'user' && text.includes(steer))
      expect(steerAt, 'the steer is a user message').toBeGreaterThan(0)
      expect(roles[steerAt - 1]).toBe('assistant')
      expect(roles[steerAt + 1]).toBe('assistant')
      expect(texts[steerAt + 1]).toContain(`Steered: ${steer}.`)
      expect(texts.some((text, index) => roles[index] === 'user' && text.includes('/compact')), 'no /compact message').toBe(false)
      await expect(guest.getByTestId(testIds.shareTranscript)).not.toContainText('MOCK-SUMMARY')
      await expect(guest.getByTestId(testIds.compactionDivider)).toHaveCount(0)
      await expect(messages.last()).toContainText('summary:yes')

      // The todo list of the `mock:todo` reply: three rows, the last one "3/3", its body the finished list.
      const todoRows = byTestId(messages.filter({ hasText: MOCK_TODO_DONE }), testIds.shareToolRow, { 'data-tool-name': 'todo_write' })
      await expect(todoRows).toHaveCount(3)
      await expect(todoRows.last().getByTestId(testIds.toolRowSummary)).toHaveText('3/3')
      await todoRows.last().getByRole('button').first().click()
      const todos = todoRows.last().getByTestId(testIds.shareToolRowOutput).getByTestId(testIds.todoItem)
      await expect(todos).toHaveCount(3)
      await expect(todos.nth(2)).toHaveAttribute('data-status', 'completed')

      // The sub-agents: "Explore" with its description, its steps and its report.
      const taskRows = byTestId(guest, testIds.shareToolRow, { 'data-tool-name': 'task' })
      await expect(taskRows).toHaveCount(2)
      await expect(taskRows.first()).toContainText(`Explore${MOCK_SUBAGENT_TASKS[0].description}`)
      await taskRows.first().getByRole('button').first().click()
      const taskBody = taskRows.first().getByTestId(testIds.shareToolRowOutput)
      await expect(byTestId(taskBody, testIds.taskStep, { 'data-tool-name': 'list_directory' })).toHaveAttribute('data-state', 'done')
      await expect(taskBody.getByTestId(testIds.taskReport)).toContainText(`Report: ${MOCK_SUBAGENT_TASKS[0].prompt}`)

      // The approved plan and the write it allowed.
      const planRow = byTestId(guest, testIds.shareToolRow, { 'data-tool-name': 'exit_plan_mode' })
      await expect(planRow).toHaveCount(1)
      await expect(planRow).toContainText('Approved · Accept edits')
      await planRow.getByRole('button').first().click()
      await expect(planRow.getByTestId(testIds.shareToolRowOutput).locator('[data-slot="plan-body"]')).toContainText('Create notes.txt.')
      await expect(byTestId(guest, testIds.shareToolRow, { 'data-tool-name': 'write_file' })).toContainText(MOCK_PLAN_FILE)
    }
    finally {
      await visitor.close()
    }
  })
})
