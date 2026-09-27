# Phase 2 — Chat MVP + settings

Part of the harness-forge build plan. Progress is tracked in `docs/ROADMAP.md` (coordinator only). Shared names come
from `docs/DECISIONS.md`; endpoints and the stream protocol from `docs/API.md`; components, props, shortcuts and test
ids from `docs/UI.md`.

## Goal

A usable chat: the server streams AI SDK v7 runs with tools, approvals, slash commands, titles and usage/cost; the
web app renders the Claude Code-style transcript, composer, sidebar chat list, command palette and every settings
page; `@smoke` e2e specs guard the flow.

## Entry criteria

- Phase 1 exit criteria met; W1 checkpoint commit exists.
- Providers, credentials, catalog, chats, events, files, plugin host and the mock provider (`mock:echo`,
  `mock:reasoning`, `mock:tool-approval`, `mock:error`) work through the API.
- The coordinator has built the W1 checkpoint (`pnpm build`) for the e2e agent.

## Exit criteria

- ROADMAP items W2.1–W2.6 checked; W2 gate green; checkpoint commit.
- `POST /api/chat` with `mock:echo` streams a UI message stream; stop, resume and approvals work.
- `pnpm test:e2e --grep @smoke` is green with the OS color scheme emulated as light.
- Settings pages and login work end to end against the real API.

## Rules for every Phase 2 agent

- Server paths are under `apps/server/src/`; web paths under `apps/web/app/`. Tests live next to code.
- Frozen: `packages/*/src`, `app.ts`, `*/types.ts`, layouts, store signatures, `nuxt.config.ts`,
  `components/{ui,ai-elements}/**` (no exceptions: W2.2 renders `Markdown.vue` itself instead of patching AI
  Elements), CSS tokens. Blocked → CCR + local adapter.
- Cross-agent components are imported explicitly by path (e.g.
  `import ChatComposer from '~/components/chat/composer/ChatComposer.vue'`), never through auto-import prefixes.
- UI: shadcn-vue + Tailwind tokens only, `data-testid` from `utils/testids.ts`, `aria-label` on icon-only
  buttons, no `v-html`. AI SDK v7 names only (`instructions`, `isStepCount`, `toolApproval`, `onEnd`,
  `result.stream`, async `convertToModelMessages`); `useChat()` from `@ai-sdk/vue` 4, `DefaultChatTransport` from
  `ai`. Verify in the installed `.d.ts`.
- Verify commands — server: `pnpm -F @harness-forge/server test` · `pnpm typecheck`; web:
  `pnpm -F @harness-forge/web test` · `pnpm -F @harness-forge/web typecheck:fast`; all: `pnpm check:english`.

---

## Wave W2 (6 agents in one launch)

### W2.1 chat-server

- **Mission.** Implement the chat pipeline of the plan's Appendix C: runs, history, tools, approvals, slash
  commands, streaming, persistence, titles, usage/cost and error mapping.
- **Owned.** `apps/server/src/chat/**`, `apps/server/src/http/routes/{chat,commands}.ts` (+ tests).
- **Read-only highlights.** `chat/types.ts`, `providers/**` (`resolveModel`), `registry/**`, `mcp/types.ts`,
  `services/chats/types.ts`, `services/events/types.ts`, `docs/API.md` (chat request, stream, resume, stop).
