// Hooks, project trust and project MCP on a phone (docs/UI.md 2.18, 9.13, 7.33, 14.5, 14.6), project `mobile` (Pixel 7
// at 390x844, touch):
// - Settings -> Customize -> Hooks with a project (an approved and a pending project hook with long commands) and a
//   personal hook never scrolls sideways; the five kind tabs sit in a row of their own that scrolls sideways; every
//   hook row menu is a 40 px target. The hook editor is a full-width sheet whose footer (Cancel, Save hook) stays on the
//   screen while its body scrolls; the import dialog fits the screen with its preview and 40 px buttons.
// - In a project chat with a pending hook, a pending `.mcp.json` server and a command with a shell line: the trust chip
//   is a 40 px target; the trust dialog and the MCP servers dialog fit the screen (their footers visible, 40 px
//   checkboxes and buttons) and the page never scrolls sideways.
import type { Locator, Page } from '@playwright/test'
import {
  boxOf,
  byTestId,
  createPersonalHook,
  documentWidths,
  expect,
  hookGroup,
  hookRow,
  mcpVariable,
  seedHookProjectChat,
  test,
  testIds,
  touchTargetSize,
  uniqueId,
  writeHookScript,
  writeProjectFile,
} from '../../helpers/index.ts'

const VIEWPORT = { width: 390, height: 844 }

async function expectTouchTarget(target: Locator, name: string): Promise<void> {
  await expect(target, name).toBeVisible()
  await expect.poll(async () => (await touchTargetSize(target)).height, { message: `${name} height` }).toBeGreaterThanOrEqual(40)
  expect((await touchTargetSize(target)).width, `${name} width`).toBeGreaterThanOrEqual(40)
}

async function expectNoSidewaysScroll(page: Page, where: string): Promise<void> {
  await expect.poll(async () => (await documentWidths(page)).scrollWidth, { message: `${where} fits 390 px` }).toBeLessThanOrEqual(VIEWPORT.width)
}

/** The element lies inside the screen (polled: sheets slide in, dialogs zoom in). */
async function expectInsideViewport(target: Locator, name: string): Promise<void> {
  await expect.poll(async () => {
    const box = await boxOf(target)
    return box.x >= -0.5 && box.y >= -0.5 && box.x + box.width <= VIEWPORT.width + 0.5 && box.y + box.height <= VIEWPORT.height + 0.5
  }, { message: `${name} fits the screen` }).toBe(true)
}

/** A long but harmless command (the script exists only in the spec's project folder). */
function longCommand(name: string): string {
  return `sh .harness/hooks/${name}.sh --report-folder build/reports/hooks --with-a-very-long-option-name=enabled`
}

