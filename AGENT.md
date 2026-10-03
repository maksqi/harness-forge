# AGENT.md — rules for AI agents working on harness-forge

**harness-forge** is a self-hosted, single-user, BYOK (bring-your-own-key) AI chat + agent harness with a web UI.
Plugins (managed in a dedicated **Plugins** tab) add LLM providers, models, tools, MCP servers and slash commands.
The chat UI mimics the Claude Code desktop app, simplified. Dark theme is the default.

Read this file fully before doing anything. Then read the docs listed in "Where things are documented".

## Golden rules

1. **English only.** Code, comments, docs, UI strings, test names, commit messages, log messages — everything.
   No Cyrillic characters anywhere in the repository. `pnpm check:english` enforces this.
2. **Dark theme is the default.** Light and System are opt-in via the theme toggle. Never ship a light flash on load.
3. **Stay inside your OWNED paths.** Your task prompt lists OWNED / READ-ONLY / FORBIDDEN paths. Never edit a file
   you do not own, even to fix a typo — report it instead.
4. **Frozen files change only through the coordinator** (see "Contracts, freeze and CCRs").
5. **Sub-agents never run:** `pnpm`/`npm`/`npx`/`pnpm dlx` installs or CLIs (shadcn-vue, ai-elements-vue, nuxi,
   drizzle-kit), `git` write commands (add/commit/checkout/reset/stash/clean) on this repository (Phase 8 tests may `git init` and
   commit inside their own `realpath(mkdtemp())` folders), `nuxt dev`/`nuxt build`/`nuxt prepare`,
   or any server on ports 3000/8787. Running scripts that already exist (`pnpm -F <pkg> test`, `pnpm typecheck`,
   `pnpm -F @harness-forge/web typecheck:fast`, `pnpm check:english`) is allowed.
6. **Verify APIs against installed types.** Library versions here are newer than most model training data.
   Before using an API, read its `.d.ts` in `node_modules` (e.g. `node_modules/ai/dist/index.d.ts`). Never guess.
7. **Security by default.** No secrets in code, logs or API responses. Never render untrusted HTML (`v-html` is
   forbidden). Validate every request body with zod. Guard every filesystem path derived from user input.
8. **Tests live next to code** (`*.test.ts`). New behavior needs a test.
9. **Keep the contract.** Request/response shapes come from `packages/shared`; plugin shapes come from
   `packages/plugin-sdk`. If the contract is wrong, file a CCR — do not fork local copies of the types.

## Stack and pinned versions (verified 2026-09-27)

| Area | Choice |
|---|---|
| Runtime | Node >= 22.12 (dev machine: 26.x), pnpm 11 workspaces |
| Language | TypeScript **~6.0.3** (TS 7 breaks `.vue` prop-type imports — never upgrade), ESM everywhere, `strict: true` |
| Web | Nuxt 4.5 SPA (`ssr: false`, `nuxt generate`), shadcn-vue 2.8 (`shadcn-nuxt`), reka-ui 2.10, Tailwind CSS 4.3 (`@tailwindcss/vite`), `@nuxtjs/color-mode` 4, Pinia 4 + `@pinia/nuxt`, `@vueuse/nuxt` 15, `@lucide/vue`, vue-sonner, `@tanstack/vue-form`, CodeMirror 6, AI Elements Vue (copied, prefix `Ai`), markstream-vue 2 |
| Server | Hono 4.13 + `@hono/node-server` 2, `@hono/zod-validator`, Drizzle ORM 0.45 + `@libsql/client`, zod 4 |
| LLM | Vercel AI SDK **v7** (`ai`), `@ai-sdk/vue` 4 (`useChat`), official `@ai-sdk/*` providers, `@openrouter/ai-sdk-provider`, `@ai-sdk/mcp` |
| Tooling | tsx (dev), tsdown (server build), Vitest 4, Playwright (Chromium), ESLint with `@antfu/eslint-config` |
| Icons | `@lobehub/icons-static-svg` (served by the server), `@lucide/vue` for UI icons |

## Version facts (read before coding)