- **Tasks.**
  1. **W2.1-T1 Runs** — `chat/runs.ts`: one active run per chat (a second `POST /chat` → 409 `conflict`), an
     `AbortController` per run (never the request signal), resume buffer fed by `consumeSseStream`;
     `GET /chat/:id/stream` replays the active run or returns 204 when idle; `POST /chat/:id/stop` aborts into the
     normal persist path; emits `run.started` / `run.finished`.
     *Accept:* closing the client connection does not stop the run; a resumed client receives the remaining parts.
  2. **W2.1-T2 Request + model** — validate with the shared chat request schema; upsert the chat (client uuidv7);
     user message ids come from the client (`createMessageId`, ADR-019: `msg_` format and uniqueness checked),
     assistant ids never do; store mode/effort in chat settings; `resolveModel` → 400 `provider_not_configured`
     **before** streaming.
  3. **W2.1-T3 History** — one transaction: slash-command expansion (original text shown, expansion in
     `metadata.command`; `reply` commands written via `createUIMessageStream` without a model call); pending
     approvals → denied ("superseded"); edit = replace `messageId` and drop later messages; regenerate = drop
     `messageId` and later; continuation merges only approval decisions (by approval id); `validateUIMessages`;
     `/api/files` parts → bytes for vision/pdf-capable models only.
  4. **W2.1-T4 Tools** — registry + MCP tools filtered by `toolMode` (`off` ⇒ none), tool prefs and
     `capabilities.tools`; each wrapped with the plugin guard, an owner-active check, `tool.before`/`tool.after`
     hooks and a 64 KB output cap.
  5. **W2.1-T5 Approvals** — `chat/approval.ts` passed as `streamText({ toolApproval })`: user override in
     `tool_prefs` (allow/ask/deny) → `tool.approve` hook → mode: `ask` ⇒ `safe` runs, everything else needs
     approval; `auto` ⇒ only `always` needs approval; policy `deny` ⇒ denied.
     *Accept:* a table-driven test covers every (override, hook, mode, policy) combination.
  6. **W2.1-T6 Params** — global + chat `instructions`, `provider.reasoning()`, hooks `chat.params` / `chat.headers`,
     `await convertToModelMessages(history, { tools })`, hook `chat.messages`, trim oldest turns above 85% of the
     context window.
  7. **W2.1-T7 Stream** — `streamText({ model, instructions, messages, tools, reasoning, providerOptions, headers,
     toolApproval, stopWhen: isStepCount(maxSteps ?? 20), abortSignal: run.signal, maxRetries: 2 })` (`reasoning` +
     `providerOptions` from `ReasoningParams`), `result.consumeStream()`, `createUIMessageStreamResponse({ stream:
     toUIMessageStream({ stream: result.stream, originalMessages, sendReasoning: true, sendSources: true,
     generateMessageId: createMessageId, messageMetadata, onError, onEnd }), consumeSseStream })`
     (`createMessageId` from `@harness-forge/shared`: `msg_` + 16 chars; the SDK's `createIdGenerator` default
     separator is `-`). Verify each option name in the installed types.
  8. **W2.1-T8 Metadata + persistence** — start `{ modelRef, startedAt }`; finish `{ finishedAt, durationMs,
     reasoningMs, usage (incl. reasoning and cache tokens), costUsd (catalog or OpenRouter-reported), finishReason }`;
     `onEnd` idempotent upsert: message (+ `aborted`, error), usage row, chat `updated_at` and `pending_approval`,
     provider status, `message.completed` hook, release run, `run.finished` (with `awaitingApproval`).
  9. **W2.1-T9 Titles** — first turn, in parallel: `titleModelRef ?? smallModelId ?? chat model`, ≤8 words, 10 s
     timeout, fallback = first 60 chars; never overwrites a user title; pushed as `chat.updated`.
  10. **W2.1-T10 Errors** — `provider.mapError` first, then 401/403 → `auth_invalid` (action `configure-provider`),
      429 → `rate_limited` (+ `retryAfterMs`), 404 → `model_not_found` (action `refresh-models`), context length →
      `context_overflow`, ECONNREFUSED/ENOTFOUND → `provider_unreachable`, else `provider_error`; the envelope
      `status` carries the upstream status, the HTTP status of pre-stream errors comes from `errorStatusByCode`
      (`auth_invalid` → 502, never 401); `onError` returns the envelope JSON.
  11. **W2.1-T11 Commands API** — `GET /commands`: registry commands (name, description, source plugin).
- **Tests.** With `MockLanguageModelV4`: echo stream, 409, stop → `aborted: true` persisted, resume replay + 204,
  approval matrix, command expansion + reply command, edit/regenerate truncation, title timeout fallback (fake
  timers), usage row + cost, error mapping table, `provider_not_configured` without a stream, 64 KB cap, trimming.
- **Verify.** Server commands.

### W2.2 chat-web

- **Mission.** Build the chat session layer and transcript: `useChatSession`, empty state, chat page, messages, every
  part renderer and the safe `Markdown` wrapper.
- **Owned.** `pages/index.vue`, `pages/chat/[id].vue`, `components/chat/*` (files directly in `chat/`),
  `components/chat/parts/**`, `composables/useChatSession.ts` (+ test), `components/common/Markdown.vue` (+ test).
  No AI Elements file is edited: `message/MessageResponse.vue` and `reasoning/ReasoningContent.vue` render markdown
  with vue-stream-markdown, so W2.2 never uses `AiMessageResponse` / `AiReasoningContent` and renders text and
  reasoning through `Markdown.vue` itself.
