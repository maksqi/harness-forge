// File mentions (docs/UI.md 2.16, 7.26, 12; ADR-042): `@` in the composer of a project chat searches the project's
// files (`GET /api/projects/:id/files?q=`); picking a file keeps `@path` in the text and attaches a snapshot of the file
// as a project chip (`composer-attachment` `data-kind="project"`), which `mock:echo` then sees inlined.
// - `@pars` + Enter: the highlighted match, the inserted mention, a chip that finished uploading, the echo of the file.
// - A folder drills down (`@src/`, the menu stays open on it); Esc closes the menu first and keeps the text; "Mention a
//   file" in the `+` menu inserts `@`; `a@b` searches nothing; a chat without a project never opens the menu.
// - A project folder that is gone: the menu's error state "The project folder is unavailable."
import type { Page } from '@playwright/test'
import {
  byTestId,
  composer,
  expect,
  expectMessageStatus,
  lastAssistantMessage,
  openNewChat,
  recordRequests,
  seedProjectChat,
  test,
  testIds,
  userMessages,
} from '../../helpers/index.ts'

const FILES = {
  'src/parser.ts': 'export const parse = 1\n',
  'src/lexer.ts': 'export const lex = 1\n',
  'README.md': '# Mentions demo\n',
}

function composerInput(page: Page) {
  return page.getByTestId(testIds.composerInput)
}

function mentionMenu(page: Page) {
  return page.getByTestId(testIds.mentionMenu)
}

/** The decoded `q` values of the mention searches a page sent. */
function searchQueries(log: Awaited<ReturnType<typeof recordRequests>>): string[] {
  return log.requests.map(request => new URLSearchParams(request.query).get('q') ?? '')
}

