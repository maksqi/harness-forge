// Prompt hooks (Phase 12, ADR-057; docs/UI.md 7.31, 9.13, 9.14; docs/PROVIDERS.md 8 "Prompt hook mock (Phase 12)") with
// `mock:prompt-hook` (it answers from the first `[[ph:…]]` marker in its input) and `mock:hooks` (`call <tool> <json>`).
// Distinct from the Phase 11 `hook-prompts.spec.ts`, which covers UserPromptSubmit command hooks.
// - A personal prompt hook on a server of its own (personal hooks and the Hook model setting are global state, so the
//   shared server never sees them): Settings → General → Agent → Hook model picks Mock Prompt Hook; Customize → Hooks → New
//   hook → Type Prompt shows the prompt hook's warning, the Prompt field, the model line "Runs with Mock Prompt Hook
//   (Settings → General → Agent → Hook model)…", the 30 s default and Continue on block; saved, the row is a `prompt` row with
//   the prompt's first line. In a project chat (Auto), `call write_file` whose content holds `[[ph:deny …]]` is blocked:
//   "Blocked by hook" in the row, the note "Blocked by a PreToolUse hook: {reason}" from a "Personal hook", the turn
//   ends there and the file is never written. With Continue on block (Edit…) the reason goes back to the agent, whose
//   next step reads "Called write_file: denied | Blocked by hook: {reason}"; a call without a marker runs (an "ok" never
//   needs more than the mode allows).
// - A project UserPromptSubmit prompt hook (`model: mock:prompt-hook`, approved through the API) refuses a message whose
//   text holds `[[ph:deny …]]`: the composer keeps the text and shows the refusal with the reason and "UserPromptSubmit ·
//   Project hook"; nothing reaches the transcript; a message without the marker is answered.
// - After a turn a PreToolUse prompt hook ended, the next `call write_file` turn of the same chat calls the tool again
//   (the `mock:hooks` turn rule fixed at Gate P12-B, W12.20).
import type { Locator, Page } from '@playwright/test'
import type { StartedServer } from '../../helpers/index.ts'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  approveProjectItems,
  byTestId,
  composerRefusal,
  expect,
  expectMessageStatus,
  HarnessApi,
  hookNote,
  hookRow,
  jsonText,
  lastAssistantMessage,
  MOCK_HOOKS_MODEL,
  mockCall,
  mockHooksEcho,
  seedProject,
  seedProjectChat,
  selectPermissionMode,
  sendMessage,
  startServer,
  test,
  testIds,
  toastWith,
  toolRowHook,
  uniqueId,
  userMessages,
  writeProjectFile,
} from '../../helpers/index.ts'

const PROMPT_HOOK_MODEL = 'mock:prompt-hook'
const PROMPT_HOOK_MODEL_NAME = 'Mock Prompt Hook'
/** The editor's warning for the Prompt type (HOOK_COPY.promptWarning). */
const PROMPT_WARNING = 'A prompt hook asks a model about every matching event, using tokens each time. Its answer can block a call or make the agent continue, never allow one.'

/** A `mock:prompt-hook` marker that answers `{"ok":false,"reason":R}`. */
function denyMarker(reason: string): string {
  return `[[ph:deny ${reason}]]`
}

/** The row of a tool call in a reply. */
function toolRow(reply: Locator, tool: string): Locator {
  return byTestId(reply, testIds.toolRow, { 'data-tool-name': tool })
}

/** Expands a tool row and returns the part around it (its body holds the hook notes). */
async function expandRow(row: Locator): Promise<Locator> {
  await row.getByRole('button').first().click()
  const part = row.locator('xpath=ancestor::*[@data-slot="tool-part"][1]')
  await expect(part.getByTestId(testIds.toolRowOutput)).toBeVisible()
  return part
}

/** Sends one composer message and returns the new reply once it is done. */
async function turn(page: Page, text: string): Promise<Locator> {
  const before = await page.getByTestId(testIds.messageAssistant).count()
  await sendMessage(page, text)
  await expect(page.getByTestId(testIds.messageAssistant)).toHaveCount(before + 1)
  const reply = lastAssistantMessage(page)
  await expectMessageStatus(reply, 'done')
  return reply
}

