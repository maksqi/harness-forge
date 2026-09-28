# End-to-end tests

Playwright specs that drive the production build (`apps/web/.output/public` served by `apps/server/dist/main.mjs`)
in Chromium with the dev-only `mock` provider (`HF_MOCK_PROVIDER=1`, docs/PROVIDERS.md 8). Tests tagged `@smoke` in
their title run at every gate (`--grep @smoke`); every core test is.

```
e2e/
  helpers/          shared helpers (this file documents their API; keep it stable)
  specs/core/       core app: theme, navigation, chat, composer, settings, login (W2.6)
  specs/plugins/    plugins tab, install, wizard, code plugins, MCP (W3.6)
  fixtures/         plugin fixtures used by the plugin specs (W3.6)
```

## Running

`playwright.config.ts` (frozen) runs one worker, serially, against `E2E_BASE_URL`; without it the config starts
`pnpm start:e2e` (:8899, data in `.tmp/e2e`) or reuses a server already answering there.

```sh
# the coordinator's e2e server (default)
pnpm test:e2e --grep @smoke

# an agent slot k: own server, fresh data directory, own output folder
rm -rf .tmp/<agent>/data
HF_MOCK_PROVIDER=1 HF_PORT=889k HF_DATA_DIR=.tmp/<agent>/data node apps/server/dist/main.mjs &
E2E_BASE_URL=http://127.0.0.1:889k pnpm exec playwright test e2e/specs/core --output .tmp/<agent>/test-results
```

