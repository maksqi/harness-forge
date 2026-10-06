// Command extras (docs/UI.md 7.8, 7.28, 7.31, 7.33; ADR-052) with `mock:hooks`, which answers any other turn `Hooks mock:
// <user text>` (docs/PROVIDERS.md 8), so the expansion the model got is visible.
// - An approved project command with a `` !`cmd` `` line and an `@README.md` reference: the span's output and the file
//   are frozen into the expansion before the model call; after a reload the command badge's tooltip reads "Ran 1 shell
//   command" and "Included README.md"; a regenerate reuses the frozen expansion (the span's script counts its runs in a
//   file: still one run).
// - An unapproved project command: "Needs approval" in the slash menu; sending it is refused in the composer (`untrusted`,
//   the text stays, nothing is stored) with Review…, which opens the trust dialog on the command; once approved the same
//   text runs.
// - With the shell off (`HF_WORKSPACE_SHELL=0`, a server of its own) a command with `!` lines is refused (409 `disabled`,
//   the transcript's request error with the server's message, not a composer refusal) and nothing is stored.
// - An approved command in a project whose UserPromptSubmit hook blocks: the prompt hooks run before the command's `!`
//   lines, so the refusal comes without a run of the span.
import type { Locator, Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  approveProjectItems,
  assistantMessages,
  byTestId,
  composerRefusal,
  definitionFile,
  expect,
  expectMessageStatus,
  HarnessApi,
  HOOK_SCRIPT_TEXT,
  hookGroup,
  lastAssistantMessage,
  MOCK_HOOKS_MODEL,
  seedHookProjectChat,
  seedProjectChat,
  sendMessage,
  startServer,
  test,
  testIds,
  toastWith,
  trustItem,
  uniqueId,
  userMessages,
} from '../../helpers/index.ts'

/** A script that counts its runs in `.span-count` and prints the count. */
const COUNT_SCRIPT = 'echo run >> .span-count\nwc -l < .span-count | tr -d \' \'\n'

/** The stored text of the chat's last message (the page types a finished reply out over a few frames). */
async function lastStoredText(api: HarnessApi, chatId: string): Promise<string> {
  const last = (await api.getChat(chatId)).messages.at(-1)
  expect(last?.role).toBe('assistant')
  return (last?.parts ?? []).map(part => (part.type === 'text' ? part.text : '')).join('')
}

/** Sends from the composer and waits for the new reply to finish. */
async function send(page: Page, text: string): Promise<Locator> {
  const count = await assistantMessages(page).count()
  await sendMessage(page, text)
  await expect(assistantMessages(page)).toHaveCount(count + 1)
  const reply = lastAssistantMessage(page)
  await expectMessageStatus(reply, 'done')
  return reply
}

/** How often the count script ran. */
async function spanRuns(folder: string): Promise<number> {
  try {
    return (await readFile(join(folder, '.span-count'), 'utf8')).split('\n').filter(line => line !== '').length
  }
  catch {
    return 0
  }
}

