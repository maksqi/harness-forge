// Plan files (docs/UI.md 7.25, 9.11; ADR-047) with `mock:plan` in a project chat: with "Save approved plans" on, the
// approval of a plan writes it as `.harness/plans/<date>-<slug>.md` through the journal.
// - "Approve, accept edits": the plan row's body starts with the `plan-file` chip ("Saved to" the path, Copy path, Show
//   changes), the file on disk holds the plan; Show changes opens the changes panel, which lists the plan file next to
//   the file the plan wrote.
// - "Rewind files to here" on the user message lists the plan file as a file to delete and removes it.
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  byTestId,
  changesFile,
  changesPanel,
  composer,
  expect,
  expectMessageStatus,
  lastAssistantMessage,
  MOCK_PLAN_FILE,
  mockPlanDone,
  openRewind,
  seedProjectChat,
  selectPermissionMode,
  sendMessage,
  test,
  testIds,
  toastWith,
  usePlanSettings,
  userMessages,
} from '../../helpers/index.ts'

const PLAN_PATH = /^\.harness\/plans\/\d{4}-\d{2}-\d{2}-plan(?:-\d+)?\.md$/

async function planFiles(folder: string): Promise<string[]> {
  try {
    return (await readdir(join(folder, '.harness/plans'))).sort()
  }
  catch {
    return []
  }
}

test.describe('plan files', () => {
  test('an approved plan is saved as a Markdown file: the chip, the changes panel, and rewind removes it @smoke', async ({ page, api, cleanup }) => {
    await usePlanSettings(api, cleanup, { planFiles: true, planDirectory: '.harness/plans' })
    const { chatId, folder } = await seedProjectChat(api, cleanup, { modelRef: 'mock:plan', prefix: 'plan-files', files: { 'README.md': '# Plans\n' } })

    await page.goto(`/chat/${chatId}`)
    await expect(composer(page).getByTestId(testIds.modelPickerTrigger)).toHaveAttribute('data-model-ref', 'mock:plan')
    await selectPermissionMode(page, 'plan')
    await sendMessage(page, 'Plan the notes file.')
    const reply = lastAssistantMessage(page)
    const card = reply.getByTestId(testIds.planApproval)
    await expect(card).toHaveAttribute('data-state', 'pending')
    expect(await planFiles(folder.path), 'nothing is saved before the approval').toEqual([])

    await card.getByTestId(testIds.planApproveEdits).click()
    await expect(reply).toContainText(mockPlanDone('edits'))
    await expectMessageStatus(reply, 'done')

    // The chip, first in the body of the approved plan row: the saved path.
    const planRow = byTestId(reply, testIds.toolRow, { 'data-tool-name': 'exit_plan_mode' })
    await expect(planRow).toContainText('Approved · Accept edits')
    await planRow.getByRole('button').first().click()
    const chip = reply.getByTestId(testIds.planFile)
    await expect(chip).toHaveAttribute('data-state', 'saved')
    await expect(chip).toHaveAttribute('data-path', PLAN_PATH)
    const path = (await chip.getAttribute('data-path'))!
    await expect(chip).toContainText('Saved to')
    await expect(chip.locator('[data-slot="plan-file-path"]')).toContainText(path.split('/').at(-1)!)
    await expect(chip.locator('[data-slot="plan-file-path"]')).toContainText(`Plan saved to ${path}`)
    const files = await planFiles(folder.path)
    expect(files).toEqual([path.split('/').at(-1)])
    const saved = await readFile(join(folder.path, path), 'utf8')
    expect(saved).toContain('# Plan')
    expect(saved).toContain('Create notes.txt.')

    // Show changes: the panel lists the plan file and the file the plan wrote.
    await chip.locator('[data-slot="plan-file-show-changes"]').click()
    await expect(changesPanel(page)).toHaveAttribute('data-state', 'ready')
    await expect(changesFile(page, path)).toHaveAttribute('data-status', 'added')
    await expect(changesFile(page, MOCK_PLAN_FILE)).toBeVisible()
    await changesPanel(page).getByTestId(testIds.changesClose).click()

    // Rewind to the user message deletes the plan file too.
    const dialog = await openRewind(page, userMessages(page).first())
    await expect(dialog).toHaveAttribute('data-state', 'ready')
    await expect(byTestId(dialog, testIds.rewindFile, { 'data-path': path })).toHaveAttribute('data-action', 'delete')
    await expect(byTestId(dialog, testIds.rewindFile, { 'data-path': MOCK_PLAN_FILE })).toHaveAttribute('data-action', 'delete')
    await dialog.getByTestId(testIds.rewindRestore).click()
    await expect(dialog).toBeHidden()
    await expect(toastWith(page, 'Restored 2 files')).toBeVisible()
    await expect.poll(() => planFiles(folder.path), { message: 'the plan file is gone' }).toEqual([])
  })
})