- **Read-only highlights.** `components/ai-elements/**`, `stores/**`, `packages/shared/src/**` (chat contract),
  `docs/UI.md` (transcript, parts, header), `docs/API.md` (stream protocol).
- **Tasks.**
  1. **W2.2-T1 Session registry** — `useChatSession(id)`: `useChat({ id, messages, generateId: createMessageId,
     transport: new DefaultChatTransport({ api: '/api/chat', prepareSendMessagesRequest }), sendAutomaticallyWhen:
     lastAssistantMessageIsCompleteWithApprovalResponses })` kept in a detached `effectScope` registry (8 most
     recent; a streaming session is never evicted). `@ai-sdk/vue` 4 has no `resume` option: on mount, when the chat
     has an active run (`ChatSummary.running` or a `run.started` event), the session calls `chat.resumeStream()`
     (`GET /api/chat/:id/stream`, 204 when idle). User message ids come from `createMessageId` (ADR-019); the request
     body carries only the last message + `modelRef`, `reasoningEffort`, `toolMode`, `trigger`, `messageId?`; writes
     per-chat run status to the chats store.
     *Accept:* navigating away mid-stream and back shows the stream still running; the 9th session evicts the
     least recently used idle one.
  2. **W2.2-T2 Empty state** — `pages/index.vue`: ember mark, Source Serif 32px "What's next, {displayName}?" (or
     "What's next?"), composer, "Connect a provider to start" callout when no provider is connected; the first send
     creates a uuidv7 chat id and navigates to `/chat/:id` without dropping the stream.
  3. **W2.2-T3 Chat page** — `pages/chat/[id].vue`: header h-12 (border after scroll) with inline-rename title and
     `⋯` Rename / Show thinking / Export MD·JSON / Delete; transcript `max-w-3xl`; scroll-to-bottom pill; sticky
     composer; unknown id → not-found state.
  4. **W2.2-T4 Messages** — `ChatTranscript.vue`, `ChatMessage.vue`: user = right-aligned `bg-muted rounded-2xl`
     ≤85%; assistant = no bubble, parts in order; hover actions copy / regenerate / edit (edit resubmits with
     `messageId`); per-message stats from metadata (model, duration, tokens, cost).
  5. **W2.2-T5 Part renderers** — `components/chat/parts/**`: text → `Markdown` (`final` when done); reasoning
     (`AiReasoning` + `AiReasoningTrigger`, body = `Markdown` inside a shadcn `CollapsibleContent`; "Thinking… Ns"
     shimmer → "Thought for Ns" from `metadata.reasoningMs` after a reload; collapsed unless Show thinking); tool
     row (`▸ icon name "first arg" status`: spinner / amber approval / ✓ / ✗ / Denied; expandable input/output
     capped at 4 KB; MCP server badge); approval card (`AiConfirmation` "Allow **tool**?" + args + Deny / Allow +
     "Always allow {tool}" checkbox, i.e. "Don't ask again" → `addToolApprovalResponse` + `PATCH /api/tools/:name`
     with override `allow`; UI.md 7.3); file chip/thumbnail; sources row;
     error alert ("Open settings" → `/settings/providers?configure=<id>` for `auth_invalid` /
     `provider_not_configured`, else Retry).
  6. **W2.2-T6 Markdown** — `components/common/Markdown.vue` wraps markstream-vue with raw HTML escaped (verify the
     prop name in the installed types), lazy Shiki code blocks with copy, links limited to `http`, `https`,
     `mailto` (`rel="noopener noreferrer"`, new tab); every assistant text and reasoning part renders through it.
     *Accept:* `<script>`, `<img onerror>` and `javascript:` links render inert as text.
- **Tests.** registry eviction, request body shape, part renderer states (incl. approval), Markdown XSS cases, 4 KB
  cap.
- **Verify.** Web commands.

### W2.3 composer-web

- **Mission.** Build the composer: prompt input, attachments, model picker, effort and permission menus, slash menu,
  send/stop and composer shortcuts.
- **Owned.** `components/chat/composer/**`, `composables/useComposer*.ts`.
- **Read-only highlights.** `components/ai-elements/prompt-input/**`, `components/ai-elements/context/**`,
  `components/providers/ProviderIcon.vue`, `stores/{models,providers,settings}.ts`, `composables/useShortcuts.ts`,
  `docs/UI.md` (composer, shortcuts).