- **AI SDK v7**: `streamText({ instructions })` (not `system`); `stopWhen: isStepCount(n)` (`stepCountIs` is a
  deprecated alias); `result.stream` (not `fullStream`); callbacks `onEnd` / `onStepEnd` (not `onFinish`);
  tool approval is the `toolApproval` option of `streamText` (not per-tool `needsApproval`);
  `convertToModelMessages` is **async**; system messages inside `messages` are rejected by default.
  Server response: `createUIMessageStreamResponse({ stream: toUIMessageStream({ stream: result.stream, ... }) })`.
  Always pass provider **instances** — a plain string model id is routed to the Vercel AI Gateway.
  Custom providers implement `LanguageModelV4` from `@ai-sdk/provider`. Test models: `MockLanguageModelV4`,
  `simulateReadableStream` from `ai/test`. Verify every name in the installed `.d.ts`.
- **AI SDK v7 media** (Phase 6): `generateImage`, `transcribe` and `generateSpeech` are stable (`experimental_*` names
  are deprecated aliases); specs `ImageModelV4`, `TranscriptionModelV4`, `SpeechModelV4`; test doubles
  `MockImageModelV4`, `MockTranscriptionModelV4`, `MockSpeechModelV4` from `ai/test`. Always pass model instances.
  `toUIMessageStream`'s own `onEnd` saves the chunks it produced itself, so a transform placed after it never reaches
  the saved message: wrap it as `createUIMessageStream({ originalMessages, generateId, onEnd, execute: ({ writer }) =>
  writer.merge(ui.pipeThrough(transform)) })`. Generated files are stored in `files` before they are streamed; no
  `data:` URL is ever saved in `messages`.
- **Plugin API 1.1.0** (Phase 6, additive): `ProviderDefinition.createImageModel?`, `imageParams?`,
  `createTranscriptionModel?`, `createSpeechModel?`, `transcriptionOptions?`; `PluginContext.images.generate`. The
  template mirror `apps/server/src/plugins/templates/sdk-types.ts` must match the SDK.
- **Plugin API 1.2.0** (Phase 7, additive): `ToolCallContext.workspace?: { projectId, name, root }` (set when the
  chat's project folder opened), `ToolDefinition.workspace?: 'read' | 'write' | 'execute'` (such tools are offered only
  in chats with an open project), `ImageGenerateResult.modelName`. `ToolMode` is `off | ask | edits | auto` (`edits` =
  "Accept edits": `safe` tools and `ask` tools with workspace `write` run without asking). The mirror follows.
- **Agent workspace** (Phase 7, ADR-031 … ADR-033): projects are folders inside `HF_WORKSPACE_ROOTS`; every path a
  workspace tool touches resolves through `apps/server/src/workspace/paths.ts` (`resolveWorkspacePath`, realpath
  containment); the `shell` tool runs in its own process group with a minimal environment; never call `spawn` with a
  shell string elsewhere. Tests use `realpath(mkdtemp())` (macOS `/var` is a link to `/private/var`) and POSIX `sh`
  syntax only (CI runs Linux).
- **Workspace 2.0** (Phase 8, ADR-036 … ADR-039; plugin API stays 1.2.0): every core `write_file` / `edit_file` write goes
  through `journaledWrite` (`apps/server/src/workspace/journal.ts`), which snapshots the previous state into
  `<dataDir>/checkpoints/` and journals it in `workspace_changes`; revert / rewind / undo write through
  `apps/server/src/services/checkpoints/restore.ts`; the run scope (`workspace/run-scope.ts`, bound to
  the tool call context) carries the chat, message, journal, shell rules and the sticky working folder; one per-file
  lock (`workspace/file-lock.ts`) serializes writes. Rewind, revert and undo are batches (`wcb_` ids) and are refused
  (409 `run-active`) while any chat of the project runs. **git runs only through `apps/server/src/workspace/git.ts`**
  (argument arrays, scrubbed environment, `GIT_CEILING_DIRECTORIES`, hooks / fsmonitor / filter and diff drivers
  neutralized, a read-only command allowlist); the
  shell stays the only shell-string spawn. Shell rules (`shell_rules`, `srl_` ids) are matched by the shared parser
  `packages/shared/src/util/shell-command.ts`, which fails closed. The automatic file sweep (`fileSweep`) is opt-in.
- **@ai-sdk/vue 4**: use the `useChat()` composable (the `Chat` class is deprecated); `DefaultChatTransport` is
  imported from `ai`.
