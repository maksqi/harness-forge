// The agent's todo list (docs/UI.md 2.16, 7.25; ADR-041) with `mock:todo` and `mock:plan` (docs/PROVIDERS.md 8):
// - `mock:todo` sends three `todo_write` calls 400 ms apart (all to do, then 1/3 with "Changing the code", then all
//   done): the strip in the composer dock follows them (recorded by `recordStates`, because one state lasts only
//   400 ms) and hides once the run ended with every item done; each call is a `todo_write` row, the last one reads
//   "3/3" and expands to the list; a reload keeps the rows.
// - An unfinished list of the latest reply (`mock:plan` waits for its plan approval with "Exploring the project" in
//   progress) keeps the strip after the run; its toggle expands the list above it ("Tasks 0/2", "Hide tasks") and the
//   open state is remembered in `localStorage['hf-todo-expanded']`.
import {
  byTestId,
  CHAT_URL_PATTERN,
  chatIdFromUrl,
  expect,
  expectMessageStatus,
  expectStatesInOrder,
  lastAssistantMessage,
  MOCK_PLAN_TODOS,
  MOCK_TODO_DONE,
  MOCK_TODO_ITEMS,
  openNewChat,
  recordStates,
  seedProjectChat,
  selectModel,
  sendMessage,
  storageItem,
  test,
  testIds,
} from '../../helpers/index.ts'

/** The strip as one string: `<open|closed> <done>/<total> <toggle text>`. */
const STRIP_SNAPSHOT = `return el.dataset.state + ' ' + el.dataset.value + '/' + el.dataset.count + ' '
  + el.querySelector('[data-testid="todo-strip-toggle"]').textContent.replace(/\\s+/g, ' ').trim()`

test.describe('todos', () => {
  test('the strip goes from 0/3 over 1/3 to 3/3 and hides after the run; the row reads 3/3, also after a reload @smoke', async ({ page, cleanup }) => {
    await openNewChat(page)
    const recorder = await recordStates(page, 'todo-strip', testIds.todoStrip, STRIP_SNAPSHOT)
    await selectModel(page, 'mock:todo')
    await sendMessage(page, 'Do the three tasks.')
    await expect(page).toHaveURL(CHAT_URL_PATTERN)
    const chatId = chatIdFromUrl(page)
    cleanup(api => api.removeChat(chatId))

    const reply = lastAssistantMessage(page)
    await expect(reply).toContainText(MOCK_TODO_DONE)
    await expectMessageStatus(reply, 'done')
    const strip = page.getByTestId(testIds.todoStrip)
    await expect(strip, 'every item is done: the strip hides after the run').toHaveCount(0)
    expectStatesInOrder(await recorder.states(), [
      'closed 0/3 0/3',
      `closed 1/3 1/3 · ${MOCK_TODO_ITEMS[1].activeForm}`,
      'closed 3/3 All tasks done',
      '',
    ], 'the todo strip')

    // Three todo_write rows; the last one reads 3/3 and expands to the finished list.
    const rows = byTestId(reply, testIds.toolRow, { 'data-tool-name': 'todo_write' })
    await expect(rows).toHaveCount(3)
    await expect(rows.last()).toHaveAttribute('data-status', 'done')
    await expect(rows.last().getByTestId(testIds.toolRowSummary)).toHaveText('3/3')
    await expect(rows.first().getByTestId(testIds.toolRowSummary)).toHaveText('0/3')
    await rows.last().getByRole('button').first().click()
    const list = reply.getByTestId(testIds.toolRowOutput).last().getByTestId(testIds.todoList)
    await expect(list).toBeVisible()
    const items = list.getByTestId(testIds.todoItem)
    await expect(items).toHaveCount(3)
    for (const [index, item] of MOCK_TODO_ITEMS.entries()) {
      await expect(items.nth(index)).toHaveAttribute('data-status', 'completed')
      await expect(items.nth(index)).toContainText(item.content)
    }

    // A reload keeps the rows and the summary; the finished list never brings the strip back.
    await page.reload()
    await expectMessageStatus(lastAssistantMessage(page), 'done')
    const reloaded = byTestId(lastAssistantMessage(page), testIds.toolRow, { 'data-tool-name': 'todo_write' })
    await expect(reloaded).toHaveCount(3)
    await expect(reloaded.last().getByTestId(testIds.toolRowSummary)).toHaveText('3/3')
    await expect(strip).toHaveCount(0)
  })

  test('an unfinished list keeps the strip; its toggle shows the items and the open state is remembered @smoke', async ({ page, api, cleanup }) => {
    // `mock:plan` writes two todos (the first in progress), then waits for the plan approval: the list stays unfinished.
    const { chatId } = await seedProjectChat(api, cleanup, { modelRef: 'mock:plan', prefix: 'todos' })
    await api.sendChat({ chatId, modelRef: 'mock:plan', toolMode: 'plan', text: 'Plan the notes file.' })

    await page.goto(`/chat/${chatId}`)
    await expect(lastAssistantMessage(page).getByTestId(testIds.planApproval)).toBeVisible()
    const strip = page.getByTestId(testIds.todoStrip)
    const toggle = strip.getByTestId(testIds.todoStripToggle)
    await expect(strip).toHaveAttribute('data-state', 'closed')
    await expect(strip).toHaveAttribute('data-count', '2')
    await expect(strip).toHaveAttribute('data-value', '0')
    await expect(toggle).toHaveText(`0/2 · ${MOCK_PLAN_TODOS[0].activeForm}`)
    await expect(toggle).toHaveAccessibleName('Show tasks, 0 of 2 done')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(strip.getByTestId(testIds.todoList)).toHaveCount(0)
    expect(await storageItem(page, 'hf-todo-expanded')).toBeNull()

    // Open: the list above the header line, the first item in progress (its in-progress wording), the second to do.
    await toggle.click()
    await expect(strip).toHaveAttribute('data-state', 'open')
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(toggle).toHaveAccessibleName('Hide tasks')
    await expect(toggle).toHaveText('Tasks 0/2')
    await expect(toggle).toBeFocused()
    const items = strip.getByTestId(testIds.todoList).getByTestId(testIds.todoItem)
    await expect(items).toHaveCount(2)
    await expect(items.nth(0)).toHaveAttribute('data-status', 'in_progress')
    await expect(items.nth(0)).toContainText(MOCK_PLAN_TODOS[0].activeForm)
    await expect(items.nth(1)).toHaveAttribute('data-status', 'pending')
    await expect(items.nth(1)).toContainText(MOCK_PLAN_TODOS[1].content)
    expect(await storageItem(page, 'hf-todo-expanded')).toBe('1')

    // The open state survives a reload; closing it is remembered too.
    await page.reload()
    await expect(strip).toHaveAttribute('data-state', 'open')
    await expect(strip.getByTestId(testIds.todoItem)).toHaveCount(2)
    await toggle.click()
    await expect(strip).toHaveAttribute('data-state', 'closed')
    await expect(strip.getByTestId(testIds.todoList)).toHaveCount(0)
    expect(await storageItem(page, 'hf-todo-expanded')).toBe('0')
  })
})