| Variable | Meaning |
|---|---|
| `E2E_BASE_URL` | server under test (disables the config's webServer) |
| `E2E_AUTH_BASE_URL` | optional server started with `HF_PASSWORD`, used by the login spec; without it the spec starts its own password server from `apps/server/dist/main.mjs` on a free port with a temporary data directory |
| `E2E_AUTH_PASSWORD` | password of `E2E_AUTH_BASE_URL` (default `secret`) |

Specs assume a server with `HF_MOCK_PROVIDER=1`, no provider keys in its environment and no password. They may
share one data directory across runs: every spec creates its own data (unique titles and texts from `uniqueId()`)
and restores any global state it changes (settings, provider switches, credentials) in `finally` / `afterEach`.

## Core specs (`specs/core`)

| Spec | Covers |
|---|---|
| `theme.spec.ts` | dark by default under a light OS with empty storage (`html.dark` in the first frame, never `light`); Light and System persist across reloads, System follows the OS |
| `navigation.spec.ts` | sidebar Chat / Plugins mode tabs (the Chat tab returns to the last chat); Mod+K palette finds a chat by a word of its messages |
| `chat.spec.ts` | new chat with `mock:echo`: incremental streaming, automatic title in the sidebar and header, transcript after reload; Stop keeps and persists the partial reply as stopped |
| `chat-parts.spec.ts` | `mock:reasoning` Thinking / Thought row; `mock:tool-approval` card with Allow (tool row done + tool result answer) and Deny (Denied + denial answer) |
| `chat-errors.spec.ts` | `mock:error` alert with Open settings; a keyless provider's model (`provider_not_configured`) with Open settings; "Connect a provider" callout with Send disabled when nothing is usable |
| `composer.spec.ts` | slash menu lists the client and server commands, filters by prefix, closes on Escape |
| `providers.spec.ts` | OpenAI key dialog: Save tests first, "Save anyway" on a fake key, only the masked hint afterwards, no DOM node holds the key |
| `login.spec.ts` | `HF_PASSWORD` server: redirect to `/login?redirect=`, wrong password error, login opens the target, session survives a reload and authenticates API calls |

## Writing specs

- Import everything from `helpers/index.ts` (explicit `.ts` paths, ESM): `test` (Playwright's test plus the `api`
  fixture) and `expect`.
- Select elements only through the test-id contract (docs/UI.md 13): `page.getByTestId(testIds.newChat)`, and
  `byTestId(scope, testIds.chatRow, { 'data-chat-id': id })` for repeated elements. A missing id is a CCR, never a
  CSS or text selector on app internals.
- Web-first assertions only (`await expect(locator).toHaveAttribute(...)`, `expect.poll`, `toPass`), no fixed sleeps.
- Tag the tests the gate must run with `@smoke` in the title.
- Keyboard shortcuts: `pressShortcut(page, 'Mod+K')`, not `ControlOrMeta` (see Keyboard below).
- Assistant text is markdown: straight quotes render as typographic quotes, match them with `looseQuotes()`.
- The helpers import `@harness-forge/shared` by path (`packages/shared/src/index.ts`): the root package does not
  depend on it, and Playwright compiles the TypeScript sources directly.

```ts
import { expect, lastAssistantMessage, startChat, test, testIds } from '../../helpers/index.ts'

test('echoes a message @smoke', async ({ page, api }) => {
  const chatId = await startChat(page, { modelRef: 'mock:echo', text: 'hello there' })
  await expect(lastAssistantMessage(page)).toHaveAttribute('data-status', 'done')
  await api.deleteChat(chatId)
})
```

## Helper API (`helpers/index.ts`)

### Fixtures (`fixtures.ts`)

| Export | Description |
|---|---|
| `test` | `@playwright/test` `test` extended with `api: HarnessApi` (bound to the test's `request` context and `baseURL`) |
| `expect` | Playwright's `expect` |

### API (`api.ts`)

`HarnessApi` wraps the typed `createApiClient()` of `@harness-forge/shared`, sent through a Playwright
`APIRequestContext` (requests appear in traces; cookies are those of the context).

| Member | Description |
|---|---|
| `new HarnessApi(context, baseURL?)` | API over any request context, e.g. `page.request` to act as the logged-in browser |
| `HarnessApi.create(baseURL?)` / `dispose()` | own request context for `beforeAll` / `afterAll` |
| `client` | the full typed client: `api.client.plugins.list()`, `api.client.pluginInstall.install({ form })`, ... (docs/API.md 3.4; non-2xx throws `HarnessError`) |
| `getSettings()` / `updateSettings(patch)` | `GET` / `PUT /api/settings` |
| `listProviders()` / `getProvider(id)` | provider summaries |
| `setProviderEnabled(id, enabled)` | `PATCH /api/providers/:id` |
| `setCredentials(id, values)` / `clearCredentials(id)` | `PUT` / `DELETE /api/providers/:id/credentials` |
| `disableUsableProviders()` | disables every usable provider (enabled, configured, with models); resolves to a `restore()` function |
| `createChat({ id?, title?, modelRef? })` | `POST /api/chats` (a title here is a user title) |
| `getChat(id)` / `searchChats(q)` / `deleteChat(id)` | chat detail, `GET /api/chats?q=`, delete (404 ignored) |
| `sendChat({ chatId?, text, modelRef?, toolMode?, reasoningEffort? })` | `POST /api/chat` (default `mock:echo`, `ask`, `auto`); resolves when the run finished with `{ chatId, userMessageId, chunks, text }` |
| `waitForChatTitle(id, timeout?)` | polls until the chat has a title and returns it |

Also exported: `requestFetch(context)` (a `fetch` over an `APIRequestContext`), `parseUiMessageStream(body)`,
`streamText(chunks)`, `isUsableProvider(provider)`.

### Chat UI (`chat.ts`)

| Export | Description |
|---|---|
| `openNewChat(page)` | `/`, waits for the greeting and an editable composer |
| `selectModel(page, modelRef)` | picks `provider:model` in the composer's model picker and verifies the trigger |
| `selectPermissionMode(page, mode)` | sets the composer's permission mode (`ask` / `auto` / `off`; only for models with tools) |
| `sendMessage(page, text)` | fills the composer and clicks Send once it is ready |
| `startChat(page, { modelRef, text })` | `openNewChat` + `selectModel` + `sendMessage`, then waits for `/chat/<id>`; returns the chat id |
| `composer(page)` · `userMessages(page)` · `assistantMessages(page)` · `lastAssistantMessage(page)` | locators |
| `expectMessageStatus(message, status?, timeout?)` | waits for `data-status` (`streaming` / `done` / `aborted` / `error`) |
| `chatRow(page, chatId)` | the sidebar row of a chat |
| `chatIdFromUrl(page)` · `CHAT_URL_PATTERN` | chat id of a `/chat/<id>` URL |

### Test ids and locators (`testids.ts`, `locators.ts`)

| Export | Description |
|---|---|
| `testIds` · `TestId` | the web app's constants (`apps/web/app/utils/testids.ts`) |
| `byTestId(scope, id, attributes?)` | locator for a test id plus exact `data-*` values |
| `testIdSelector(id, attributes?)` | the same as a CSS selector |

### Theme (`theme.ts`)

| Export | Description |
|---|---|
| `installThemeProbe(page)` | init script that records the `<html>` class in the first animation frame and every class it had |
| `readThemeProbe(page)` | `{ firstFrame, history }` of the current document |
| `storedColorMode(page)` | `localStorage['hf-color-mode']` of the page's origin, or `null` |
| `COLOR_MODE_STORAGE_KEY` | `'hf-color-mode'` |

### Keyboard (`keyboard.ts`)

| Export | Description |
|---|---|
| `pressShortcut(page, 'Mod+K')` | presses an app shortcut, resolving `Mod` the way the app does |
| `modKey(page)` | `'Meta'` or `'Control'` |

The app picks `Mod` from the browser's platform (`navigator.userAgentData.platform`). The "Desktop Chrome" device of
the config reports Windows even on a Mac host, so Playwright's host-based `ControlOrMeta` presses the wrong key there:
use `pressShortcut`.

### Other helpers

| Export | Description |
|---|---|
| `startPasswordServer({ password? })` | `{ baseURL, password, stop() }`: `E2E_AUTH_BASE_URL`, or a password-protected server started from the build (`auth-server.ts`) |
| `uniqueId(prefix?)` · `wordList(count, prefix?)` · `firstWords(text, count)` | unique test data (`data.ts`) |
| `looseQuotes(text)` | a RegExp matching `text` with straight or typographic quotes: assistant markdown renders `"a"` as `“a”` (`data.ts`) |
| `baseUrlFromEnv()` · `apiBaseUrl(baseURL)` · `DEFAULT_BASE_URL` | environment (`env.ts`) |

## Mock models

`mock:echo` streams the user text back (one word every 25 ms; a 400-word message streams for about 10 s),
`mock:reasoning` streams a reasoning part first ("Thinking about ...", 100 ms per word) and answers
`Answer: <text>`, `mock:tool-approval` calls `mock_approval_tool` (approval in mode `ask`; Allow ->
`Tool result: {"echoed":"<text>"}`, Deny -> `The tool call was denied.`), `mock:error` fails with `auth_invalid`
(action `configure-provider`). Chat titles come from `mock:echo`: the first 8 words of the first message.
