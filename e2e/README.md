# End-to-end tests

Playwright specs that drive the production build (`apps/web/.output/public` served by `apps/server/dist/main.mjs`)
in Chromium with the dev-only `mock` provider (`HF_MOCK_PROVIDER=1`, docs/PROVIDERS.md 8), including its media models
(images, speech to text, read-aloud). Tests tagged `@smoke` in their title run at every gate (`--grep @smoke`); every
core test is.

```
e2e/
  helpers/            shared helpers (this file documents their API; keep it stable)
  specs/core/         core app: theme, navigation, chat, resume, keyboard, composer, settings, login (W2.6, W5.8),
                      branching, data (backup, delete-all, import), share links (W5.10), images, voice, versions,
                      edit attachments (W6.12)
  specs/plugins/      plugins tab, install, wizard, code plugins, MCP (W3.6)
  specs/mobile/       phone layout, project `mobile` only (W5.8, W6.12)
  specs/tablet/       touch tablet (icon rail), project `tablet` only (W6.12)
  specs/screenshots/  screenshots for the visual review, opt-in with `E2E_SCREENSHOTS=1` (W5.8, W6.12)
  fixtures/           plugin fixtures used by the plugin specs (W3.6)
```

## Running

`playwright.config.ts` (frozen) runs one worker, serially, against `E2E_BASE_URL`; without it the config starts
`pnpm start:e2e` (:8899, data in `.tmp/e2e`) or reuses a server already answering there. It has three projects:
`chromium` ("Desktop Chrome", every spec except `specs/mobile/` and `specs/tablet/`), `mobile` (Pixel 7 at 390x844 with
touch, only `specs/mobile/`) and `tablet` (Galaxy Tab S9 landscape, 1024x640 with touch: `pointer: coarse`, wider than
the 768 px sheet breakpoint; only `specs/tablet/`). All three use Chromium, so CI needs no other browser.

Media (Phase 6, docs/UI.md 14.7): every project grants `permissions: ['microphone']` and launches Chromium with
`--use-fake-ui-for-media-stream` (no permission prompt), `--use-fake-device-for-media-stream` (a fake microphone, so
`MediaRecorder` records a real WebM/Opus clip) and `--autoplay-policy=no-user-gesture-required` (read-aloud chunks play
without a gesture). Headless Chromium plays the silent WAV clips of `mock:speech` to their end, so the voice specs need
no `getUserMedia` / `MediaRecorder` / `Audio` mocks; if a CI browser ever refuses the fake devices, mock them with
`page.addInitScript` in the voice specs (the fallback of docs/UI.md 14.7).

```sh
# the coordinator's e2e server (default), every project
pnpm test:e2e --grep @smoke

# one project
pnpm test:e2e --project=mobile
pnpm test:e2e --project=tablet

# an agent slot k: own server, fresh data directory, own output folder
rm -rf .tmp/<agent>/data
HF_MOCK_PROVIDER=1 HF_OFFLINE=1 HF_PORT=889k HF_DATA_DIR=.tmp/<agent>/data node apps/server/dist/main.mjs &
E2E_BASE_URL=http://127.0.0.1:889k pnpm exec playwright test e2e/specs/core --output .tmp/<agent>/test-results

# screenshots (skipped without E2E_SCREENSHOTS=1)
E2E_SCREENSHOTS=1 pnpm test:e2e --grep @screenshots
```

