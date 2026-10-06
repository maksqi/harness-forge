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
| Parsing | `yaml` 2 (frontmatter of agent, command and skill files; imported only by `packages/shared/src/util/definitions.ts`) |
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
- **Plugin API 1.3.0** (Phase 9, additive): `ToolMode` gains `plan`; `ToolDefinition.execute` may be an async generator
  (each yield is a preliminary output, the last one the final output). The template mirror follows.
- **Agent 2.0** (Phase 9, ADR-040 … ADR-043): `prepareStep` (verified in `ai/dist/index.d.ts`) may return `messages`
  (carried forward to later steps), `activeTools` and `instructions`; it runs before every model call incl. step 0.
  One composer `apps/server/src/chat/steps.ts` runs, in order, the context guard (automatic compaction), the steer
  injection and the sub-agent finalize nudge. Model history is built only by `apps/server/src/chat/model-history.ts`
  (compaction → steer split → task output reduction → command expansions); history-derived state (`findCompaction`,
  `compactionMarkers`, `splitSteers`, `latestTodos`) comes only from `packages/shared/src/util/agent-state.ts`, mention
  parsing / ranking only from `packages/shared/src/util/mentions.ts`. New UI data parts: `data-compaction`,
  `data-steer`, transient `data-activity`. Builtin plugin `core-agent` (`todo_write`, `exit_plan_mode`, `task`) reaches
  server internals through the private side channel `apps/server/src/chat/agent-scope.ts`. Plan mode is enforced on the
  server (tool set + approval). Sub-agents never create approval requests (a call that would ask is denied), depth 1.
  The steer queue is in memory (`/chat/:id/queue`, SSE `queue.changed`). Tests use only mock models
  (`MockLanguageModelV4`, `simulateReadableStream` from `ai/test`).
- **Plugin API 1.4.0** (Phase 10, additive): `contributes.agents` / `contributes.skills` (declarative), `ctx.agents.register`,
  `ctx.skills.register` (code), `AgentDefinition { name, description, instructions, tools?, model? }`,
  `SkillDefinition { name, description, content }`; registry kinds `agent` / `skill`. The template mirror follows.
- **Customization** (Phase 10, ADR-044 … ADR-047): agents, commands and skills are markdown files with YAML frontmatter,
  parsed **only** by `packages/shared/src/util/{definitions,arguments,tool-names}.ts` (`yaml` core schema, no aliases,
  byte caps before parsing; verify the API in `node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/*.d.ts`). Sources,
  lowest first: builtin < plugin < user (table `customizations`, `cus_` ids, raw markdown) < project `.claude/{agents,
  commands,skills}` < project `.harness/{…}`; one catalog service `apps/server/src/services/customizations/`. Project
  files are **untrusted and restrict-only**: read through `resolveWorkspacePath` / `openWorkspaceFile` (no links,
  regular files, caps), never written by the harness, their `tools` / `allowed-tools` only narrow (never a grant, a
  mode, an override or a shell rule), `model` resolves only to configured providers, command bodies are text (no
  `!bash`, no `@file`). `task.type` is a catalog agent name (builtins `explore` / `general`); `skill` is the fourth
  `core-agent` tool. Background sub-agents (`task` with `background: true`) live in `apps/server/src/chat/background/`
  and the `background_tasks` table (`bgt_` ids): never approvals, 3 per chat / 10 per server / 30 min, stopped on chat
  or project delete, delete-all, key rotation and shutdown but **not** by the chat's Stop, delivered exactly once as
  `data-task-result` (steer step, or a server-started turn with `origin: 'task'` from a user-role carrier message;
  `splitTaskResults` in `packages/shared/src/util/agent-state.ts` builds the model view), and a running one makes its
  project busy (409 `run-active`). Plan files (`planFiles`, `planDirectory`) and `/remember` (`POST /memory`) write
  through the journal. New ids `cus_`, `bgt_`; SSE `task.changed`, `customization.changed`; migration
  `0007_customizations`.
