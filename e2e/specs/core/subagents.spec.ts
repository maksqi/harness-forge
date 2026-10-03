// Sub-agents (docs/UI.md 2.16, 7.27; ADR-043) with `mock:subagent` as the chat model and as `subagentModelRef`
// (docs/PROVIDERS.md 8): the parent calls `task` twice in one step (an explore and a general sub-agent, run in
// parallel), each child lists the folder (300 ms per step) and reports; `loop` keeps the children busy until the step
// limit, `write` lets a general child in Accept edits write `subagent.txt`.
// - Two blocks run at the same time (recorded with `recordStates`: both `running` in one snapshot), the live line shows
//   the latest step and, once finished, the report's first sentence; expanding a block shows the prompt, the steps, the
//   report and the meta line; no approval anywhere; a reload keeps the blocks.
// - Stop ends both sub-agents: the blocks read "Stopped" (`aborted`), also after a reload.
// - A sub-agent's write is journaled under the reply: "Rewind files to here" on the user message lists the file and
//   deletes it; the changes panel lists it first.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  byTestId,
  changesToggle,
  expect,
  expectMessageStatus,
  expectStatesInOrder,
  lastAssistantMessage,
  MOCK_SUBAGENT_FILE,
  MOCK_SUBAGENT_FILE_CONTENT,
  MOCK_SUBAGENT_TASKS,
  openRewind,
  recordStates,
  seedProjectChat,
  sendMessage,
  test,
  testIds,
  toastWith,
  useAgentSettings,
  userMessages,
} from '../../helpers/index.ts'

const MODEL = 'mock:subagent'
const [EXPLORE, GENERAL] = MOCK_SUBAGENT_TASKS

/** One task block as `<kind>:<state>:<live line>`. */
const BLOCK_SNAPSHOT = `return el.dataset.kind + ':' + el.dataset.state + ':'
  + (el.querySelector('[data-slot="task-live"]')?.textContent.replace(/\\s+/g, ' ').trim() ?? '')`

async function fileText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  }
  catch {
    return null
  }
}

