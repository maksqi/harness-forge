// Background agents (docs/UI.md 2.17, 7.27, 7.29; ADR-046) with `mock:background` as the chat model and, because
// `subagentModelRef` is cleared for the test, as the model of its children (docs/PROVIDERS.md 8): `bg [type] [steps <N>]
// [slow <K> | loop]` launches one `task { background: true }`; a child takes K steps of 500 ms (default 2; `loop` until
// its step limit) and reports `Report: background done`; a delivered result is answered `Background result: <status> |
// <first report line>`; `steps <N>` keeps the launching reply busy for N steps of 400 ms and ends early with
// `Finished: in-run result <status>` once a result is injected.
// - Idle path: the launching block reads "In background", the dock lists the running agent with its live line, and when
//   it finishes the server starts a turn by itself: a carrier message with the result note ("Sent to the agent") and a
//   reply, announced "Background agent finished: …"; the block then offers "Go to the result"; a reload keeps it.
// - The composer's Stop ends only the reply; the agent keeps running. A row's Stop ends it ("Stopped", "Report
//   pending") without starting a turn; the next turn opens with its inline note. Stop all ends every running agent.
// - A result that arrives while a reply runs is an inline note in that reply (no extra turn).
// - The dock comes back after a reload, and a second page of the chat sees the same agent and its stop.
import type { Page } from '@playwright/test'
import type { CleanupTask, HarnessApi } from '../../helpers/index.ts'
import {
  assistantMessages,
  backgroundAgentRow,
  backgroundAgents,
  byTestId,
  chatTasks,
  expect,
  expectAnnounced,
  expectMessageStatus,
  lastAssistantMessage,
  MOCK_BACKGROUND_MODEL,
  MOCK_BACKGROUND_REPORT,
  mockBackgroundDescription,
  mockBackgroundResult,
  recordAnnouncements,
  sendMessage,
  test,
  testIds,
  uniqueId,
  useAgentSettings,
  userMessages,
  waitForChatTask,
} from '../../helpers/index.ts'

const TASK_ID = /bgt_[\dA-Za-z]{16}/

/** A `mock:background` chat, removed (its agents stopped) through `cleanup`; the page opens it. */
async function openBackgroundChat(page: Page, api: HarnessApi, cleanup: (task: CleanupTask) => void): Promise<string> {
  const chat = await api.createChat({ title: `Background ${uniqueId('bg')}`, modelRef: MOCK_BACKGROUND_MODEL })
  cleanup(api => api.removeChat(chat.id))
  await page.goto(`/chat/${chat.id}`)
  await expect(page.getByTestId(testIds.composerInput)).toBeEditable()
  return chat.id
}

/** The task id named by the launching reply ("Started in background: bgt_…"). */
async function launchedTaskId(page: Page): Promise<string> {
  const reply = lastAssistantMessage(page)
  await expect(reply).toContainText(TASK_ID)
  return (await reply.textContent())!.match(TASK_ID)![0]
}

