// Project trust (docs/UI.md 2.18, 7.33, 9.10, 9.13; ADR-049) with `mock:hooks` (docs/PROVIDERS.md 8 "Hook mocks (Phase
// 11)"). A fixture project holds the three kinds of executable items: a UserPromptSubmit hook in `.harness/settings.json`
// (`sh .harness/hooks/context.sh`, it adds the context `lint ok`), a stdio server in `.mcp.json` (the dependency-free
// fixture `mcp-min.mjs`, copied into the folder and run as `node tools/mcp-min.mjs --marker`, which writes
// `.mcp-started-<pid>` when it starts) and a project command whose body has a `` !`echo hi` `` line.
// - Nothing runs before it is approved: `context?` reads `Context: none`, `mcp?` `MCP tools: none` (no marker file), the
//   command is refused in the composer (`untrusted`); the chat header chip reads "3 to review".
// - The dialog (from the chip) approves the three items one checkbox at a time; then all three run.
// - A script changed on disk is pending again (`changed`, "Changed since you approved it.") and stops running at once
//   (verify-before-run); a change while the dialog is open makes Approve a 409 `stale` ("… changed while you were
//   reviewing …"); Revoke turns an approved item back into a New one.
// - The entry points: the chat project chip's menu, Settings -> Projects (the "{n} to review" badge and the row menu)
//   and the Customize Hooks tab ("Review {n}…").
// - Approving needs a fresh password (a password server of its own, the browser clock 11 minutes past the login).
// - Phase 12 (W12.14, docs/UI.md 7.34): a group with a command hook and a prompt hook (`data-type` command / prompt; the
//   prompt hook shows its prompt in the "Prompt" block and "Model: …"); one item selected makes the group's "Select all 2"
//   mixed (`aria-checked="mixed"`, the minus icon), a click selects both, another clears them; nothing is approved.
import type { Locator, Page } from '@playwright/test'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  approveProjectItems,
  byTestId,
  composer,
  composerRefusal,
  definitionFile,
  expect,
  expectMessageStatus,
  HarnessApi,
  HOOK_SCRIPT_TEXT,
  hookGroup,
  lastAssistantMessage,
  MOCK_HOOKS_MODEL,
  pendingTrustItems,
  projectSettings,
  projectTrust,
  REPO_ROOT,
  seedProjectChat,
  sendMessage,
  startPasswordServer,
  test,
  testIds,
  toastWith,
  trustItem,
  uniqueId,
  writeHookScript,
  writeProjectFile,
} from '../../helpers/index.ts'

/** The dependency-free stdio MCP fixture (Node built-ins only), copied into each project folder. */
const MCP_MIN_SOURCE = join(REPO_ROOT, 'apps/server/src/mcp/__fixtures__/mcp-min.mjs')
/** The `.mcp.json` name of the project's server (its harness id is the same). */
const MCP_SERVER = 'notes'
/** The tools of `mcp-min.mjs` as the project's chats get them (sorted). */
const MCP_TOOLS = ['echo', 'env', 'pid'].map(tool => `mcp__${MCP_SERVER}__${tool}`)

interface TrustProject {
  projectId: string
  projectName: string
  folder: string
  chatId: string
  command: string
}

/**
 * A project chat (`mock:hooks`) with three pending items: the UserPromptSubmit `context` hook, the `notes` stdio server
 * and the command `/<command>` whose body runs `echo hi`. Nothing is approved.
 */
async function seedTrustProject(api: HarnessApi, cleanup: Parameters<typeof seedProjectChat>[1]): Promise<TrustProject> {
  const command = uniqueId('say')
  const { project, folder, chatId } = await seedProjectChat(api, cleanup, {
    modelRef: MOCK_HOOKS_MODEL,
    prefix: 'trust',
    files: {
      'tools/mcp-min.mjs': await readFile(MCP_MIN_SOURCE, 'utf8'),
      '.mcp.json': `${JSON.stringify({ mcpServers: { [MCP_SERVER]: { command: 'node', args: ['tools/mcp-min.mjs', '--marker'] } } }, null, 2)}\n`,
      [`.harness/commands/${command}.md`]: definitionFile({ description: 'Says hi' }, 'Say: !`echo hi`\n'),
    },
  })
  const hook = await writeHookScript(folder.path, 'context')
  await writeProjectFile(folder.path, '.harness/settings.json', projectSettings({ UserPromptSubmit: [hookGroup(hook)] }))
  return { projectId: project.id, projectName: project.name, folder: folder.path, chatId, command }
}

