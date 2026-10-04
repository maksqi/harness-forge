// Settings -> Customize on a phone (docs/UI.md 2.17, 9.12, 14.5, 14.6), project `mobile` (Pixel 7 at 390x844, touch):
// - With a project selected (long paths, a shadowed and an invalid file) and a personal agent with a long description,
//   the page never scrolls sideways, the kind tabs sit in a row of their own that scrolls sideways, and every row's `⋯`
//   menu is a 40 px target that opens inside the screen.
// - The editor is a full-width sheet: inside the screen, its body editor at most half the screen tall, its footer
//   (Cancel, Save) with 40 px buttons; the viewer of a project file fits the same way.
import type { Locator, Page } from '@playwright/test'
import {
  boxOf,
  byTestId,
  chooseRowAction,
  createPersonalDefinition,
  customizationRow,
  customizeSection,
  definitionFile,
  documentWidths,
  expect,
  seedProject,
  test,
  testIds,
  touchTargetSize,
  uniqueId,
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

/** The element lies inside the screen (polled: sheets slide in). */
async function expectInsideViewport(target: Locator, name: string): Promise<void> {
  await expect.poll(async () => {
    const box = await boxOf(target)
    return box.x >= -0.5 && box.y >= -0.5 && box.x + box.width <= VIEWPORT.width + 0.5 && box.y + box.height <= VIEWPORT.height + 0.5
  }, { message: `${name} fits the screen` }).toBe(true)
}

/** A project with agents in both folders (long names and paths) and a personal agent with a long description. */
async function seedCustomize(api: Parameters<typeof createPersonalDefinition>[0], cleanup: Parameters<typeof createPersonalDefinition>[1]) {
  const agent = uniqueId('mobile-reviewer-with-a-long-name')
  const personal = uniqueId('mobile-personal')
  const { project } = await seedProject(api, cleanup, {
    prefix: 'mobile-customize-with-a-long-folder-name',
    files: {
      [`.harness/agents/${agent}.md`]: definitionFile({ name: agent, description: 'Reviews the diff of a pull request for bugs, risky changes and missing tests before a release.', tools: ['read_file', 'search_files', 'list_directory'] }, 'PERSONA: phone\n'),
      [`.claude/agents/${agent}.md`]: definitionFile({ name: agent, description: 'The older Claude Code version of the same reviewer.' }, 'PERSONA: claude\n'),
      [`.claude/agents/${uniqueId('broken')}.md`]: definitionFile({ name: 'x-broken' }, 'No description.\n'),
    },
  })
  await createPersonalDefinition(api, cleanup, {
    kind: 'agent',
    name: personal,
    content: definitionFile({ name: personal, description: 'A personal agent whose description is long enough to wrap onto a second line on a phone screen.', model: 'mock:agents' }, 'PERSONA: personal\n'),
  })
  return { project, agent, personal }
}

test.describe('mobile customize', () => {
  test('the page never scrolls sideways; the tabs scroll in their row; the row menus are 40 px targets', async ({ page, api, cleanup }) => {
    const { project, agent } = await seedCustomize(api, cleanup)
    await page.goto(`/settings/customize?tab=agents&project=${project.id}`)
    const section = customizeSection(page, 'project')
    await expect(section).toHaveAttribute('data-count', '3')
    await expect(customizeSection(page, 'user')).toBeVisible()
    await expectNoSidewaysScroll(page, 'Customize with a project')

    // The tabs: a row of their own that scrolls sideways (never the page).
    const tablist = page.getByRole('tablist', { name: 'Kinds' })
    await expectInsideViewport(tablist.locator('xpath=..'), 'the tab row')
    expect(await tablist.locator('xpath=..').evaluate(element => element.ownerDocument.defaultView!.getComputedStyle(element).overflowX)).toBe('auto')
    for (const tab of await page.getByTestId(testIds.customizeTab).all())
      expect((await touchTargetSize(tab)).height, 'a tab height').toBeGreaterThanOrEqual(40)
    await byTestId(page, testIds.customizeTab, { 'data-value': 'skills' }).tap()
    await expect(byTestId(page, testIds.customizeTab, { 'data-value': 'skills' })).toHaveAttribute('data-state', 'active')
    await expectNoSidewaysScroll(page, 'the Skills tab')
    await byTestId(page, testIds.customizeTab, { 'data-value': 'agents' }).tap()
    await expect(customizationRow(section, { 'data-path': `.harness/agents/${agent}.md` })).toBeVisible()

    // Every row menu is a 40 px target; one opens inside the screen.
    const menus = page.getByTestId(testIds.customizationRowMenu)
    // The personal agent, three project files (the invalid one too) and the two built-in agents.
    expect(await menus.count()).toBeGreaterThanOrEqual(6)
    for (const menu of await menus.all())
      await expectTouchTarget(menu, 'a row menu')
    await customizationRow(section, { 'data-path': `.harness/agents/${agent}.md` }).getByTestId(testIds.customizationRowMenu).tap()
    const opened = page.getByRole('menu')
    await expect(opened).toBeVisible()
    await expectInsideViewport(opened, 'the row menu')
    await page.keyboard.press('Escape')
    await expect(opened).toHaveCount(0)
    await expectNoSidewaysScroll(page, 'after the row menu')
  })

  test('the editor and the viewer are full-width sheets with 40 px footers', async ({ page, api, cleanup }) => {
    const { project, agent, personal } = await seedCustomize(api, cleanup)
    await page.goto(`/settings/customize?tab=agents&project=${project.id}`)
    await expect(customizeSection(page, 'project')).toHaveAttribute('data-count', '3')

    // The editor of the personal agent.
    await chooseRowAction(page, customizationRow(customizeSection(page, 'user'), { 'data-name': personal }), testIds.customizationEdit)
    const editor = page.getByTestId(testIds.customizationEditor)
    await expect(editor).toHaveAttribute('data-mode', 'edit')
    await expectInsideViewport(editor, 'the editor sheet')
    await expect.poll(async () => Math.round((await boxOf(editor)).width), { message: 'the sheet is as wide as the screen' }).toBe(VIEWPORT.width)
    const body = editor.getByTestId(testIds.customizationBody)
    await expect(body).toHaveAttribute('data-ready', 'true')
    expect((await boxOf(body)).height, 'the body editor is at most half the screen').toBeLessThanOrEqual(VIEWPORT.height / 2 + 1)
    const save = editor.getByTestId(testIds.customizationSave)
    await expectInsideViewport(save, 'Save')
    await expect.poll(async () => (await touchTargetSize(save)).height, { message: 'Save height' }).toBeGreaterThanOrEqual(40)
    const cancel = editor.getByRole('button', { name: 'Cancel' })
    await expect.poll(async () => (await touchTargetSize(cancel)).height, { message: 'Cancel height' }).toBeGreaterThanOrEqual(40)
    await expectTouchTarget(editor.getByTestId(testIds.customizationModel), 'the model select')
    await expectNoSidewaysScroll(page, 'the editor')
    await cancel.tap()
    await expect(editor).toBeHidden()

    // The viewer of a project file.
    await chooseRowAction(page, customizationRow(customizeSection(page, 'project'), { 'data-path': `.harness/agents/${agent}.md` }), testIds.customizationView)
    const viewer = page.getByTestId(testIds.customizationViewer)
    await expect(viewer).toContainText(`.harness/agents/${agent}.md`)
    await expectInsideViewport(viewer, 'the viewer sheet')
    await expect.poll(async () => Math.round((await boxOf(viewer)).width)).toBe(VIEWPORT.width)
    for (const name of ['Export .md', 'Copy to personal'])
      await expect.poll(async () => (await touchTargetSize(viewer.getByRole('button', { name }))).height, { message: `${name} height` }).toBeGreaterThanOrEqual(40)
    await expectNoSidewaysScroll(page, 'the viewer')
  })
})
