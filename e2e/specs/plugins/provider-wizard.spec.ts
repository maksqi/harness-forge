// Provider wizard (docs/UI.md 8.5, docs/API.md 5.17): template -> base URL of the mock OpenAI server -> credentials
// -> fetch models -> review + Test -> Create. The mock only accepts the key typed in the wizard, so every step that
// talks to it (model listing, ping, chat) proves the credentials travel to the provider, and the review proves they
// never land in plugin.json. The created provider then appears in the model picker and a chat streams its reply.
import type { MockOpenAIServer } from '../../fixtures/mock-openai-server.ts'
import { expect, test } from '@playwright/test'
import { startMockOpenAI } from '../../fixtures/mock-openai-server.ts'
import { getPlugin, getProvider, removeChat, removePlugin } from './_support/api.ts'
import { testIds } from './_support/testids.ts'
import { byTestId, lastAssistantMessage, selectModel, sendMessage, startNewChatInApp } from './_support/ui.ts'

const PLUGIN_ID = 'e2e-wizard'
const API_KEY = 'sk-e2e-wizard-4242'

test.describe('Provider wizard @plugins', () => {
  let mock: MockOpenAIServer
  /** Chats a test opened; deleted after it. */
  const chats: string[] = []

  test.beforeAll(async ({ request }) => {
    mock = await startMockOpenAI({ apiKeys: [API_KEY] })
    await removePlugin(request, PLUGIN_ID)
  })

  test.afterEach(async ({ request }) => {
    for (const id of chats.splice(0))
      await removeChat(request, id)
  })

  test.afterAll(async ({ request }) => {
    await removePlugin(request, PLUGIN_ID)
    await mock?.close()
  })

  test('creates a provider whose model streams a chat reply @smoke', async ({ page, request }) => {
    await page.goto('/plugins')
    await page.getByTestId(testIds.pageHeader).getByTestId(testIds.pluginsNew).click()
    await page.getByTestId(testIds.pluginsNewProvider).click()
    await expect(page).toHaveURL(/\/plugins\/new\?type=provider/)
    const wizard = page.getByTestId(testIds.wizard)
    const next = page.getByTestId(testIds.wizardNext)

    // 1. Basics: the id follows the name.
    await expect(wizard).toHaveAttribute('data-step', 'basics')
    await page.getByTestId(testIds.wizardName).fill('E2E Wizard')
    await expect(page.getByTestId(testIds.wizardId)).toHaveValue(PLUGIN_ID)
    await next.click()

    // 2. API: a template prefills the format and a base URL, which then points at the mock.
    await expect(wizard).toHaveAttribute('data-step', 'api')
    await byTestId(page, testIds.wizardTemplate, { 'data-value': 'vllm' }).click()
    await expect(byTestId(page, testIds.wizardApiFormat, { 'data-value': 'openai-chat' })).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByTestId(testIds.wizardBaseUrl)).toHaveValue(/^http:\/\/localhost:\d+\/v1$/)
    await page.getByTestId(testIds.wizardBaseUrl).fill(mock.baseURL)
    await next.click()

    // 3. Credentials: bearer auth; the value is used for testing and stored encrypted on create.
    await expect(wizard).toHaveAttribute('data-step', 'credentials')
    await expect(page.getByTestId(testIds.wizardAuthStyle)).toHaveAttribute('data-value', 'bearer')
    await byTestId(page, testIds.wizardCredentialValue, { 'data-value': 'apiKey' }).fill(API_KEY)
    await next.click()

    // 4. Models: "Fetch models" lists GET /v1/models of the mock through the draft test.
    await expect(wizard).toHaveAttribute('data-step', 'models')
    await page.getByTestId(testIds.wizardFetchModels).click()
    await expect(page.getByText(/2 models · \d+ ms/)).toBeVisible()
    const fetched = page.getByRole('list', { name: 'Fetched models' })
    await fetched.getByRole('listitem').filter({ has: page.getByText('mock-gpt', { exact: true }) }).getByRole('checkbox').click()
    await expect(byTestId(page, testIds.wizardModelRow, { 'data-value': 'mock-gpt' })).toBeVisible()
    expect(mock.requests.filter(request => request.kind === 'models').at(-1)?.authorization).toBe(`Bearer ${API_KEY}`)
    await next.click()

    // 5. Review: the manifest carries the base URL but never the key; Test sends a 1-token ping.
    await expect(wizard).toHaveAttribute('data-step', 'review')
    const manifest = page.getByTestId(testIds.wizardManifest)
    await expect(manifest).toContainText(mock.baseURL)
    await expect(manifest).toContainText('mock-gpt')
    await expect(manifest).not.toContainText(API_KEY)
    await page.getByTestId(testIds.wizardTest).click()
    const result = page.getByTestId(testIds.wizardTestResult)
    await expect(result).toHaveAttribute('data-status', 'ok')
    await expect(result).toContainText('Connected')
    expect(mock.requests.filter(request => request.kind === 'ping').at(-1)).toMatchObject({ authorization: `Bearer ${API_KEY}`, reply: 'pong' })

    await page.getByTestId(testIds.wizardCreate).click()
    await expect(page).toHaveURL(new RegExp(`/plugins/${PLUGIN_ID}(?:\\?|$)`))
    await expect(page.getByTestId(testIds.pluginDetail)).toHaveAttribute('data-state', 'active')
    expect(await getPlugin(request, PLUGIN_ID)).toMatchObject({ kind: 'declarative', source: 'created', state: 'active', runsCode: false })
    expect(await getProvider(request, PLUGIN_ID)).toMatchObject({ pluginId: PLUGIN_ID, enabled: true, status: 'connected' })

    // Without a reload, the provider is in the model picker and a chat streams the mock's reply.
    await startNewChatInApp(page)
    await selectModel(page, `${PLUGIN_ID}:mock-gpt`)
    mock.reset()
    chats.push(await sendMessage(page, 'Hello from the wizard spec, streamed word by word [[slow]]'))
    const reply = lastAssistantMessage(page)
    await expect(reply).toHaveAttribute('data-status', 'streaming')
    await expect(reply).toHaveAttribute('data-status', 'done', { timeout: 15_000 })
    await expect(reply).toContainText('Mock reply: Hello from the wizard spec, streamed word by word')
    await expect(reply.getByTestId(testIds.messageMeta)).toContainText('Mock GPT')

    const chat = mock.chatRequests()
    expect(chat).toHaveLength(1)
    expect(chat[0]).toMatchObject({ stream: true, authorization: `Bearer ${API_KEY}` })
    expect(chat[0]?.body?.model).toBe('mock-gpt')
  })
})