/** Whether the MCP fixture ever started in the folder (`--marker` writes `.mcp-started-<pid>`). */
async function mcpStarted(folder: string): Promise<boolean> {
  return (await readdir(folder)).some(name => name.startsWith('.mcp-started-'))
}

/**
 * Sends a message from the composer, waits for the finished reply and returns its stored text (the page types a finished
 * reply out over a few frames, so a text check on the page could pass on a prefix).
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

/** The trust dialog, opened from the chat header chip. */
async function openTrustFromChip(page: Page, count: number): Promise<Locator> {
  const chip = page.getByTestId(testIds.projectTrustChip)
  await expect(chip).toHaveAttribute('data-count', String(count))
  await chip.click()
  const dialog = page.getByTestId(testIds.projectTrustDialog)
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('[data-slot="project-trust-loading"]')).toHaveCount(0)
  return dialog
}

test.describe('project trust', () => {
  test('three pending items never run; the chip opens the dialog, approving them one by one makes them run @smoke', async ({ page, api, cleanup }) => {
    const seeded = await seedTrustProject(api, cleanup)
    await page.goto(`/chat/${seeded.chatId}`)

    // The chip counts the pending items (named for screen readers).
    const chip = page.getByTestId(testIds.projectTrustChip)
    await expect(chip).toHaveAttribute('data-count', '3')
    await expect(chip).toHaveText('3 to review')
    await expect(chip).toHaveAccessibleName(`Review 3 items in ${seeded.projectName} that can run commands`)

    // Pending items never run: no hook context, no MCP tools (the server never started), the command is refused.
    expect(await ask(page, api, seeded.chatId, 'context?')).toBe('Context: none')
    expect(await ask(page, api, seeded.chatId, 'mcp?')).toBe('MCP tools: none')
    expect(await mcpStarted(seeded.folder), 'the MCP server never started').toBe(false)
    await sendMessage(page, `/${seeded.command} go`)
    const refusal = composerRefusal(page)
    await expect(refusal).toHaveAttribute('data-code', 'untrusted')
    await expect(refusal).toContainText(`/${seeded.command} runs shell lines you haven't approved.`)
    await expect(page.getByTestId(testIds.composerInput)).toHaveValue(`/${seeded.command} go`)
    await refusal.getByTestId(testIds.composerRefusalDismiss).click()
    await expect(refusal).toHaveCount(0)
    await page.getByTestId(testIds.composerInput).fill('')

    // The dialog: the warning, Needs review · 3, one group per kind, every item New with its exact command.
    const dialog = await openTrustFromChip(page, 3)
    await expect(dialog.getByRole('heading', { level: 2 })).toHaveText(`Review ${seeded.projectName}`)
    await expect(dialog.getByTestId(testIds.projectTrustWarning)).toContainText('Approve only what you would run yourself.')
    await expect(dialog.getByTestId(testIds.projectTrustFilter)).toHaveAttribute('data-value', 'pending')
    await expect(dialog.getByTestId(testIds.projectTrustFilter)).toContainText('Needs review · 3')
    await expect(dialog.getByTestId(testIds.projectTrustGroup)).toHaveCount(3)
    for (const kind of ['hook', 'mcp', 'command']) {
      const group = byTestId(dialog, testIds.projectTrustGroup, { 'data-kind': kind })
      await expect(group).toHaveAttribute('data-count', '1')
      await expect(trustItem(group, { 'data-kind': kind, 'data-state': 'new' })).toBeVisible()
    }
    const hookItem = trustItem(dialog, { 'data-kind': 'hook' })
    await expect(hookItem).toHaveAccessibleName('Hook sh .harness/hooks/context.sh, New')
    await expect(hookItem.locator('[data-slot="project-trust-command"]')).toHaveText('sh .harness/hooks/context.sh')
    await expect(hookItem.locator('[data-slot="project-trust-details"]')).toContainText('Runs .harness/hooks/context.sh')
    await expect(trustItem(dialog, { 'data-kind': 'mcp' }).locator('[data-slot="project-trust-command"]')).toHaveText('node tools/mcp-min.mjs --marker')
    await expect(trustItem(dialog, { 'data-kind': 'command' }).locator('[data-slot="project-trust-command"]')).toHaveText('echo hi')
    // The first pending item's checkbox has the focus; nothing is selected, so Approve is disabled.
    await expect(hookItem.getByTestId(testIds.projectTrustSelect)).toBeFocused()
    const approve = dialog.getByTestId(testIds.projectTrustApprove)
    await expect(approve).toBeDisabled()

    // One checkbox at a time (there is no "Approve all"), then Approve 3 items.
    for (const kind of ['hook', 'mcp', 'command'])
      await trustItem(dialog, { 'data-kind': kind }).getByTestId(testIds.projectTrustSelect).click()
    await expect(approve).toHaveAttribute('data-count', '3')
    await expect(approve).toHaveText('Approve 3 items')
    await expect(dialog).toContainText('3 selected')
    await approve.click()
    await expect(toastWith(page, `Approved 3 items in ${seeded.projectName}`)).toBeVisible()
    await expect(dialog.locator('[data-slot="project-trust-done"]')).toHaveText(`Everything in ${seeded.projectName} is approved.`)
    await expect(dialog.getByTestId(testIds.projectTrustFilter)).toContainText('Needs review · 0')
    await dialog.locator('[data-action="close"]').click()
    await expect(dialog).toBeHidden()
    await expect(chip).toHaveCount(0)
    expect((await pendingTrustItems(api, seeded.projectId)).length).toBe(0)

    // Approved, all three run: the hook's context, the server's tools, the command's shell line.
    expect(await ask(page, api, seeded.chatId, 'context?')).toBe(`Context: UserPromptSubmit:${HOOK_SCRIPT_TEXT.context}`)
    expect(await ask(page, api, seeded.chatId, 'mcp?')).toBe(`MCP tools: ${MCP_TOOLS.join(', ')}`)
    expect(await mcpStarted(seeded.folder), 'the MCP server started').toBe(true)
    expect(await ask(page, api, seeded.chatId, `/${seeded.command} go`)).toMatch(/^Hooks mock: Say: hi\s+go$/)
  })

  test('a changed script is pending again and stops running; a change during the review is a stale approval; Revoke @smoke', async ({ page, api, cleanup }) => {
    const seeded = await seedTrustProject(api, cleanup)
    await approveProjectItems(api, seeded.projectId)
    await page.goto(`/chat/${seeded.chatId}`)
    expect(await ask(page, api, seeded.chatId, 'context?')).toBe(`Context: UserPromptSubmit:${HOOK_SCRIPT_TEXT.context}`)
    await expect(page.getByTestId(testIds.projectTrustChip)).toHaveCount(0)

    // The script changes on disk: the hook's hash no longer matches, so it does not run (checked before every run) and
    // the chip shows it again.
    await writeHookScript(seeded.folder, 'context', { text: 'changed context' })
    // `context?` lists the hook blocks of the whole prompt: only the first turn's.
    expect(await ask(page, api, seeded.chatId, 'context?')).toBe(`Context: UserPromptSubmit:${HOOK_SCRIPT_TEXT.context}`)
    const dialog = await openTrustFromChip(page, 1)
    const changed = trustItem(dialog, { 'data-kind': 'hook', 'data-state': 'changed' })
    await expect(changed).toContainText('Changed since you approved it.')
    await expect(changed).toHaveAccessibleName('Hook sh .harness/hooks/context.sh, Changed')
    await expect(dialog.locator('[data-slot="project-trust-orphaned"]')).toHaveCount(0)

    // It changes again while the dialog is open: Approve is refused as stale, the list is fetched again.
    await changed.getByTestId(testIds.projectTrustSelect).click()
    const approve = dialog.getByTestId(testIds.projectTrustApprove)
    await expect(approve).toHaveText('Approve 1 item')
    await writeHookScript(seeded.folder, 'context', { text: 'changed again' })
    await approve.click()
    const error = dialog.getByTestId(testIds.projectTrustError)
    await expect(error).toHaveAttribute('data-code', 'conflict')
    await expect(error).toHaveText('1 item changed while you were reviewing. Check it again.')
    await expect(error).toBeFocused()
    await expect(approve).toBeDisabled()

    // The current version is approved now, and it runs with its new text.
    const current = trustItem(dialog, { 'data-kind': 'hook', 'data-state': 'changed' })
    await expect(current).toHaveAttribute('data-key', (await pendingTrustItems(api, seeded.projectId))[0]!.sha256)
    await current.getByTestId(testIds.projectTrustSelect).click()
    await approve.click()
    await expect(toastWith(page, `Approved 1 item in ${seeded.projectName}`)).toBeVisible()
    await expect(dialog.locator('[data-slot="project-trust-done"]')).toBeVisible()

    // Revoke (All): the item is New again and focus moves to its checkbox.
    await byTestId(dialog, testIds.projectTrustFilter).locator('[data-value="all"]').click()
    await expect(dialog.getByTestId(testIds.projectTrustFilter)).toHaveAttribute('data-value', 'all')
    const command = trustItem(dialog, { 'data-kind': 'command', 'data-state': 'approved' })
    await command.getByTestId(testIds.projectTrustRevoke).click()
    await expect(toastWith(page, `Revoked /${seeded.command}. It won't run until you approve it again.`)).toBeVisible()
    const revoked = trustItem(dialog, { 'data-kind': 'command', 'data-state': 'new' })
    await expect(revoked.getByTestId(testIds.projectTrustSelect)).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(page.getByTestId(testIds.projectTrustChip)).toHaveAttribute('data-count', '1')
    expect(await ask(page, api, seeded.chatId, 'context?')).toBe(`Context: UserPromptSubmit:${HOOK_SCRIPT_TEXT.context}; UserPromptSubmit:changed again`)
    const list = await projectTrust(api, seeded.projectId)
    expect(list.items.filter(item => item.state === 'pending').map(item => item.kind)).toEqual(['command'])
  })

  test('the entry points: the chat project chip menu, Settings -> Projects and the Customize Hooks tab', async ({ page, api, cleanup }) => {
    const seeded = await seedTrustProject(api, cleanup)
    // Only the hook stays pending.
    await approveProjectItems(api, seeded.projectId, item => item.kind !== 'hook')

    // The chat project chip's menu.
    await page.goto(`/chat/${seeded.chatId}`)
    await expect(page.getByTestId(testIds.projectTrustChip)).toHaveAttribute('data-count', '1')
    await page.getByTestId(testIds.chatProjectChip).click()
    await page.getByTestId(testIds.chatProjectTrust).click()
    let dialog = page.getByTestId(testIds.projectTrustDialog)
    await expect(trustItem(dialog, { 'data-kind': 'hook', 'data-state': 'new' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()

    // Settings -> Projects: the row's badge and its menu item.
    await page.goto('/settings/projects')
    const row = page.getByTestId(testIds.projectRow).filter({ hasText: seeded.projectName })
    const badge = row.getByTestId(testIds.projectTrustPending)
    await expect(badge).toHaveAttribute('data-count', '1')
    await expect(badge).toHaveText('1 to review')
    await row.getByTestId(testIds.projectRowMenu).click()
    await page.getByRole('menu').getByTestId(testIds.projectTrust).click()
    dialog = page.getByTestId(testIds.projectTrustDialog)
    await expect(dialog.getByRole('heading', { level: 2 })).toHaveText(`Review ${seeded.projectName}`)
    await expect(trustItem(dialog, { 'data-kind': 'hook', 'data-state': 'new' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()

    // Customize -> Hooks with the project: the section's "Review 1…" and the row's state.
    await page.goto(`/settings/customize?tab=hooks&project=${seeded.projectId}`)
    const section = byTestId(page, testIds.hooksSection, { 'data-source': 'project' })
    await expect(byTestId(section, testIds.hookRow, { 'data-source': 'project', 'data-state': 'pending' })).toBeVisible()
    const review = section.getByTestId(testIds.customizeTrustReview)
    await expect(review).toHaveAttribute('data-count', '1')
    await expect(review).toHaveText('Review 1…')
    await review.click()
    dialog = page.getByTestId(testIds.projectTrustDialog)
    const item = trustItem(dialog, { 'data-kind': 'hook', 'data-state': 'new' })
    await item.getByTestId(testIds.projectTrustSelect).click()
    await dialog.getByTestId(testIds.projectTrustApprove).click()
    await expect(toastWith(page, `Approved 1 item in ${seeded.projectName}`)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(byTestId(section, testIds.hookRow, { 'data-source': 'project', 'data-state': 'active' })).toBeVisible()
    await expect(section.getByTestId(testIds.customizeTrustReview)).toHaveCount(0)
  })

  test('approving needs a fresh password', async ({ page, cleanup }) => {
    const server = await startPasswordServer({ dedicated: true, label: 'hf-e2e-trust' })
    cleanup(() => server.stop())
    // Fake timers from the first document on, so the browser clock can pass the 10-minute fresh-auth window.
    await page.clock.install()
    const session = new HarnessApi(page.request, server.baseURL)
    await session.client.auth.login({ body: { password: server.password } })
    const seeded = await seedTrustProject(session, cleanup)

    await page.goto(`${server.baseURL}/chat/${seeded.chatId}`)
    const dialog = await openTrustFromChip(page, 3)
    await trustItem(dialog, { 'data-kind': 'hook' }).getByTestId(testIds.projectTrustSelect).click()
    await page.clock.fastForward('11:00')
    await dialog.getByTestId(testIds.projectTrustApprove).click()
    const prompt = page.getByTestId(testIds.confirmPasswordDialog)
    await expect(prompt).toBeVisible()
    await expect(prompt).toContainText('Approving project commands needs your password.')
    await prompt.getByTestId(testIds.confirmPasswordInput).fill(server.password)
    await prompt.getByTestId(testIds.confirmPasswordSubmit).click()
    await expect(prompt).toBeHidden()
    await expect(toastWith(page, `Approved 1 item in ${seeded.projectName}`)).toBeVisible()
    await expect(page.getByTestId(testIds.projectTrustChip)).toHaveAttribute('data-count', '2')
    expect((await pendingTrustItems(session, seeded.projectId)).map(item => item.kind).sort()).toEqual(['command', 'mcp'])
    await expect(composer(page)).toBeVisible()
  })

  test('Phase 12: a command and a prompt hook in one group; the mixed Select all @smoke', async ({ page, api, cleanup }) => {
    const { project, folder, chatId } = await seedProjectChat(api, cleanup, { modelRef: MOCK_HOOKS_MODEL, prefix: 'trust-mixed' })
    const hook = await writeHookScript(folder.path, 'context')
    const prompt = 'Check that the prompt names a ticket. $ARGUMENTS'
    await writeProjectFile(folder.path, '.harness/settings.json', `${JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: 'command', command: hook }] },
          { hooks: [{ type: 'prompt', prompt, model: 'mock:prompt-hook' }] },
        ],
      },
    }, null, 2)}\n`)
    await page.goto(`/chat/${chatId}`)
    const dialog = await openTrustFromChip(page, 2)
    const group = byTestId(dialog, testIds.projectTrustGroup, { 'data-kind': 'hook' })
    await expect(group).toHaveAttribute('data-count', '2')
    const commandItem = trustItem(group, { 'data-type': 'command' })
    const promptItem = trustItem(group, { 'data-type': 'prompt' })
    await expect(commandItem.locator('[data-slot="project-trust-command"]')).toHaveText(hook)
    await expect(promptItem.locator('[data-slot="project-trust-command"]')).toHaveAccessibleName('Prompt')
    await expect(promptItem.locator('[data-slot="project-trust-command"]')).toHaveText(prompt)
    await expect(promptItem).toContainText('Model: mock:prompt-hook')

    const selectAll = group.getByTestId(testIds.projectTrustSelectAll)
    await expect(group).toContainText('Select all 2')
    await expect(selectAll).toHaveAttribute('aria-checked', 'false')
    await commandItem.getByTestId(testIds.projectTrustSelect).click()
    await expect(selectAll).toHaveAttribute('aria-checked', 'mixed')
    await expect(selectAll).toHaveAttribute('data-state', 'indeterminate')
    await expect(selectAll.locator('[data-slot="project-trust-select-all-mixed"]')).toBeVisible()
    await expect(dialog.getByTestId(testIds.projectTrustApprove)).toHaveText('Approve 1 item')
    await selectAll.click()
    await expect(selectAll).toHaveAttribute('aria-checked', 'true')
    await expect(promptItem.getByTestId(testIds.projectTrustSelect)).toHaveAttribute('aria-checked', 'true')
    await expect(dialog.getByTestId(testIds.projectTrustApprove)).toHaveText('Approve 2 items')
    await selectAll.click()
    await expect(selectAll).toHaveAttribute('aria-checked', 'false')
    await expect(dialog.getByTestId(testIds.projectTrustApprove)).toBeDisabled()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    expect((await pendingTrustItems(api, project.id)).length, 'closing approves nothing').toBe(2)
  })
})
