// Workspace tools in a project chat (docs/UI.md 2.14, 7.3, 7.11, 7.19; docs/PROVIDERS.md 8; ADR-032, ADR-033) with
// `mock:workspace`, which writes `mock-workspace.txt` ("Hello from the mock agent."), edits it ("mock agent" ->
// "workspace agent") and runs `cat mock-workspace.txt`, then answers "Workspace done: Hello from the workspace agent.".
// - `ask`: the write card previews the new file and the edit card the diff; after Allow the edit row reads `+1 −1` and
//   expands to the diff; the shell card ("Run this command?") has no "Always allow" and its Run shows the terminal output
//   with exit code 0; the file on disk holds the edited text.
// - Accept edits (`edits`): the write and the edit run without a card, the shell still asks.
// - "Accept all edits in this chat" on the write card switches the chat to Accept edits: the edit then runs without a
//   card.
// - A share link with tool details shows the diff of the edit on the share page (the server has no password, which
//   only adds a warning to the Share dialog).
// - Phase 8 (W8.12): every row summary has its spoken label (`+1 −1` reads "1 line added, 1 removed"); with
//   `mock:checkpoint` the shell keeps its working folder between calls: the terminal output shows the folder before `$`
//   and "Now in mock-dir", and the next turn's approval cards say where the command runs ("In {project}/mock-dir",
//   then "mock-dir/mock-dir": the folder nests).
import type { Locator, Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  byTestId,
  composer,
  expect,
  expectMessageStatus,
  lastAssistantMessage,
  MOCK_CHECKPOINT_DIR,
  MOCK_CHECKPOINT_DONE,
  MOCK_CHECKPOINT_LS,
  MOCK_CHECKPOINT_MKDIR,
  MOCK_WORKSPACE_COMMAND,
  MOCK_WORKSPACE_DONE,
  MOCK_WORKSPACE_EDITED,
  MOCK_WORKSPACE_FILE,
  seedProject,
  selectPermissionMode,
  sendMessage,
  test,
  testIds,
  uniqueId,
} from '../../helpers/index.ts'

const MODEL = 'mock:workspace'
/** U+2212, the minus sign of the row summaries and diff stats (docs/UI.md 7.19). */
const MINUS = '−'

/** The tool row of a workspace tool in the last reply. */
function toolRow(page: Page, toolName: string): Locator {
  return byTestId(lastAssistantMessage(page), testIds.toolRow, { 'data-tool-name': toolName })
}

/** The approval card of a workspace tool in the last reply. */
function approvalCard(page: Page, toolName: string): Locator {
  return byTestId(lastAssistantMessage(page), testIds.toolApproval, { 'data-tool-name': toolName })
}

/** The expanded body of a tool row (its collapsible content follows the row inside the same tool part). */
function rowBody(row: Locator): Locator {
  return row.locator('xpath=ancestor::*[@data-slot="tool-part"][1]').getByTestId(testIds.toolRowOutput)
}

/** Opens a project chat (created through the API) with `mock:workspace` and sets the permission mode. */
async function openProjectChat(page: Page, chatId: string, mode: 'ask' | 'edits'): Promise<void> {
  await page.goto(`/chat/${chatId}`)
  await expect(page.getByTestId(testIds.chatProjectChip)).toBeVisible()
  await expect(composer(page).getByTestId(testIds.modelPickerTrigger)).toHaveAttribute('data-model-ref', MODEL)
  await selectPermissionMode(page, mode)
}