- **Tasks.**
  1. **W2.3-T1 ChatComposer** — `ChatComposer.vue` on `AiPromptInput`: `rounded-[20px] border bg-card`; chips →
     autosize textarea (≤40vh, "Reply…") → toolbar [`+` ModelPicker EffortMenu] … [PermissionMenu context ring
     Send/Stop (32px ember circle)]; send key from settings (`enter | mod-enter`), Shift+Enter newline, Esc stops a
     running stream, ↑ in an empty composer emits `edit-last`; unsent draft kept per chat in sessionStorage.
  2. **W2.3-T2 Attachments** — `+` menu (Attach files, Commands); paste and drop → `POST /api/files` with progress;
     removable chips and image thumbnails; warning when the model lacks vision/pdf.
  3. **W2.3-T3 ModelPicker** — popover with a command list grouped by provider (`ProviderIcon` headers), capability
     badges (tools, vision, reasoning, context size), search, favorites → recent → by provider; Alt+M; unconfigured
     providers disabled with "Connect"; "Manage models" → `/settings/models`.
  4. **W2.3-T4 EffortMenu + PermissionMenu** — effort only for reasoning models (values from `reasoningEfforts`,
     default `auto`; Alt+R); permission mode `off | ask | auto` only when tools exist (Alt+P).
  5. **W2.3-T5 SlashMenu** — `/` at the start opens commands from `GET /api/commands` plus client-only `/new`,
     `/model`, `/effort`, `/mode`, `/help`; keyboard navigation; client-only commands never reach the server.
  6. **W2.3-T6 Context ring** — `AiContext` shows used vs context window from the last usage metadata; tooltip with
     tokens and cost.
- **Tests.** send-key matrix, slash filtering + client-only commands, upload flow (mocked `$api`), menus hidden when
  not applicable, Alt shortcuts by `event.code` and ignored with Ctrl.
- **Verify.** Web commands.

### W2.4 sidebar-web

- **Mission.** Replace the Phase 0 stub slots with the chat list, the command palette, the shortcuts dialog and the
  global shortcuts.
- **Owned.** `components/app-shell/{ChatNav,CommandPalette,ShortcutsDialog}.vue` (+ tests),
  `components/app-shell/chat-nav/**` (sub-components), `composables/useGlobalShortcuts.ts` (+ test).
- **Read-only highlights.** `components/app-shell/AppSidebar.vue`, `layouts/**`, `stores/{chats,ui}.ts`,
  `composables/useShortcuts.ts`, `docs/UI.md` (sidebar, palette, shortcuts).
- **Tasks.**
  1. **W2.4-T1 ChatNav** — "New chat" (Mod+Shift+O) and "Search" (Mod+K) rows; date groups Today / Yesterday /
     Previous 7 days / Previous 30 days / month (UI.md 5.3); row = title + status dot (pulsing ember running, amber
     awaiting approval, foreground unread) read from the chats store (`statusOf(id)`; approval comes from
     `ChatSummary.pendingApproval` and `run.finished` `awaitingApproval`, so it survives reloads); active row; hover
     `⋯` Rename (inline) / Export / Delete (toast with Undo; the DELETE request is sent only when the toast
     expires); infinite scroll by cursor; live `chat.*` updates.
  2. **W2.4-T2 CommandPalette** — Mod+K: debounced chat search (`GET /api/chats?q`) + actions (New chat, Plugins,
     each settings page, theme Dark / Light / System, Show shortcuts).
  3. **W2.4-T3 ShortcutsDialog** — Mod+/: the `useShortcuts` registry grouped, with platform key labels.
  4. **W2.4-T4 Global shortcuts** — `useGlobalShortcuts()` registers Mod+K, Mod+Shift+O, Mod+/ and Shift+Esc
     (focus composer) plus the display-only Mod+B entry (handled by `SidebarProvider`) through `useShortcuts` (C5
     registry; the single `keydown` listener lives in `plugins/shortcuts.client.ts`); it is called from
     `CommandPalette.vue` (mounted once by the frozen layout), so no layout change is needed.
     *Accept:* each shortcut is registered exactly once; Mod = Meta on macOS, Ctrl elsewhere.
- **Tests.** date grouping boundaries (fixed clock), Undo cancels the DELETE, palette ordering, shortcut
  registration.
- **Verify.** Web commands.

### W2.5 settings-web

- **Mission.** Build every settings page and the login page against the real API.
- **Owned.** `pages/settings/**`, `pages/login.vue`, `components/settings/**`.
- **Read-only highlights.** `stores/{auth,providers,models,settings}.ts`, `components/providers/ProviderIcon.vue`,
  `components/app-shell/SettingsNav.vue`, `docs/UI.md` (settings pages), `docs/API.md`.