- **Plugin API 1.5.0** (Phase 11, additive): `contributes.hooks` (Claude Code `hooks` format; a plugin with command
  hooks or `!` spans in a command template needs a trust pin like a stdio MCP declaration), `contributes.outputStyles`,
  `ctx.outputStyles.register` (`OutputStyleDefinition { name, description, content, keepCodingInstructions? }`), code
  hook events `prompt.submit`, `session.start`, `run.stop`, `subagent.stop`, `compact.before`, `notification`
  and `tool.after` output `context?`; registry `styles`, `hookCommands`. The template mirror follows.
- **Hooks, trust and project MCP** (Phase 11, ADR-048 … ADR-052): command hooks (eight Claude Code events) come from
  personal rows (table `hooks`, `hok_` ids), the `hooks` key of a project's `.harness` / `.claude`
  `settings{,.local}.json` and plugins; they are parsed, matched (a safe subset: names, `|`, `*` / `.*`, never a
  `RegExp` from input) and read **only** by `packages/shared/src/util/{hooks,trust,mcp-config,command-template,
  output-styles}.ts`; they run **only** through `runShellCommand` (`apps/server/src/workspace/shell.ts`, `input` /
  `env` options; still the only shell-string spawn) with a stdin JSON payload (Claude Code fields + `harness`), in the
  project folder (else `<dataDir>/hooks`). Every executable project item (project hooks, `.mcp.json` servers incl.
  http / sse, command files with `` !`cmd` `` spans) runs only when the sha256 of `trustHashInput(item)` (the item
  **and** the script files it names) is approved for the project (table `project_trust`, fresh auth, never in
  backups) and is re-checked right before every spawn. `.mcp.json` variables (`${VAR}`, `${VAR:-default}`) come only
  from encrypted per-project values (secret scope `project:<projectId>`), **never from `process.env`**. Hook output
  is a persisted `data-hook` part (`hev_` ids, model view through `splitHooks` in
  `packages/shared/src/util/agent-state.ts`); a blocking Stop hook starts a server turn with `origin: 'hook'` (≤ 5 in a
  row). Kill switches: setting `hooksEnabled`, `HF_WORKSPACE_SHELL=0` (no shell string at all), `HF_SAFE_MODE` (no
  command hooks, no project MCP). Output styles are the catalog kind `style` (`output-styles` folders, builtins
  `default` / `explanatory` / `learning`; chat ?? project ?? global `outputStyle`). Migration `0008_hooks_trust`;
  SSE `hooks.changed`, `project-trust.changed`, `project-mcp.changed`; mock `mock:hooks`.
- **Plugin API 1.6.0** (Phase 12, additive): `CommandDefinition.{ syntax?: 'template' | 'markdown', argumentHint?, model?,
  allowedTools? }`, `SkillDefinition.{ baseDir?, argumentHint?, userInvocable?, modelInvocable? }`, agent fields
  `disallowedTools?` / `maxTurns?` / `color?` / `skills?`, hook events + `PostToolUseFailure`, `PermissionRequest`,
  `SubagentStart`, `PostCompact`, `SessionEnd`, command hook `args?` / `async?` / `if?` / `statusMessage?`, prompt hook
  handlers (`type: 'prompt'`; prompt-only hooks need no trust pin), names qualified with the plugin's own id,
  `PluginSource` `github` / `marketplace`. The template mirror follows.
