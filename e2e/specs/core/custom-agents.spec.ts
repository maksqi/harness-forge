// Custom agents in the chat (docs/UI.md 2.17, 7.27; ADR-045) with `mock:agents` as the chat model and, because
// `subagentModelRef` is cleared for the test, as the model of its sub-agents (docs/PROVIDERS.md 8): `agent <type>`
// starts one `task` call of that type; the child lists the folder and reports its persona (the `PERSONA:` line of the
// agent's body) and the tools it was offered.
// - The task block of a project agent is `data-kind="custom"` with its name as the label and `data-agent-type`; its
//   trigger is named "Sub-agent {name}: …"; hovering the label opens the card with the description and the source
//   (`Project: .harness/agents/{name}.md`).
// - The agent's `tools` list only narrows: the report lists the allowed tools that run without approval in Ask
//   (`read_file`, `list_directory`), never `write_file`; no approval card appears; a reload keeps the block.
import {
  byTestId,
  definitionFile,
  expect,
  expectMessageStatus,
  lastAssistantMessage,
  MOCK_AGENTS_MODEL,
  mockAgentReport,
  seedProjectChat,
  sendMessage,
  test,
  testIds,
  uniqueId,
  useAgentSettings,
} from '../../helpers/index.ts'

test.describe('custom agents', () => {
  test.beforeEach(async ({ api, cleanup }) => {
    // The sub-agents run on the chat's model (`mock:agents`).
    await useAgentSettings(api, cleanup, { subagentModelRef: null })
  })

  test('a project agent runs as its own task block with its name and card; its report lists only the allowed tools @smoke', async ({ page, api, cleanup }) => {
    // At most 24 characters: the label shows the whole name.
    const reviewer = uniqueId('rv')
    const { chatId } = await seedProjectChat(api, cleanup, {
      modelRef: MOCK_AGENTS_MODEL,
      prefix: 'agents',
      files: {
        [`.harness/agents/${reviewer}.md`]: definitionFile(
          { name: reviewer, description: 'Reviews code for the e2e run.', tools: ['read_file', 'list_directory', 'write_file'] },
          'PERSONA: strict reviewer\nReview the code carefully.\n',
        ),
        'src/app.ts': 'export {}\n',
      },
    })
    const report = mockAgentReport('strict reviewer', ['list_directory', 'read_file'])

    await page.goto(`/chat/${chatId}`)
    await sendMessage(page, `agent ${reviewer}`)
    const reply = lastAssistantMessage(page)
    await expectMessageStatus(reply, 'done')
    await expect(reply).toContainText(`Agent report: ${report}`)
    await expect(page.getByTestId(testIds.toolApproval)).toHaveCount(0)

    const block = byTestId(reply, testIds.taskBlock, { 'data-kind': 'custom', 'data-agent-type': reviewer })
    await expect(block).toHaveAttribute('data-state', 'completed')
    const label = block.locator('[data-slot="task-agent-label"]')
    await expect(label).toHaveText(reviewer)
    const trigger = block.getByTestId(testIds.taskBlockTrigger)
    await expect(trigger).toHaveAccessibleName(`Sub-agent ${reviewer}: Run ${reviewer}, completed, 1 tool call`)
    await expect(trigger).toHaveAccessibleDescription(`Reviews code for the e2e run.. Project: .harness/agents/${reviewer}.md`)
    // The live line is the report's first sentence (its Markdown marks removed, so `_` goes too).
    await expect(block.locator('[data-slot="task-live"]')).toContainText('Report: persona=strict reviewer | tools:')

    // The card: the description and where the agent came from.
    await label.hover()
    const card = page.locator('[data-slot="task-agent-card"]')
    await expect(card).toBeVisible()
    await expect(card).toContainText(reviewer)
    await expect(card).toContainText('Reviews code for the e2e run.')
    await expect(card.locator('[data-slot="task-agent-source"]')).toHaveText(`Project: .harness/agents/${reviewer}.md`)
    await page.mouse.move(0, 0)
    await expect(card).toBeHidden()

    // Expanded: the step and the report with the allowed tools only.
    await trigger.click()
    await expect(trigger).toHaveAttribute('aria-expanded', 'true')
    await expect(byTestId(block, testIds.taskStep, { 'data-tool-name': 'list_directory' })).toHaveAttribute('data-state', 'done')
    await expect(block.getByTestId(testIds.taskReport)).toContainText(report)
    await expect(block.getByTestId(testIds.taskReport)).not.toContainText('write_file')

    // The server kept the agent's snapshot; a reload shows the same block.
    const detail = await api.getChat(chatId)
    const part = detail.messages.at(-1)?.parts.find(item => item.type === 'tool-task') as { output?: { type?: string, agent?: { source?: string, path?: string } } } | undefined
    expect(part?.output).toMatchObject({ type: reviewer, agent: { source: 'project', path: `.harness/agents/${reviewer}.md` } })
    await page.reload()
    await expect(block).toHaveAttribute('data-state', 'completed')
    await expect(label).toHaveText(reviewer)
  })
})