- **Tasks.**
  1. **W2.5-T1 Providers** — list with color icon, model count or "Local — no key", status badge (Connected / Not
     configured / From env / Error 401), enable switch, Test; key dialog ("Get a key ↗", reveal toggle for typed
     input only, Advanced base URL, Test before Save, Remove key); stored keys appear only as hints;
     `?configure=<id>` opens that provider's dialog; warning banner when served over HTTP from a non-localhost host.
     *Accept:* no DOM node ever contains a stored key.
  2. **W2.5-T2 Models** — default model + title model; per-provider tables (favorite, hide, alias), refresh, add a
     custom model id.
  3. **W2.5-T3 General** — display name, instructions, send key, default permission mode + effort, max steps, Alt
     shortcuts toggle, password set/change/clear (read-only notice while `HF_PASSWORD` is set; `PUT
     /api/auth/password` is a fresh-auth route, so a stale session logs in with the current password first). Bulk
     data export/import/delete is not in v1 (ADR-020); chats are exported one at a time from the chat menus.
  4. **W2.5-T4 Appearance** — theme cards Dark / Light / System (`useColorMode().preference`), reading font, text
     size, density, expand thinking (`showThinking`).
  5. **W2.5-T5 About** — app version, Node version, uptime and library versions from `GET /api/health` (`Health`:
     `version`, `node`, `uptimeSec`, `versions.{ai,hono,nuxt?}`), MIT license, "Copy diagnostics" (versions,
     provider statuses, plugin states; never keys).
  6. **W2.5-T6 Login** — password form, error state, rate-limit message with the retry time, redirect to
     `?redirect=` (only paths starting with `/`, not `//`).
- **Tests.** key dialog (hint only, Test before Save), settings validation, `?configure=` deep link, login redirect
  and rate-limit message.
- **Verify.** Web commands.

### W2.6 e2e-core

- **Mission.** Write the `@smoke` Playwright specs that guard the core chat flow at every later gate.
- **Owned.** `e2e/**`.
- **Read-only highlights.** `playwright.config.ts`, `apps/web/app/utils/testids.ts`, `docs/UI.md` (test ids),
  `docs/PROVIDERS.md` (mock models), `packages/shared/src/**` (`createApiClient` for setup).
- **Tasks.**
  1. **W2.6-T1 Support** — `e2e/support/**`: API helpers over `createApiClient` against `E2E_BASE_URL`, test-id
     imports, new-chat helper, light color-scheme context.
  2. **W2.6-T2 Specs** — `e2e/specs/core/*.spec.ts`, each tagged `@smoke`:
     1. dark default: OS emulated light + empty storage → `html.dark` before first paint;
     2. theme toggle: Light persists across reload (`hf-color-mode`);
     3. login: set a password via `PUT /api/auth/password` → reload → wrong password error → correct password →
        app; the password is cleared in `afterAll` (serial describe);
     4. stream `mock:echo`: text appears incrementally; the title shows in the sidebar;
     5. reasoning `mock:reasoning`: a "Thought for" row;
     6. tool approval `mock:tool-approval` (tool `mock_approval_tool`, mode `ask`): Allow → result row, then
        `Tool result: {"echoed":…}`; Deny → "Denied", then `The tool call was denied.`;
     7. persistence: reload keeps the transcript;
     8. stop during `mock:echo` (a 400-word message streams for about 10 s): partial message kept and marked stopped;
     9. provider not configured: `defaultModelRef` set to an unconfigured builtin model via `PUT /api/settings` →
        send → alert with "Open settings" → `/settings/providers?configure=<id>`.
- **Verify.** `pnpm test:e2e --list` (specs compile and are discovered). Specs that need only Phase 1 UI can run
  against the coordinator's W1 build on the agent slot: `HF_MOCK_PROVIDER=1 HF_PORT=889k
  HF_DATA_DIR=.tmp/W2.6 pnpm start` + `E2E_BASE_URL=http://127.0.0.1:889k pnpm test:e2e --grep @smoke`. The full
  suite runs at the gate against the fresh build.

### Wave W2 ownership

`?id?.vue` matches the literal Nuxt file `[id].vue`: square brackets are glob character classes, so they are not
written literally in globs.