- **Claude Code ecosystem** (Phase 12, ADR-053 … ADR-058): Claude Code plugins are a third plugin format
  (`plugins.format = claude`, files kept byte for byte with exec bits, read in place by `apps/server/src/plugins/claude/**`
  through the shared parsers; Claude `plugin.json` / `marketplace.json` are parsed **only** by
  `packages/shared/src/util/claude-plugins.ts`); a plugin that runs anything needs a trust pin over a sha256 of its
  **whole file tree**; Claude entries use qualified names `<pluginId>:<name>` (`catalogNameSchema`); plugin variables
  (`${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`, `${user_config.KEY}`, …) are substituted only by
  `substitutePluginVariables`, never from `process.env`. Marketplaces (table `marketplaces`, `mkt_` ids) and GitHub
  sources use **HTTPS archives only, never git**: ref → commit via the GitHub API, the commit's zip from codeload, all
  through `safeFetch`; `HF_OFFLINE=1` refuses them (409 `offline`). The home-folder import reads **only** the allowlist
  of `packages/shared/src/util/claude-import.ts` (`isClaudeHomeImportPath`) at `HF_CLAUDE_HOME` (default `~/.claude`,
  `0` = off, the Docker default) or from an upload; the plan (`cip_` ids) is built and kept on the server (contents and
  env / header values never reach the browser); scan and apply need fresh auth; imported command hooks and `!` commands
  arrive turned off. Project definition files are edited through `/projects/:id/definitions/file` (path guard, file
  lock, `expectedSha256` → 409 `stale`, not journaled, `workspace.changed` source `user`); **saving never approves**.
  Prompt hooks (`type: 'prompt'`, `hookModelRef`, answers `{ ok, reason?, impossible? }` parsed only by
  `readPromptHookAnswer`; `ok: true` never allows), 13 hook events, `transcript_path`
  (`<dataDir>/transcripts/<chatId>.jsonl`, 0600, never in backups); trust item v2 only for hooks with the new fields
  (v1 bytes unchanged). Frontmatter: new keys are kept only when set; `argumentBase` = 0 when a body uses `$0` /
  `$ARGUMENTS[` or declares `arguments`, else 1; Claude model aliases through `modelAliases`. Tests use a temp
  `HF_CLAUDE_HOME`, injected `safeFetch` or the test-only `HF_TEST_REMOTE_URL` (only with `HF_MOCK_PROVIDER=1`), and the
  mock `mock:prompt-hook`. Migration `0009_claude_ecosystem`; SSE `marketplace.changed`; settings `hookModelRef`,
  `modelAliases`.
- **Never create `.claude/`, `.harness/`, `.claude-plugin/` or `.mcp.json` anywhere in the repository** (at the root
  they would configure the coordinator's own Claude Code session, and Claude Code also discovers nested `.claude/`
  folders). Test fixtures are built at test time in `realpath(mkdtemp())` folders; seeds live under `.tmp/`. The only
  committed exception is `examples/plugins/claude-review-kit/.claude-plugin/plugin.json`.
