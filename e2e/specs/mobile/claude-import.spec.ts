// Import from Claude Code and the project file editor on a phone (Phase 12; docs/UI.md 2.19, 9.14, 14.5, 14.6), project
// `mobile` (Pixel 7 at 390x844, touch), on the shared server. Nothing is imported: the preview is a plan without side
// effects, and the dialog is discarded.
// - The import dialog is full screen (0, 0, 390 x 844) with its footer (Back, Import {n} items) at the bottom of the
//   screen while the body scrolls under it; the source radios, the item and Select all checkboxes, the resolution select
//   of a conflict (an `explore` agent: a built-in name) and the variable input are 40 px targets; nothing scrolls sideways, in the page or in the dialog. Escape asks "Discard this import?".
// - The project file editor (Edit… of a project agent) is a sheet as wide as the screen, inside it, with Copy path, Cancel
//   and Save as 40 px targets on the screen; nothing scrolls sideways. (Its × Close: the tablet spec.)
// The fake home lives in a temp folder outside the repository; `GET /api/claude-import/home` is stubbed in the browser.
import type { Locator, Page } from '@playwright/test'
import {
  chooseClaudeFolder,
  claudeImportEnable,
  claudeImportGroup,
  claudeImportItem,
  continueToPreview,
  FAKE_HOME,
  FAKE_HOME_CONFLICT_AGENT,
  fakeClaudeHomeTree,
  openClaudeImport,
  seedFakeClaudeHome,
} from '../../helpers/claude-home.ts'
import {
  boxOf,
  byTestId,
  definitionFile,
  documentWidths,
  expect,
  seedProject,
  stubClaudeHome,
  test,
  testIds,
  touchTargetSize,
} from '../../helpers/index.ts'
import { openProjectFileEditor, projectFileContent, projectRow } from '../../helpers/project-files.ts'

const VIEWPORT = { width: 390, height: 844 }

async function expectTouchTarget(target: Locator, name: string, options: { width?: boolean } = {}): Promise<void> {
  await expect(target, name).toBeVisible()
  const size = await touchTargetSize(target)
  expect(size.height, `${name} height`).toBeGreaterThanOrEqual(40)
  if (options.width !== false)
    expect(size.width, `${name} width`).toBeGreaterThanOrEqual(40)
}

async function expectNoSidewaysScroll(page: Page, where: string): Promise<void> {
  await expect.poll(async () => (await documentWidths(page)).scrollWidth, { message: `${where} fits 390 px` }).toBeLessThanOrEqual(VIEWPORT.width)
}

/** The element lies inside the screen (polled: dialogs and sheets animate in). */
async function expectInsideViewport(target: Locator, name: string): Promise<void> {
  await expect.poll(async () => {
    const box = await boxOf(target)
    return box.x >= -0.5 && box.y >= -0.5 && box.x + box.width <= VIEWPORT.width + 0.5 && box.y + box.height <= VIEWPORT.height + 0.5
  }, { message: `${name} fits the screen` }).toBe(true)
}

/** An element never scrolls sideways inside itself. */
async function expectNoInnerSidewaysScroll(target: Locator, name: string): Promise<void> {
  const widths = await target.evaluate(element => ({ scroll: element.scrollWidth, client: element.clientWidth }))
  expect(widths.scroll, `${name} does not scroll sideways`).toBeLessThanOrEqual(widths.client + 1)
}