test.describe('background agents', () => {
  test.beforeEach(async ({ api, cleanup }) => {
    // The children run on the chat's model (`mock:background`).
    await useAgentSettings(api, cleanup, { subagentModelRef: null })
  })

  test('an idle background agent reports by itself: In background, the dock\'s live line, the carrier note and a reply @smoke', async ({ page, api, cleanup }) => {
    const chatId = await openBackgroundChat(page, api, cleanup)
    const announced = await recordAnnouncements(page)
    await sendMessage(page, 'bg explore slow 6')
    const taskId = await launchedTaskId(page)
    const launch = assistantMessages(page).first()
    await expect(launch).toContainText(`Started in background: ${taskId}`)

    // The launching block runs in the background.
    const block = byTestId(launch, testIds.taskBlock, { 'data-background': 'true' })
    await expect(block).toHaveAttribute('data-state', 'running')
    await expect(block).toHaveAttribute('data-kind', 'explore')
    await expect(block.getByTestId(testIds.taskBlockTrigger)).toContainText('In background')
    await expect(block.getByTestId(testIds.taskBlockTrigger)).toHaveAccessibleName(/, running in the background$/)

    // The dock (open by default on a wide screen): the running row with its live line, Stop all, the footnote.
    const dock = backgroundAgents(page)
    await expect(dock).toHaveAttribute('data-state', 'open')
    await expect(dock).toHaveAttribute('data-count', '1')
    await expect(dock).toContainText('Background agents · 1 running')
    const row = backgroundAgentRow(page, { 'data-task-id': taskId })
    await expect(row).toHaveAttribute('data-state', 'running')
    await expect(row).toHaveAttribute('data-kind', 'explore')
    await expect(row).toContainText(mockBackgroundDescription())
    await expect(row.locator('[data-slot="background-agent-live"]')).toContainText('└ current_time')
    await expect(row.getByTestId(testIds.backgroundAgentStop)).toHaveAccessibleName(`Stop ${mockBackgroundDescription()}`)
    await expect(dock.getByTestId(testIds.backgroundAgentsStopAll)).toBeVisible()
    await expect(dock.locator('[data-slot="background-agents-footnote"]')).toHaveText('They keep running after the reply. Stop in the composer doesn\'t stop them.')

    // It finishes: the server starts a turn from a carrier message that holds the result note.
    const carrier = userMessages(page).nth(1)
    const note = byTestId(carrier, testIds.taskResult, { 'data-task-id': taskId })
    await expect(note).toHaveAttribute('data-variant', 'turn', { timeout: 15_000 })
    await expect(note).toHaveAttribute('data-status', 'completed')
    await expect(note).toHaveAccessibleName(`Background agent result: ${mockBackgroundDescription()}`)
    await expect(note).toContainText(`Background agent finished · Explore · ${mockBackgroundDescription()}`)
    await expect(note.locator('[data-slot="task-result-summary"]')).toHaveText(MOCK_BACKGROUND_REPORT)
    await expect(carrier).toContainText('Sent to the agent')
    const reply = lastAssistantMessage(page)
    await expect(assistantMessages(page)).toHaveCount(2)
    await expect(reply).toContainText(mockBackgroundResult('completed'), { timeout: 15_000 })
    await expectMessageStatus(reply, 'done')
    await expect(userMessages(page)).toHaveCount(2)
    await expectAnnounced(announced, `Background agent finished: ${mockBackgroundDescription()}`)
    // Delivered: nothing left in the dock.
    await expect(dock).toHaveCount(0)

    // The note opens the report; the launching block now links to the result.
    const toggle = note.getByTestId(testIds.taskResultToggle)
    await expect(toggle).toHaveText('Show report')
    await toggle.click()
    await expect(toggle).toHaveAttribute('data-state', 'open')
    await expect(note.getByTestId(testIds.taskResultReport)).toContainText(MOCK_BACKGROUND_REPORT)
    await expect(block).toHaveAttribute('data-state', 'completed')
    await block.getByTestId(testIds.taskBlockTrigger).click()
    await expect(block.getByTestId(testIds.taskBlockReveal)).toHaveAttribute('data-target', 'result')
    const tasks = await chatTasks(api, chatId)
    expect(tasks.find(task => task.id === taskId)).toMatchObject({ status: 'completed', deliveredMessageId: await carrier.getAttribute('data-message-id') })

    // A reload keeps the carrier note and the reply, and no dock.
    await page.reload()
    await expect(byTestId(userMessages(page).nth(1), testIds.taskResult, { 'data-task-id': taskId })).toHaveAttribute('data-variant', 'turn')
    await expect(lastAssistantMessage(page)).toContainText(mockBackgroundResult('completed'))
    await expect(backgroundAgents(page)).toHaveCount(0)
  })

  test('the composer\'s Stop leaves it running; its own Stop ends it and the next turn opens with its note @smoke', async ({ page, api, cleanup }) => {
    const chatId = await openBackgroundChat(page, api, cleanup)
    // A child that runs until it is stopped, and a reply that stays busy for ten steps.
    await sendMessage(page, 'bg explore loop steps 10')
    const reply = lastAssistantMessage(page)
    const task = await waitForChatTask(api, chatId, item => item.status === 'running')
    const row = backgroundAgentRow(page, { 'data-task-id': task.id })
    await expect(row).toHaveAttribute('data-state', 'running')
    await expectMessageStatus(reply, 'streaming')

    // The composer's Stop ends the reply only.
    await page.getByTestId(testIds.composerStop).click()
    await expectMessageStatus(reply, 'aborted')
    await expect(row).toHaveAttribute('data-state', 'running')
    await expect(row.locator('[data-slot="background-agent-live"]')).toContainText('└ current_time')
    expect((await chatTasks(api, chatId)).find(item => item.id === task.id)?.status).toBe('running')

    // The row's Stop: stopped, the report waits for the next turn.
    await row.getByTestId(testIds.backgroundAgentStop).click()
    await expect(row).toHaveAttribute('data-state', 'aborted')
    await expect(row).toContainText('Stopped')
    await expect(row.locator('[data-slot="background-agent-pending"]')).toHaveText('Report pending')
    await expect(backgroundAgents(page)).toHaveAttribute('data-count', '0')
    await expect(backgroundAgents(page)).toContainText('Background agents')
    await expect(backgroundAgents(page).getByTestId(testIds.backgroundAgentsStopAll)).toHaveCount(0)
    expect((await chatTasks(api, chatId)).find(item => item.id === task.id)).toMatchObject({ status: 'aborted', deliveredAt: null })

    // The next turn the user starts opens with the stopped agent's note (a stop never starts a turn by itself).
    await sendMessage(page, 'hello')
    const next = lastAssistantMessage(page)
    await expectMessageStatus(next, 'done')
    await expect(userMessages(page)).toHaveCount(2)
    await expect(userMessages(page).last()).toContainText('hello')
    const note = byTestId(next, testIds.taskResult, { 'data-task-id': task.id })
    await expect(note).toHaveAttribute('data-variant', 'inline')
    await expect(note).toHaveAttribute('data-status', 'aborted')
    await expect(note).toContainText('Background agent stopped')
    // (The reply's text is the mock's: after the stopped reply, which ended with a tool step, the mock reads `hello` as
    // a steer of the `steps` turn and answers "Finished: in-run result aborted".)
    await expect(next).toContainText('in-run result aborted')
    await expect(backgroundAgents(page)).toHaveCount(0)
  })

  test('Stop all ends every running agent; the next turn delivers their reports @smoke', async ({ page, api, cleanup }) => {
    const chatId = await openBackgroundChat(page, api, cleanup)
    await sendMessage(page, 'bg explore loop')
    await expect(lastAssistantMessage(page)).toContainText(TASK_ID)
    await expectMessageStatus(lastAssistantMessage(page), 'done')
    await sendMessage(page, 'bg general loop')
    await expect(assistantMessages(page)).toHaveCount(2)
    await expect(lastAssistantMessage(page)).toContainText(TASK_ID)
    const dock = backgroundAgents(page)
    await expect(dock).toHaveAttribute('data-count', '2')
    await expect(dock).toContainText('Background agents · 2 running')
    await expect(backgroundAgentRow(page, { 'data-kind': 'general' })).toHaveAttribute('data-state', 'running')

    await dock.getByTestId(testIds.backgroundAgentsStopAll).click()
    await expect(backgroundAgentRow(page, { 'data-state': 'aborted' })).toHaveCount(2)
    await expect(dock).toHaveAttribute('data-count', '0')
    await expect(dock).toHaveAttribute('data-total', '2')
    await expect(dock.getByTestId(testIds.backgroundAgentsStopAll)).toHaveCount(0)
    await expect.poll(async () => (await chatTasks(api, chatId)).map(task => task.status).sort()).toEqual(['aborted', 'aborted'])
    // Collapsed, the line says the reports wait.
    await dock.getByTestId(testIds.backgroundAgentsToggle).click()
    await expect(dock).toHaveAttribute('data-state', 'closed')
    await expect(dock.getByTestId(testIds.backgroundAgentsToggle)).toContainText('2 background agents finished · reports pending')
    await expect(dock.getByTestId(testIds.backgroundAgentsToggle)).toHaveAccessibleName('Show background agents, 2 finished')

    // Nothing starts by itself; the next turn delivers both stopped reports at its first step.
    await sendMessage(page, 'hello')
    const next = lastAssistantMessage(page)
    await expect(assistantMessages(page)).toHaveCount(3)
    await expectMessageStatus(next, 'done')
    await expect(userMessages(page)).toHaveCount(3)
    await expect(next.getByTestId(testIds.taskResult)).toHaveCount(2)
    await expect(byTestId(next, testIds.taskResult, { 'data-status': 'aborted', 'data-variant': 'inline' })).toHaveCount(2)
    await expect(next).toContainText(/Background result: aborted \| /)
    await expect(dock).toHaveCount(0)
  })

  test('a result that arrives while a reply runs is an inline note; a reload and a second page show the dock @smoke', async ({ page, context, api, cleanup }) => {
    const chatId = await openBackgroundChat(page, api, cleanup)
    // The child (two 500 ms steps) finishes while the reply takes ten 400 ms steps: the result joins the reply.
    await sendMessage(page, 'bg explore steps 10')
    const reply = lastAssistantMessage(page)
    await expect(reply).toContainText('Finished: in-run result completed', { timeout: 15_000 })
    await expectMessageStatus(reply, 'done')
    const note = reply.getByTestId(testIds.taskResult)
    await expect(note).toHaveAttribute('data-variant', 'inline')
    await expect(note).toHaveAttribute('data-status', 'completed')
    await expect(userMessages(page)).toHaveCount(1)
    await expect(assistantMessages(page)).toHaveCount(1)

    // A running agent: the dock comes back after a reload ...
    await sendMessage(page, 'bg explore loop')
    await expect(assistantMessages(page)).toHaveCount(2)
    const taskId = (await waitForChatTask(api, chatId, item => item.status === 'running')).id
    await page.reload()
    const row = backgroundAgentRow(page, { 'data-task-id': taskId })
    await expect(row).toHaveAttribute('data-state', 'running')
    await expect(backgroundAgents(page)).toHaveAttribute('data-count', '1')

    // ... and a second page of the chat sees it; its Stop reaches the first page.
    const second = await context.newPage()
    try {
      await second.goto(`/chat/${chatId}`)
      const secondRow = backgroundAgentRow(second, { 'data-task-id': taskId })
      await expect(secondRow).toHaveAttribute('data-state', 'running')
      await secondRow.getByTestId(testIds.backgroundAgentStop).click()
      await expect(secondRow).toHaveAttribute('data-state', 'aborted')
      await expect(row).toHaveAttribute('data-state', 'aborted')
      await expect(row.locator('[data-slot="background-agent-pending"]')).toHaveText('Report pending')
    }
    finally {
      await second.close()
    }
  })
})