- **vue-tsc 3.3.12** (vuejs/language-tools#6240): a `//` inside a component prop value in a template (a URL literal)
  corrupts the generated code; put URLs into script constants (`apps/web/app/components/template-literals.test.ts`
  guards it).
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
| `pnpm start:e2e` | production server with `HF_MOCK_PROVIDER=1 HF_OFFLINE=1 HF_CLAUDE_HOME=0 HF_PORT=8899 HF_DATA_DIR=.tmp/e2e` |
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
`shell` tool, ADR-033, and since Phase 11 runs no command hook and no command `!` span), `HF_CLAUDE_HOME` (the
Claude Code folder the import scan reads, default `~/.claude`, `0` = off, ADR-055), plus provider key
fallbacks (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, ...). CLI-only: `HF_NEW_MASTER_KEY` (read by `rotate-key`, ADR-034). Test-only: `HF_LIVE`, `HF_LIVE_PROVIDERS`,
`HF_LIVE_MAX_COST_USD`, `HF_LIVE_MEDIA`, `HF_TEST_REQUIRE_WEB_BUILD`, `E2E_SCREENSHOTS`, `HF_TEST_FILE_SWEEP_DELAY_MS`
(only with `HF_MOCK_PROVIDER=1`, ADR-039), `HF_TEST_REMOTE_URL` (loopback fake for GitHub / codeload / archive hosts;
only with `HF_MOCK_PROVIDER=1`, ADR-054). See `.env.example` and
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
  Added in Phase 9 (after Gate P9-0b): `services/project-files/types.ts`, the P9-0b versions of `types.ts`,
  `chat/types.ts` and the deps start / stop order, `chat/{steps,markers,model-history,agent-scope}.ts`,
  `builtin-plugins/{index.ts,core-agent/index.ts}`, the mock models, `packages/shared/src/util/{agent-state,mentions}.ts`,
  plugin SDK 1.3.0, the props / emits / root test ids of the P9-0b stub components, the `chat-queue` store, the
  `useProjectFiles` / `useFileMentions` / `useModeCycle` signatures, the `useChatSession` additions and the Phase 9 test
  ids (see `docs/phases/phase-9-v1-5.md` "FREEZE in Phase 9").
  Added in Phase 10 (after Gate P10-0b): `services/customizations/types.ts`, `chat/background/types.ts`,
  `chat/subagent/host.ts`, the P10-0b versions of `types.ts`, `chat/types.ts`, `registry/types.ts`, the deps start /
  stop order and the boot sweep, `chat/{pipeline,tools,steps,markers,model-history,agent-scope}.ts`, the signatures of
  the P10-0b chat stubs, `builtin-plugins/{index.ts,core-agent/index.ts}`, the mock models,
  `packages/shared/src/util/{definitions,arguments,tool-names,agent-state}.ts`, plugin SDK 1.4.0, the props / emits /
  root test ids of the P10-0b stub components, the `customizations` and `background-tasks` stores, the
  `AGENT_TASK_CONTEXT` injection key, the `useChatSession` additions, the Customize settings route and its nav entry and
  the Phase 10 test ids (see `docs/phases/phase-10-v1-6.md` "FREEZE in Phase 10").
  Added in Phase 11 (after Gate P11-0b): `services/{hooks,project-config,project-trust}/types.ts`, `mcp/types.ts`, the
  P11-0b versions of `types.ts`, `chat/types.ts`, `registry/types.ts` and the deps start / stop order,
  `chat/{pipeline,tools,approval,steps,model-history,agent-scope,hooks}.ts`, the signatures of the P11-0b chat stubs,
  `workspace/shell.ts`, `mcp/stdio-transport.ts`, `builtin-plugins/{index.ts,core-agent/**}` (incl. the builtin output
  styles), the mock models, `packages/shared/src/util/{hooks,trust,mcp-config,command-template,output-styles,definitions,
  agent-state}.ts`, plugin SDK 1.5.0, the props / emits / root test ids of the P11-0b stub components, the `hooks`,
  `project-trust` and `project-mcp` stores, the pure-module signatures, the `useChatSession` additions, the Customize
  tab query and the Phase 11 test ids (see `docs/phases/phase-11-v1-7.md` "FREEZE in Phase 11").
  Added in Phase 12 (after Gate P12-0b): `plugins/marketplaces/types.ts`, `services/{claude-import,project-definitions}/types.ts`,
  the P12-0b versions of `types.ts`, `plugins/types.ts`, `registry/types.ts`, `services/{hooks,customizations}/types.ts`
  and the deps start / stop order, `chat/{hooks,approval,tools,steps,pipeline,model-history,agent-scope}.ts` and
  `chat/subagent/host.ts` with the P12-0b call sites, the signatures of the P12-0b stubs, the mock models (incl.
  `mock:prompt-hook`), `testing/{fake-remote,claude-fixtures}.ts`, `packages/shared/src/util/{claude-plugins,claude-import,
  claude-permissions,hooks,trust,definitions,arguments}.ts`, plugin SDK 1.6.0, the props / emits / root test ids of the
  P12-0b stub components, the `marketplaces` store, `useClaudeImport`, the pure-module signatures, the Customize import
  query and the Phase 12 test ids (see `docs/phases/phase-12-v1-8.md` "FREEZE in Phase 12").
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