test.describe('mobile Claude Code import', () => {
  test('the import dialog is full screen with a sticky footer; its controls are 40 px; nothing scrolls sideways', async ({ page, cleanup }) => {
    const home = await seedFakeClaudeHome(cleanup, fakeClaudeHomeTree({ builtinConflict: true }))
    const stub = await stubClaudeHome(page)
    const dialog = await openClaudeImport(page)
    await expect.poll(async () => boxOf(dialog), { message: 'the dialog fills the screen' }).toEqual({ x: 0, y: 0, ...VIEWPORT })
    for (const value of ['folder', 'zip'])
      await expectTouchTarget(byTestId(dialog, testIds.claudeImportSource, { 'data-value': value }), `the ${value} source`, { width: false })
    await expectTouchTarget(dialog.getByRole('button', { name: 'Choose folder…' }), 'Choose folder…')
    await expectTouchTarget(dialog.getByTestId(testIds.claudeImportContinue), 'Continue')

    await chooseClaudeFolder(dialog, home)
    const preview = await continueToPreview(dialog)
    await expect(preview).toHaveAttribute('data-count', String(FAKE_HOME.items + 1))
    await expectNoSidewaysScroll(page, 'the import preview')
    await expectNoInnerSidewaysScroll(dialog, 'the dialog')

    // The footer stays at the bottom of the screen while the body scrolls under it.
    const back = dialog.getByTestId(testIds.claudeImportBack)
    const submit = dialog.getByTestId(testIds.claudeImportSubmit)
    for (const [button, name] of [[back, 'Back'], [submit, 'Import']] as const) {
      await expectTouchTarget(button, name)
      await expectInsideViewport(button, name)
    }
    const footerTop = (await boxOf(submit)).y
    expect(footerTop + (await boxOf(submit)).height, 'the footer sits at the bottom').toBeGreaterThan(VIEWPORT.height - 80)
    const body = preview.locator('xpath=..')
    await body.evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })
    await expect.poll(async () => body.evaluate(element => element.scrollTop), { message: 'the body scrolled' }).toBeGreaterThan(0)
    expect((await boxOf(submit)).y, 'the footer did not move').toBeCloseTo(footerTop, 0)

    // Checkboxes, the conflict's resolution select and the variable input are 40 px targets. (The Turn on after import
    // switch answers in 38.4 px: like every Switch, its `::after` hit area counts from inside its 1 px border.)
    const agents = claudeImportGroup(preview, 'agent')
    await agents.scrollIntoViewIfNeeded()
    await expectTouchTarget(agents.getByTestId(testIds.claudeImportSelectAll), 'the Agents Select all')
    await expectTouchTarget(claudeImportItem(agents, 'agent', 'reviewer').getByTestId(testIds.claudeImportSelect), 'an item checkbox')
    const conflict = claudeImportItem(agents, 'agent', FAKE_HOME_CONFLICT_AGENT)
    await expect(conflict).toHaveAttribute('data-status', 'conflict')
    await expectTouchTarget(conflict.getByTestId(testIds.claudeImportResolution), 'the resolution select', { width: false })
    const deploy = claudeImportItem(preview, 'command', 'deploy')
    await deploy.scrollIntoViewIfNeeded()
    await expect(claudeImportEnable(deploy)).toBeVisible()
    const http = claudeImportItem(preview, 'mcp-server', FAKE_HOME.mcpServers.http)
    await http.scrollIntoViewIfNeeded()
    await expectTouchTarget(http.locator(`[data-action="variable"][data-name="${FAKE_HOME.mcpVariable}"]`), 'the variable input', { width: false })
    await expectNoInnerSidewaysScroll(dialog, 'the dialog with every group')

    // Escape asks first; Discard closes without importing.
    await page.keyboard.press('Escape')
    const discard = page.getByRole('alertdialog').filter({ hasText: 'Discard this import?' })
    await expect(discard).toBeVisible()
    await expectInsideViewport(discard, 'the discard question')
    await discard.getByRole('button', { name: 'Discard' }).click()
    await expect(dialog).toBeHidden()
    expect(stub.scans(), 'no server-side scan').toBe(0)
  })

  test('the project file editor is a sheet as wide as the screen with 40 px Copy path, Cancel and Save; nothing scrolls sideways', async ({ page, api, cleanup }) => {
    const path = '.claude/agents/phone-reviewer-with-a-rather-long-file-name.md'
    const { project } = await seedProject(api, cleanup, {
      prefix: 'mobile-file-editor-with-a-long-folder-name',
      files: { [path]: definitionFile({ name: 'phone-reviewer', description: 'Reviews code on a phone, with a description long enough to wrap twice on a narrow screen.' }, 'Review the code you are given.\n') },
    })
    await page.goto(`/settings/customize?tab=agents&project=${project.id}`)
    const row = projectRow(page, 'agent', 'phone-reviewer')
    await expect(row).toBeVisible()
    await expectNoSidewaysScroll(page, 'Customize with a project')
    const editor = await openProjectFileEditor(page, row, path, 'Review the code you are given.')
    await expectInsideViewport(editor, 'the file editor')
    await expect.poll(async () => (await boxOf(editor)).width, { message: 'the sheet is as wide as the screen' }).toBe(VIEWPORT.width)
    await expect(projectFileContent(editor)).toBeVisible()
    const save = editor.getByTestId(testIds.projectFileSave)
    await expectTouchTarget(save, 'Save')
    await expectInsideViewport(save, 'Save')
    await expectTouchTarget(editor.getByRole('button', { name: 'Copy path' }), 'Copy path')
    await expectTouchTarget(editor.getByRole('button', { name: 'Cancel' }), 'Cancel')
    await expectNoSidewaysScroll(page, 'the file editor')
    await expectNoInnerSidewaysScroll(editor, 'the file editor')
    await page.keyboard.press('Escape')
    await expect(editor).toBeHidden()
  })
})