test.describe('workspace tools', () => {
  test('ask: the edit preview shows the diff, the row expands to it, the shell runs after Run @smoke', async ({ page, api, cleanup }) => {
    const { project, folder } = await seedProject(api, cleanup, { name: `Tools ${uniqueId('ask')}` })
    const chat = await api.createChat({ title: `Workspace ask ${uniqueId('chat')}`, projectId: project.id, modelRef: MODEL })
    cleanup(api => api.removeChat(chat.id))

    await openProjectChat(page, chat.id, 'ask')
    await sendMessage(page, 'Create the file, edit it and print it.')

    // 1. write_file: a content preview of the new file and "Accept all edits in this chat".
    const writeCard = approvalCard(page, 'write_file')
    await expect(writeCard).toBeVisible()
    await expect(writeCard).toContainText('Allow write_file?')
    const writePreview = writeCard.getByTestId(testIds.toolApprovalPreview)
    await expect(writePreview).toHaveAttribute('data-kind', 'content')
    await expect(writePreview).toContainText(`Create or overwrite ${MOCK_WORKSPACE_FILE} · 1 line`)
    await expect(writePreview).toContainText('Hello from the mock agent.')
    await expect(writeCard.getByTestId(testIds.toolApprovalAcceptEdits)).toHaveAttribute('data-state', 'unchecked')
    await expect(writeCard.getByTestId(testIds.toolApprovalAlways)).toHaveCount(0)
    await writeCard.getByTestId(testIds.toolApprovalAllow).click()
    await expect(toolRow(page, 'write_file')).toHaveAttribute('data-state', 'output-available')
    await expect(toolRow(page, 'write_file').getByTestId(testIds.toolRowSummary)).toHaveText('New · 1 line')
    // The visible summary is hidden from screen readers; its spoken label sits next to it.
    await expect(toolRow(page, 'write_file').getByTestId(testIds.toolRowSummary)).toHaveAttribute('aria-hidden', 'true')
    await expect(toolRow(page, 'write_file').getByText('New file, 1 line', { exact: true })).toBeAttached()

    // 2. edit_file: the preview is the diff of the old and the new string.
    const editCard = approvalCard(page, 'edit_file')
    await expect(editCard).toBeVisible()
    const editPreview = editCard.getByTestId(testIds.toolApprovalPreview)
    await expect(editPreview).toHaveAttribute('data-kind', 'diff')
    const previewDiff = editPreview.getByTestId(testIds.diffView)
    await expect(previewDiff).toHaveAttribute('data-path', MOCK_WORKSPACE_FILE)
    await expect(byTestId(previewDiff, testIds.diffLine, { 'data-kind': 'del' })).toHaveText(/mock agent/)
    await expect(byTestId(previewDiff, testIds.diffLine, { 'data-kind': 'add' })).toHaveText(/workspace agent/)
    await editCard.getByTestId(testIds.toolApprovalAllow).click()

    // The edit row reads +1 −1 and expands to the server's diff.
    const editRow = toolRow(page, 'edit_file')
    await expect(editRow).toHaveAttribute('data-state', 'output-available')
    const summary = editRow.getByTestId(testIds.toolRowSummary)
    await expect(summary).toHaveText(`+1 ${MINUS}1`)
    await expect(summary).toHaveAttribute('data-tone', 'success')
    await expect(editRow.getByText('1 line added, 1 removed', { exact: true })).toBeAttached()

    // 3. shell: "Run this command?" with the command, no "Always allow", Run instead of Allow.
    const shellCard = approvalCard(page, 'shell')
    await expect(shellCard).toBeVisible()
    await expect(shellCard).toContainText('Run this command?')
    await expect(shellCard).toHaveAccessibleName(`Approval needed: run ${MOCK_WORKSPACE_COMMAND}`)
    const command = shellCard.getByTestId(testIds.toolApprovalPreview)
    await expect(command).toHaveAttribute('data-kind', 'command')
    await expect(command).toContainText(MOCK_WORKSPACE_COMMAND)
    await expect(command).toContainText('Runs on the server with the server user\'s permissions.')
    await expect(shellCard.getByTestId(testIds.toolApprovalAlways)).toHaveCount(0)
    await expect(shellCard.getByTestId(testIds.toolApprovalAcceptEdits)).toHaveCount(0)
    const run = shellCard.getByTestId(testIds.toolApprovalAllow)
    await expect(run).toHaveText('Run')
    await run.click()

    const reply = lastAssistantMessage(page)
    await expect(reply).toContainText(MOCK_WORKSPACE_DONE)
    await expectMessageStatus(reply)
    const shellRow = toolRow(page, 'shell')
    await expect(shellRow).toHaveAttribute('data-state', 'output-available')
    await expect(shellRow.getByTestId(testIds.toolRowSummary)).toHaveText('exit 0')
    await expect(shellRow.getByText('Exit code 0', { exact: true })).toBeAttached()

    // Expanded rows: the diff of the edit, the terminal output of the shell.
    await editRow.getByRole('button').click()
    const diff = rowBody(editRow).getByTestId(testIds.diffView)
    await expect(diff).toBeVisible()
    await expect(diff).toHaveAttribute('data-path', MOCK_WORKSPACE_FILE)
    await expect(diff).toHaveAttribute('data-state', 'modified')
    await expect(byTestId(diff, testIds.diffLine, { 'data-kind': 'del' })).toHaveText(/Hello from the mock agent\./)
    await expect(byTestId(diff, testIds.diffLine, { 'data-kind': 'add' })).toHaveText(/Hello from the workspace agent\./)
    await expect(rowBody(editRow).getByTestId(testIds.toolRawToggle)).toHaveAttribute('data-state', 'closed')

    await shellRow.getByRole('button').click()
    const terminal = rowBody(shellRow).getByTestId(testIds.terminalOutput)
    await expect(terminal).toBeVisible()
    await expect(terminal).toHaveAttribute('data-status', 'ok')
    await expect(terminal.getByTestId(testIds.terminalCommand)).toHaveText(`$ ${MOCK_WORKSPACE_COMMAND}`)
    await expect(terminal.getByTestId(testIds.terminalStdout)).toHaveText('Hello from the workspace agent.')
    const exit = terminal.getByTestId(testIds.terminalExit)
    await expect(exit).toHaveText('Exit code 0')
    await expect(exit).toHaveAttribute('data-value', '0')

    // The file on disk holds the edited text; the run is stored as done.
    expect(await readFile(join(folder.path, MOCK_WORKSPACE_FILE), 'utf8')).toBe(MOCK_WORKSPACE_EDITED)
    await expect.poll(async () => (await api.getChat(chat.id)).pendingApproval).toBe(false)
  })

  test('Accept edits runs the write and the edit without asking; the shell still asks @smoke', async ({ page, api, cleanup }) => {
    const { project, folder } = await seedProject(api, cleanup, { name: `Tools ${uniqueId('edits')}` })
    const chat = await api.createChat({ title: `Workspace edits ${uniqueId('chat')}`, projectId: project.id, modelRef: MODEL })
    cleanup(api => api.removeChat(chat.id))

    await openProjectChat(page, chat.id, 'edits')
    await expect(composer(page).getByTestId(testIds.permissionMenuTrigger)).toHaveAccessibleName('Permission mode: Accept edits')
    await sendMessage(page, 'Go.')

    // The shell card comes first: the write and the edit already ran without a card.
    const shellCard = approvalCard(page, 'shell')
    await expect(shellCard).toBeVisible()
    await expect(approvalCard(page, 'write_file')).toHaveCount(0)
    await expect(approvalCard(page, 'edit_file')).toHaveCount(0)
    await expect(toolRow(page, 'write_file')).toHaveAttribute('data-state', 'output-available')
    await expect(toolRow(page, 'edit_file')).toHaveAttribute('data-state', 'output-available')
    await expect(toolRow(page, 'edit_file').getByTestId(testIds.toolRowSummary)).toHaveText(`+1 ${MINUS}1`)
    expect(await readFile(join(folder.path, MOCK_WORKSPACE_FILE), 'utf8')).toBe(MOCK_WORKSPACE_EDITED)
    await expect(shellCard.getByTestId(testIds.toolApprovalAlways)).toHaveCount(0)

    // Deny: the shell never runs and the model reports the denial.
    await shellCard.getByTestId(testIds.toolApprovalDeny).click()
    await expect(shellCard).toBeHidden()
    await expect(toolRow(page, 'shell')).toHaveAttribute('data-state', 'output-denied')
    await expect(toolRow(page, 'shell')).toContainText('Denied')
    await expect(lastAssistantMessage(page)).toContainText('The tool call was denied.')
    await expectMessageStatus(lastAssistantMessage(page))
  })

  test('"Accept all edits in this chat" switches the chat to Accept edits @smoke', async ({ page, api, cleanup }) => {
    const { project } = await seedProject(api, cleanup, { name: `Tools ${uniqueId('accept')}` })
    const chat = await api.createChat({ title: `Workspace accept ${uniqueId('chat')}`, projectId: project.id, modelRef: MODEL })
    cleanup(api => api.removeChat(chat.id))

    await openProjectChat(page, chat.id, 'ask')
    await sendMessage(page, 'Go.')
    const writeCard = approvalCard(page, 'write_file')
    await expect(writeCard).toBeVisible()
    const accept = writeCard.getByTestId(testIds.toolApprovalAcceptEdits)
    await accept.click()
    await expect(accept).toHaveAttribute('data-state', 'checked')
    await writeCard.getByTestId(testIds.toolApprovalAllow).click()

    // The chat now accepts edits: the composer shows it, the server stored it, and the edit runs without a card.
    const trigger = composer(page).getByTestId(testIds.permissionMenuTrigger)
    await expect(trigger).toHaveAttribute('data-value', 'edits')
    await expect.poll(async () => (await api.getChat(chat.id)).settings.toolMode).toBe('edits')
    const shellCard = approvalCard(page, 'shell')
    await expect(shellCard).toBeVisible()
    await expect(approvalCard(page, 'edit_file')).toHaveCount(0)
    await expect(toolRow(page, 'edit_file')).toHaveAttribute('data-state', 'output-available')
    await shellCard.getByTestId(testIds.toolApprovalAllow).click()
    await expect(lastAssistantMessage(page)).toContainText(MOCK_WORKSPACE_DONE)
    await expectMessageStatus(lastAssistantMessage(page))
  })

  test('a share link with tool details shows the diff of the edit @smoke', async ({ page, api, cleanup }) => {
    const { project } = await seedProject(api, cleanup, { name: `Tools ${uniqueId('share')}` })
    const chat = await api.createChat({ title: `Workspace share ${uniqueId('chat')}`, projectId: project.id, modelRef: MODEL })
    cleanup(api => api.removeChat(chat.id))
    // Auto mode runs the whole plan without a card.
    const { text } = await api.sendChat({ chatId: chat.id, modelRef: MODEL, toolMode: 'auto', text: 'Go.' })
    expect(text).toBe(MOCK_WORKSPACE_DONE)
    const share = await api.client.shares.create({ body: { chatId: chat.id, options: { toolDetails: true } } })

    await page.goto(share.path)
    await expect(page.getByTestId(testIds.sharePage)).toHaveAttribute('data-state', 'ready')
    const editRow = byTestId(page, testIds.shareToolRow, { 'data-tool-name': 'edit_file' })
    await expect(editRow).toHaveAttribute('data-status', 'done')
    await expect(editRow.getByTestId(testIds.toolRowSummary)).toHaveText(`+1 ${MINUS}1`)
    await expect(byTestId(page, testIds.shareToolRow, { 'data-tool-name': 'shell' }).getByTestId(testIds.toolRowSummary)).toHaveText('exit 0')
    await editRow.getByRole('button').first().click()
    const diff = editRow.getByTestId(testIds.diffView)
    await expect(diff).toBeVisible()
    await expect(diff).toHaveAttribute('data-path', MOCK_WORKSPACE_FILE)
    await expect(byTestId(diff, testIds.diffLine, { 'data-kind': 'add' })).toHaveText(/Hello from the workspace agent\./)
  })

  test('the shell keeps its working folder: the prompt, "Now in" and the next cards show it @smoke', async ({ page, api, cleanup }) => {
    const { project } = await seedProject(api, cleanup, { name: `Sticky ${uniqueId('cwd')}` })
    const chat = await api.createChat({ title: `Sticky folder ${uniqueId('chat')}`, projectId: project.id, modelRef: 'mock:checkpoint' })
    cleanup(api => api.removeChat(chat.id))
    expect((await api.sendChat({ chatId: chat.id, modelRef: 'mock:checkpoint', toolMode: 'auto', text: 'First turn.' })).text).toBe(MOCK_CHECKPOINT_DONE)

    await page.goto(`/chat/${chat.id}`)
    await expect(lastAssistantMessage(page)).toContainText(MOCK_CHECKPOINT_DONE)
    const shellRows = byTestId(lastAssistantMessage(page), testIds.toolRow, { 'data-tool-name': 'shell' })
    await expect(shellRows).toHaveCount(2)

    // The first command starts in the project folder (no folder before `$`) and ends in mock-dir.
    await shellRows.nth(0).getByRole('button').first().click()
    const mkdir = rowBody(shellRows.nth(0)).getByTestId(testIds.terminalOutput)
    await expect(mkdir.getByTestId(testIds.terminalCommand)).toHaveText(`$ ${MOCK_CHECKPOINT_MKDIR}`)
    await expect(mkdir.getByTestId(testIds.terminalCwd)).toHaveCount(0)
    const nowIn = mkdir.getByTestId(testIds.terminalCwdChange)
    await expect(nowIn).toHaveAttribute('data-value', MOCK_CHECKPOINT_DIR)
    await expect(nowIn).toHaveText(`Now in ${MOCK_CHECKPOINT_DIR}`)
    // The next one starts there: the prompt shows the folder.
    await shellRows.nth(1).getByRole('button').first().click()
    const ls = rowBody(shellRows.nth(1)).getByTestId(testIds.terminalOutput)
    const cwd = ls.getByTestId(testIds.terminalCwd)
    await expect(cwd).toHaveAttribute('data-value', MOCK_CHECKPOINT_DIR)
    await expect(cwd).toHaveText(MOCK_CHECKPOINT_DIR)
    await expect(ls.getByTestId(testIds.terminalCommand)).toHaveText(`${MOCK_CHECKPOINT_DIR} $ ${MOCK_CHECKPOINT_LS}`)
    await expect(ls.getByTestId(testIds.terminalCwdChange)).toHaveCount(0)

    // A second turn in Ask: the cards say where each command runs; the folder nests (mock-dir/mock-dir).
    await expect(composer(page).getByTestId(testIds.modelPickerTrigger)).toHaveAttribute('data-model-ref', 'mock:checkpoint')
    await selectPermissionMode(page, 'ask')
    await sendMessage(page, 'Second turn.')
    await approvalCard(page, 'write_file').getByTestId(testIds.toolApprovalAllow).click()
    const nested = `${MOCK_CHECKPOINT_DIR}/${MOCK_CHECKPOINT_DIR}`
    for (const [command, folder] of [[MOCK_CHECKPOINT_MKDIR, MOCK_CHECKPOINT_DIR], [MOCK_CHECKPOINT_LS, nested]] as const) {
      const card = approvalCard(page, 'shell')
      await expect(card).toHaveAccessibleName(`Approval needed: run ${command}`)
      await expect(card.locator('[data-slot="command-meta"]')).toHaveText(`In ${project.name}/${folder}`)
      await card.getByTestId(testIds.toolApprovalAllow).click()
      await expect(card).toBeHidden()
    }
    const reply = lastAssistantMessage(page)
    await expect(reply).toContainText(MOCK_CHECKPOINT_DONE)
    await expectMessageStatus(reply)
    const second = byTestId(reply, testIds.toolRow, { 'data-tool-name': 'shell' }).nth(0)
    await second.getByRole('button').first().click()
    const terminal = rowBody(second).getByTestId(testIds.terminalOutput)
    await expect(terminal.getByTestId(testIds.terminalCwd)).toHaveAttribute('data-value', MOCK_CHECKPOINT_DIR)
    await expect(terminal.getByTestId(testIds.terminalCwdChange)).toHaveAttribute('data-value', nested)
    await expect(terminal.getByTestId(testIds.terminalCwdChange)).toHaveText(`Now in ${nested}`)
  })
})
