// Plugins with agents and skills (docs/UI.md 8.1, 8.2, 8.8, 9.12; plugin API 1.4.0): a declarative plugin contributes
// two agents and a skill; a personal agent takes the name of one of its agents.
// - The Browse filter "Agents and skills" (`?filter=agents`) lists exactly the plugins that contribute agents or skills,
//   this one among them; its card summary ends with "2 agents · 1 skill".
// - The plugin detail shows an Agents section (a row per agent: the model ref and the tools; the shadowed one with its
//   Shadowed badge, "Not used: your personal agent wins.") and a Skills section; "Open in Customize" opens Settings ->
//   Customize on the Agents tab, where the plugin's rows are listed From plugins (one shadowed).
import {
  byTestId,
  createCustomizationPlugin,
  createPersonalDefinition,
  customizationPluginManifest,
  customizationRow,
  customizeSection,
  definitionFile,
  expect,
  test,
  testIds,
  uniqueId,
} from '../../helpers/index.ts'

test.describe('plugin agents and skills @plugins', () => {
  test('the "Agents and skills" filter, the card summary and the detail sections @smoke', async ({ page, api, cleanup }) => {
    const pluginId = uniqueId('e2e-agents')
    const pluginName = `Agent kit ${pluginId.slice(-6)}`
    const reviewer = uniqueId('kit-rv')
    const shadowed = uniqueId('kit-sh')
    const skill = uniqueId('kit-notes')
    await createCustomizationPlugin(api, cleanup, customizationPluginManifest(pluginId, pluginName, {
      agents: [
        { name: reviewer, description: 'Reviews a diff for bugs.', instructions: 'PERSONA: kit reviewer', tools: ['read_file', 'search_files'], model: 'mock:agents' },
        { name: shadowed, description: 'Loses its name to a personal agent.', instructions: 'PERSONA: kit shadowed' },
      ],
      skills: [{ name: skill, description: 'How to write release notes.', content: '# Release notes\n\nList the user-facing changes.\n' }],
    }))
    await createPersonalDefinition(api, cleanup, { kind: 'agent', name: shadowed, content: definitionFile({ name: shadowed, description: 'My own agent.' }, 'PERSONA: mine\n') })
    const plugins = (await api.client.plugins.list()).items
    const withAgents = plugins.filter(plugin => plugin.contributions.agents.length > 0 || plugin.contributions.skills.length > 0)
    expect(withAgents.map(plugin => plugin.id)).toContain(pluginId)

    // The filter lists exactly the plugins with agents or skills.
    await page.goto('/plugins')
    const filter = byTestId(page.getByTestId(testIds.sidebar), testIds.pluginsFilter, { 'data-value': 'agents' })
    await expect(filter).toContainText('Agents and skills')
    await expect(page.getByTestId(testIds.sidebar).locator('[data-slot="plugins-filter-count"][data-value="agents"]')).toHaveText(String(withAgents.length))
    await filter.click()
    await expect(filter).toHaveAttribute('data-active', 'true')
    await expect(page).toHaveURL(/[?&]filter=agents(?:&|$)/)
    await expect(page.getByTestId(testIds.pluginCard)).toHaveCount(withAgents.length)
    const card = byTestId(page, testIds.pluginCard, { 'data-plugin-id': pluginId })
    await expect(card).toContainText(pluginName)
    await expect(card).toContainText('2 agents · 1 skill')

    // The detail: the Agents and the Skills sections.
    await card.getByText(pluginName, { exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`/plugins/${pluginId}`))
    const agents = byTestId(page, testIds.pluginCustomizations, { 'data-kind': 'agent' })
    await expect(agents).toHaveAttribute('data-count', '2')
    const reviewerRow = byTestId(agents, testIds.pluginCustomization, { 'data-name': reviewer })
    await expect(reviewerRow).toHaveAttribute('data-state', 'active')
    await expect(reviewerRow).toContainText('Reviews a diff for bugs.')
    await expect(reviewerRow.locator('[data-slot="plugin-customization-meta"]')).toHaveText('mock:agents · 2 tools')
    const shadowedRow = byTestId(agents, testIds.pluginCustomization, { 'data-name': shadowed })
    await expect(shadowedRow).toHaveAttribute('data-state', 'shadowed')
    await expect(shadowedRow.locator('[data-slot="plugin-customization-meta"]')).toHaveText('Default model · All tools')
    const badge = shadowedRow.locator('[data-slot="plugin-customization-shadowed"]')
    await expect(badge).toHaveText('Shadowed')
    await expect(badge).toHaveAttribute('aria-description', 'Not used: your personal agent wins.')
    const skills = byTestId(page, testIds.pluginCustomizations, { 'data-kind': 'skill' })
    await expect(skills).toHaveAttribute('data-count', '1')
    await expect(byTestId(skills, testIds.pluginCustomization, { 'data-name': skill })).toContainText('How to write release notes.')

    // Open in Customize: the Agents tab lists the plugin's agents From plugins.
    await agents.locator('[data-slot="plugin-customizations-open"]').click()
    await expect(page).toHaveURL(/\/settings\/customize\?tab=agents/)
    const section = customizeSection(page, 'plugin')
    await expect(customizationRow(section, { 'data-name': reviewer, 'data-plugin-id': pluginId })).toHaveAttribute('data-state', 'active')
    await expect(customizationRow(section, { 'data-name': reviewer })).toContainText(pluginName)
    await expect(customizationRow(section, { 'data-name': shadowed, 'data-plugin-id': pluginId })).toHaveAttribute('data-state', 'shadowed')
    await expect(customizationRow(customizeSection(page, 'user'), { 'data-name': shadowed })).toHaveAttribute('data-state', 'active')
  })
})
