// Code plugins in the browser (docs/UI.md 8.6, 8.10; docs/PLUGINS.md 8; docs/API.md 5.18): New plugin -> Code plugin
// -> Tool template creates a trusted, active plugin and opens its Source tab; a syntax error introduced in the editor
// makes "Build & reload" report a diagnostic (the running code stays active); the fixed and edited source builds,
// reloads and stays trusted; then a chat on the mock OpenAI server calls the new tool, the approval card appears
// (template policy `ask`), and after Allow the tool row shows the output of the edited code.
import type { MockOpenAIServer } from '../../fixtures/mock-openai-server.ts'
import { expect, test } from '@playwright/test'
import { startMockOpenAI } from '../../fixtures/mock-openai-server.ts'
import { fixtureManifest, withBaseURL } from '../../fixtures/plugins.ts'
import { getPlugin, readPluginFile, recreateDeclarativePlugin, removeChat, removePlugin, toolNames } from './_support/api.ts'
import { testIds } from './_support/testids.ts'
import {
  appendToEditor,
  byTestId,
  lastAssistantMessage,
  replaceEditorContent,
  selectModel,
  sendMessage,
  startNewChat,
  toolRow,
} from './_support/ui.ts'

const PLUGIN_ID = 'e2e-code-tool'
const TOOL = 'e2e_code_tool_text_stats'
const LLM_PLUGIN = 'e2e-tools-llm'
const MODEL_REF = `${LLM_PLUGIN}:tool-caller`
/** A line of the Tool template's `execute`; the spec adds a field after it. */
const ANCHOR = 'readingMinutes: Math.ceil(words / 230),'