- **MCP**: `createMCPClient` from `@ai-sdk/mcp`; stdio transport from `@ai-sdk/mcp/mcp-stdio`.
- **TypeScript 6**: list `types` explicitly in tsconfig; do not use `baseUrl`.
- **pnpm 11**: all settings live in `pnpm-workspace.yaml` (the `pnpm` field in package.json is ignored);
  dependency build scripts need `allowBuilds`.
- **Pinia 4**: ESM-only, needs `@vue/devtools-api` v8.
- **@nuxtjs/color-mode 4**: `useColorMode().preference = 'dark' | 'light' | 'system'`; `value` is read-only.
- **shadcn-vue**: components live in `apps/web/app/components/ui` (no prefix). AI Elements Vue components live in
  `apps/web/app/components/ai-elements` and are used with the `Ai` prefix (`<AiConversation>`). Do not add the
  shadcn-vue native chat components (`Message`, `Bubble`, `Message Scroller`) — name clash.
- **Icons in Vue**: `@lucide/vue` (the old `lucide-vue-next` is deprecated).
- **Forms**: `@tanstack/vue-form` + zod v4 (vee-validate stable needs zod 3 — do not use it).

## Repository map

```
AGENT.md CLAUDE.md README.md LICENSE          root docs
package.json pnpm-workspace.yaml             workspace + scripts + catalog/overrides/allowBuilds
docs/                                         ROADMAP (progress), DECISIONS (ADRs + contract seed), ARCHITECTURE,
                                              API, PLUGINS, PROVIDERS, UI, phases/phase-N-*.md
scripts/                                      check-english.mjs, audit-ownership.mjs, update-catalog.ts
packages/shared/        @harness-forge/shared       zod DTOs, HarnessError, route table, createApiClient
packages/plugin-sdk/    @harness-forge/plugin-sdk   plugin types, definePlugin, manifest/settings schemas
apps/server/            @harness-forge/server       Hono core: http/, security/, db/, services/, registry/,
                                                    plugins/, catalog/, providers/, chat/, mcp/, workspace/,
                                                    builtin-plugins/
apps/web/               @harness-forge/web          Nuxt 4 SPA: app/{pages,layouts,components,composables,stores,...}
examples/plugins/                              sample plugins (also used as test fixtures)
e2e/                                           Playwright specs + fixtures
data/                                          runtime data (gitignored)
```

## Commands

| Command | Purpose |
|---|---|
| `pnpm dev` | server (`tsx watch`, :8787) + web (`nuxt dev`, :3000, proxies `/api`) — coordinator only |
| `pnpm build` | `nuxt generate` (web) + `tsdown` (server) — coordinator only |
| `pnpm start` | production server on :8787 serving API + SPA |
| `pnpm start:e2e` | production server with `HF_MOCK_PROVIDER=1 HF_PORT=8899 HF_DATA_DIR=.tmp/e2e` |
| `pnpm test` | Vitest (all projects); `pnpm -F <pkg> test` for one package |
| `pnpm test:live` | opt-in live provider suite (`*.live.test.ts`; needs `HF_LIVE=1` + provider keys; paid calls) — never in `pnpm test` |
| `pnpm test:e2e` | Playwright |
| `pnpm lint` | ESLint (agents: `--fix` only on owned paths) |
| `pnpm typecheck` | `tsc --noEmit` for packages/server + `nuxi typecheck` for web |
| `pnpm -F @harness-forge/web typecheck:fast` | `vue-tsc -b --noEmit` (for agents; needs an existing `.nuxt`) |
| `pnpm check:english` | fail on any Cyrillic character in tracked + untracked (non-ignored) files |
| `pnpm check` | check:english + lint + typecheck + test |
| `pnpm db:generate` | drizzle-kit generate — coordinator only |
| `pnpm catalog:update` | refresh the bundled models.dev snapshot — coordinator only |
| `pnpm key:rotate` | offline master-key rotation (`rotate-key` CLI, ADR-034; the server must be stopped) — coordinator / user only |

## Conventions

- **Files**: server/packages use `kebab-case.ts`; Vue components use `PascalCase.vue`; composables `useThing.ts`;
  Pinia stores `stores/<name>.ts` exporting `use<Name>Store`.