test.describe('sub-agents', () => {
  test.beforeEach(async ({ api, cleanup }) => {
    await useAgentSettings(api, cleanup, { subagentModelRef: MODEL })
  })

  test('two sub-agents run in parallel with a live line; a block expands to its steps and report @smoke', async ({ page, api, cleanup }) => {
    const { chatId } = await seedProjectChat(api, cleanup, { modelRef: MODEL, prefix: 'subagents', files: { 'src/app.ts': 'export {}\n' } })
    await page.goto(`/chat/${chatId}`)
    const recorder = await recordStates(page, 'task-blocks', testIds.taskBlock, BLOCK_SNAPSHOT)
    await sendMessage(page, 'Explore the project.')

    const reply = lastAssistantMessage(page)
    const explore = byTestId(reply, testIds.taskBlock, { 'data-kind': 'explore' })
    const general = byTestId(reply, testIds.taskBlock, { 'data-kind': 'general' })
    await expect(reply.getByTestId(testIds.taskBlock)).toHaveCount(2)
    await expect(reply).toContainText(`Reports: Report: ${EXPLORE.prompt}`)
    await expectMessageStatus(reply, 'done')
    await expect(explore).toHaveAttribute('data-state', 'completed')
    await expect(general).toHaveAttribute('data-state', 'completed')
    await expect(page.getByTestId(testIds.toolApproval)).toHaveCount(0)

    // Both ran at the same time; the live line followed the steps, then showed the report's first sentence.
    const states = await recorder.states()
    expectStatesInOrder(states, [/^explore:running:.* \|\| general:running:/], 'both sub-agents run in parallel')
    expectStatesInOrder(states, [/^explore:running:└ list_directory/, /^explore:completed:Report: List the project files\.( \|\||$)/], 'the live line of the explore block')
    await expect(explore.locator('[data-slot="task-live"]')).toHaveText(`Report: ${EXPLORE.prompt}`)
    await expect(general.locator('[data-slot="task-live"]')).toHaveText(`Report: ${GENERAL.prompt}`)

    // The trigger names the block; expanding shows the prompt, the steps, the report and the meta line.
    const trigger = explore.getByTestId(testIds.taskBlockTrigger)
    await expect(trigger).toHaveAccessibleName(`Explore sub-agent: ${EXPLORE.description}, completed, 1 tool call`)
    await expect(general.getByTestId(testIds.taskBlockTrigger)).toHaveAccessibleName(`Sub-agent: ${GENERAL.description}, completed, 1 tool call`)
    await expect(explore.getByTestId(testIds.taskReport)).toHaveCount(0)
    await trigger.click()
    await expect(trigger).toHaveAttribute('aria-expanded', 'true')
    await expect(explore).toContainText(EXPLORE.prompt)
    const steps = explore.getByTestId(testIds.taskStep)
    await expect(steps).toHaveCount(1)
    await expect(steps.first()).toHaveAttribute('data-tool-name', 'list_directory')
    await expect(steps.first()).toHaveAttribute('data-state', 'done')
    await expect(explore.getByTestId(testIds.taskReport)).toContainText(`Report: ${EXPLORE.prompt}`)
    await expect(explore.locator('[data-slot="task-meta"]')).toContainText('subagent')

    // A reload keeps both finished blocks and their steps.
    await page.reload()
    await expectMessageStatus(lastAssistantMessage(page), 'done')
    await expect(explore).toHaveAttribute('data-state', 'completed')
    await expect(general).toHaveAttribute('data-state', 'completed')
    await explore.getByTestId(testIds.taskBlockTrigger).click()
    await expect(explore.getByTestId(testIds.taskStep)).toHaveCount(1)
    await expect(explore.getByTestId(testIds.taskReport)).toContainText(`Report: ${EXPLORE.prompt}`)
  })

  test('Stop ends both sub-agents: the blocks read Stopped, also after a reload @smoke', async ({ page, api, cleanup }) => {
    const { chatId } = await seedProjectChat(api, cleanup, { modelRef: MODEL, prefix: 'subagents' })
    await page.goto(`/chat/${chatId}`)
    // `loop`: the children list the folder until their step limit (30 steps, about 9 s).
    await sendMessage(page, 'loop')
    const reply = lastAssistantMessage(page)
    const blocks = reply.getByTestId(testIds.taskBlock)
    await expect(blocks).toHaveCount(2)
    await expect(byTestId(reply, testIds.taskBlock, { 'data-state': 'running' })).toHaveCount(2)
    await expect(blocks.first().locator('[data-slot="task-live"]')).toContainText('list_directory')

    await page.getByTestId(testIds.composerStop).click()
    await expectMessageStatus(reply, 'aborted')
    await expect(byTestId(reply, testIds.taskBlock, { 'data-state': 'aborted' })).toHaveCount(2)
    await expect(blocks.first()).toContainText('Stopped')

    await page.reload()
    await expect(lastAssistantMessage(page).getByTestId(testIds.taskBlock)).toHaveCount(2)
    await expect(byTestId(lastAssistantMessage(page), testIds.taskBlock, { 'data-state': 'aborted' })).toHaveCount(2)
    await expect(page.getByTestId(testIds.composerSend)).toBeVisible()
  })

  test('"Rewind files to here" covers a sub-agent\'s write @smoke', async ({ page, api, cleanup }) => {
    const { chatId, folder } = await seedProjectChat(api, cleanup, { modelRef: MODEL, prefix: 'subagents' })
    // In Accept edits the general sub-agent writes `subagent.txt` (the user text contains "write").
    await api.sendChat({ chatId, modelRef: MODEL, toolMode: 'edits', text: 'Explore, then write a file.' })
    const file = join(folder.path, MOCK_SUBAGENT_FILE)
    expect(await fileText(file)).toBe(MOCK_SUBAGENT_FILE_CONTENT)

    await page.goto(`/chat/${chatId}`)
    const reply = lastAssistantMessage(page)
    await expectMessageStatus(reply, 'done')
    const general = byTestId(reply, testIds.taskBlock, { 'data-kind': 'general' })
    await expect(general).toHaveAttribute('data-state', 'completed')
    await general.getByTestId(testIds.taskBlockTrigger).click()
    await expect(byTestId(general, testIds.taskStep, { 'data-tool-name': 'write_file' })).toHaveAttribute('data-state', 'done')
    await expect(changesToggle(page)).toHaveAttribute('data-count', '1')

    const dialog = await openRewind(page, userMessages(page).first())
    await expect(dialog).toHaveAttribute('data-state', 'ready')
    const row = byTestId(dialog, testIds.rewindFile, { 'data-path': MOCK_SUBAGENT_FILE })
    await expect(row).toHaveAttribute('data-action', 'delete')
    await dialog.getByTestId(testIds.rewindRestore).click()
    await expect(dialog).toBeHidden()
    await expect(toastWith(page, 'Restored 1 file')).toBeVisible()
    await expect.poll(() => fileText(file), { message: 'the file the sub-agent created is gone' }).toBeNull()
    await expect(changesToggle(page)).toHaveAttribute('data-count', '0')
  })
})