test.describe('Code plugins @plugins', () => {
  let mock: MockOpenAIServer
  /** Chats a test opened; deleted after it. */
  const chats: string[] = []

  test.beforeAll(async ({ request }) => {
    mock = await startMockOpenAI()
    await removePlugin(request, PLUGIN_ID)
    await recreateDeclarativePlugin(request, fixtureManifest(LLM_PLUGIN, withBaseURL(mock.baseURL)))
  })

  test.afterEach(async ({ request }) => {
    for (const id of chats.splice(0))
      await removeChat(request, id)
  })

  test.afterAll(async ({ request }) => {
    await removePlugin(request, PLUGIN_ID)
    await removePlugin(request, LLM_PLUGIN)
    await mock?.close()
  })

  test('builds a Tool template plugin edited in the Source tab and calls it in chat @smoke', async ({ page, request }) => {
    // Create from the Tool template.
    await page.goto('/plugins')
    await page.getByTestId(testIds.pageHeader).getByTestId(testIds.pluginsNew).click()
    await page.getByTestId(testIds.pluginsNewCode).click()
    await expect(page).toHaveURL(/\/plugins\/new\?type=code/)
    const form = page.getByTestId(testIds.codePluginForm)
    await form.getByTestId(testIds.codePluginName).fill('E2E Code Tool')
    await expect(form.getByTestId(testIds.codePluginId)).toHaveValue(PLUGIN_ID)
    const template = byTestId(form, testIds.codePluginTemplate, { 'data-value': 'tool' })
    await template.click()
    await expect(template).toHaveAttribute('aria-checked', 'true')
    await form.getByTestId(testIds.codePluginCreate).click()

    await expect(page).toHaveURL(new RegExp(`/plugins/${PLUGIN_ID}\\?tab=source`))
    await expect(page.getByTestId(testIds.pluginDetail)).toHaveAttribute('data-state', 'active')
    await expect(page.getByTestId(testIds.pluginTabSource)).toHaveAttribute('data-state', 'active')
    await expect(byTestId(page, testIds.codeFile, { 'data-path': 'plugin.json' })).toBeVisible()
    await expect(byTestId(page, testIds.codeEditorTab, { 'data-path': 'index.mjs' })).toBeVisible()
    const editor = page.getByTestId(testIds.codeEditor)
    await expect(editor).toContainText(`name: '${TOOL}'`)
    const created = await getPlugin(request, PLUGIN_ID)
    expect(created).toMatchObject({ kind: 'code', source: 'created', editable: true, trust: { required: true, trusted: true } })
    expect(await toolNames(request)).toContain(TOOL)
    const original = await readPluginFile(request, PLUGIN_ID, 'index.mjs')
    expect(original).toContain(ANCHOR)

    // A syntax error: Build & reload saves the file and reports the diagnostic.
    const tab = byTestId(page, testIds.codeEditorTab, { 'data-path': 'index.mjs' })
    const buildLog = page.getByTestId(testIds.codeBuildLog)
    await appendToEditor(page, '\nconst broken = ;\n')
    await expect(tab).toHaveAttribute('data-dirty', 'true')
    await page.getByTestId(testIds.codeBuildReload).click()
    await expect(buildLog).toContainText('Build failed')
    await expect(buildLog).toContainText(/index\.mjs:\d+:\d+/)
    await expect(buildLog).toContainText('Unexpected ";"')
    const inlineDiagnostic = editor.getByTitle(/Unexpected ";"/)
    await expect(inlineDiagnostic).toBeVisible()
    await expect(tab).toHaveAttribute('data-dirty', 'false')
    expect(await readPluginFile(request, PLUGIN_ID, 'index.mjs')).toContain('const broken = ;')
    await expect(page.getByTestId(testIds.pluginDetail)).toHaveAttribute('data-state', 'active')

    // Fix it and change the tool: its output gains a field.
    const fixed = original.replace(ANCHOR, `${ANCHOR}\n          editedBy: 'e2e',`)
    await replaceEditorContent(page, fixed)
    await expect(tab).toHaveAttribute('data-dirty', 'true')
    await page.getByTestId(testIds.codeBuildReload).click()
    await expect(buildLog).toContainText('Build succeeded')
    await expect(buildLog).toContainText('Reloaded (active)')
    await expect(inlineDiagnostic).toHaveCount(0)
    await expect(tab).toHaveAttribute('data-dirty', 'false')
    expect(await readPluginFile(request, PLUGIN_ID, 'index.mjs')).toBe(fixed)
    const rebuilt = await getPlugin(request, PLUGIN_ID)
    expect(rebuilt).toMatchObject({ state: 'active', trust: { trusted: true } })
    expect(rebuilt?.trust.hash).not.toBe(created?.trust.hash)

    // The mock model calls the tool; the approval card asks first (policy `ask`).
    await startNewChat(page)
    await selectModel(page, MODEL_REF)
    mock.reset()
    chats.push(await sendMessage(page, `Count the words, please [[tool:${TOOL} {"text":"one two three four"}]]`))
    const row = toolRow(page, TOOL)
    await expect(row).toHaveAttribute('data-state', 'approval-requested')
    const approval = byTestId(page, testIds.toolApproval, { 'data-tool-name': TOOL })
    await expect(approval).toContainText(`Allow ${TOOL}?`)
    await expect(approval).toContainText('one two three four')
    expect(mock.chatRequests()[0]?.toolNames).toContain(TOOL)

    await approval.getByTestId(testIds.toolApprovalAllow).click()
    await expect(row).toHaveAttribute('data-state', 'output-available')
    await expect(approval).toBeHidden()
    await row.click()
    const output = page.getByTestId(testIds.toolRowOutput).first()
    await expect(output).toContainText('"words": 4')
    await expect(output).toContainText('"editedBy": "e2e"')
    const reply = lastAssistantMessage(page)
    await expect(reply).toHaveAttribute('data-status', 'done')
    await expect(reply).toContainText('Tool result:')
    await expect(reply).toContainText('editedBy')
    const followUp = mock.chatRequests().at(-1)
    expect(followUp?.body?.messages?.at(-1)).toMatchObject({ role: 'tool' })
  })
})