- **Imports**: ESM with explicit relative paths inside a package; cross-package imports only via package names
  (`@harness-forge/shared`, `@harness-forge/plugin-sdk`). Internal packages export TypeScript source (no build).
- **Ids**: chats and messages use uuidv7 (chats) / prefixed ids (`msg_...`). Plugin ids match
  `^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$`.
- **Model reference**: `providerId:modelId`, split on the **first** colon (`ollama:llama3:8b`,
  `openrouter:anthropic/claude-sonnet-5`). Never put a model ref in a URL path.
- **Errors**: every non-2xx API response is a `HarnessError` envelope (see `docs/API.md`); UI maps `code` to UX.
- **Validation**: zod v4 schemas from `@harness-forge/shared` on both sides; server validates with
  `@hono/zod-validator`.
- **UI**: shadcn-vue + Tailwind tokens only (no hard-coded colors); interactive elements get `data-testid` from the
  shared constants file; every icon-only button has `aria-label`; keyboard shortcuts follow `docs/UI.md`.
- **Web unit tests**: Vitest cannot resolve Nuxt's `#imports`. Components/composables that need Nuxt composables
  (`useRoute`, `useColorMode`, `navigateTo`, ...) import them through a small local module (pattern:
  `apps/web/app/components/app-shell/nuxt-imports.ts`) that tests `vi.mock`. Keep pages thin; put logic in
  composables/stores that are testable with a mocked `$api`.
- **Server state** belongs in SQLite via Drizzle; plugin code never touches the DB directly (only via `ctx`).
- **Logging**: no API keys, no message contents at info level; use the request id.

## Environment variables

`HF_PORT` (8787), `HF_HOST` (127.0.0.1), `HF_DATA_DIR` (`./data`, resolved against the repo root in dev),
`HF_PASSWORD`, `HF_MASTER_KEY`, `HF_MOCK_PROVIDER`, `HF_SAFE_MODE`, `HF_PLUGIN_WATCH`, `HF_OFFLINE`, `HF_INSECURE`,
`HF_TRUST_PROXY` (trusted reverse proxies, ADR-026), `HF_API_TARGET` (web dev proxy target), `HF_WORKSPACE_ROOTS`
(folders that may hold projects, default `<dataDir>/workspaces`, ADR-031), `HF_WORKSPACE_SHELL` (`0` removes the
`shell` tool, ADR-033), plus provider key fallbacks (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, ...). CLI-only:
`HF_NEW_MASTER_KEY` (read by `rotate-key`, ADR-034). Test-only: `HF_LIVE`, `HF_LIVE_PROVIDERS`,
`HF_LIVE_MAX_COST_USD`, `HF_LIVE_MEDIA`, `HF_TEST_REQUIRE_WEB_BUILD`, `E2E_SCREENSHOTS`, `HF_TEST_FILE_SWEEP_DELAY_MS`
(only with `HF_MOCK_PROVIDER=1`, ADR-039). See `.env.example` and
`docs/DECISIONS.md` (Contract seed).

**Never run `pnpm test:live` unless your task prompt says so** — it makes paid provider calls with real keys.

## Ports and data for agents

The coordinator owns :3000 (web dev), :8787 (server dev, data in `data/`) and :8899 (e2e). If you need your own
server, use your slot `k` from the task prompt: `HF_PORT=879k HF_DATA_DIR=.tmp/<agent-id>`; e2e agents use
`889k`. Stop every process you started before reporting. Prefer in-process tests: `createTestApp()` +
`app.request()` with an in-memory database.

## Contracts, freeze and CCRs