test.describe('command shell lines and file references', () => {
  test('`!` output and @README.md are frozen into the expansion; the badge names them; a regenerate reuses them @smoke', async ({ page, api, cleanup }) => {
    const command = uniqueId('status')
    const marker = uniqueId('readme')
    const { project, folder, chatId } = await seedProjectChat(api, cleanup, {
      modelRef: MOCK_HOOKS_MODEL,
      prefix: 'cmd-shell',
      files: {
        'README.md': `# Demo\n\n${marker}\n`,
        '.harness/scripts/count.sh': COUNT_SCRIPT,
        [`.harness/commands/${command}.md`]: definitionFile({ description: 'Shows the status' }, 'Count: !`sh .harness/scripts/count.sh`\nRead @README.md\n'),
      },
    })
    const list = await approveProjectItems(api, project.id, item => item.kind === 'command')
    expect(list.items.find(item => item.kind === 'command')?.refs.map(ref => ref.path)).toEqual(['.harness/scripts/count.sh'])

    await page.goto(`/chat/${chatId}`)
    await expect(await send(page, `/${command} now`)).toContainText('Hooks mock: Count: 1')
    const text = await lastStoredText(api, chatId)
    expect(text).toContain('Hooks mock: Count: 1\nRead @README.md')
    expect(text).toContain(`<file path="README.md">\n# Demo\n\n${marker}\n</file>`)
    expect(await spanRuns(folder.path)).toBe(1)
    // The bubble keeps the typed text.
    await expect(userMessages(page).last()).toContainText(`/${command} now`)
    await expect(userMessages(page).last()).not.toContainText(marker)

    // The badge comes with the stored message: after a reload, its tooltip names what was inlined.
    await page.reload()
    const badge = userMessages(page).first().locator('[data-slot="command-badge"]')
    await expect(badge).toContainText(`/${command}`)
    await badge.focus()
    await expect(page.locator('[data-slot="command-badge-inlined"]')).toHaveText(['Ran 1 shell command', 'Included README.md'])
    await expect(badge).toHaveAccessibleName(`Command /${command}, Project command, Ran 1 shell command, Included README.md`)
    await page.keyboard.press('Escape')

    // A regenerate reuses the frozen expansion: the same text, the script did not run again.
    const reply = lastAssistantMessage(page)
    await expectMessageStatus(reply, 'done')
    const firstReplyId = (await api.getChat(chatId)).messages.at(-1)?.id
    await reply.getByTestId(testIds.messageRegenerate).click()
    await expect(byTestId(lastAssistantMessage(page), testIds.messageBranch)).toHaveAttribute('data-count', '2')
    await expectMessageStatus(lastAssistantMessage(page), 'done')
    await expect.poll(async () => (await api.getChat(chatId)).messages.at(-1)?.id, { message: 'the regenerated reply is stored' }).not.toBe(firstReplyId)
    expect(await lastStoredText(api, chatId)).toBe(text)
    expect(await spanRuns(folder.path)).toBe(1)
  })

  test('an unapproved command is refused in the composer; Review… approves it and the same text runs @smoke', async ({ page, api, cleanup }) => {
    const command = uniqueId('hello')
    const { project, chatId } = await seedProjectChat(api, cleanup, {
      modelRef: MOCK_HOOKS_MODEL,
      prefix: 'cmd-trust',
      files: { [`.harness/commands/${command}.md`]: definitionFile({ description: 'Says hi' }, 'Say: !`echo hi`\n') },
    })
    await page.goto(`/chat/${chatId}`)
    const input = page.getByTestId(testIds.composerInput)
    await expect(input).toBeEditable()

    // The slash menu marks it.
    await input.fill(`/${command}`)
    const row = byTestId(page.getByTestId(testIds.slashMenu), testIds.slashMenuItem, { 'data-value': command, 'data-group': 'project' })
    await expect(row).toHaveAttribute('data-trust', 'pending')
    await expect(row.locator('[data-slot="slash-menu-trust"]')).toHaveText('Needs approval')
    await expect(row).toHaveAccessibleName(/, needs approval$/)

    // Sending is refused before anything is stored; the text stays in the composer.
    await sendMessage(page, `/${command} go`)
    const refusal = composerRefusal(page)
    await expect(refusal).toHaveAttribute('data-code', 'untrusted')
    await expect(refusal).toContainText(`/${command} runs shell lines you haven't approved.`)
    await expect(input).toHaveValue(`/${command} go`)
    await expect(input).toBeFocused()
    await expect(userMessages(page)).toHaveCount(0)
    expect((await api.getChat(chatId)).messages).toHaveLength(0)

    // Review… opens the trust dialog on the command's item.
    await refusal.getByTestId(testIds.composerRefusalReview).click()
    const dialog = page.getByTestId(testIds.projectTrustDialog)
    const item = trustItem(dialog, { 'data-kind': 'command', 'data-state': 'new' })
    await expect(item.getByTestId(testIds.projectTrustSelect)).toBeFocused()
    await expect(item.locator('[data-slot="project-trust-command"]')).toHaveText('echo hi')
    await item.getByTestId(testIds.projectTrustSelect).click()
    await dialog.getByTestId(testIds.projectTrustApprove).click()
    await expect(toastWith(page, `Approved 1 item in ${project.name}`)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()

    // The same text runs now; the refusal is gone.
    const count = await assistantMessages(page).count()
    await page.getByTestId(testIds.composerSend).click()
    await expect(assistantMessages(page)).toHaveCount(count + 1)
    await expectMessageStatus(lastAssistantMessage(page), 'done')
    await expect(refusal).toHaveCount(0)
    await expect.poll(() => lastStoredText(api, chatId)).toMatch(/^Hooks mock: Say: hi\s+go$/)
  })

  test('with the shell turned off a command with shell lines is refused', async ({ page, cleanup }) => {
    const server = await startServer({ env: { HF_WORKSPACE_SHELL: '0' }, label: 'hf-e2e-shell-off' })
    cleanup(() => server.stop())
    const owner = new HarnessApi(page.request, server.baseURL)
    const command = uniqueId('hello')
    const { chatId } = await seedProjectChat(owner, cleanup, {
      modelRef: MOCK_HOOKS_MODEL,
      prefix: 'cmd-off',
      files: { [`.harness/commands/${command}.md`]: definitionFile({ description: 'Says hi' }, 'Say: !`echo hi`\n') },
    })
    await page.goto(`${server.baseURL}/chat/${chatId}`)
    await sendMessage(page, `/${command} go`)
    // Not a composer refusal: the request error of the transcript (the v1.6 handling of a 409) with the server's text.
    await expect(page.getByTestId(testIds.chatError)).toContainText(`The /${command} command runs shell lines, but shell commands are turned off on this server (HF_WORKSPACE_SHELL=0).`)
    await expect(composerRefusal(page)).toHaveCount(0)
    // Nothing was stored: a reload shows an empty chat.
    expect((await owner.getChat(chatId)).messages).toHaveLength(0)
    await page.reload()
    await expect(page.getByTestId(testIds.composerInput)).toBeEditable()
    await expect(userMessages(page)).toHaveCount(0)
  })

  // Prompt hooks run before a command file's `!` spans (W11.17): a blocked prompt runs no shell line.
  test('a blocking UserPromptSubmit hook refuses a command before its shell lines run', async ({ page, api, cleanup }) => {
    const command = uniqueId('count')
    const { chatId, folder, project } = await seedHookProjectChat(api, cleanup, {
      prefix: 'cmd-prompt',
      scripts: ['prompt-block'],
      hooks: commands => ({ UserPromptSubmit: [hookGroup(commands['prompt-block']!)] }),
      files: {
        '.harness/scripts/count.sh': COUNT_SCRIPT,
        [`.harness/commands/${command}.md`]: definitionFile({ description: 'Counts' }, 'Count: !`sh .harness/scripts/count.sh`\n'),
      },
    })
    await approveProjectItems(api, project.id, item => item.kind === 'command')
    await page.goto(`/chat/${chatId}`)
    await sendMessage(page, `/${command} now`)
    await expect(composerRefusal(page)).toHaveAttribute('data-code', 'hook-blocked')
    await expect(composerRefusal(page)).toContainText(HOOK_SCRIPT_TEXT.promptBlock)
    expect((await api.getChat(chatId)).messages).toHaveLength(0)
    // The prompt hooks run before the command's `!` lines: a blocked prompt runs nothing.
    expect(await spanRuns(folder.path), 'the span never ran').toBe(0)
  })
})