```json
{
  "wave": "W2",
  "agents": {
    "W2.1": [
      "apps/server/src/chat/**",
      "apps/server/src/http/routes/chat.ts",
      "apps/server/src/http/routes/chat.test.ts",
      "apps/server/src/http/routes/commands.ts",
      "apps/server/src/http/routes/commands.test.ts"
    ],
    "W2.2": [
      "apps/web/app/pages/index.vue",
      "apps/web/app/pages/chat/?id?.vue",
      "apps/web/app/components/chat/*",
      "apps/web/app/components/chat/parts/**",
      "apps/web/app/composables/useChatSession.ts",
      "apps/web/app/composables/useChatSession.test.ts",
      "apps/web/app/components/common/Markdown.vue",
      "apps/web/app/components/common/Markdown.test.ts"
    ],
    "W2.3": [
      "apps/web/app/components/chat/composer/**",
      "apps/web/app/composables/useComposer*.ts"
    ],
    "W2.4": [
      "apps/web/app/components/app-shell/ChatNav.vue",
      "apps/web/app/components/app-shell/ChatNav.test.ts",
      "apps/web/app/components/app-shell/CommandPalette.vue",
      "apps/web/app/components/app-shell/CommandPalette.test.ts",
      "apps/web/app/components/app-shell/ShortcutsDialog.vue",
      "apps/web/app/components/app-shell/ShortcutsDialog.test.ts",
      "apps/web/app/components/app-shell/chat-nav/**",
      "apps/web/app/composables/useGlobalShortcuts.ts",
      "apps/web/app/composables/useGlobalShortcuts.test.ts"
    ],
    "W2.5": [
      "apps/web/app/pages/settings/**",
      "apps/web/app/pages/login.vue",
      "apps/web/app/components/settings/**"
    ],
    "W2.6": ["e2e/**"]
  }
}
```

### Wave W2 cross-agent contracts

| Producer → consumer | Contract |
|---|---|
| W2.1 ↔ W2.2 | chat request, `MessageMetadata`, `data-*` parts from `@harness-forge/shared`; UI message stream, resume (`GET /chat/:id/stream`, 204 idle) and stop per API.md; errors arrive as envelope JSON |
| W2.3 → W2.2 | `ChatComposer` (`components/chat/composer/ChatComposer.vue`) is rendered by `pages/index.vue` and `pages/chat/[id].vue` with the props/emits fixed in UI.md (submit payload, stop, `edit-last`); the composer never calls `useChat` |
| W2.2 → W2.4 | per-chat run status flows through the chats store (C5 signature); W2.4 never imports `useChatSession` |
| W2.1 → W2.3 | `GET /api/commands` feeds SlashMenu; client-only commands stay in W2.3 |
| W2.2 → W2.5 | "Open settings" links to `/settings/providers?configure=<id>`; W2.5 opens that provider's key dialog |
| W2.3 → W2.5 | "Manage models" links to `/settings/models` |
| all → W2.6 | `data-testid` values from `apps/web/app/utils/testids.ts`; missing ids are requested by CCR, not invented |

## Gate W2

1. `node scripts/audit-ownership.mjs .tmp/waves/W2.json`
2. `pnpm install --frozen-lockfile` (if deps changed) → `pnpm check` → `pnpm build`.
3. `pnpm start:e2e` → `curl -sf :8899/api/health` → stream a chat with `mock:echo`:
   ```sh
   curl -N -s http://127.0.0.1:8899/api/chat \
     -H 'content-type: application/json' -H 'origin: http://127.0.0.1:8899' \
     -d '{"chatId":"0199a8f0-0000-7000-8000-000000000001","message":{"id":"msg_gate000000000001","role":"user","parts":[{"type":"text","text":"ping"}]},"trigger":"submit-message","modelRef":"mock:echo","reasoningEffort":"auto","toolMode":"ask"}'
   ```
   → text-delta frames echo `ping`, then a finish frame; afterwards
   `curl -s -o /dev/null -w '%{http_code}' :8899/api/chat/0199a8f0-0000-7000-8000-000000000001/stream` prints `204`,
   and `GET /api/chats/0199a8f0-0000-7000-8000-000000000001` returns both messages and a title.
4. `pnpm test:e2e --grep @smoke` with the OS color scheme emulated as light, asserting `html.dark`.
5. Screenshots (dark + light) of `/`, `/chat/:id` (finished stream, reasoning row, approval card), each
   `/settings/*` page and `/login` into `.tmp/gates/W2/`.
6. Update ROADMAP + wave log → checkpoint commit.