- **Frozen** (coordinator-only) after Phase 0: `packages/*/src`, `apps/server/src/app.ts`,
  `apps/server/src/db/schema.ts`, `apps/server/drizzle/**`, every `*/types.ts` under `apps/server/src`,
  `apps/server/src/builtin-plugins/index.ts`, `apps/web/app/layouts/**`, store signatures in
  `apps/web/app/stores/**`, `apps/web/nuxt.config.ts`, every `package.json` and config file,
  `apps/web/app/components/{ui,ai-elements}/**`, CSS design tokens in `apps/web/app/assets/css/main.css`.
  Added in Phase 5 (after Gate P5-0b): `apps/web/app/utils/testids.ts` (a new test id is a CCR), the new
  `services/{data,shares}/types.ts`, `layouts/share.vue` and the ui store members `shareChatId` / `openShare` /
  `closeShare` (see `docs/phases/phase-5-v1-1.md` "FREEZE in Phase 5").
  Added in Phase 6 (after Gate P6-0b): `services/{images,audio}/types.ts`, the props of the P6-0b stub components
  (`ImageGallery`, `GeneratingImages`, `ImageOptionsMenu`, `MicButton`, `RecordingIndicator`, `ReadAloudButton`,
  `MediaSettings`, `ImageSettings`, `VoiceSettings`) and the signatures of `useImageOptions`, `useVoiceInput`,
  `useSpeechPlayer` (see `docs/phases/phase-6-v1-2.md` "FREEZE in Phase 6").
  Added in Phase 7 (after Gate P7-0b): `services/{projects,keys,maintenance}/types.ts` and the P7-0b versions of
  `services/{chats,files,data,images,events}/types.ts`, `workspace/paths.ts`, `services/chats/approvals.ts`, the
  `main.ts` boot hooks, `security/types.ts`, the props of the P7-0b stub components, the `projects` store and the new
  `chats` store members, and the `useChatSession` additions (see `docs/phases/phase-7-v1-3.md` "FREEZE in Phase 7").
  Added in Phase 8 (after Gate P8-0b): `services/{checkpoints,shell-rules}/types.ts` and the P8-0b versions of
  `services/{data,files}/types.ts`, `workspace/{run-scope,file-lock,git}.ts`, `packages/shared/src/util/shell-command.ts`,
  the props / emits of the P8-0b stub components (`components/workspace/**`), `DiffView` props, the `workspace` and
  `shell-rules` stores, the `useChatSession` additions (`cwd`, `ToolApprovalDecision.allowRules`) and the Phase 8 test
  ids (see `docs/phases/phase-8-v1-4.md` "FREEZE in Phase 8").
- **CCR (contract change request)**: if a frozen contract blocks you, write a local adapter inside your owned
  paths, keep working, and add a CCR to your report: file, current shape, proposed shape, reason.
- **DEPENDENCY REQUEST**: never install packages. Use existing dependencies or Node built-ins; if something is truly
  missing, write a small local helper and add a request: package, version range, target package, reason,
  alternatives considered.

## Report format (≤ 300 words)

1. Tasks done (task ids). 2. Files touched. 3. Commands run + results (tests, typecheck, check:english).
4. CCRs. 5. Dependency requests. 6. Open issues / risks. 7. Suggested ROADMAP updates.

## Git workflow

- **All work happens on `main`.** No long-lived feature branches; the repository is `github.com/maksqi/harness-forge`.
- Commits follow Conventional Commits in English (`feat: …`, `fix: …`, `docs: …`, `chore: …`), subject ≤ 72 chars.
- Sub-agents never run git write commands; the coordinator commits to `main` after a green gate (`pnpm check`,
  `pnpm build`, and the e2e suite when the UI or API changed).
- Push to `origin main` only when the user asks. Never force-push or rewrite history without explicit approval.
- CI (`.github/workflows/ci.yml`) runs on every push to `main` and on pull requests: check, build + Playwright e2e,
  Docker image.

## Progress tracking

`docs/ROADMAP.md` is the single source of truth for progress and is edited only by the coordinator. Agents suggest
checkbox updates in their report. Decisions are recorded in `docs/DECISIONS.md` (coordinator only).

## Where things are documented

- `docs/ROADMAP.md` — phases, tasks, owners, wave log.
- `docs/DECISIONS.md` — ADRs and the contract seed (names, env vars, ids, ports, data layout).
- `docs/ARCHITECTURE.md` — components, flows, data dir, security model, production topology.
- `docs/API.md` — every endpoint, the error envelope, the chat stream protocol.
- `docs/PLUGINS.md` — plugin manifest, contribution points, `PluginContext`, lifecycle, install, trust.
- `docs/PROVIDERS.md` — built-in providers, base URLs, icons, seed models, declarative provider format.
- `docs/UI.md` — layout, design tokens, components, routes, shortcuts, `data-testid` contract.
- `docs/phases/phase-N-*.md` — per-phase tasks with owners and acceptance criteria.
