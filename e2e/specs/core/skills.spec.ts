// Skills in the chat (docs/UI.md 2.17, 7.28; ADR-045) with `mock:agents` (docs/PROVIDERS.md 8): `skill <name>` calls the
// `core-agent` tool `skill`, then answers `Skill loaded: <the first 80 characters of the content>`.
// - A project skill (`.harness/skills/<name>/SKILL.md` with a supporting file): the row reads "Loaded skill {name}" with
//   the source "Project" (named "Loaded skill {name}, Project"), runs without an approval, and expands to the body: the
//   description, the folder, the supporting files, the instructions and the caption; a reload keeps it.
// - An unknown skill: the row reads "Couldn't load skill" and the reply names the failure.
// - Phase 11 (ADR-052; docs/UI.md 7.8): user-invocable skills in the slash menu: the Skills group (last, `data-group`
//   `skill`) with the argument hint and the source, a 64-character name, `/name args` expands the skill's content (the
//   reply shows it), the user message's badge names a skill ("Skill" in its screen reader text, "Project skill") after a
//   reload; a skill with `user-invocable: false` is not in the menu.
import type { Locator } from '@playwright/test'
import {
  byTestId,
  composer,
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
  userMessages,
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

  test('user-invocable skills: the Skills group with the hint, a 64-character name, the skill badge; a hidden skill is not offered @smoke', async ({ page, api, cleanup }) => {
    const id = uniqueId('forms')
    // The longest name a skill (and a slash command) may have: 64 characters.
    const skill = `${id}-${'x'.repeat(63 - id.length)}`
    expect(skill).toHaveLength(64)
    const hidden = uniqueId('hidden')
    const marker = uniqueId('marker')
    const { chatId } = await seedProjectChat(api, cleanup, {
      modelRef: MOCK_AGENTS_MODEL,
      prefix: 'skills',
      files: {
        [`.harness/skills/${skill}/SKILL.md`]: definitionFile({ 'name': skill, 'description': 'Fills PDF forms', 'argument-hint': '<form>' }, `SKILL-BODY ${marker} for $ARGUMENTS.\n`),
        [`.harness/skills/${hidden}/SKILL.md`]: definitionFile({ 'name': hidden, 'description': 'Only for the agent', 'user-invocable': 'false' }, 'Hidden.\n'),
      },
    })

    await page.goto(`/chat/${chatId}`)
    const input = page.getByTestId(testIds.composerInput)
    await expect(input).toBeEditable()
    await input.fill('/')
    const menu = page.getByTestId(testIds.slashMenu)
    const row = byTestId(menu, testIds.slashMenuItem, { 'data-value': skill, 'data-group': 'skill' })
    await expect(row).toBeAttached()
    // The Skills group comes last.
    expect(await menu.locator('[data-group]:not([data-testid])').evaluateAll(items => items.map(item => item.getAttribute('data-group')).at(-1))).toBe('skill')
    await expect(row.locator('[data-slot="slash-menu-hint"]')).toHaveText('<form>')
    await expect(row.locator('[data-slot="slash-menu-detail"]')).toHaveText('Project')
    await expect(row).toHaveAccessibleName(`/${skill}, Fills PDF forms, arguments <form>`)
    await expect(byTestId(menu, testIds.slashMenuItem, { 'data-value': hidden })).toHaveCount(0)
    await input.fill(`/${hidden}`)
    await expect(byTestId(menu, testIds.slashMenuItem, { 'data-value': hidden })).toHaveCount(0)

    // Picking it inserts the name (the ghost argument hint of such a long name: the fixme test below).
    await input.fill(`/${skill.slice(0, 20)}`)
    await expect(menu.getByTestId(testIds.slashMenuItem)).toHaveCount(1)
    await input.press('Enter')
    await expect(input).toHaveValue(`/${skill} `)
    await input.pressSequentially('the tax form')
    await page.getByTestId(testIds.composerSend).click()
    const reply = lastAssistantMessage(page)
    await expectMessageStatus(reply, 'done')
    await expect(reply).toContainText(`Agents mock: SKILL-BODY ${marker} for the tax form.`)
    await expect(userMessages(page).last()).toContainText(`/${skill} the tax form`)

    // The badge comes with the stored message: a skill, from the project.
    await page.reload()
    const badge = userMessages(page).last().locator('[data-slot="command-badge"]')
    await expect(badge).toContainText(`/${skill}`)
    await expect(badge).toHaveAccessibleName(`Skill /${skill}, Project skill`)
    await badge.focus()
    await expect(page.locator('[data-slot="command-badge-source"]')).toHaveText('Project skill')
    const detail = await api.getChat(chatId)
    expect(detail.messages[0]?.metadata?.command).toMatchObject({ name: skill, kind: 'skill', source: 'project' })
  })

  // The ghost argument hint follows skill names of up to 64 characters (fixed in P11-B, W11.19).
  test('the ghost argument hint follows a 64-character skill name', async ({ page, api, cleanup }) => {
    const id = uniqueId('forms')
    const skill = `${id}-${'x'.repeat(63 - id.length)}`
    const { chatId } = await seedProjectChat(api, cleanup, {
      modelRef: MOCK_AGENTS_MODEL,
      prefix: 'skills',
      files: { [`.harness/skills/${skill}/SKILL.md`]: definitionFile({ 'name': skill, 'description': 'Fills PDF forms', 'argument-hint': '<form>' }, 'Fill $ARGUMENTS.\n') },
    })
    await page.goto(`/chat/${chatId}`)
    const input = page.getByTestId(testIds.composerInput)
    await input.fill(`/${skill} `)
    await expect(composer(page).getByTestId(testIds.slashArgumentHint)).toContainText('<form>')
    await expect(input).toHaveAccessibleDescription(/Arguments: <form>/)
  })
})