test.describe('mobile hooks', () => {
  test('the Hooks tab never scrolls sideways; the editor sheet keeps its footer; the import dialog fits', async ({ page, api, cleanup }) => {
    const marker = uniqueId('mobile-hook')
    // Notification: never shown in a chat, so the personal hook changes nothing for other specs.
    await createPersonalHook(api, cleanup, { event: 'Notification', command: `sh ${marker}.sh --notify-with-a-long-option-name=enabled` })
    const { project, folder } = await seedHookProjectChat(api, cleanup, {
      prefix: 'mobile-hooks-with-a-long-folder-name',
      scripts: [['record', { file: 'approved' }]],
      hooks: { PostToolUse: [hookGroup(longCommand('approved'), { matcher: 'Write|Edit' })] },
    })
    // A second settings file adds a pending hook after the approval.
    await writeHookScript(folder.path, 'record', { file: 'pending' })
    await writeProjectFile(folder.path, '.claude/settings.json', JSON.stringify({ hooks: { SessionStart: [hookGroup(longCommand('pending'))] } }))

    await page.goto(`/settings/customize?tab=hooks&project=${project.id}`)
    const panel = page.getByTestId(testIds.hooksPanel)
    await expect(panel).toBeVisible()
    const projectSection = byTestId(page, testIds.hooksSection, { 'data-source': 'project' })
    await expect(projectSection).toHaveAttribute('data-count', '2')
    await expect(hookRow(projectSection, { 'data-state': 'pending' })).toBeVisible()
    await expect(hookRow(projectSection, { 'data-state': 'active' })).toBeVisible()
    await expectNoSidewaysScroll(page, 'the Hooks tab')

    // The five tabs: a row of their own that scrolls sideways (never the page), 40 px tall.
    const tablist = page.getByRole('tablist', { name: 'Kinds' })
    const tabRow = tablist.locator('xpath=..')
    await expectInsideViewport(tabRow, 'the tab row')
    expect(await tabRow.evaluate(element => element.ownerDocument.defaultView!.getComputedStyle(element).overflowX)).toBe('auto')
    await expect(page.getByTestId(testIds.customizeTab)).toHaveCount(5)
    for (const tab of await page.getByTestId(testIds.customizeTab).all())
      expect((await touchTargetSize(tab)).height, 'a tab height').toBeGreaterThanOrEqual(40)

    // Every row menu is a 40 px target and opens inside the screen.
    const menus = page.getByTestId(testIds.hookRowMenu)
    expect(await menus.count()).toBeGreaterThanOrEqual(3)
    for (const menu of await menus.all())
      await expectTouchTarget(menu, 'a hook row menu')
    await hookRow(projectSection, { 'data-state': 'pending' }).getByTestId(testIds.hookRowMenu).tap()
    const opened = page.getByRole('menu')
    await expectInsideViewport(opened, 'the row menu')
    await page.keyboard.press('Escape')
    await expect(opened).toHaveCount(0)

    // The editor: a full-width sheet; its footer stays on the screen while the body scrolls.
    await byTestId(page, testIds.customizeNew, { 'data-kind': 'hook' }).tap()
    const editor = page.getByTestId(testIds.hookEditor)
    await expect(editor).toHaveAttribute('data-mode', 'new')
    await expectInsideViewport(editor, 'the editor sheet')
    await expect.poll(async () => Math.round((await boxOf(editor)).width), { message: 'the sheet is as wide as the screen' }).toBe(VIEWPORT.width)
    const save = editor.getByTestId(testIds.hookSave)
    const cancel = editor.getByRole('button', { name: 'Cancel' })
    await expectInsideViewport(save, 'Save hook')
    await expect.poll(async () => (await touchTargetSize(save)).height, { message: 'Save height' }).toBeGreaterThanOrEqual(40)
    await expect.poll(async () => (await touchTargetSize(cancel)).height, { message: 'Cancel height' }).toBeGreaterThanOrEqual(40)
    await editor.getByTestId(testIds.hookCommand).fill(Array.from({ length: 8 }, (_, index) => `${longCommand('step')} ${index}`).join('\n'))
    await editor.getByTestId(testIds.hookEditorEnabled).scrollIntoViewIfNeeded()
    await expectInsideViewport(save, 'Save hook after scrolling the body')
    await expectInsideViewport(editor.getByTestId(testIds.hookEditorEnabled), 'the On switch')
    await expectNoSidewaysScroll(page, 'the editor')
    await cancel.tap()
    await page.getByTestId(testIds.hookDiscardConfirm).tap()
    await expect(editor).toBeHidden()

    // The import dialog with a preview.
    await page.getByTestId(testIds.customizeImport).tap()
    const dialog = page.getByTestId(testIds.hookImportDialog)
    await expectInsideViewport(dialog, 'the import dialog')
    await dialog.getByTestId(testIds.hookImportInput).fill(JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: 'Bash|Edit', hooks: [{ type: 'command', command: `${longCommand(marker)} --guard` }] }],
        Stop: [{ hooks: [{ type: 'command', command: `sh ${marker}-lint.sh` }] }],
      },
    }))
    const preview = dialog.getByTestId(testIds.hookImportPreview)
    await expect(preview).toHaveAttribute('data-count', '2')
    const submit = dialog.getByTestId(testIds.hookImportSubmit)
    await expectInsideViewport(submit, 'Add 2 hooks')
    await expect.poll(async () => (await touchTargetSize(submit)).height, { message: 'Add height' }).toBeGreaterThanOrEqual(40)
    await expectInsideViewport(dialog, 'the import dialog with its preview')
    await expectNoSidewaysScroll(page, 'the import dialog')
    await dialog.getByRole('button', { name: 'Cancel' }).tap()
    await expect(dialog).toBeHidden()
  })

  test('the trust chip, the trust dialog and the MCP servers dialog fit the screen', async ({ page, api, cleanup }) => {
    const command = uniqueId('deploy')
    const { chatId } = await seedHookProjectChat(api, cleanup, {
      prefix: 'mobile-trust',
      scripts: [['record', { file: 'session-context-with-a-long-name' }]],
      hooks: commands => ({ SessionStart: [hookGroup(commands['session-context-with-a-long-name']!)] }),
      approve: false,
      files: {
        [`.harness/commands/${command}.md`]: '---\ndescription: Deploy the preview\n---\nStatus: !`git status --short --branch --untracked-files=all`\n',
        '.mcp.json': `${JSON.stringify({ mcpServers: { 'docs-search-with-a-long-name': { command: 'node', args: ['tools/mcp-server-with-a-long-file-name.mjs', '--verbose'], env: { DOCS_TOKEN: mcpVariable('DOCS_TOKEN') } } } }, null, 2)}\n`,
      },
    })

    await page.goto(`/chat/${chatId}`)
    const chip = page.getByTestId(testIds.projectTrustChip)
    await expect(chip).toHaveAttribute('data-count', '3')
    await expectTouchTarget(chip, 'the trust chip')
    await expectNoSidewaysScroll(page, 'the chat with the chip')

    // The trust dialog: full width minus the margins, the footer on the screen, 40 px targets.
    await chip.tap()
    const trust = page.getByTestId(testIds.projectTrustDialog)
    await expect(byTestId(trust, testIds.projectTrustItem, { 'data-state': 'new' })).toHaveCount(3)
    await expectInsideViewport(trust, 'the trust dialog')
    const approve = trust.getByTestId(testIds.projectTrustApprove)
    await expectInsideViewport(approve, 'Approve')
    await expect.poll(async () => (await touchTargetSize(approve)).height, { message: 'Approve height' }).toBeGreaterThanOrEqual(40)
    for (const checkbox of await trust.getByTestId(testIds.projectTrustSelect).all())
      await expectTouchTarget(checkbox, 'an item checkbox')
    await trust.getByTestId(testIds.projectTrustSelect).last().scrollIntoViewIfNeeded()
    await expectInsideViewport(approve, 'Approve after scrolling the list')
    await expectNoSidewaysScroll(page, 'the trust dialog')
    await page.keyboard.press('Escape')
    await expect(trust).toBeHidden()

    // The MCP servers dialog, from the project chip's menu.
    await page.getByTestId(testIds.chatProjectChip).tap()
    await page.getByTestId(testIds.chatProjectMcp).tap()
    const mcp = page.getByTestId(testIds.projectMcpDialog)
    const server = byTestId(mcp, testIds.projectMcpServer, { 'data-state': 'pending' })
    await expect(server).toBeVisible()
    await expectInsideViewport(mcp, 'the MCP servers dialog')
    await expectTouchTarget(server.getByTestId(testIds.projectMcpReview), 'Review…')
    await expectNoSidewaysScroll(page, 'the MCP servers dialog')
    await page.keyboard.press('Escape')
    await expect(mcp).toBeHidden()
  })
})