| Variable | Meaning |
|---|---|
| `E2E_BASE_URL` | server under test (disables the config's webServer) |
| `E2E_AUTH_BASE_URL` | optional server started with `HF_PASSWORD`, used by the login and share specs; without it they start their own password server from `apps/server/dist/main.mjs` on a free port with a temporary data directory. The data spec never uses it: delete-all wipes every chat, so it always starts a server of its own |
| `E2E_AUTH_PASSWORD` | password of `E2E_AUTH_BASE_URL` (default `secret`) |
| `E2E_SCREENSHOTS` | `1` runs the `@screenshots` spec (otherwise its tests are skipped) |

Specs assume a server with `HF_MOCK_PROVIDER=1`, no provider keys in its environment and no password. They may
share one data directory across runs: every spec creates its own data (unique titles and texts from `uniqueId()`)
and restores any global state it changes (settings, provider switches, credentials, custom models, chats) through
the `cleanup` fixture, or in `finally` / `afterEach`. Prefer `cleanup`: it also runs after a timeout, when a
`finally` block can no longer reach the API (the test's request context is closed by then). Anything that needs a
password (login, share links, delete-all) runs on a second server from `startPasswordServer()`, never on the shared
one; a spec that wipes data asks for a server of its own (`dedicated: true`).

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
| `resume.spec.ts` | a running 600-word `mock:echo` reply (about 15 s) resumes after a reload, after leaving the chat and coming back (sidebar dot `running`), and in a second tab: `streaming` again from its first words, `done` with its last word, stored exactly once (one reply, no second version) |
| `keyboard.spec.ts` | the chat without clicks: Mod+Shift+O, Alt+M (type + Enter picks), Enter, Esc (stop), Shift+Esc, ↑ (edit; checks only that the edited text is the last user message and a reply streams), Alt+R, Alt+P, Shift+Tab / Tab / Enter on the approval card, Mod+/, Mod+B, Mod+K; `toBeFocused()` after every step |
| `settings.spec.ts` | General (send key Mod+Enter in the composer, custom instructions), Appearance (theme, `data-reading-font` / `data-text-size` / `data-density` on `<html>`, "Expand thinking by default"), Models (default model, a custom model as favorite and hidden in the picker, removed), About (Copy diagnostics with clipboard permission: an allow-list report without secrets) |
| `branching.spec.ts` | message versions with `mock:echo` (docs/UI.md 7.5): A, then B; editing A shows "2/2" on the user message; "Previous version" brings back A, B and their replies (focus stays on the control); Regenerate on the last reply shows "2/2" on it; a reload keeps the versions; ArrowLeft in a switcher picks the previous version, which survives a reload; the server's `branches` match. Asserted through `message-branch*` (`data-index`, `data-count`, `data-message-id`, `aria-disabled`) |
| `data.spec.ts` | Settings -> Data on a password server of its own (`dedicated: true`): Export backup downloads a zip (`PK` magic, `manifest.json` counts, `chats/<id>.json` per chat, no share link or token); Delete all data needs exactly `DELETE` and, with the browser clock 11 minutes past the login (`page.clock.fastForward`), the password prompt, and also deletes the share links; importing the zip brings the chats back into the sidebar with their messages (no share link); a second import skips every chat |
| `share.spec.ts` | share links on a password server: "Share…" in the chat header menu, "Create link" (defaults, focused absolute URL); a browser context without cookies opens the link as the read-only transcript (title, messages; no sidebar, composer, actions or switchers; no session); Revoke… in the dialog, then a reload of the link shows "This link is unavailable" |
| `images.spec.ts` | image generation (docs/UI.md 7.7, 7.16): `mock:image` from the picker's "Image models" group (`model-picker-group` `data-value="images"`), "Describe an image…", no effort / permission / context ring; `image-options-trigger` 16:9 and 2 images; a "slow" prompt shows `image-generating` (`data-count` 2, "Generating 2 images… Ns") until the gallery (`image-gallery` `data-count` 2, two `image-tile`s, `/api/files/` images of 320x180, no Copy or Read aloud); the stored reply has two file parts and `metadata.image`, never a `data:` URL; the lightbox (Previous disabled, Next focused, ArrowLeft, "1 / 2") and its same-origin Download (`image-download`, the stored file name, a PNG); Esc returns focus to the tile; Regenerate shows the placeholders again, then "2/2"; `mock:image-chat` (aspect ratio only, 3:2 → 318x212): text + a one-image gallery; `generate_image` with `mock:image-tool` (`imageModelRef` set through the API): the approval card, Allow → the tool row, the image below it, "Image tool result: 1 image(s)" |
| `voice.spec.ts` | voice (docs/UI.md 7.17, 7.18, 9.9) with `transcriptionModelRef` / `speechModelRef` set through the API: type "Hello ", record until the timer shows 0:01 (the indicator replaces the left tools, Send disabled), Stop → one multipart request with the part `file` (`dictation.webm`, `audio/webm…`, the WebM magic) and "Hello This is a mock transcription." with the focus back in the textarea; Alt+V starts and stops; Esc in the textarea, Esc on the mic and the indicator's Cancel drop a recording without a request; without a model the mic's setup popover leads to `/settings/media`; read aloud: the request body `{ text }`, `playing` (`aria-pressed`, "Stop reading"), the natural end of a 2 s clip, a second reply stops the first, Stop and Esc → `idle`; Settings → Media: the image, speech-to-text and read-aloud selects list only their kind, the language, the voice suggestions (`mock-voice-a`, `mock-voice-b`) and the speed save, Test voice sends `{ text, modelRef, voice }`, plays and stops; everything survives a reload |
| `versions.spec.ts` | version management (docs/UI.md 7.5, 14.1; ADR-030): "Delete this version" asks first (Cancel keeps every version and refocuses the button), "Delete version" shows the previous version (3 → 2 versions), announces "Version deleted" and focuses the switcher; down to one version: no switcher, focus on Copy; a remembered deep path (B'1 chosen under B, then an edit of A and back: B'1, not the newest B'2, also after a reload; deleting the edit returns to that path); two tabs: a switch in either tab and a deletion move the other one |
| `edit-attachments.spec.ts` | attachments on edit (docs/UI.md 7.5, S8): the editor's chips (`message-edit-attachment`), "Remove {name}", the paperclip (`message-edit-attach`, Playwright's `filechooser` event: the hidden input has no test id) with an upload held by `page.route` (chip `uploading`, Send disabled and `aria-busy`), then Send: a new version with exactly the kept and the added file (UI, echo and server), the old version keeps its files; Cancel discards removals and uploads |

## Mobile specs (`specs/mobile`, project `mobile`)

docs/UI.md 14.6, with the existing test ids (Phases 5 and 6 add none for mobile). They are not tagged `@smoke`: the
full suite runs them, or `pnpm test:e2e --project=mobile`.

| Spec | Covers |
|---|---|
| `shell.spec.ts` | the sidebar is a sheet (dialog on the left edge, narrower than the screen) opened by the header's `sidebar-trigger`, closed by a navigation; its rows are touch targets of at least 40x40 px |
| `layout.spec.ts` | no sideways scroll at 390 px (`scrollWidth <= 390`) on `/`, a chat with wide markdown, `/plugins`, a plugin and every settings page; the composer inside the viewport on `/` and under a long transcript |
| `chat.spec.ts` | the model picker is a bottom drawer (full width, on the bottom edge); a `mock:echo` reply streams and finishes; composer toolbar buttons and message actions are touch targets of at least 40x40 px |
| `media.spec.ts` | Phase 6 at 390 px: the mic is a 40x40 target; recording and transcribing keep the layout (no sideways scroll, the indicator and the composer inside the viewport) and the textarea gets no focus afterwards (touch); a four-image gallery keeps two columns inside the column; the lightbox fits the screen; the image options trigger, Read aloud, Delete this version and the version switcher are 40x40 targets (sizes are polled: a dialog zooms in from 95%) |

## Tablet specs (`specs/tablet`, project `tablet`)

docs/UI.md 14.5, 14.7 (S9), with the existing test ids; not tagged `@smoke` (`pnpm test:e2e --project=tablet`).

| Spec | Covers |
|---|---|
| `touch-targets.spec.ts` | `pointer: coarse` and the sidebar in the page (not a sheet); collapsed with its own trigger, the icon rail is 56 px wide (the page, `getByRole('main')`, starts at x = 56; the sidebar fills the rail inside its 1 px border) in the chat, plugins and settings modes, every visible button and link of the rail is at least 40x40 px and inside the rail; the rail's "Expand sidebar" expands it again |

## Screenshots (`specs/screenshots`)

`screenshots.spec.ts` (`@screenshots`) runs only with `E2E_SCREENSHOTS=1`. It starts its own password-protected server
from the build (`startServer`, fresh data directory, whatever `E2E_BASE_URL` says), creates a few chats (markdown,
reasoning, tool result, pending approval, provider error, a chat whose first message and reply have two versions, a
chat with an outdated share link that includes reasoning and tool details, and a chat of two `mock:image` turns: one
16:9 image, then two variations of it), sets the image and speech-to-text models (no visible change elsewhere), and
captures every screen in dark and light (stored color mode set by an init script), at 1440x900 and on a 390x844 phone
(Pixel 7, touch), with reduced motion and a browser clock that starts at a fixed time two minutes after the seed
(relative times read "2m ago"; the clock then runs, because a frozen clock stalls the transcript's scroll-to-bottom).
Files: `.tmp/screenshots/{dark,light}/<screen>-{desktop,mobile}.png`, for example `chat-desktop.png`,
`sidebar-mobile.png`. Screens: login, new-chat, chat, chat-reasoning, chat-tools, chat-approval, chat-error,
chat-versions (the "‹ 2/2 ›" switchers), chat-delete-version (the "Delete this version?" dialog), chat-images (the
galleries), chat-images-generating (a "slow" two-image turn in a chat of its own: the placeholder tiles),
composer-recording (the recording indicator at 0:02), share-dialog, share-page, share-unavailable, model-picker,
command-palette, shortcuts (desktop), sidebar (mobile), plugins, plugin-detail, plugin-mcp, plugin-new-provider,
plugin-new-code, settings-providers, settings-provider-key, settings-models, settings-media (every model chosen, voice
and speed), settings-general, settings-appearance, settings-data (with the share link), settings-about,
chat-not-found, page-not-found. A screen that starts something undoes it in its `close` step after the picture (cancels the dialog or
the recording, deletes its chat, turns read-aloud off again, puts the clock offset back), so the other screens look the
same in every run; the image-turn screen runs the page clock at the real time while it is shown, because its
"Generating… Ns" counter counts from the server's start time.

## Writing specs

- Import everything from `helpers/index.ts` (explicit `.ts` paths, ESM): `test` (Playwright's test plus the `api` and
  `cleanup` fixtures) and `expect`.
- Register the undo of every global change before making it: `cleanup(api => api.updateSettings(before))`,
  `cleanup(api => api.removeChat(chatId))`.
- Select elements only through the test-id contract (docs/UI.md 13): `page.getByTestId(testIds.newChat)`, and
  `byTestId(scope, testIds.chatRow, { 'data-chat-id': id })` for repeated elements. A missing id is a CCR, never a
  CSS or text selector on app internals.
- Web-first assertions only (`await expect(locator).toHaveAttribute(...)`, `expect.poll`, `toPass`), no fixed sleeps.
- Tag the tests the gate must run with `@smoke` in the title.
- Keyboard shortcuts: `pressShortcut(page, 'Mod+K')`, not `ControlOrMeta`; text editing keys follow the host:
  `selectAllText(page, field)` (see Keyboard below).
- Assistant text is markdown: straight quotes render as typographic quotes, match them with `looseQuotes()`.
- Settings -> Media: save `mediaSettingsOf(await api.getSettings())` and restore it through `cleanup` before changing a
  media key; start from `NO_MEDIA_SETTINGS` when a test needs a known state (e.g. no speech-to-text model).
- Request bodies: `Request.postDataBuffer()` of a page request is empty when the body holds a file or a blob (the
  dictation upload); `recordRequests(page, method, path)` reads bodies through `page.route()` and lets the requests
  through (`route.fallback()`), so it also proves that an action sent nothing. Hold a request (an upload in flight) with
  a `page.route` handler that awaits a promise before `route.fallback()`.
- A file input without a test id (the message editor's) is driven through its button and Playwright's `filechooser`
  event (`page.waitForEvent('filechooser')`, then `setFiles`).
- Sizes of elements inside a dialog: poll them (`expect.poll`), dialogs zoom in from 95% (a 40 px button measures 38 px
  meanwhile).
- The helpers import `@harness-forge/shared` by path (`packages/shared/src/index.ts`): the root package does not
  depend on it, and Playwright compiles the TypeScript sources directly.
- The root `tsconfig.json` type-checks `e2e/**` without the DOM library: inside `evaluate` callbacks reach browser
  globals through the element (`element.ownerDocument`, `ownerDocument.defaultView`), or pass a string expression
  (`page.evaluate<string>('navigator.clipboard.readText()')`).

```ts
import { expect, lastAssistantMessage, startChat, test, testIds } from '../../helpers/index.ts'

test('echoes a message @smoke', async ({ page, cleanup }) => {
  const chatId = await startChat(page, { modelRef: 'mock:echo', text: 'hello there' })
  cleanup(api => api.removeChat(chatId))
  await expect(lastAssistantMessage(page)).toHaveAttribute('data-status', 'done')
})
```

## Helper API (`helpers/index.ts`)

### Fixtures (`fixtures.ts`)

| Export | Description |
|---|---|
| `test` | `@playwright/test` `test` extended with `api: HarnessApi` (bound to the test's `request` context and `baseURL`) and `cleanup(task)` |
| `cleanup(task)` | registers `task(api)` to run after the test whatever happened, also after a timeout; last registered first, every task runs even when one fails (the first error is reported) |
| `CleanupTask` | `(api: HarnessApi) => unknown` |
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
| `stopChat(id)` / `removeChat(id)` | `POST /api/chat/:id/stop` (resolves to whether a run was stopped); stop, then delete (for `cleanup`) |
| `sendChat({ chatId?, text, parentId?, modelRef?, toolMode?, reasoningEffort?, imageOptions? })` | `POST /api/chat` (default `mock:echo`, `ask`, `auto`); resolves when the run finished with `{ chatId, userMessageId, chunks, text }`. `parentId`: omitted = the active leaf, `null` = a first message; an edit sends the parent of the edited message. `imageOptions` (`{ n?, aspectRatio?, editPrevious? }`) only with image models and chat models with image output, e.g. `{ modelRef: 'mock:image', imageOptions: { n: 2, aspectRatio: '16:9' } }` |
| `regenerateChat({ chatId, messageId?, modelRef?, toolMode?, reasoningEffort?, imageOptions? })` | `POST /api/chat` with `regenerate-message`: a new version of the reply `messageId` (default: the active leaf); resolves like `sendChat` (`userMessageId` = the answered user message) |
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
| `messageSnapshot(message)` · `MessageSnapshot` | `{ text, status }` read in that order (a `streaming` status proves the text was read mid-stream) |
| `expectStreamingWith(message, text, timeout?)` | waits until the message is `streaming` and shows `text`; returns that snapshot (e.g. to prove the last word was not there yet) |
| `chatRow(page, chatId)` | the sidebar row of a chat |
| `chatStatusDot(page, chatId, attributes?)` | the status dot next to that row (same list item, not inside the link), e.g. `{ 'data-status': 'running' }` |
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
| `hasFocus(locator)` | whether one of its elements has focus (never waits) |
| `pressUntilFocused(page, key, locator, max?)` | presses `key` (`Tab`, `Shift+Tab`, `ArrowDown`, ...) until the locator has focus, at most `max` (10) times |
| `selectAllText(page, field)` | selects the whole value of a focused input or textarea with the host's `ControlOrMeta+A` and checks that all of it is selected |

The app picks `Mod` from the browser's platform (`navigator.userAgentData.platform`). The "Desktop Chrome" device of
the config reports Windows even on a Mac host, so Playwright's host-based `ControlOrMeta` presses the wrong key there:
use `pressShortcut`. Letters are case-sensitive in Playwright: Mod+B is `pressShortcut(page, 'Mod+b')`, because the
sidebar compares `event.key` with a lowercase `b` (the app's own registry lowercases, so `'Mod+K'` works). Text
editing keys follow the host instead: `ControlOrMeta` is Meta on macOS and Control on Linux and Windows (resolved
from the platform of the process that runs Playwright), Chromium selects all with Ctrl+A on Linux and Windows, and
on macOS Playwright sends Meta+A as the `selectAll:` editing command, so `selectAllText` works on every host (CI runs
Linux). CodeMirror resolves its `Mod` from `navigator.platform`, which also stays the host's (the device only changes
the user agent), so the plugin specs use `ControlOrMeta` in the code editor. Avoid keys whose meaning differs by host
in text fields (Home / End scroll on macOS instead of moving the caret).

### Layout (`layout.ts`)

| Export | Description |
|---|---|
| `documentWidths(page)` | `{ scrollWidth, clientWidth }` of `<html>` (sideways scroll when `scrollWidth` exceeds the viewport) |
| `boxOf(locator)` | its bounding box (fails when it has none) |
| `touchTargetSize(locator)` | the size it answers touches in: its box, or a larger positioned `::after` hit area (the 32 px send button is 44 px) |

### Media (`media.ts`)

| Export | Description |
|---|---|
| `MEDIA_SETTINGS_KEYS` · `MediaSettings` | the Settings -> Media keys: `imageModelRef`, `transcriptionModelRef`, `transcriptionLanguage`, `speechModelRef`, `speechVoice`, `speechSpeed` |
| `mediaSettingsOf(settings)` | those keys of a `Settings` (restore them with `cleanup(api => api.updateSettings(before))`) |
| `NO_MEDIA_SETTINGS` | nothing chosen: every model `null`, language `auto`, voice `null`, speed 1 |
| `naturalSize(image)` | the pixel size of an `<img>` once it has loaded (e.g. 320x180 for a 16:9 `mock:image`) |
| `multipartParts(body, contentType)` · `MultipartPart` | the parts of a `multipart/form-data` body: `name`, `filename?`, `contentType?`, `size`, `head` (the first 16 bytes) |
| `recordRequests(page, method, path)` · `RequestLog` · `RecordedRequest` | records every matching request of the page from now on (`requests`: method, path, headers, `body` with file bytes; `jsonBodies()`), lets it through, `stop()` removes the route |

### Other helpers

| Export | Description |
|---|---|
| `startPasswordServer({ password?, dedicated?, label? })` | `{ baseURL, password, stop() }`: `E2E_AUTH_BASE_URL`, or a password-protected server started with `startServer` (`auth-server.ts`); `dedicated: true` always starts one with an empty data directory (for specs that wipe data); `label` names its temporary directory |
| `startServer({ env?, label? })` | `{ baseURL, stop() }`: the build on a free port of 127.0.0.1 with a temporary data directory, `HF_MOCK_PROVIDER=1`, `HF_OFFLINE=1` and every provider key variable set empty (which also beats a repository `.env`); `stop()` removes the directory (`server.ts`) |
| `REPO_ROOT` | the repository root (`server.ts`) |
| `uniqueId(prefix?)` · `wordList(count, prefix?)` · `firstWords(text, count)` | unique test data (`data.ts`) |
| `looseQuotes(text)` | a RegExp matching `text` with straight or typographic quotes: assistant markdown renders `"a"` as `“a”` (`data.ts`) |
| `isZip(bytes)` · `zipEntries(zip)` · `readZipText(zip, name)` · `ZipEntry` | a downloaded zip with Node built-ins (`zip.ts`): the `PK\x03\x04` magic, the central directory entries (`name`, `method`, sizes), the text of one stored or deflated entry (e.g. `manifest.json` of a backup) |
| `baseUrlFromEnv()` · `apiBaseUrl(baseURL)` · `DEFAULT_BASE_URL` | environment (`env.ts`) |

## Mock models

`mock:echo` streams the user text back (50 ms, then one word every 25 ms: 400 words stream for about 10 s, 600 for
about 15 s),
`mock:reasoning` streams a reasoning part first ("Thinking about ...", 100 ms per word) and answers
`Answer: <text>`, `mock:tool-approval` calls `mock_approval_tool` (approval in mode `ask`; Allow ->
`Tool result: {"echoed":"<text>"}`, Deny -> `The tool call was denied.`), `mock:error` fails with `auth_invalid`
(action `configure-provider`). Chat titles come from `mock:echo`: the first 8 words of the first message. Text files
attached to a `mock:echo` message reach it inlined (`Attached file "<name>": <contents>`), so its echo names them.

Media models (Phase 6): `mock:image` (an image model in the picker's "Image models" group: 300 ms, 5 s when the prompt
contains "slow", "fail" fails; solid-color PNGs with a 320 px long edge at the requested aspect ratio, square for Auto),
`mock:image-chat` (a chat model with image output: `Image for: <text>`, then one PNG), `mock:image-tool` (calls
`generate_image` when offered, which needs `imageModelRef`; then `Image tool result: <n> image(s)`),
`mock:transcribe` (`This is a mock transcription.` for any accepted recording) and `mock:speech` (a silent WAV, 400 ms
per word, 1 s to 6 s; voices `mock-voice-a`, `mock-voice-b`). Read-aloud ends every block with sentence punctuation:
end a reply you compare with the `{ text }` of `POST /api/audio/speech` with a period.
