// Skills in the chat (docs/UI.md 2.17, 7.28; ADR-045) with `mock:agents` (docs/PROVIDERS.md 8): `skill <name>` calls the
// `core-agent` tool `skill`, then answers `Skill loaded: <the first 80 characters of the content>`.
// - A project skill (`.harness/skills/<name>/SKILL.md` with a supporting file): the row reads "Loaded skill {name}" with
//   the source "Project" (named "Loaded skill {name}, Project"), runs without an approval, and expands to the body: the
//   description, the folder, the supporting files, the instructions and the caption; a reload keeps it.
// - An unknown skill: the row reads "Couldn't load skill" and the reply names the failure.
import type { Locator } from '@playwright/test'
import {
  byTestId,
  definitionFile,
  expect,
  expectMessageStatus,
  lastAssistantMessage,
  MOCK_AGENTS_MODEL,
  seedProjectChat,
  sendMessage,
  test,
  testIds,
  uniqueId,
} from '../../helpers/index.ts'

/** The expanded body of a tool row (the part around the row). */
function toolBody(row: Locator): Locator {
  return row.locator('xpath=ancestor::*[@data-slot="tool-part"][1]').getByTestId(testIds.toolRowOutput)
}

test.describe('skills', () => {
  test('a project skill loads as a "Loaded skill" row whose body shows the instructions and the files @smoke', async ({ page, api, cleanup }) => {
    const skill = uniqueId('pdf')
    const marker = uniqueId('marker')
    const content = `PDF-SKILL: read ref.md first. ${marker}\n\n## Steps\n\n1. Read the form.\n2. Fill the fields.\n`
    const { chatId } = await seedProjectChat(api, cleanup, {
      modelRef: MOCK_AGENTS_MODEL,
      prefix: 'skills',
      files: {
        [`.harness/skills/${skill}/SKILL.md`]: definitionFile({ name: skill, description: 'Works with PDF forms.' }, content),
        [`.harness/skills/${skill}/ref.md`]: '# Reference\n',
      },
    })

    await page.goto(`/chat/${chatId}`)
    // The agent's instructions list the skill.
    await sendMessage(page, 'skills?')
    await expect(lastAssistantMessage(page)).toContainText(`Skills: ${skill}`)
    await sendMessage(page, `skill ${skill}`)
    const reply = lastAssistantMessage(page)
    await expect(reply).toContainText('Skill loaded: PDF-SKILL: read ref.md first.')
    await expectMessageStatus(reply, 'done')
    await expect(page.getByTestId(testIds.toolApproval)).toHaveCount(0)

    const row = byTestId(reply, testIds.toolRow, { 'data-tool-name': 'skill' })
    await expect(row).toHaveAttribute('data-state', 'output-available')
    await expect(row.locator('[data-slot="skill-row-label"]')).toHaveText('Loaded skill')
    await expect(row.locator('[data-slot="skill-row-name"]')).toHaveText(skill)
    await expect(row.locator('[data-slot="skill-row-source"]')).toHaveText('Project')
    const trigger = row.getByRole('button').first()
    await expect(trigger).toHaveAccessibleName(`Loaded skill ${skill}, Project`)

    // The body: what the agent read.
    await trigger.click()
    const body = toolBody(row).locator('[data-slot="skill-body"]')
    await expect(body).toBeVisible()
    await expect(body.locator('[data-slot="skill-description"]')).toHaveText('Works with PDF forms.')
    await expect(body.locator('[data-slot="skill-base-dir"]')).toContainText(`.harness/skills/${skill}`)
    await expect(body.locator('[data-slot="skill-files"]').getByRole('listitem')).toHaveText(['ref.md'])
    await expect(body.locator('[data-slot="skill-content"]')).toContainText(marker)
    await expect(body.locator('[data-slot="skill-content"]')).toContainText('Fill the fields.')
    await expect(body.locator('[data-slot="skill-caption"]')).toHaveText('The agent read these instructions.')

    // A reload keeps the row.
    await page.reload()
    await expect(row.locator('[data-slot="skill-row-name"]')).toHaveText(skill)
    await expect(row.locator('[data-slot="skill-row-source"]')).toHaveText('Project')
  })

  test('an unknown skill: "Couldn\'t load skill" and the failure in the reply @smoke', async ({ page, api, cleanup }) => {
    const { chatId } = await seedProjectChat(api, cleanup, {
      modelRef: MOCK_AGENTS_MODEL,
      prefix: 'skills',
      files: { [`.harness/skills/known/SKILL.md`]: definitionFile({ name: 'known', description: 'A known skill.' }, 'Known.\n') },
    })
    await page.goto(`/chat/${chatId}`)
    await sendMessage(page, 'skill nope')
    const reply = lastAssistantMessage(page)
    await expectMessageStatus(reply, 'done')
    await expect(reply).toContainText('The tool call failed:')
    await expect(reply).toContainText('Unknown skill')
    const row = byTestId(reply, testIds.toolRow, { 'data-tool-name': 'skill' })
    await expect(row.locator('[data-slot="skill-row-label"]')).toHaveText('Couldn\'t load skill')
    await expect(row.locator('[data-slot="skill-row-name"]')).toHaveText('nope')
  })
})