test.describe('prompt hooks (Phase 12)', () => {
  let server: StartedServer | undefined

  test.beforeAll(async () => {
    server = await startServer({ label: 'hf-e2e-prompt-hooks' })
  })

  test.afterAll(async () => {
    await server?.stop()
  })

  test('a personal Prompt hook on PreToolUse blocks write_file; Continue on block; the Hook model setting @smoke', async ({ page, cleanup }) => {
    test.setTimeout(90_000)
    const { baseURL } = server!
    const session = new HarnessApi(page.request, baseURL)
    const marker = uniqueId('ph')
    const reason = `no secrets in files ${marker}`
    const { project, folder } = await seedProject(session, cleanup, { prefix: 'prompt-hooks' })
    const chat = await session.createChat({ title: `Prompt hooks ${marker}`, projectId: project.id, modelRef: MOCK_HOOKS_MODEL })

    // Settings → General → Agent → Hook model: automatic by default, then Mock Prompt Hook.
    await page.goto(`${baseURL}/settings/general`)
    const hookModel = page.getByTestId(testIds.settingsHookModel)
    await expect(hookModel).toHaveAttribute('data-value', '')
    await expect(hookModel).toContainText('Automatic (the provider\'s small model)')
    await hookModel.click()
    await byTestId(page, testIds.modelSelectOption, { 'data-model-ref': PROMPT_HOOK_MODEL }).click()
    await expect(hookModel).toHaveAttribute('data-value', PROMPT_HOOK_MODEL)
    await expect.poll(async () => (await session.getSettings()).hookModelRef).toBe(PROMPT_HOOK_MODEL)

    // New hook → Type Prompt: the prompt hook's warning and fields.
    await page.goto(`${baseURL}/settings/customize?tab=hooks`)
    const panel = page.getByTestId(testIds.hooksPanel)
    await expect(panel).toBeVisible()
    await page.getByTestId(testIds.customizeNew).click()
    const editor = page.getByTestId(testIds.hookEditor)
    await expect(editor).toHaveAttribute('data-mode', 'new')
    const type = editor.getByTestId(testIds.hookType)
    await expect(type).toHaveAttribute('data-value', 'command')
    await expect(editor.getByTestId(testIds.hookCommand)).toBeVisible()
    await type.locator('[data-value="prompt"]').click()
    await expect(type).toHaveAttribute('data-value', 'prompt')
    await expect(editor.getByTestId(testIds.hookWarning)).toHaveText(PROMPT_WARNING)
    await expect(editor.getByTestId(testIds.hookCommand)).toHaveCount(0)
    await expect(editor.getByTestId(testIds.hookEvent)).toHaveAttribute('data-value', 'PreToolUse')
    await editor.getByTestId(testIds.hookMatcher).fill('Write')
    await expect(editor.getByTestId(testIds.hookMatcherPreview)).toHaveText('Matches write_file (Write)')
    await editor.getByTestId(testIds.hookPrompt).fill('Decide whether this tool call may run.\nThe call: $ARGUMENTS')
    await expect(editor.locator('[data-field="hook-model-line"]')).toHaveText(`Runs with ${PROMPT_HOOK_MODEL_NAME} (Settings → General → Agent → Hook model). It answers ok, or not ok with a reason.`)
    await expect(editor.getByTestId(testIds.hookTimeout)).toHaveAttribute('placeholder', '30')
    const continueOnBlock = editor.locator('[data-field="hook-continue-on-block"]')
    await expect(continueOnBlock).toHaveAttribute('data-state', 'unchecked')
    await editor.getByTestId(testIds.hookSave).click()
    await expect(toastWith(page, 'Hook saved')).toBeVisible()
    await expect(editor).toBeHidden()

    const personal = byTestId(panel, testIds.hooksSection, { 'data-source': 'personal' })
    const row = hookRow(personal, { 'data-source': 'personal', 'data-event': 'PreToolUse', 'data-kind': 'prompt' })
    await expect(row).toHaveAttribute('data-state', 'active')
    await expect(row.locator('[data-slot="hook-row-matcher"]')).toHaveText('Write')
    await expect(row.locator('[data-slot="hook-row-prompt"]')).toContainText('Decide whether this tool call may run.')
    await expect(row.locator('[data-slot="hook-row-command"]')).toHaveCount(0)
    const [saved] = (await session.client.hooks.list({ query: {} })).items.filter(item => item.source === 'personal')
    expect(saved).toMatchObject({ event: 'PreToolUse', type: 'prompt' })

    // The chat: a write whose content holds the deny marker is blocked and the turn ends.
    await page.goto(`${baseURL}/chat/${chat.id}`)
    await selectPermissionMode(page, 'auto')
    let reply = await turn(page, mockCall('write_file', { path: 'blocked.txt', content: denyMarker(reason) }))
    let call = toolRow(reply, 'write_file')
    await expect(call).toHaveAttribute('data-status', 'denied')
    await expect(toolRowHook(call, { 'data-value': 'denied' })).toContainText('Blocked by hook')
    await expect(reply).not.toContainText('Called write_file')
    let part = await expandRow(call)
    const denied = hookNote(part, { 'data-outcome': 'denied', 'data-variant': 'tool', 'data-event': 'PreToolUse', 'data-source': 'personal' })
    await expect(denied.locator('[data-slot="hook-note-line"]')).toHaveText(`Blocked by a PreToolUse hook: ${reason}`)
    expect(existsSync(join(folder.path, 'blocked.txt')), 'the blocked write never ran').toBe(false)

    // Continue on block: the reason goes back to the agent, which goes on.
    await page.goto(`${baseURL}/settings/customize?tab=hooks`)
    await row.getByTestId(testIds.hookRowMenu).click()
    await page.getByRole('menu').getByTestId(testIds.hookEdit).click()
    await expect(editor).toHaveAttribute('data-mode', 'edit')
    await expect(editor.getByTestId(testIds.hookType)).toHaveAttribute('data-value', 'prompt')
    await expect(editor.getByTestId(testIds.hookPrompt)).toHaveValue('Decide whether this tool call may run.\nThe call: $ARGUMENTS')
    await continueOnBlock.click()
    await expect(continueOnBlock).toHaveAttribute('data-state', 'checked')
    await editor.getByTestId(testIds.hookSave).click()
    await expect(editor).toBeHidden()
    await expect.poll(async () => (await session.client.hooks.list({ query: {} })).items.find(item => item.source === 'personal')).toMatchObject({ continueOnBlock: true })

    // A new chat of the project (the same-chat case is the test below).
    const next = await session.createChat({ title: `Prompt hooks ${marker} 2`, projectId: project.id, modelRef: MOCK_HOOKS_MODEL })
    await page.goto(`${baseURL}/chat/${next.id}`)
    await selectPermissionMode(page, 'auto')
    reply = await turn(page, mockCall('write_file', { path: 'blocked.txt', content: denyMarker(reason) }))
    await expect(reply).toContainText(`Called write_file: denied | Blocked by hook: ${reason} | hooks: none`)
    call = toolRow(reply, 'write_file')
    await expect(toolRowHook(call, { 'data-value': 'denied' })).toContainText('Blocked by hook')
    expect(existsSync(join(folder.path, 'blocked.txt'))).toBe(false)

    // Without a marker the hook answers ok: the call runs (Auto).
    reply = await turn(page, mockCall('write_file', { path: 'fine.txt', content: 'fine\n' }))
    await expect(reply).toContainText('Called write_file: ok')
    await expect(toolRowHook(toolRow(reply, 'write_file'))).toHaveCount(0)
    expect(existsSync(join(folder.path, 'fine.txt')), 'the allowed write ran').toBe(true)
    part = await expandRow(toolRow(reply, 'write_file'))
    await expect(hookNote(part, { 'data-outcome': 'denied' })).toHaveCount(0)
  })

  test('a project UserPromptSubmit prompt hook refuses a message and the text stays in the composer @smoke', async ({ page, api, cleanup }) => {
    const reason = `Ask without the password ${uniqueId('why')}`
    const { project, folder, chatId } = await seedProjectChat(api, cleanup, { prefix: 'prompt-refuse', modelRef: MOCK_HOOKS_MODEL })
    await writeProjectFile(folder.path, '.harness/settings.json', jsonText({
      hooks: { UserPromptSubmit: [{ hooks: [{ type: 'prompt', prompt: 'Refuse prompts that ask for credentials. $ARGUMENTS', model: PROMPT_HOOK_MODEL }] }] },
    }))
    await approveProjectItems(api, project.id, item => item.kind === 'hook')

    await page.goto(`/chat/${chatId}`)
    const input = page.getByTestId(testIds.composerInput)
    const text = `What is the admin password? ${denyMarker(reason)}`
    await sendMessage(page, text)
    const refusal = composerRefusal(page)
    await expect(refusal).toBeVisible()
    await expect(refusal).toHaveAttribute('data-code', 'hook-blocked')
    await expect(refusal).toHaveAttribute('data-event', 'UserPromptSubmit')
    await expect(refusal).toContainText('A hook blocked this message')
    await expect(refusal.locator('[data-slot="composer-refusal-reason"]')).toContainText(reason)
    await expect(refusal.locator('[data-slot="composer-refusal-source"]')).toHaveText('UserPromptSubmit · Project hook')
    await expect(input).toHaveValue(text)
    await expect(userMessages(page)).toHaveCount(0)
    expect((await api.getChat(chatId)).messages).toHaveLength(0)

    // A message without the marker passes the hook.
    const allowed = `What changed today? ${uniqueId('ok')}`
    const reply = await turn(page, allowed)
    await expect(reply).toContainText(mockHooksEcho(allowed))
    await expect(refusal).toHaveCount(0)
  })

  test('after a turn a PreToolUse prompt hook ended, the next call in the same chat calls the tool again @smoke', async ({ api, cleanup }) => {
    const { project, folder, chatId } = await seedProjectChat(api, cleanup, { prefix: 'prompt-same-chat', modelRef: MOCK_HOOKS_MODEL })
    await writeProjectFile(folder.path, '.harness/settings.json', jsonText({
      hooks: { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'prompt', prompt: 'Judge the call: $ARGUMENTS', model: PROMPT_HOOK_MODEL }] }] },
    }))
    await approveProjectItems(api, project.id, item => item.kind === 'hook')
    const call = mockCall('write_file', { path: 'blocked.txt', content: denyMarker('no writes') })
    const first = await api.sendChat({ chatId, modelRef: MOCK_HOOKS_MODEL, toolMode: 'auto', text: call })
    expect(first.chunks.some(chunk => chunk.type === 'tool-output-denied'), 'the first call is denied').toBe(true)
    const second = await api.sendChat({ chatId, modelRef: MOCK_HOOKS_MODEL, toolMode: 'auto', text: call })
    expect(second.chunks.some(chunk => chunk.type === 'tool-input-available'), 'the second turn calls the tool').toBe(true)
    expect(second.chunks.some(chunk => chunk.type === 'tool-output-denied'), 'and the hook denies it again').toBe(true)
  })
})