test.describe('file mentions', () => {
  test('@pars + Enter inserts the mention and attaches the file as a project chip @smoke', async ({ page, api, cleanup }) => {
    const { chatId, project } = await seedProjectChat(api, cleanup, { modelRef: 'mock:echo', prefix: 'mentions', files: FILES })
    await page.goto(`/chat/${chatId}`)
    const input = composerInput(page)
    await input.click()
    await page.keyboard.type('Fix @pars')

    const menu = mentionMenu(page)
    await expect(menu).toHaveAttribute('data-state', 'ready')
    await expect(menu).toContainText(`Files in ${project.name}`)
    const first = menu.getByTestId(testIds.mentionMenuItem).first()
    await expect(first).toHaveAttribute('data-path', 'src/parser.ts')
    await expect(first).toHaveAttribute('data-kind', 'file')
    await expect(first).toHaveAttribute('aria-selected', 'true')
    await expect(first.locator('[data-slot="mention-highlight"]').first()).toHaveText('pars')
    await expect(input).toBeFocused()

    // Enter picks it: the mention and a blank replace the token, a project chip uploads the file.
    await page.keyboard.press('Enter')
    await expect(menu).toHaveCount(0)
    await expect(input).toHaveValue('Fix @src/parser.ts ')
    const chip = byTestId(composer(page), testIds.composerAttachment, { 'data-kind': 'project', 'data-path': 'src/parser.ts' })
    await expect(chip).toHaveAttribute('data-state', 'done')
    await expect(chip).toContainText('parser.ts')

    // Sent like an upload: the user message keeps the text and the file, the echo sees the file's content.
    await page.keyboard.press('Enter')
    await expect(userMessages(page).last()).toContainText('Fix @src/parser.ts')
    const reply = lastAssistantMessage(page)
    await expectMessageStatus(reply, 'done')
    await expect(reply).toContainText('export const parse = 1')
    await expect(composer(page).getByTestId(testIds.composerAttachment)).toHaveCount(0)
  })

  test('a folder drills down, Esc closes the menu first, a@b and chats without a project search nothing @smoke', async ({ page, api, cleanup }) => {
    const { chatId, project } = await seedProjectChat(api, cleanup, { modelRef: 'mock:echo', prefix: 'mentions', files: FILES })
    await page.goto(`/chat/${chatId}`)
    const input = composerInput(page)
    const menu = mentionMenu(page)
    await input.click()

    // "Mention a file" in the + menu inserts `@` and opens the menu on the whole project.
    await composer(page).getByTestId(testIds.composerAdd).click()
    await page.getByTestId(testIds.composerMention).click()
    await expect(input).toHaveValue('@')
    await expect(input, 'the focus is back in the composer once the + menu closed').toBeFocused()
    await expect(menu).toHaveAttribute('data-state', 'ready')
    await expect(byTestId(menu, testIds.mentionMenuItem, { 'data-path': 'README.md' })).toBeVisible()

    // A folder: Enter opens it and the menu stays open on its files.
    await page.keyboard.type('sr')
    const folder = byTestId(menu, testIds.mentionMenuItem, { 'data-path': 'src', 'data-kind': 'dir' })
    await expect(menu.getByTestId(testIds.mentionMenuItem).first()).toHaveAttribute('data-path', 'src')
    await expect(folder).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(input).toHaveValue('@src/')
    await expect(menu).toHaveAttribute('data-count', '2')
    await expect(byTestId(menu, testIds.mentionMenuItem, { 'data-path': 'src/lexer.ts' })).toBeVisible()
    await expect(byTestId(menu, testIds.mentionMenuItem, { 'data-path': 'src/parser.ts' })).toBeVisible()
    await expect(composer(page).getByTestId(testIds.composerAttachment)).toHaveCount(0)

    // Esc closes the menu, nothing else: the text stays, the focus too.
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await expect(input).toHaveValue('@src/')
    await expect(input).toBeFocused()

    // `a@b` is not a mention: only the `@` after the blank searches (its request proves the debounce elapsed).
    const searches = await recordRequests(page, 'GET', `/api/projects/${project.id}/files`)
    await input.fill('')
    await page.keyboard.type('mail a@b')
    await expect(menu).toHaveCount(0)
    await page.keyboard.type(' @lex')
    await expect(menu).toHaveAttribute('data-state', 'ready')
    await expect(menu.getByTestId(testIds.mentionMenuItem)).toHaveCount(1)
    await expect(menu.getByTestId(testIds.mentionMenuItem)).toHaveAttribute('data-path', 'src/lexer.ts')
    await expect.poll(() => searchQueries(searches), { message: 'the token after the blank was searched' }).toContain('lex')
    for (const query of searchQueries(searches))
      expect(query, 'every search came from the token after the blank').toMatch(/^l?e?x?$/)
    await searches.stop()

    // A chat without a project: `@` opens nothing.
    await openNewChat(page)
    await composerInput(page).click()
    await page.keyboard.type('Fix @pars')
    await expect(composerInput(page)).toHaveValue('Fix @pars')
    await expect(menu).toHaveCount(0)
    await expect(composer(page).getByTestId(testIds.composerAdd)).toBeVisible()
    await composer(page).getByTestId(testIds.composerAdd).click()
    await expect(page.getByTestId(testIds.composerMention)).toHaveCount(0)
    await page.keyboard.press('Escape')
  })

  test('a project folder that is gone shows the error state @smoke', async ({ page, api, cleanup }) => {
    const { chatId, folder } = await seedProjectChat(api, cleanup, { modelRef: 'mock:echo', prefix: 'mentions', files: FILES })
    await folder.remove()
    await page.goto(`/chat/${chatId}`)
    await composerInput(page).click()
    await page.keyboard.type('@par')
    const menu = mentionMenu(page)
    await expect(menu).toHaveAttribute('data-state', 'error')
    await expect(menu).toContainText('The project folder is unavailable.')
    await expect(menu.getByTestId(testIds.mentionMenuItem)).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await expect(composerInput(page)).toHaveValue('@par')
  })
})
