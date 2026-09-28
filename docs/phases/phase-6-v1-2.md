# Phase 6 — v1.2: multimodal + stabilization

Part of the harness-forge build plan. Progress is tracked in `docs/ROADMAP.md` (coordinator only). Shared names come
from `docs/DECISIONS.md` (ADR-028 … ADR-030, the ADR-027 consequence and the contract seed; it wins on conflict);
endpoints and DTOs from `docs/API.md` (4.18 images, 4.19 audio, `audio.ts`, `chats.ts`); components, props, composable
signatures, shortcuts and test ids from `docs/UI.md` (7.16 – 7.18, 9.9, 10.4, 11, 12, 13.7); flows, tables and security
rules from `docs/ARCHITECTURE.md` (6.1, 6.8, 6.11, 6.12, 8, 9, 10.2, 10.8, 12); provider media support, mock models and
the live media checks from `docs/PROVIDERS.md` (8, 12, 13); the plugin API 1.1.0 from `docs/PLUGINS.md` (9).

**Status (2026-09-29):** Phase 6 is done: P6-00, P6-0a, P6-0b, P6-A (+ the post-gate fix `6e96d85`), P6-B and the
final gate are committed (`a5fd107`, `11516c7`, `163f5e8`, `3e115cb`, final gate `chore: final gate for harness-forge
v1.2`). W6.15 / W6.16 (fix-ups) were not needed: the P6-A gate was green; the coordinator fixed the few items found in
P6-B at the final gate (migration `0003` ages listings instead of clearing them; the expanded sidebar trigger's 40 px
touch target). "Outcome" at the end of this file records what actually happened in each wave; the plan sections below are
corrected where the implementation differs from the plan.

## Goal

Ship v1.2: multimodal features through the user's own providers, plus a stabilization track.

- **Image generation** (ADR-028): image turns with dedicated image models (`kind: 'image'`, `generateImage`), images
  from chat models with image output (`capabilities.imageOutput`), and a builtin `generate_image` tool. Every generated
  image is stored as a file before it is streamed or saved: no `data:` URL ever reaches the `messages` table.
- **Voice** (ADR-029): dictation (browser `MediaRecorder` → `POST /api/audio/transcriptions` → `transcribe()`) and
  read-aloud (`POST /api/audio/speech` → `generateSpeech()`), both opt-in in the new Settings → Media page. Audio and
  text pass through the server and are never stored or logged.
- **Versions** (ADR-030, amends ADR-023): each message remembers the version last shown under it, a version can be
  deleted, and a version switch in one tab moves the other open tabs.
- **Stabilization**: the red CI on `main`, Dependabot and an `actionlint` job (all three shipped in the P6-00 hotfix);
  one shared fresh-auth composable for every password prompt; editing the attachments of a message when editing it;
  40 px icon-rail targets on touch tablets.

Out of scope (ROADMAP backlog): knowledge / RAG, child-process isolation for code plugins, a plugin registry, an agent
workspace (file and shell tools), multi-user accounts, desktop / CLI clients, master-key rotation, audio attachments to
chat models, declarative image and voice providers, provider-native image tools (the OpenAI Responses image tool),
browser speech recognition and on-device speech synthesis (they break bring-your-own-key), streaming transcription
(`experimental_streamTranscribe`), cleanup of orphaned files (generated images are only removed by delete-all), video
generation.

Totals after Phase 6: routes 73 → **76** (`audio.transcribe`, `audio.speech`, `chats.deleteMessage`), tables **15**
(unchanged: images add no route and no table), migrations `0000_initial_schema`, `0001` + **`0002`** (remembered
versions: `messages.selected_child_id` + backfill) + **`0003`** (`0003_refresh_model_listings`, added at Gate P6-A:
every successful cached model listing is aged by one TTL so it is stale once), ADR-028 … ADR-030 (+ an ADR-027 consequence), plugin API **1.1.0**
(additive; the builtin `core-providers` and `core-tools` are 1.1.0 with `engines: ^1.1.0`). Agents: 2 (P6-0a) + 2
(P6-0b) + 11 (P6-A) + 3 (P6-B), in the Phase 5 wave method (ADR-016); no fix-up agent was needed.

## Entry criteria

- v1.1 is on `main` (`30da884` final gate) plus the hotfix `a5fd107`: `pnpm check` (4212 tests), `pnpm build` and e2e
  44/44 (`chromium` + `mobile`) are green.
- The approved plan exists; K1 is done: DECISIONS.md carries ADR-028 … ADR-030, the ADR-027 consequence and the Phase 6
  contract seed (settings keys, mock models, the HTTP API table with `audio.ts`, the `chat.updated` payload, migration
  `0002`, test-only `HF_LIVE_MEDIA`); ROADMAP.md has the Phase 6 section; AGENT.md has the AI SDK media and plugin API
  1.1.0 version facts, `HF_LIVE_MEDIA` and the Phase 6 freeze additions.

## Exit criteria

- Every Phase 6 item in `docs/ROADMAP.md` is checked; every wave gate is green; the final checkpoint commit
  `chore: final gate for harness-forge v1.2` exists (pushed only when the user asks).
- `pnpm check` and `pnpm build` are green; the built-page CSP test passes with `HF_TEST_REQUIRE_WEB_BUILD=1` and asserts
  `media-src 'self' blob:`.
- `pnpm test:e2e` (projects `chromium` + `mobile` + `tablet`) is green 3× in a row, including the new specs images,
  voice, versions, edit-attachments and tablet touch targets; the `@screenshots` run (dark + light) was reviewed.
- CI on `main` is green (`check`, `e2e`, `docker`, `audit`, `actionlint`); Dependabot opens sane pull requests (no
  downgrades, 0.x minor bumps separate).
- A v1.1 data directory boots on v1.2 with every chat intact: migration `0002` sets `selected_child_id` only on the
  parents of the active paths, and switching away and back restores the path.
- `pnpm test` never calls a paid API; `HF_LIVE_MEDIA=1 pnpm test:live` adds the image and voice checks (never run by
  agents).
- README status reads "v1.2".

Manual acceptance (coordinator, `HF_MOCK_PROVIDER=1 pnpm dev`):

- Pick "Mock Image" → two 16:9 images appear after the placeholder tiles; regenerate gives "‹ 2/2 ›"; "make it blue"
  edits the previous image (`metadata.image.inputs` = 2).
- `mock:image-chat` shows text + an image; `generate_image` (with `mock:image-tool` and Settings → Media → Image model
  "Mock Image") asks for approval, then shows the image below the tool row.
- Settings → Media: pick `mock:transcribe` → Alt+V records, Stop inserts "This is a mock transcription." at the caret;
  pick `mock:speech` → "Read aloud" plays and "Stop reading" stops.
- Edit a message and remove / add an attachment; delete a version; switch versions in one tab → the other tab follows.
- A v1.1 data directory boots on v1.2 with every chat intact.

With real keys (the user, optional): an OpenAI `gpt-image-1` image turn, a Gemini image-output chat, Groq Whisper
dictation, OpenAI `gpt-4o-mini-tts` read-aloud.

## Steps

| Step | Owner | Output |
|---|---|---|
| P6-00 | coordinator | hotfix S1 – S3 (red CI, Dependabot, `actionlint`), one commit (done: `a5fd107`) |
| P6-0a | coordinator (K1) + C10, D6 | decisions, ROADMAP, AGENT.md; every shared / SDK contract + 501 stubs + API.md; every other doc |
| Gate P6-0a | coordinator | audit, frozen install, check, build, CSP test, 501 probes, e2e regression, commit |
| P6-0b | coordinator (K3, K4) + C11, C12 | schema + migration `0002`, server and web skeletons, mock media models, test ids, Playwright config, FREEZE |
| Gate P6-0b | coordinator | audit, `nuxi prepare`, check, build, CSP test, e2e regression, v1.1 upgrade probe, FREEZE, commit |
| P6-A | W6.1 – W6.11 (one launch) | features |
| Gate P6-A | coordinator (K5) | CCR batch, `nuxi prepare`, check, build, probes, e2e, screenshots, audit, commit |
| P6-B | W6.12 – W6.14 (+ W6.15 / W6.16 fix-ups when the P6-A gate is red) | feature e2e, docs reconciliation, live media checks |
| Final gate | coordinator (K6) | e2e ×3 (three projects), v1.1 → v1.2 upgrade, audit, optional live suite, ROADMAP, memory, commit |

## Deviations from the plan (binding)

- **Dependabot** shipped as `cooldown.default-days: 1` (the same age as pnpm 11's built-in minimum release age), not as
  a pnpm `minimumReleaseAge: 10080` setting (an early draft): with a 7-day cooldown Dependabot proposed the newest
  release older than 7 days, which can be *older* than the locked version (PR #1 downgraded `ai` and `hono`).
- **One settings page** `/settings/media` ("Images and voice", nav label "Media", after Models) holds both the Images
  section (`imageModelRef`, "None (the generate_image tool is off)") and the Voice section. The image design's "Image
  model" row in Settings → Models is dropped; the `generate_image` error text says "Choose an image model in
  Settings → Media."
- **Service locations**: `ImageService` in `S/services/images/{types,index}.ts` (not `S/images/`), `AudioService` in
  `S/services/audio/{types,index,sniff}.ts`; both are `AppServices` members.
- **Web ownership** follows the P6-A table below, not the per-design agent splits of the design reports.
- **Seeds**: `gemini-3.5-transcribe` exists only in the `@ai-sdk/google` type union and is left out of the seeds; the
  voice lists come from vendor docs and are marked unverified (PROVIDERS.md 13).
- **Docs** are written by D6 (UI, ARCHITECTURE, PROVIDERS, PLUGINS, the guides, README, `.env.example`, this file) and
  C10 (API.md) in P6-0a, and reconciled by W6.13 in P6-B. P6-A agents never edit docs.
- **Feature e2e specs** (images, voice, versions, edit-attachments, tablet) are written in P6-B by W6.12, not by the
  P6-A web agents.
- **Every new web test id** is added by C12 in P6-0b, copied verbatim from UI.md 13.7; `utils/testids.ts` is frozen
  during P6-A.
- **Route module** `audio` (`http/routes/audio.ts`); route keys `audio.transcribe` (`POST /audio/transcriptions`,
  multipart), `audio.speech` (`POST /audio/speech`, binary response) and `chats.deleteMessage` (`DELETE
  /chats/:id/messages/:messageId`); conflict reason `only-version`.
- **`UsagePurpose`** gains `image`, `transcription` and `speech` as a TypeScript type only (the column is free text): no
  migration.

Implementation deviations found in P6-A and at its gate (the docs were reconciled by W6.13):

- **Migration `0003_refresh_model_listings`** (coordinator, K5 at Gate P6-A; not in the plan): one hand-written
  `UPDATE model_cache SET fetched_at = fetched_at - 86400000 WHERE fetched_at IS NOT NULL`, so every successful listing
  cached by v1.1 is stale once and listed again in the catalog's first background cycle after the start, while the
  catalog keeps serving it meanwhile (the first version set `fetched_at` to null, which the catalog reads as "never
  listed": W6.13 found that it would have hidden the cached models until a refresh succeeded; fixed before the final
  gate). Found at the gate: the e2e server's cached mock listing hid the
  new chat seeds `mock:image-chat` / `mock:image-tool` for up to 24 h, and a real upgrade would keep listings without
  the v1.2 listing rules (media ids, OpenRouter `output_modalities`) just as long. Tested in `S/db/upgrade.test.ts`;
  listed in DECISIONS.md. As built, a null `fetched_at` also means "never listed" to the catalog: until a provider's
  first v1.2 refresh succeeds it serves the provider's seeds (plus plugin and custom models), not the cached listing,
  and a failed refresh keeps it that way (the migration comment says the cached listing stays visible; reported as a
  suspected bug by W6.13, see P6-B below).
- **Media models without a factory are not listed** (W6.2): an image, transcription or speech entry from a listing, a
  seed or a plugin appears in the catalog only when its provider defines the matching factory (`createImageModel`,
  `createTranscriptionModel`, `createSpeechModel`); custom models always appear (the resolvers then explain the error:
  `model_not_found` for an image model, `validation_error` for a voice model). The plan hid such image models instead;
  models.dev-only voice models such as `alibaba:qwen3-asr-flash` are left out (the Risks row below is settled this way).
  Image models are visible, transcription and speech models hidden from the chat picker; `modelCount` counts visible
  chat models only.
- **Classification** (W6.2): the catch-all "id contains image" fallback is removed; only the image-model id regex
  matches before the modalities, and the id-only rules add `tts` → speech and `whisper|transcri` → transcription (the
  mock seeds `mock:image-chat` / `mock:image-tool` keep the explicit `kind: 'chat'` that C11 gave them against the old
  fallback).
- **Google** (W6.3) has no `createImageModel` (Imagen through `.image()` is not wired): its images come from the chat
  models with image output, `gemini-*-image*` and `nano-banana*`.
- **`generate_image` model output** (W6.4) names the model ref ("Generated 2 images with openai:gpt-image-1; they are
  shown to the user below this call."), not the model name: the plugin API image result carries no display name (an
  optional CCR for a `modelName`, backlog).
- **Builtin manifests** (K5): `core-providers` and `core-tools` 1.1.0 with `engines: ^1.1.0`; `mock` stays 1.0.0 with
  `engines: ^1.1.0`.
- **Image turns** (W6.1): an approval continuation sent with an image model is refused with `400 validation_error` on
  the new issue path `['modelRef']`; the generated images of the parent reply become input images only for vision
  models (like attached images); the image-prompt check is skipped when a reply command writes the reply; in the
  history every generated file part of an assistant message becomes a `[Generated image: <name>]` /
  `[Generated file: <name>]` marker, and the latest images are carried into the next user message in addition (API.md
  4.18, 5.10).
- **Settings → Models**: `CustomModelDialog` gained an "Image output" checkbox for custom chat models (W6.10, read by
  the catalog as `capabilities.imageOutput`); after the gate (`6e96d85`) Favorite and Visible exist only for chat and
  image models (the models the chat picker can show), speech, transcription and other kinds show a dash ("Chosen in
  Settings → Media").
- **Alt+V** stays the dictation shortcut (W6.9, `preventDefault` on a match, respects `altShortcuts`); no Alt+J fallback
  was needed. Firefox on Windows is unverified.
- **Web contracts** (W6.8 – W6.10): additions to frozen stubs without prop or emit changes — `MicButton` exposes
  `activate()` (Alt+V calls it) and the `RecordingIndicator` root carries `data-state`, `role="group"` and `aria-label`;
  the Voice field suggests the model's voices as a plain list (not a searchable command list); the composer's live
  region has no `role="status"`; `MediaSettings` renders only the page body (the page frame renders the "Images and
  voice" header).
- **Catalog names and prices** (W6.2 / W6.3): models.dev lacks all six OpenAI voice seeds (`gpt-4o-mini-transcribe`,
  `gpt-4o-transcribe`, `whisper-1`, `gpt-4o-mini-tts`, `tts-1`, `tts-1-hd`) and the xAI `stt` / `tts` ids, and prices
  no image seed; where models.dev knows a model its name wins over the seed name (`gpt-image-1` shows as
  "gpt-image-1", Groq's `whisper-large-v3` as "Whisper"). xAI returns at most 3 images per call.
- **Fresh auth** (W6.11, UI.md 8.4): code-plugin reload, Source saves and builds and creating a code plugin ask for the
  password first when the session is not fresh; the provider wizard asks once (a second refusal is an error); the
  rate-limit text counts down everywhere as "Try again in {n}s." (install / trust said "{n} s"); a 403 from login shows
  the server message (plugin detail and data used to say "Wrong password"); the install / trust "Log in" opens the
  prompt and then submits again.

## Rules for every Phase 6 agent

- Read `AGENT.md` fully, your section of this file and the docs it names. Paths: `S` = `apps/server/src`,
  `W` = `apps/web/app`. Stay inside your OWNED globs; the FREEZE list below overrides any owned glob.
- Never run: package installs or CLIs (`pnpm add`, `drizzle-kit`, `nuxi`, `shadcn-vue`), git write commands,
  `nuxt dev` / `nuxt build` / `nuxt prepare`, servers on :3000 / :8787 / :8899, and **never `pnpm test:live`** (with or
  without `HF_LIVE_MEDIA=1`: the repository `.env` may hold real keys and the suite makes paid calls). Existing scripts
  are allowed.
- Your own server uses your slot: `HF_PORT=879k HF_DATA_DIR=.tmp/<agent-id>`; e2e agents use `889k` (k ≠ 9) with
  `E2E_BASE_URL`. Stop every process you started before reporting. Prefer `createTestApp()` + `app.request()`.
- Contracts: DTOs and route keys only from `@harness-forge/shared`, plugin shapes only from `@harness-forge/plugin-sdk`;
  server services only through the frozen `types.ts` interfaces. A missing member, a contract change, a frozen-file
  edit or a **new test id** is a CCR in your report (file, current shape, proposed shape, reason) plus a local adapter
  so you can keep working.
- New components are imported explicitly by path (`import ImageGallery from './parts/ImageGallery.vue'`): the
  coordinator runs `nuxi prepare` only at the gates, so auto-import types do not know files created mid-wave.
- The props of the P6-0b stub components and the signatures of `useImageOptions`, `useVoiceInput` and
  `useSpeechPlayer` (UI.md 10.4 and 11.3) are frozen: implement behind them; a change is a CCR.
- AI SDK media: verify every name in the installed `.d.ts` (`generateImage`, `transcribe`, `generateSpeech`;
  `ImageModelV4`, `TranscriptionModelV4`, `SpeechModelV4`); test with `MockImageModelV4`, `MockTranscriptionModelV4`,
  `MockSpeechModelV4` from `ai/test`; always pass model instances (a string id goes to the Vercel AI Gateway).
- Privacy: prompts, transcripts, speech text and audio bytes are never logged at `info`; audio and speech text are never
  stored (ARCHITECTURE.md 10.8, 12).
- Web unit tests: happy-dom has no `MediaRecorder`, no `mediaDevices` and a stub `play()`: use
  `W/utils/testing/fake-media.ts` (`FakeMediaRecorder`, `installFakeMedia({ deny?, mimeTypes?, secure? })`,
  `FakeAudio`), shipped by C12.
- Verify before reporting — server: `pnpm -F @harness-forge/server test` · `pnpm typecheck`; shared:
  `pnpm -F @harness-forge/shared test`; web: `pnpm -F @harness-forge/web test` ·
  `pnpm -F @harness-forge/web typecheck:fast`; all: `pnpm check:english`.
- Report ≤ 300 words in the AGENT.md format (tasks, files, commands + results, CCRs, dependency requests, open issues,
  suggested ROADMAP updates).

## FREEZE in Phase 6

In force since Phase 0 (AGENT.md): `packages/*/src`, `S/app.ts`, `S/db/schema.ts`, `apps/server/drizzle/**`, every
`*/types.ts` under `S`, `S/builtin-plugins/index.ts`, `W/layouts/**`, store signatures in `W/stores/**`,
`apps/web/nuxt.config.ts`, every `package.json` and config file, `W/components/{ui,ai-elements}/**`, the CSS design
tokens in `W/assets/css/main.css`. Added in Phase 5: `S/services/{data,shares}/types.ts`, `W/layouts/share.vue`, the ui
store members `shareChatId` / `openShare` / `closeShare`, and `W/utils/testids.ts` (a new test id is a CCR).

P6-0a and P6-0b open the frozen files **only** for their named owners: C10 — `packages/*/src/**`, `S/app.ts`; K3 —
`S/db/schema.ts` + `apps/server/drizzle/**`; C11 — `S/types.ts`, `S/providers/types.ts`,
`S/services/{images,audio,files,chats}/types.ts`; C12 — `W/utils/testids.ts`; K4 — `playwright.config.ts`.

Added to the freeze after Gate P6-0b:

- `S/services/{images,audio}/types.ts` (and the P6-0b versions of `S/providers/types.ts`,
  `S/services/{files,chats}/types.ts`, `S/types.ts`, which were frozen already);
- `W/utils/testids.ts` (again: the Phase 6 ids of UI.md 13.7 are in);
- the props, emits and root test ids of the P6-0b stub components (UI.md 10.4): `ImageGallery`, `GeneratingImages`,
  `ImageOptionsMenu`, `MicButton`, `RecordingIndicator`, `ReadAloudButton`, `MediaSettings`, `ImageSettings`,
  `VoiceSettings`;
- the signatures of `useImageOptions`, `useVoiceInput` and `useSpeechPlayer` (UI.md 11.3).

Opened in P6-A for one owner: `W/components/ui/sidebar/**` for W6.11 (S9, every patch recorded in
`apps/web/AI_ELEMENTS_PATCHES.md`). No other CCR is pre-approved; the coordinator batches CCRs at Gate P6-A.

---

## Wave P6-00 — hotfix (done)

The coordinator fixed three problems before P6-0a, in one commit (`a5fd107`, `fix: register shutdown handlers before
boot and repair dependency automation`).

- **S1 Red CI.** `S/main.test.ts` got exit code `null` on Linux: `main.ts` logged `listening` before
  `installShutdown()` registered SIGINT / SIGTERM, so the test's SIGTERM hit the default handler (the same race killed
  a real server that got SIGTERM while plugins loaded). `main.ts` now keeps a boot `state` (`database`, `deps`,
  `started`, `server`, the `current` step promise, `stopping`) and calls `installShutdown(state, logger)` right after the
  logger, before `ensureDataDir`. Each slow step (open, migrate, `startDeps`, listen) is tracked in `state.current`, and
  the boot returns early when `stopping` is set after `startDeps` and after listen. `listen()` resolves
  `{ server, info }`; `logger.info('listening')` runs in `main()` once `state.server` is set. `shutdown(signal)`: a
  second signal exits 1; logs `shutting down` with `phase: 'booting' | 'listening'`; a 10 s timer; waits for
  `state.current`; closes the server only when listening and `stopDeps` only when started; `closeAllConnections`;
  closes the database; logs `stopped`; exits 0. The boot `catch` returns early while stopping. `main.test.ts` gained
  `RunResult.signal` and the test "SIGTERM while plugins load" (stops at the `trusting reverse proxies` log line,
  expects code 0, signal `null`, `shutting down` and `stopped` logged), which fails on the old `main.ts`.
- **S2 Dependabot.** PR #1 downgraded `ai` 7.0.116 → 7.0.107 and `hono` 4.13.9 → 4.13.8 and put `katex` 0.16 → 0.18 (a
  breaking 0.x minor) into the minor group. `.github/dependabot.yml` (npm block): `cooldown.default-days: 1`
  (`semver-major-days: 30` kept), `open-pull-requests-limit: 10`, groups listed inline: `ai-sdk` (`ai`, `@ai-sdk/*`,
  `@openrouter/ai-sdk-provider`; minor + patch), `drizzle` (`drizzle-orm`, `drizzle-kit`), `zero-major-patches` (katex,
  `@hono/zod-validator`, `@libsql/client`, esbuild, fflate, tsdown, class-variance-authority; patch only) and
  `minor-and-patch` (`*` excluding all of those); a 0.x minor bump matches no group and gets its own pull request. The
  `ignore` list is unchanged. ADR-027 got its consequence line.
- **S3 actionlint.** New `ci.yml` job `actionlint` (`timeout-minutes: 5`; `actions/checkout@v7`, then
  `docker://rhysd/actionlint:1.7.12` with `args: -color`; bumped by hand, Dependabot skips `docker://`). The release box
  of `docs/phases/phase-4-hardening.md` is ticked.

Gate result: `pnpm check` green with 4212 tests; `main.test.ts` green 3× in a row; the new SIGTERM-during-boot test fails
on the old `main.ts`; `actionlint` 1.7.12 exit 0. User actions (outward-facing, asked of the user): push `main` (turns
CI green) and close Dependabot PR #1 unmerged with a comment naming the fix commit.

---

## Wave P6-0a — decisions, docs, contracts (done)

Two agents in one launch (C10, D6) after the coordinator finished K1.

### Coordinator actions

- **K1 (done)** — `docs/DECISIONS.md`: ADR-028 images, ADR-029 voice, ADR-030 remembered versions + deleting a version +
  the `chat.updated` leaf (amends ADR-023), the ADR-027 consequence (S2); contract seed: builtin tool `generate_image`,
  plugin API `1.1.0`, `messages.selected_child_id`, model kinds `transcription` / `speech`, usage purposes, conflict
  reason `only-version`, the HTTP API table (`audio.ts`, `DELETE /chats/:id/messages/:messageId`), the `chat.updated`
  payload, the chat request `imageOptions` and metadata `image`, the six settings keys, migration `0002`, the Phase 6
  mock models, test-only `HF_LIVE_MEDIA`. `docs/ROADMAP.md`: the Phase 6 section (checkboxes per wave and agent), the
  trimmed backlog, the P6-00 wave-log row. `AGENT.md`: the AI SDK media and plugin API 1.1.0 version facts, the
  `createUIMessageStream` + `writer.merge` pattern, `HF_LIVE_MEDIA`, the Phase 6 freeze additions.
- Ownership file `.tmp/waves/P6-0a.json` (below).

### C10 contracts (k2)

- **Mission.** Write every shared and plugin SDK contract of Phase 6, the three new routes as 501 stubs and
  `docs/API.md`, keeping `pnpm check` green.
- **Owned.** `packages/*/src/**`, `docs/API.md`, `S/app.ts`, `S/http/routes/audio.ts` (new 501 stubs),
  `S/http/routes/chats.ts` (the `deleteMessage` stub only), `S/http/middleware/body-limit.ts` (audio 25 MiB + 64 KiB),
  `S/testing/api-samples.ts`, the route-table-driven security tests (`S/http/middleware/session-auth.test.ts`,
  `S/http/middleware/fresh-auth.test.ts`, `S/security/{fresh-auth-routes,secret-leaks,request-guards}.test.ts`),
  `S/plugins/templates/sdk-types.ts` + `S/plugins/compile.test.ts` (1.1.0), `S/plugins/context.ts` (an `images` stub
  that throws `not_implemented`), `S/services/chats/index.ts` (`emitUpdated` with the leaf) + `S/testing/fake-chats.ts`,
  `W/utils/testing/fixtures.ts`, and every fixture that needs the required `imageOutput` capability or the new settings
  keys (listed in the report; the coordinator accepts them in the audit).
- **Read-only highlights.** `.tmp/p6-designs/**` (images, voice, stabilization; the README reconciliation is binding),
  `docs/DECISIONS.md`, `packages/shared/src/api/routes.test.ts` and `contract.test.ts` (doc-coupled: API.md 8 and the
  DECISIONS module table), `packages/shared/src/schemas/manifest.test.ts` (parses the PLUGINS.md manifests written by
  D6), `S/http/routes-mounted.test.ts`, `S/plugins/templates/templates.test.ts` (the mirror must match the SDK).
- **Tasks.**
  1. **C10-T1 Enums and limits** — `modelKindSchema` += `transcription`, `speech` (`audio` stays); `LIMITS` gains
     `imagesPerTurnMax` (4), `imageInputsMax` (4), `generatedImageBytes` (20 MiB = `uploadBytes`, so a backup restores
     every generated image), `imagePromptMaxChars` (32,000), `audioUploadBytes` (25 MiB), `speechTextMaxChars` (4096),
     `transcriptionMaxSeconds` (600), `speechFirstChunkChars` (300), `speechChunkChars` (1500).
  2. **C10-T2 Image and audio schemas** — new `schemas/images.ts`: `IMAGE_ASPECT_RATIOS`, `imageAspectRatioSchema`,
     `imageOptionsSchema` (strict: `n` 1–4, `aspectRatio?`, `editPrevious?`), `imageTurnMetadataSchema` (`n`,
     `aspectRatio?`, `inputs?`, `revisedPrompt?`), `GENERATE_IMAGE_TOOL_NAME`, `generateImageToolInputSchema`,
     `generateImageToolOutputSchema`, `GENERATED_IMAGE_MIME_TYPES` (png, jpeg, webp, gif); new `schemas/audio.ts`:
     `transcriptionLanguageSchema`, `speechVoiceSchema`, `audioTranscribeFormSchema`, `audioTranscriptionSchema`,
     `audioSpeechBodySchema`. *Accept:* valid and invalid samples per schema (strictness, bounds, the language and voice
     patterns).
  3. **C10-T3 Chats, models, settings, events** — `chatRequestBodySchema.imageOptions?`, `messageMetadataSchema.image?`,
     notice code `generated-file-dropped`; `modelCapabilitiesSchema.imageOutput: z.boolean()` (required, so every
     fixture changes), `ModelInfo.voices?` / `CatalogModel.voices?` (≤ 100, unique); settings `imageModelRef` (null),
     `transcriptionModelRef` (null), `transcriptionLanguage` (`auto`), `speechModelRef` (null), `speechVoice` (null),
     `speechSpeed` (1, 0.5–2); `chatUpdatedDataSchema = chatSummarySchema.extend({ activeLeafId })` for `chat.updated`
     (`chatSummarySchema` itself unchanged: chat export v2 extends it). *Accept:* `null` leaf accepted, a missing leaf
     rejected; old settings documents parse with the new defaults.
  4. **C10-T4 Route table** — `chatMessageParamsSchema`; module `audio` in `ApiModule`; keys `audio.transcribe`
     (form `audioTranscribeFormSchema`, response `audioTranscriptionSchema`), `audio.speech` (body
     `audioSpeechBodySchema`, binary response), `chats.deleteMessage` (params `chatMessageParamsSchema`, response
     `chatDetailSchema`) → 76 routes; conflict reason `only-version`. Neither audio route is `fresh` or `public`.
     *Accept:* `routes.test.ts` (API.md section 8 index + the DECISIONS module table) and `contract.test.ts` green.
  5. **C10-T5 Plugin SDK 1.1.0** — `PLUGIN_API_VERSION = '1.1.0'`; optional `ProviderDefinition` members
     `createImageModel`, `imageParams`, `createTranscriptionModel`, `createSpeechModel`, `transcriptionOptions`;
     `PluginContext.images.generate` (shapes in PLUGINS.md 9); the mirror `S/plugins/templates/sdk-types.ts`;
     `compile.test.ts` expects `"1.1.0"`; `exports.test.ts`. `ctx.ai` gets no `generateImage`. *Accept:* the
     templates test (mirror vs SDK) green; a 1.0 plugin (`engines.harness: "^1.0.0"`) still loads.
  6. **C10-T6 `docs/API.md`** — sections 3 (module `audio`), 4 (4.18 images, 4.19 audio, the chat request
     `imageOptions` with its 400 rules, metadata `image`, the `generated-file-dropped` notice, the `chat.updated`
     payload, `voices`, the settings keys), 5 (`audio.ts`, `chats.ts` delete: 404, 409 `only-version` / `run-active`,
     `chat.updated`, usage / shares / files kept), 6 (the `file` parts of generated images, the image-turn chunks), 8
     (the 76-route index in the parsed format).
  7. **C10-T7 Server stubs and compile fixes** — `S/app.ts` mounts `audio`; the three routes answer `501
     not_implemented`; `body-limit.ts` gives `audio.transcribe` 25 MiB + 64 KiB; `api-samples.ts`; the route-table-driven
     security tests follow the new routes; `S/plugins/context.ts` gets an `images` member whose `generate` throws
     `not_implemented`; `services/chats/index.ts` `emitUpdated` emits `{ ...toSummary(row), activeLeafId:
     row.activeLeafId }` (update, touch, setTitle, switchBranch) and `S/testing/fake-chats.ts` does the same;
     `W/utils/testing/fixtures.ts` and every other fixture get `imageOutput` and the new settings keys. *Accept:*
     `routes-mounted.test.ts` green (no new route answers 404); `pnpm check` green.
- **Tests.** Schema tests for every new DTO; route-table tests; the updated route-driven security tests; the SDK export
  test.
- **Verify.** Shared, server and web commands.

### D6 docs (k1)

- **Mission.** Write this file and update the user-facing and architecture docs so P6-0b and P6-A agents can build
  against them.
- **Owned.** `docs/phases/phase-6-v1-2.md` (new), `docs/UI.md`, `docs/ARCHITECTURE.md`, `docs/PROVIDERS.md`,
  `docs/PLUGINS.md`, `docs/guides/**`, `README.md`, `.env.example`.
- **Tasks.**
  1. **D6-T1 Phase doc** — this file: waves, agents, owned globs, tasks with acceptance criteria, gates, ownership JSON,
     cross-agent contracts, risks.
  2. **D6-T2 UI.md** — the Media wireframe (2.10) and composer states (2.11), the settings nav (5.5), routes (6), message
     parts (7.1), actions and versions (7.5), streaming states (7.6), composer (7.7), model picker (7.9), the new 7.16
     image gallery, 7.17 voice input and 7.18 read aloud, fresh auth (8.4), Models (9.3), the new 9.9 Media, the
     component inventory and contracts (10.3, 10.4), stores and composables (11), shortcuts (12), the new 13.7 test ids,
     accessibility and tablets (14), copy (15).
  3. **D6-T3 ARCHITECTURE.md** — server and web maps (3, 4), boot notes (5), the chat pipeline restructure (6.1),
     remembered and deleted versions (6.8), the new 6.11 image generation and 6.12 voice, the data model and migration
     `0002` (8), the catalog kinds and visibility rules (9), headers (10.2), limits (10.4), the new 10.8 privacy of
     media, observability (12).
  4. **D6-T4 PROVIDERS.md** — the new section 13 "Image and voice models" (support table, seeds, voices, listing and
     classification rules), the mock media models (8), the live media checks (12).
  5. **D6-T5 PLUGINS.md** — plugin API 1.1.0 (additive), section 9 (the new `ProviderDefinition` members, `ctx.images`,
     model kinds and `voices`), an authoring example (a code provider with a local Whisper-compatible
     `createTranscriptionModel`); every manifest example stays a valid manifest.
  6. **D6-T6 README.md and `.env.example`** — an "In progress (v1.2)" note and the HTTPS note for the microphone;
     `HF_LIVE_MEDIA` in the test-only block.
- **Verify.** `pnpm check:english`; `pnpm -F @harness-forge/shared test` (`manifest.test.ts` parses PLUGINS.md);
  `pnpm -F @harness-forge/server exec vitest run src/security/headers.test.ts` (it names ARCHITECTURE.md 10.2 but does
  not parse it).

### Wave P6-0a ownership

C10 lists the extra fixture files it had to touch (the required `imageOutput` capability, the new settings keys) in its
report; the coordinator adds them to `allow` for the audit.

```json
{
  "wave": "P6-0a",
  "agents": {
    "C10": [
      "packages/shared/src/**",
      "packages/plugin-sdk/src/**",
      "docs/API.md",
      "apps/server/src/app.ts",
      "apps/server/src/http/routes/audio.ts",
      "apps/server/src/http/routes/chats.ts",
      "apps/server/src/http/middleware/body-limit.ts",
      "apps/server/src/http/middleware/session-auth.test.ts",
      "apps/server/src/http/middleware/fresh-auth.test.ts",
      "apps/server/src/security/fresh-auth-routes.test.ts",
      "apps/server/src/security/secret-leaks.test.ts",
      "apps/server/src/security/request-guards.test.ts",
      "apps/server/src/testing/api-samples.ts",
      "apps/server/src/plugins/templates/sdk-types.ts",
      "apps/server/src/plugins/compile.test.ts",
      "apps/server/src/plugins/context.ts",
      "apps/server/src/services/chats/index.ts",
      "apps/server/src/testing/fake-chats.ts",
      "apps/web/app/utils/testing/fixtures.ts"
    ],
    "D6": [
      "docs/phases/phase-6-v1-2.md",
      "docs/UI.md",
      "docs/ARCHITECTURE.md",
      "docs/PROVIDERS.md",
      "docs/PLUGINS.md",
      "docs/guides/**",
      "README.md",
      ".env.example"
    ]
  },
  "allow": [
    "AGENT.md",
    "docs/DECISIONS.md",
    "docs/ROADMAP.md"
  ]
}
```

### Gate P6-0a

1. `node scripts/audit-ownership.mjs .tmp/waves/P6-0a.json`
2. `pnpm install --frozen-lockfile` → `pnpm check` → `pnpm build`.
3. `HF_TEST_REQUIRE_WEB_BUILD=1 pnpm -F @harness-forge/server exec vitest run src/http/static.test.ts`.
4. `pnpm start:e2e` → `curl -sf http://127.0.0.1:8899/api/health`; the three new routes are mounted (run with `bash`:
   zsh does not word-split `$r`):
   ```sh
   b=http://127.0.0.1:8899/api; c=0199a0b0-0000-7000-8000-000000000001; m=msg_AAAAAAAAAAAAAAAA
   for r in "POST /audio/transcriptions" "POST /audio/speech" "DELETE /chats/$c/messages/$m"; do
     set -- $r; curl -s -o /dev/null -w "%{http_code} $1 $2\n" -X "$1" "$b$2"
   done   # 501, or 400 where validation runs before the stub (routes-mounted.test.ts covers the full matrix)
   ```
5. `pnpm test:e2e` → 44 passed (`chromium` + `mobile`).
6. `pnpm why typescript` (only 6.0.x).
7. ROADMAP + wave log → commit `feat: add phase 6 contracts and docs`.

---

## Wave P6-0b — schema, migration `0002`, skeletons, FREEZE (done)

**Entry:** Gate P6-0a green. The coordinator lands K3 first; C11 and C12 start in one launch once the migration exists
(C11's upgrade test needs it).

### Coordinator actions

- **K3 Schema and migration `0002`** —
  1. Before any P6-0b build touches it: `rm -rf .tmp/upgrade-v11 && cp -R .tmp/e2e .tmp/upgrade-v11` (a v1.1 data
     directory with only `0000` + `0001` applied, for the upgrade probe). While the P6-0a build still serves `.tmp/e2e`,
     create two branched chats there first (send A, then B, edit A; regenerate a reply and switch back to the older
     version) and save `curl -s $b/chats/<id>` of each into `.tmp/upgrade-v11-before/`.
  2. `S/db/schema.ts`: `messages.selectedChildId` (`selected_child_id text`, nullable, **no** `references`, no index);
     `UsagePurpose` = `'chat' | 'title' | 'image' | 'transcription' | 'speech'` (TypeScript only).
  3. `pnpm db:generate --name remembered_versions`.
  4. Inspect the SQL: exactly ``ALTER TABLE `messages` ADD `selected_child_id` text;``. **Reject** any `DROP TABLE`,
     `__new_` or `PRAGMA foreign_keys` statement (foreign keys are on; a table rebuild would cascade-delete messages
     inside the migration transaction).
  5. Append the backfill after `--> statement-breakpoint` (every active path: each parent points at its child on the
     path); never re-run `db:generate` after the hand edit:
     ```sql
     WITH RECURSIVE path(chat_id, id, parent_id, seq) AS (
       SELECT m.chat_id, m.id, m.parent_id, m.seq FROM chats c JOIN messages m ON m.chat_id = c.id AND m.id = c.active_leaf_id
       UNION ALL SELECT p.chat_id, p.id, p.parent_id, p.seq FROM messages p
       JOIN path ON p.id = path.parent_id AND p.chat_id = path.chat_id AND p.seq < path.seq)
     UPDATE messages SET selected_child_id = path.id FROM path
     WHERE messages.id = path.parent_id AND messages.chat_id = path.chat_id;
     ```
- **K4 After C11 and C12** — `playwright.config.ts`: `use.permissions: ['microphone']`, `use.launchOptions.args:
  ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required']`,
  a project `tablet` (`devices['Galaxy Tab S9 landscape']`: 1024×640, Chromium, touch; `testMatch:
  /specs\/tablet\/.*\.spec\.ts$/`), and `chromium` ignores `specs/(mobile|tablet)/`; `nuxi prepare`; the gate below; the
  FREEZE additions.
- Ownership file `.tmp/waves/P6-0b.json` (below).

### C11 server skeleton (k3)

- **Mission.** Freeze the server side of Phase 6: additive interfaces, stub services, the fully working mock media
  models, the security headers, fakes and the database tests.
- **Owned.** `S/db/**` (except `schema.ts`; `apps/server/drizzle/**` is the coordinator's), `S/types.ts`, `S/deps*.ts`,
  `S/providers/types.ts`, `S/services/{images,audio}/**` (types + stub factories), `S/services/files/{types,index}.ts`
  (the `saveGenerated` stub), `S/services/chats/{types,store,index}.ts` (the `deleteMessage` stub and doc comments
  only), `S/security/headers*`, `S/http/static.test.ts`, `S/builtin-plugins/mock/**`, `S/testing/**` (except
  `api-samples.ts`).
- **Read-only highlights.** `.tmp/p6-designs/{images,voice,stabilization}.md`, ARCHITECTURE.md 6.8, 6.11, 6.12, 8,
  10.2; PROVIDERS.md 8; `packages/shared/src/**` (C10's contracts), `apps/server/drizzle/0002_*.sql`.
- **Tasks.**
  1. **C11-T1 Types (additive)** — `providers/types.ts`: `ResolvedModelBase`, `ResolvedImageModel { imageModel }`,
     `ResolvedAudioModel<M> { modelRef, providerId, modelId, model, entry, provider }`, `resolveImageModel(ref, opts)`,
     `resolveTranscriptionModel(ref, opts?)`, `resolveSpeechModel(ref, opts?)` (errors in ARCHITECTURE.md 6.11 / 6.12);
     `services/files/types.ts`: `saveGenerated({ data, mediaType, name }) → StoredFile`; new
     `services/images/types.ts` (`ImageService.generate(input) → { modelRef, images: { file, url }[], usage,
     costUsd | null, revisedPrompt?, dropped }`); new `services/audio/types.ts` (`AudioService.transcribe({ file, form,
     signal }) → AudioTranscription`, `speak({ ...AudioSpeechBody, signal }) → { audio, mediaType, modelRef }`);
     `services/chats/types.ts`: `deleteMessage(id, messageId) → ChatDetail`; `S/types.ts`: `AppServices.images`,
     `AppServices.audio`.
  2. **C11-T2 Stubs** — `services/{images,audio}/index.ts` factories whose members throw `not_implemented`; the new
     resolvers, `saveGenerated` and `deleteMessage` stubbed the same way; wired in `deps.ts`.
  3. **C11-T3 Mock media models** (fully implemented; PROVIDERS.md 8): `mock:image` (image model, `vision`; 300 ms,
     5 s when the prompt contains "slow"; honors abort; `n` solid-color PNGs colored by a hash of prompt + index +
     inputs; the aspect ratio sets the pixel size; usage = prompt words in, 100·n out; `revisedPrompt` "Mock: …"; a
     prompt containing "fail" → a 400 `APICallError`), `mock:image-chat` (`imageOutput`: streams text, then one PNG
     `file` part), `mock:image-tool` (`tools`: calls `generate_image` when offered, then answers `Image tool result: <n>
     image(s)`), `mock:transcribe` ("This is a mock transcription."), `mock:speech` (a silent 8 kHz mono 16-bit WAV,
     400 ms per word, 1–6 s; `voices: ['mock-voice-a', 'mock-voice-b']`); `png.ts` encoder on `deflateSync` + `zlib.crc32`; `createMockWav()` exported for tests;
     the provider defines `createImageModel`, `imageParams`, `createTranscriptionModel`, `createSpeechModel`.
  4. **C11-T4 Security headers** — `Permissions-Policy: camera=(), microphone=(self), geolocation=()`; `spaCsp` adds
     `media-src 'self' blob:`; the API CSP is unchanged; the comment in `http/middleware/secure-headers.ts` is not owned
     (a CCR note in the report is enough).
  5. **C11-T5 Fakes** — `S/testing/**` fakes for `ImageService`, `AudioService`, the three resolvers (on
     `MockImageModelV4` / `MockTranscriptionModelV4` / `MockSpeechModelV4`), `saveGenerated` and `deleteMessage`, so
     W6.1, W6.4, W6.5 and W6.6 can test without each other.
  6. **C11-T6 Database tests** — `db.test.ts` expects the new column (15 tables); an upgrade test migrates a temporary
     folder holding only `0000` + `0001` (the copied SQL + a two-entry journal), seeds branched chats (versions on and
     off the active path), then migrates the real folder and checks that pointers exist only on active-path parents and
     that every pointer names a child. *Accept:* a copy of `0002` without the backfill fails the same checks.
- **Tests.** Mock models (PNG signature and size per aspect ratio, determinism, abort, "slow" / "fail", the WAV header
  and duration), headers (`microphone=(self)`, `media-src` in the SPA CSP only), `static.test.ts` (the built-page CSP
  asserts `media-src`), the database tests above, `deps.test.ts` (the new stubs answer `not_implemented`).
- **Verify.** Server commands.

### C12 web skeleton (k4)

- **Mission.** Freeze the web side of Phase 6: every new test id, the Media settings link and page, the stub components
  with their final props and root test ids, the composable stubs with their final signatures, and the fake media
  helpers.
- **Owned.** `W/utils/testids.ts`, `W/components/app-shell/navigation{,.test}.ts`, `W/pages/settings/media.vue` (stub),
  the stub components `W/components/settings/media/MediaSettings.vue`, `W/components/settings/images/ImageSettings.vue`,
  `W/components/settings/voice/VoiceSettings.vue`, `W/components/chat/parts/{ImageGallery,GeneratingImages}.vue`,
  `W/components/chat/composer/{ImageOptionsMenu,MicButton,RecordingIndicator}.vue`, `W/components/chat/ReadAloudButton.vue`
  (each with a stub mount test next to it), the composable stubs `W/composables/{useImageOptions,useVoiceInput,
  useSpeechPlayer}.ts` (+ tests), `W/utils/testing/fake-media.ts`.
- **Read-only highlights.** UI.md 2.10, 5.5, 6, 7.16 – 7.18, 9.9, 10.4, 11, 13.7.
- **Tasks.**
  1. **C12-T1 Test ids** — every id of UI.md 13.7 in `utils/testids.ts` (key = the camelCase of the id, as listed
     there) under a `// Multimodal, versions and stabilization (Phase 6)` comment.
  2. **C12-T2 Settings link** — "Media" (`ImagePlayIcon` from `@lucide/vue`, verified to exist; `/settings/media`,
     `testIds.settingsNavMedia`, key `media`) in `SETTINGS_LINKS` right after Models.
  3. **C12-T3 Page stub** — `pages/settings/media.vue` renders `MediaSettings` in the settings frame.
  4. **C12-T4 Component stubs** — each stub has the UI.md 10.4 props / emits exactly and renders its root test id
     (`media-settings`, `image-settings`, `voice-settings`, `image-gallery`, `image-generating`, `image-options-trigger`,
     `composer-mic`, `composer-recording`, `message-read-aloud`); `MediaSettings` renders `ImageSettings` and
     `VoiceSettings`.
  5. **C12-T5 Composable stubs** — `useImageOptions`, `useVoiceInput`, `useSpeechPlayer` with the UI.md 11.3 signatures;
     inert bodies (idle state, no-op actions) that type-check.
  6. **C12-T6 Fake media** — `utils/testing/fake-media.ts`: `FakeMediaRecorder` (emits an EBML-prefixed `audio/webm`
     blob; `isTypeSupported` from `mimeTypes`), `installFakeMedia({ deny?, mimeTypes?, secure? })` (fake
     `navigator.mediaDevices.getUserMedia`, `MediaRecorder`, `isSecureContext`; returns an uninstall function),
     `FakeAudio` (a controllable `HTMLAudioElement` stand-in: `play()` resolves, `ended` can be fired).
- **Tests.** `navigation.test.ts` (Media after Models), one stub mount test per new component (root test id, props
  accepted), `fake-media` self-tests.
- **Verify.** Web commands (`typecheck:fast` needs the coordinator's `.nuxt`; import new components by path).

### Wave P6-0b ownership

The audit cannot express "except": `S/db/schema.ts` matches C11's glob but is the coordinator's K3 edit.

```json
{
  "wave": "P6-0b",
  "agents": {
    "C11": [
      "apps/server/src/db/**",
      "apps/server/src/types.ts",
      "apps/server/src/deps*.ts",
      "apps/server/src/providers/types.ts",
      "apps/server/src/services/images/**",
      "apps/server/src/services/audio/**",
      "apps/server/src/services/files/types.ts",
      "apps/server/src/services/files/index.ts",
      "apps/server/src/services/chats/types.ts",
      "apps/server/src/services/chats/store.ts",
      "apps/server/src/services/chats/index.ts",
      "apps/server/src/security/headers*",
      "apps/server/src/http/static.test.ts",
      "apps/server/src/builtin-plugins/mock/**",
      "apps/server/src/testing/**"
    ],
    "C12": [
      "apps/web/app/utils/testids.ts",
      "apps/web/app/components/app-shell/navigation.ts",
      "apps/web/app/components/app-shell/navigation.test.ts",
      "apps/web/app/pages/settings/media.vue",
      "apps/web/app/components/settings/media/**",
      "apps/web/app/components/settings/images/**",
      "apps/web/app/components/settings/voice/**",
      "apps/web/app/components/chat/parts/{ImageGallery,GeneratingImages}*",
      "apps/web/app/components/chat/composer/{ImageOptionsMenu,MicButton,RecordingIndicator}*",
      "apps/web/app/components/chat/ReadAloudButton*",
      "apps/web/app/composables/{useImageOptions,useVoiceInput,useSpeechPlayer}*",
      "apps/web/app/utils/testing/fake-media.ts"
    ]
  },
  "allow": [
    "apps/server/drizzle/**",
    "playwright.config.ts",
    "docs/ROADMAP.md",
    "docs/DECISIONS.md",
    "AGENT.md"
  ]
}
```

### Wave P6-0b cross-agent contracts

| Producer → consumer | Contract |
|---|---|
| C11 → W6.1, W6.4, W6.5 | `ImageService`, `AudioService`, `resolveImageModel` / `resolveTranscriptionModel` / `resolveSpeechModel`, `ResolvedModelBase`, fakes in `S/testing/**` |
| C11 → W6.4 | `FilesService.saveGenerated` (raster only, size cap, magic bytes, dedupe) |
| C11 → W6.6 | `ChatsService.deleteMessage`, `messages.selected_child_id` in the schema, the upgrade test |
| C11 → W6.12 | the five mock media models (PROVIDERS.md 8) |
| C12 → W6.7, W6.8, W6.9, W6.10 | the stub components and composable stubs with frozen props / signatures (UI.md 10.4, 11.3) |
| C12 → everyone | `utils/testids.ts` (frozen after the gate), `utils/testing/fake-media.ts` |

### Gate P6-0b

1. `node scripts/audit-ownership.mjs .tmp/waves/P6-0b.json`
2. `nuxi prepare` (K4) → `pnpm check` → `pnpm build` → the CSP test with `HF_TEST_REQUIRE_WEB_BUILD=1` (now asserts
   `media-src 'self' blob:`).
3. `pnpm start:e2e` → `pnpm test:e2e` (44 still green; the `tablet` project has no specs yet).
4. **Upgrade probe** on the copy made in K3 (never on `.tmp/e2e`, which step 3 already migrated):
   ```sh
   HF_MOCK_PROVIDER=1 HF_OFFLINE=1 HF_PORT=8898 HF_DATA_DIR=.tmp/upgrade-v11 node apps/server/dist/main.mjs &
   sqlite3 .tmp/upgrade-v11/harness.db "WITH RECURSIVE path(chat_id, id, parent_id, seq) AS (
     SELECT m.chat_id, m.id, m.parent_id, m.seq FROM chats c JOIN messages m ON m.chat_id = c.id AND m.id = c.active_leaf_id
     UNION ALL SELECT p.chat_id, p.id, p.parent_id, p.seq FROM messages p
     JOIN path ON p.id = path.parent_id AND p.chat_id = path.chat_id AND p.seq < path.seq)
   SELECT
     (SELECT count(*) FROM messages m WHERE m.selected_child_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM path WHERE path.parent_id = m.id AND path.id = m.selected_child_id)),
     (SELECT count(*) FROM path WHERE path.parent_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = path.parent_id AND m.selected_child_id = path.id))"
   # 0|0: pointers only on active-path parents, and every active-path parent has one
   ```
   `GET http://127.0.0.1:8898/api/chats/<id>` of the saved chats equals `.tmp/upgrade-v11-before/<id>.json` (same
   `messages` and `branches`); switching a branched chat away (`POST /chats/<id>/branch`) and back restores the saved
   path. Stop the probe server afterwards. (Without the `sqlite3` CLI, run the query through `node` +
   `@libsql/client`.)
5. FREEZE additions (see "FREEZE in Phase 6") → ROADMAP + wave log → commit
   `feat: add phase 6 schema, migration and skeletons`.

---
## Wave P6-A — features (done)

Eleven agents in one launch against the P6-0b checkpoint. Only server agents get slots (k1 – k6); web agents run no
server.

### Coordinator actions

- Before the launch: the ownership file `.tmp/waves/P6-A.json` (below), agent prompts with a "what exists now" section,
  the relevant plan and design sections, and the rules of this file.
- **K5 at the gate**: audit; batch the CCRs (missing members, contract changes, frozen-file edits, the
  `secure-headers.ts` comment); `nuxi prepare`; the gate commands and probes below; the screenshot review;
  `pnpm audit`; red items become W6.15 / W6.16 tasks with their globs.

### Wave rules

- Import new components explicitly by path; no `nuxt prepare` mid-wave.
- A new test id, a contract change or a frozen-file edit is a CCR in the report (with a local adapter).
- No doc edits.
- Hot files have exactly one owner (table below): `useChatSession` and the top-level chat components → W6.7;
  `chat/parts/**`, `ReadAloudButton`, `useSpeechPlayer`, `speech-text` and the share rendering files → W6.8;
  `chat/composer/**`, `useVoiceInput`, `useImageOptions`, `ModelCaps`, `stores/models` (implementation) → W6.9; the
  settings files → W6.10; `useFreshAuth`, its call sites and the sidebar patch → W6.11. `ChatHeader*` has no owner in
  P6-A (no change is planned).
- Server agents test against the C11 fakes for members other agents implement (`ImageService` for W6.1, resolvers for
  W6.4 / W6.5, `saveGenerated` for W6.1); the real round trips are probed at the gate.
- `generate_image` (W6.4-T4 and the injection of W6.1-T5) is the first item to cut if the wave overflows.

### W6.1 image-pipeline (k1)

- **Mission.** Image turns, the stream restructure of every chat run, generated-file storage, the `generate_image` file
  injection, the history carry-forward, the `imageOptions` rules and image-turn titles.
- **Owned.** `S/chat/**` (not `chat/types.ts`), `S/http/routes/chat{,.test}.ts`.
- **Read-only highlights.** `.tmp/p6-designs/images.md` sections 0 – 3; ARCHITECTURE.md 6.1, 6.11; API.md 4.18,
  `chat.ts`, 6 (chat request `imageOptions`, metadata `image`, notice `generated-file-dropped`);
  `S/providers/types.ts`, `S/services/{images,files}/types.ts`, the C11 fakes; `node_modules/ai/dist/index.d.ts`
  (`createUIMessageStream`, `writer.merge`, the UI chunk union).
- **Tasks.**
  1. **W6.1-T1 Target resolution** — `chat/prepare.ts`: `catalog.get(ref)?.kind === 'image'` →
     `providers.resolveImageModel`, else `resolveModel` (which rejects image models with `validation_error`);
     `PreparedRun.resolved` → `ResolvedModelBase` + `target: { kind: 'chat', model } | { kind: 'image', model, options }`.
     The title of an image-turn chat comes from `titleModelRef`, else the provider's `smallModelId`, else the default
     title stays. *Accept:* an image-turn chat without a title model keeps its default title and never calls the image
     model for a title.
  2. **W6.1-T2 Request rules** — `imageOptions` → `400 validation_error` on `['imageOptions']` unless the model is an
     image model or has `capabilities.imageOutput`; `n` / `editPrevious` only for image models. Image-turn prompt = the
     new user message's text after slash expansion (400 when empty or longer than `LIMITS.imagePromptMaxChars`; as
     built, not checked when a reply command writes the reply). Input images = the images attached to the message when
     the model has `vision`; else, when none are attached and `editPrevious !== false`, the generated images of the
     parent assistant reply (at most `LIMITS.imageInputsMax`; as built, also for vision models only); other attachments
     → the existing `attachments-unsupported` notice. Image turns send no history. An approval continuation sent with
     an image model → 400 on `['modelRef']` (added while building). *Accept:* route
     tests for every 400; `mock:echo` + `imageOptions` → 400; "make it blue" after a `mock:image` reply sends 2 inputs.
  3. **W6.1-T3 `chat/images.ts` `imageStream(session)`** — `createUIMessageStream({ originalMessages, generateId: () =>
     assistantId, execute, onError, onEnd: session.onEnd })` emitting `start` (metadata `{ modelRef, startedAt, image:
     { n, aspectRatio?, inputs } }`) → `start-step` → a `message-metadata` keep-alive with the same start metadata every
     15 s → one `file` chunk per image (`url: '/api/files/<id>'`, `mediaType`) → `finish-step` → `finish` (metadata
     `usage`, `costUsd?`, `image.revisedPrompt?`). The work is one call: `deps.images.generate({ resolved, prompt,
     inputFileIds, n, aspectRatio, signal: run.signal, chatId, messageId })`. Failure → `recordFatal` + an `error` chunk
     (the error envelope) persisted in `metadata.error`; Stop → an `abort` chunk, saved with `aborted: true`. *Accept:*
     chunk order; abort (a "slow" prompt); failure (a "fail" prompt); resume replays exactly once (the buffer holds
     URLs only); regenerate adds a version.
  4. **W6.1-T4 Stream restructure for every chat run** — `const ui = toUIMessageStream({ …, no onEnd })`, returned
     through `createUIMessageStream({ originalMessages: prepared.history, generateId: () => session.assistantId,
     onError: e => session.errorText(e), onEnd: session.onEnd, execute: ({ writer }) =>
     writer.merge(ui.pipeThrough(storeGeneratedFiles(session))) })`, so what is saved equals what is streamed. Models
     with `capabilities.imageOutput` get `definition.imageParams({ n: 1, aspectRatio, inputs: 0 }, model).providerOptions`
     deep-merged into the call. *Accept:* `pipeline.test.ts` stays green (resume, approvals, Stop, `reply` commands,
     title, notices).
  5. **W6.1-T5 `chat/generated-files.ts` `storeGeneratedFiles`** — `file` / `reasoning-file` chunks with a `data:` URL:
     raster types (`GENERATED_IMAGE_MIME_TYPES`) are stored through `files.saveGenerated` and re-sent with the stored URL,
     keeping `providerMetadata` (Gemini thought signatures); anything else is dropped and replaced by an inline
     `data-notice` with code `generated-file-dropped`. The final `tool-output-available` of `generate_image` (only when
     the tool belongs to `core-tools` and the output parses with `generateImageToolOutputSchema`) appends one `file`
     chunk per image and adds the tool's `costUsd` to the message cost; a `toolCallId → toolName` map is seeded from
     `prepared.continued` (approval continuations). `finalMessage()` adds `filename` (the UI chunk cannot carry it) and
     drops any leftover `data:` part. *Accept:* a test that fails when any `data:` URL is streamed or saved
     (`mock:image-chat`); a plugin tool named `generate_image` from another plugin never injects files; the injection
     works on an approval continuation.
  6. **W6.1-T6 History** — `chat/files.ts` `prepareModelFiles`: the images of the most recent assistant message that has
     any are carried into the next user message (vision models only; after a text part "(Images generated earlier in
     this chat:)", at most 4, as data URLs); every generated file part of an assistant message becomes the text
     `[Generated image: <name>]` (`[Generated file: <name>]` for other files) in place, the carried ones included (as
     built; the plan said "every other") — an assistant message never reaches a provider empty; `reasoning-file` parts
     never go back to models.
     *Accept:* history tests for both markers and a non-vision model.
- **Tests.** Stream order and metadata; no `data:` URL streamed or saved; abort; resume; regenerate; the tool injection
  only from `core-tools`; history markers; every `imageOptions` 400.
- **Verify.** Server commands.

### W6.2 model-runtime (k2)

- **Mission.** Resolve image, transcription and speech models; classify the new kinds; list non-chat seeds; the
  visibility rules; validate the new provider functions.
- **Owned.** `S/providers/**` (not `types.ts`), `S/catalog/**`, `S/registry/validate*`.
- **Read-only highlights.** `.tmp/p6-designs/images.md` section 4 (catalog and providers), `voice.md` section 3;
  ARCHITECTURE.md 9, 6.11, 6.12; PROVIDERS.md 3, 13; PLUGINS.md 9 (`ProviderDefinition`); `S/providers/types.ts`.
- **Tasks.**
  1. **W6.2-T1 Resolvers** — `resolveImageModel(ref, opts)`, `resolveTranscriptionModel(ref, opts?)`,
     `resolveSpeechModel(ref, opts?)`: the same checks as `resolveModel` (unknown or disabled provider, credentials →
     `provider_not_configured`); a model of another kind → `validation_error`; an image model whose provider has no
     `createImageModel` → `model_not_found`; a transcription / speech model whose provider lacks the factory →
     `validation_error`; a throwing factory → `plugin_error`; factories guarded 5 s. `resolveModel` rejects
     `kind: 'image'`. *Accept:* a resolver error table test.
  2. **W6.2-T2 `classify()`** — the id regex `/(?:^|\/)(?:gpt-image|chatgpt-image|dall-e|imagen|grok-imagine-image)/i`
     → `image`, before modalities; no text output: image → `image`, audio → `speech` when text is an input, else
     `audio`; audio in without text in and text out → `transcription`; the id fallback `tts` → `speech`,
     `whisper|transcri` → `transcription`; `modelsDevLayer` sets `imageOutput` from the output modalities (text + image).
     *Accept:* `gpt-image-1-mini`, `gpt-image-1.5`, `chatgpt-image-latest` → `image` although models.dev lists
     `[text, image]` output; `gemini-2.5-flash-image` → `chat` with `imageOutput`; `gpt-4o-mini-tts` → `speech`;
     `whisper-large-v3` → `transcription`.
  3. **W6.2-T3 Catalog** — seeds with an explicit non-chat kind are always listed, even next to a live listing
     (`buildEntries` used `live ?? seeds`); a media model (image, transcription, speech) is listed only when its
     provider defines the matching factory (custom models always stay; as built — the plan hid such image models);
     image models are visible, transcription and speech models are hidden from the chat picker by default;
     `ModelInfo.voices` (deduplicated, at most 100) → `CatalogModel.voices`; the default-model choice and the credential
     ping take chat models only. *Accept:* a live listing plus media seeds lists both; the image model of a provider
     without `createImageModel` is not listed; the default `validate()` ping never picks a non-chat model.
  4. **W6.2-T4 Validation** — `registry/validate.ts`: `createImageModel`, `imageParams`, `createTranscriptionModel`,
     `createSpeechModel`, `transcriptionOptions` must be functions when present. *Accept:* a non-function member →
     `validation_error` naming the member.
- **Tests.** Resolver table; classify table; catalog visibility and seed rules; validation.
- **Verify.** Server commands.

### W6.3 provider-media (k3)

- **Mission.** Image, transcription and speech support of the builtin providers.
- **Owned.** `S/builtin-plugins/core-providers/**`.
- **Read-only highlights.** PROVIDERS.md 13 (support table, seeds, voices), 3, 5; `.tmp/p6-designs/images.md` section 0,
  `voice.md` sections 0 and 3; the provider packages' `.d.ts` (`.image()`, `.transcription()`, `.speech()`, the
  provider option schemas).
- **Tasks.**
  1. **W6.3-T1 Images** — `openai`: `createImageModel` → `.image(id)`; `imageParams` maps the aspect ratio to `size`
     (1:1 → `1024x1024`, portrait → `1024x1536`, landscape → `1536x1024`; Auto → nothing). `xai`: `.image(id)`;
     `aspectRatio` passed through. `google` (no `createImageModel`): `imageParams` for `imageOutput` chat models
     (`gemini-*-image*`, `nano-banana*`) → `providerOptions.google` =
     `{ responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio } }`. `openrouter`: `imageOutput` from
     `architecture.output_modalities`; `imageParams` → `providerOptions.openrouter` = `{ modalities: ['image', 'text'],
     image_config: { aspect_ratio } }` (spread into the request body). *Accept:* per-provider tests with a fake fetch
     assert the wire body (`size`, `aspectRatio`, `responseModalities`, `modalities`).
  2. **W6.3-T2 Voice** — `openai`, `google`, `mistral`: `.transcription(id)` / `.speech(id)`; `groq`: `.transcription(id)`
     only; `xai`: `.transcription()` / `.speech()` without an id (catalog keys `stt` / `tts`). `transcriptionOptions({
     language })` → `{ openai: { language } }`, `{ google: { languageCodes: [language] } }`, `{ xai: { language } }`,
     `{ mistral: { language } }`, `{ groq: { language } }`; nothing for `auto`. Never pass `outputFormat`, `speed`,
     `instructions` or `language` to speech (unsupported options print SDK warnings; the xAI package itself always sends
     `language: 'auto'` for speech). *Accept:* fake-fetch tests assert
     the language field and that no unsupported option is sent.
  3. **W6.3-T3 Listings, seeds, voices** — listings keep the media ids the provider can run (OpenAI `gpt-image*`,
     `chatgpt-image*`, `*transcribe*`, `whisper-1`, `tts-*`, `*-tts*`; xAI `grok-imagine-image*`; Google
     `gemini-*-image*` and `nano-banana*` (chat models with image output) and `*-tts*`; Groq `whisper-*`); other non-chat
     ids stay dropped;
     seeds with explicit kinds and `voices` from PROVIDERS.md 13 (voice lists unverified; `gemini-3.5-transcribe` left
     out). *Accept:* listing tests; seeds carry `kind`; `mistral`, `groq`, `xai` voice seeds validate.
- **Tests.** One test per new factory with a fake fetch; listing filters; seeds.
- **Verify.** Server commands (never the live suite).

### W6.4 image-host (k4)

- **Mission.** `ImageService`, generated-file storage, `ctx.images` and the `generate_image` tool.
- **Owned.** `S/services/images/**` + `S/services/files/**` (not `types.ts`), `S/plugins/{context,host}*`,
  `S/builtin-plugins/core-tools/**`.
- **Read-only highlights.** `.tmp/p6-designs/images.md` sections 1c, 2 (usage and cost), 4; ARCHITECTURE.md 6.11;
  PLUGINS.md 9 (`ctx.images`); API.md 4.18; `S/services/{images,files}/types.ts`; the C11 fakes.
- **Tasks.**
  1. **W6.4-T1 `files.saveGenerated({ data, mediaType, name })`** — raster only (`GENERATED_IMAGE_MIME_TYPES`), at most
     `LIMITS.generatedImageBytes`, the magic bytes must match the type, an existing row with the same content is reused.
     *Accept:* SVG, an oversized image and a type mismatch are refused; the same bytes twice give the same file id.
  2. **W6.4-T2 `ImageService.generate(input)`** — `definition.imageParams({ n, aspectRatio, inputs }, model)` →
     `generateImage({ model, prompt: inputs ? { text, images } : text, n, size?, aspectRatio?, providerOptions,
     abortSignal, maxRetries })` with the input files read from `files`; each image stored through `saveGenerated`
     (refused ones counted in `dropped`); a usage row (`purpose: 'image'`, via `chats.addUsage`) and the provider outcome
     recorded; `costUsd` from the catalog's per-1M-token prices (null when unknown; xAI null); errors through
     `providers.mapError`. *Accept:* `MockImageModelV4` tests: usage row, cost math, abort, `dropped`, error mapping.
  3. **W6.4-T3 `ctx.images.generate({ prompt, modelRef?, n?, aspectRatio?, chatId?, signal? })`** → `{ modelRef, images:
     { fileId, url, mediaType, name, size }[], costUsd?, revisedPrompt? }`; the model is `modelRef ?? settings.imageModelRef`
     (neither → `validation_error` "Choose an image model in Settings → Media."); the plugin's `ctx.signal` and the given
     `signal` both abort. *Accept:* context tests.
  4. **W6.4-T4 `generate_image`** (`core-tools`, policy `ask`, `timeoutMs: 300_000`) — input
     `generateImageToolInputSchema`, execute = `ctx.images.generate({ ...input, chatId: c.chatId, signal: c.signal })`,
     output `generateImageToolOutputSchema` (file references only, well under 64 KB), `toModelOutput` = text only
     ("Generated 2 images with <model ref>; they are shown to the user below this call."; as built the text names the
     model ref: the result carries no display name); always registered; without
     `imageModelRef` it fails with "Choose an image model in Settings → Media." *Accept:* tool tests incl. the text-only
     model output and the missing-setting error.
- **Tests.** The four tasks above.
- **Verify.** Server commands.

### W6.5 voice-server (k5)

- **Mission.** The two audio routes and `AudioService`.
- **Owned.** `S/services/audio/**` (not `types.ts`), `S/http/routes/audio{,.test}.ts`.
- **Read-only highlights.** `.tmp/p6-designs/voice.md` sections 0, 2; ARCHITECTURE.md 6.12, 10.8, 12; API.md 4.19,
  `audio.ts`; `S/http/routes/data.ts` (`readImportForm`, the multipart pattern); `S/services/audio/types.ts`; the
  resolver fakes.
- **Tasks.**
  1. **W6.5-T1 Transcription input** — multipart parsed like `readImportForm`: exactly one `file` part plus
     `AudioTranscribeForm` fields (unknown or repeated fields → 400); an allowlist with aliases, parameters stripped:
     `audio/webm` (+ `video/webm`), `audio/ogg`, `audio/mp4` (+ `audio/x-m4a`, `video/mp4`), `audio/mpeg` (+ `audio/mp3`),
     `audio/wav` (+ `audio/x-wav`, `audio/wave`), `audio/flac` (+ `audio/x-flac`); the declared type must match the magic
     bytes (`sniff.ts`): webm = an EBML header with DocType `webm`, ogg = `OggS`, mp4 = `ftyp` with a non-image brand,
     mp3 = `ID3` or an MPEG frame sync (AAC ADTS rejected), wav = `RIFF…WAVE`, flac = `fLaC`;
     `application/octet-stream` lets the sniffer decide; under 64 bytes → 400 "The recording is empty."; above
     `LIMITS.audioUploadBytes` → 413 (body limit and service). Chat uploads are unchanged. *Accept:* a sniff table test;
     a PNG sent as `audio/webm` → 400.
  2. **W6.5-T2 Transcription** — model = `form.modelRef ?? settings.transcriptionModelRef` (neither →
     `validation_error`), language = `form.language ?? settings.transcriptionLanguage` (`auto` sends nothing) → the
     provider's `transcriptionOptions`; `withTimeout(120_000, …, c.req.raw.signal)` and `maxRetries: 1`, so a client
     disconnect aborts the provider call; `NoTranscriptGeneratedError` → 200 with `text: ''`; the response is
     `AudioTranscription { text, language, durationSec, modelRef }`. *Accept:* an aborted request aborts the model call.
  3. **W6.5-T3 Speech** — `AudioSpeechBody` (`text` 1–4096, `modelRef?`, `voice?`); model and voice from the settings
     unless the body overrides them (no model → `validation_error`); 60 s timeout; the binary response carries the
     allowlisted `Content-Type`, `Content-Length` and `Cache-Control: no-store`; never `outputFormat`, `speed`,
     `instructions` or `language`. *Accept:* 4097 characters → 400; `mock:speech` → `audio/wav` starting with `RIFF`.
  4. **W6.5-T4 Both routes** — session auth and the Origin check apply, no fresh auth; errors through
     `providers.mapError` + `recordOutcome`; the info log line carries provider, model, bytes or characters, type,
     duration and ms, never text or audio; nothing is stored; one usage row per call (`purpose` `transcription` |
     `speech`, `chatId` null, 0 tokens, `costUsd` null). *Accept:* a log-capture test finds no transcript or speech text
     in any record.
- **Tests.** Multipart rules, the sniff table, 413, model and kind errors, abort on disconnect, headers, no content in
  logs, usage rows.
- **Verify.** Server commands.

### W6.6 chats-server (k6)

- **Mission.** Remembered versions (S6), deleting a version (S7), totals that include image usage, the `chat.updated`
  leaf (S5) tests.
- **Owned.** `S/services/chats/**` (not `types.ts`), `S/http/routes/chats{,.test}.ts`, `S/testing/fake-chats*`.
- **Read-only highlights.** `.tmp/p6-designs/stabilization.md` S5 – S7; ARCHITECTURE.md 6.8, 8; API.md `chats.ts`
  (`chats.deleteMessage`), 7 (`chat.updated`); `apps/server/drizzle/0002_*.sql`; `S/db/upgrade.test.ts` (C11).
- **Tasks.**
  1. **W6.6-T1 Tree** — `TreeRow.selectedChildId` (+ `TREE_COLUMNS`); `rememberedLeafUnder(tree, messageId)` walks down:
     the remembered child when it is still a child of the node, else the only child, else `latestLeafUnder(node)`; an
     unknown id → `null`. *Accept:* `tree.test.ts` with a valid, an invalid and a missing pointer.
  2. **W6.6-T2 Store** — `rememberPathSql(chatId, leafId, when?)` (the backfill's UPDATE…FROM anchored on one leaf,
     plus `AND selected_child_id IS NOT path.id` and the `messages.seq < path.seq` guard; as built it writes only while
     `when` holds, by default "`leafId` is the chat's active leaf"). `setActiveLeaf` runs it under the condition of its
     compare-and-set, before the move and in the same batch (as built; the plan said after a successful CAS), so both
     are written or neither (atomic inside `transaction()`, so the pipeline's commit and persist get it for free);
     `switchBranch` (whose leaf becomes `rememberedLeafUnder(messageId)`) and the import batch run it too. Not exported
     (chat export v2 and backups unchanged; import re-derives it). *Accept:* A → B → A restores A's deep path where
     "latest" differs from "remembered"; a failed CAS writes nothing.
  3. **W6.6-T3 Delete a version** — `deleteMessage(id, messageId)` and the route `DELETE /chats/:id/messages/:messageId`
     → `ChatDetail`: 404 for an unknown chat or message; 409 `conflict` `only-version` when the message has no other
     version; 409 `run-active` while `hasRun` (checked by the route) and on a CAS miss (nothing deleted). When the active
     path goes through the message: target = the previous sibling by `seq`, else the next; new leaf =
     `rememberedLeafUnder(target)`; `pending_approval` recomputed like `switchBranch`. One `db.batch`: the CAS `UPDATE
     chats … WHERE active_leaf_id IS <old>` + a recursive-CTE subtree `DELETE` guarded by `EXISTS(new leaf)` and
     `EXISTS(another sibling)`; then `rememberPathSql`, `emitUpdated`, the detail. `updated_at`, usage rows, share
     snapshots and files stay; `search_text` goes with the rows. *Accept:* service tests (leaf move, an off-path delete,
     `only-version`, a CAS race, the approval flag, usage kept, the event) and route tests (200, 404, 409 ×2).
  4. **W6.6-T4 Totals** — `ChatDetail.totals` sums the `chat` and `image` usage rows of the chat. *Accept:* totals test
     with an image row.
  5. **W6.6-T5 `chat.updated` leaf** — every `chat.updated` carries the row's `activeLeafId` (update, touch, setTitle,
     switchBranch, deleteMessage); `fake-chats` does the same. *Accept:* event tests.
- **Tests.** The five tasks above.
- **Verify.** Server commands.

### W6.7 chat-surface-web

- **Mission.** Versions in the web (S5, S7), attachment editing (S8), mounting the new media parts, image options in the
  chat request.
- **Owned.** `W/composables/{useChatSession,useServerEvents}*`, `W/components/chat/{ChatMessage,MessageActions,
  MessageEditor,MessageMeta,ChatTranscript,ChatView,BranchSwitcher,UserMessageBubble,chat-format,chat-context,
  attachment-toasts,nuxt-imports}*`, `W/stores/chats*` (implementation), `W/utils/testing/fixtures.ts`.
- **Read-only highlights.** UI.md 7.1, 7.5, 7.6, 7.16, 10.4, 11.1, 13.7, 14; `.tmp/p6-designs/stabilization.md` S5, S7,
  S8; the C12 stubs `ImageGallery`, `GeneratingImages`, `ReadAloudButton` (W6.8's), `useImageOptions` (W6.9's);
  `W/composables/useComposerAttachments.ts` and `W/components/chat/composer/**` (W6.9's; import, never edit).
- **Tasks.**
  1. **W6.7-T1 Other tabs (S5)** — strip `activeLeafId` before setting `summary` (and in the chats store rows); when the
     session is idle (loaded, persisted, not busy, no switch pending or in flight, not resuming) and the pure exported
     `leafMovedElsewhere(messages, leaf, unstoredId)` is true → a coalesced `followActiveLeaf()` (GET +
     `applyDetail(detail, { keepPrefix: true })`). *Accept:* follows a moved leaf; no GET for the same leaf, while busy,
     or for the session's own switch; an unstored trailing message is ignored.
  2. **W6.7-T2 Delete a version (S7)** — `session.deleteVersion(messageId)` behaves like `switchBranch` (`switching`,
     `keepPrefix`, 409 `run-active` → follow the run, 404 → `refresh()`); `MessageActions` prop `canDeleteVersion` + event
     `delete-version` (`Trash2Icon` "Delete this version", only with versions and nothing running, 40 px on touch);
     `ChatTranscript` forwards `delete-version: [messageId]`; `ChatView` owns one `ConfirmDialog` (UI.md 7.5), the live
     region "Version deleted", focus back on the switcher, the toast "Could not delete the version". *Accept:* session
     and component tests.
  3. **W6.7-T3 Attachments on edit (S8)** — `edit(messageId, text, files?)` (omitted = keep, `[]` = remove all);
     `ChatMessage` emits `edit: [text, files]`; `MessageEditor` props `{ text, files }`: existing attachments as removable
     `FileChip`s (`message-edit-attachment`), new ones through a private `useComposerAttachments()` (paperclip
     `message-edit-attach` → a hidden input with `COMPOSER_ACCEPT`, or paste); Save waits for `settled()`, is disabled
     while an upload runs or failed, and is allowed with files and no text; Cancel disposes the instance (aborts
     uploads); rejection toasts from the new `W/components/chat/attachment-toasts.ts`; nothing under `composer/**` is
     edited. *Accept:* editor tests (remove, add, save payload, gating, cancel aborts) and session tests (files replace,
     keep, empty).
  4. **W6.7-T4 Media parts** — `chat-format.ts`: consecutive `image/*` file parts of an assistant message → one block
     `{ kind: 'gallery', parts }`; `ChatMessage` mounts `ImageGallery` for it, `GeneratingImages` while `metadata.image`
     is set and the message has no file part yet, and `ReadAloudButton` after Copy on finished assistant replies with
     text; Copy is hidden when a reply has no text; the meta hover adds "2 images · 16:9 · edited 1 image" and marks the
     cost "estimated" for image turns. *Accept:* `chat-format` tests; `ChatMessage` renders the gallery and the
     placeholders.
  5. **W6.7-T5 Request and composer** — `prepareSendMessagesRequest` adds `imageOptions:
     useImageOptions().forModel(model)` (only for image-capable models); `ChatView` passes `:previous-images` (the images
     of the last assistant message on the path) to `ChatComposer`. *Accept:* body tests (an image model sends `n` /
     `aspectRatio` / `editPrevious`; an image-output chat model the aspect ratio only; other models nothing).
- **Tests.** `useChatSession` (S5, S7, S8, `imageOptions`), `MessageEditor`, `MessageActions`, `ChatMessage`,
  `ChatTranscript`, `ChatView`, `chat-format`.
- **Verify.** Web commands.

### W6.8 media-parts-web

- **Mission.** The image gallery and lightbox, the generating placeholders, the `generate_image` tool row, the
  read-aloud player and its text rules, the gallery on the share page and the share option label.
- **Owned.** `W/components/chat/parts/**`, `W/components/chat/ReadAloudButton*`, `W/composables/useSpeechPlayer*`,
  `W/utils/speech-text*`, `W/components/share/{SharedMessage,SharedChatView,share-view,share-links,ShareOptionSwitches,
  ShareToolRow}*`.
- **Read-only highlights.** UI.md 7.2, 7.15, 7.16, 7.18, 10.4, 11, 13.7, 14; `.tmp/p6-designs/images.md` section 5,
  `voice.md` sections 1 (read aloud), 4; `W/utils/testing/fake-media.ts` (`FakeAudio`).
- **Tasks.**
  1. **W6.8-T1 `ImageGallery`** (UI.md 7.16) — one image full width, two or more in two columns; each tile opens a
     lightbox (the `FilePart` dialog pattern) with previous / next and a same-origin Download link; URLs through
     `safeAssetUrl`. *Accept:* component tests (layout by count, lightbox keys, download name).
  2. **W6.8-T2 `GeneratingImages`** — `n` placeholder tiles at the aspect ratio (Auto = square), "Generating image… 12s"
     counted from `startedAt`; static under reduced motion. *Accept:* tile count and aspect, the counter.
  3. **W6.8-T3 `generate_image` tool row** — the standard tool row (7.2) with the prompt as first argument; the output
     block keeps the JSON; the images themselves are the file parts appended below. *Accept:* ToolPart test.
  4. **W6.8-T4 Read aloud** — `utils/speech-text.ts` (text rules and sentence chunks, UI.md 7.18), `useSpeechPlayer`
     (one app-wide player: one reused `HTMLAudioElement` unlocked inside the click, object URLs revoked, one
     `AbortController` per chunk, `playbackRate` = `speechSpeed`, the next chunk prefetched; stops on another reply, a
     chat switch, page hide, recording start and Esc outside inputs) and `ReadAloudButton` (hidden without
     `speechModelRef`; `data-state`; "Read aloud" / "Stop reading"). *Accept:* speech-text table tests (fences, mermaid,
     tables, formulas, links, bare URLs, images, chunk sizes); player tests with `FakeAudio` (Stop, natural end, a second
     reply stops the first, abort on stop).
  5. **W6.8-T5 Share page** — `SharedMessage` renders consecutive image file parts with `ImageGallery`; the share option
     label "Attachments" becomes "Files and images" (web text only, in `share-links.ts`; `ShareDialog` tests select
     options by test id). *Accept:* share-view tests.
- **Tests.** The five tasks above.
- **Verify.** Web commands.

### W6.9 composer-web

- **Mission.** Dictation in the composer, the image options menu, the "Image models" picker group, the `imageOutput`
  badge and the models store rules.
- **Owned.** `W/components/chat/composer/**`, `W/composables/{useVoiceInput,useImageOptions}*`,
  `W/components/providers/ModelCaps*`, `W/stores/models*` (implementation).
- **Read-only highlights.** UI.md 7.7, 7.9, 7.17, 10.4, 11, 12, 13.7, 14; `.tmp/p6-designs/voice.md` sections 1, 4,
  `images.md` sections 1a, 5; `W/composables/useShortcuts.ts` (same-key precedence: the last registration whose `when`
  passes wins); `W/utils/testing/fake-media.ts`.
- **Tasks.**
  1. **W6.9-T1 `useVoiceInput`** (UI.md 11.3) — the state machine `idle | requesting | recording | transcribing` with an
     injectable `env`; recorder types `audio/webm;codecs=opus` → `audio/webm` → `audio/ogg;codecs=opus` → `audio/mp4` →
     the default (`pickRecorderMimeType`), 32 kbps; auto-stop at `LIMITS.transcriptionMaxSeconds`; clips under 0.5 s
     discarded; tracks always stopped in a `finally`; an ended track (a mobile interruption) stops and transcribes.
     *Accept:* state tests with `installFakeMedia` (deny, no MediaRecorder, insecure, cancel during transcription,
     auto-stop).
  2. **W6.9-T2 Mic and recording** (UI.md 7.17) — `MicButton` before `SendStopButton` (click or Alt+V registered through
     `useShortcuts()`, respecting `altShortcuts`); `RecordingIndicator` replaces the left tools while recording;
     "Transcribing…" (a click cancels); `insertDictation` at the saved caret with spacing; Esc cancels first; recording
     start stops read-aloud; Send disabled while voice input runs; the setup popover without a model; disabled on an
     insecure origin; hidden without MediaRecorder; the polite live region texts. *Accept:* `ChatComposer` tests for
     every state; `dictation.ts` tests (`insertDictation`, `pickRecorderMimeType`).
  3. **W6.9-T3 Image options** — `useImageOptions` (`localStorage['hf-image-options']`, validated with
     `imageOptionsSchema`); `ImageOptionsMenu` (aspect ratio Auto + 7 ratios, Images 1–4 and "Edit the previous image"
     for image models; aspect ratio only for image-output chat models); for image models the placeholder "Describe an
     image…" and no `ContextRing`; the new `ChatComposer` prop `previousImages`. *Accept:* `forModel` tests; menu tests
     per model kind; the placeholder.
  4. **W6.9-T4 Picker and store** — the "Image models" group after the provider groups (`model-picker-group`
     `data-value="images"`, search matches it); `ModelCaps` shows `ImageIcon` "Image output" for `imageOutput`;
     `groupedByProvider` lists chat models only; `defaultRef` prefers chat models (never an image model). *Accept:*
     model-picker and store tests.
- **Tests.** The four tasks above.
- **Verify.** Web commands.

### W6.10 media-settings-web

- **Mission.** Settings → Media and the Settings → Models changes.
- **Owned.** `W/pages/settings/{media,models}.vue`, `W/components/settings/{media,images,voice}/**`,
  `W/components/settings/{SettingsModelSelect,ModelsTable,CustomModel,custom-model,models,Models,ProviderModelsSection,
  GeneralSettings}*`.
- **Read-only highlights.** UI.md 2.10, 9.3, 9.9, 10.4, 11, 13.7, 15; the C12 stubs; `useSpeechPlayer` (W6.8's; import
  it for Test voice). A Nuxt composable goes through a local `nuxt-imports.ts` inside the owned folders (the settings
  one is not owned).
- **Tasks.**
  1. **W6.10-T1 Media page** — `MediaSettings` (`PageHeader` "Images and voice", then `ImageSettings` and
     `VoiceSettings`). *Accept:* page mount test.
  2. **W6.10-T2 Images** — "Image model" (`SettingsModelSelect kind="image"`, `allowNone` "None (the generate_image tool
     is off)") → `imageModelRef`. *Accept:* select and save tests.
  3. **W6.10-T3 Voice** — "Speech to text" (Off), "Language" (Detect automatically + languages), "Read aloud" (Off;
     changing it clears `speechVoice`), "Voice" (suggestions from `voices`, placeholder "Provider default"), "Speed"
     (0.75× – 2×), "Test voice", the privacy notice, the insecure-origin note (UI.md 9.9). *Accept:* tests for every
     control, the voice reset and Test voice through a mocked player.
  4. **W6.10-T4 Models page** — `SettingsModelSelect` gains `kind` (default `chat`); the default and title selects list
     chat models only; `CustomModelDialog` gets a "Kind" select (Chat, Image, Speech to text, Text to speech) sent as
     `kind`. *Accept:* `SettingsModelSelect` lists per kind; custom model kinds round-trip.
- **Tests.** The four tasks above.
- **Verify.** Web commands.

### W6.11 app-web

- **Mission.** One fresh-auth composable for every password prompt (S4) and 40 px icon-rail targets on touch tablets
  (S9).
- **Owned.** `W/composables/useFreshAuth*`, `W/components/plugins/**`, `W/components/settings/data/**`,
  `W/components/share/{ShareDialog,fresh-auth}*`, `W/components/app-shell/{AppBrand,ThemeToggle,AppSidebar}*`,
  `W/components/ui/sidebar/**` (opened for S9), `apps/web/AI_ELEMENTS_PATCHES.md`.
- **Read-only highlights.** UI.md 8.4, 11, 14.5, 14.7; `.tmp/p6-designs/stabilization.md` S4, S9;
  `W/components/common/ConfirmPasswordDialog.vue` (reused unchanged), `W/stores/auth.ts`.
- **Tasks.**
  1. **W6.11-T1 `useFreshAuth`** (UI.md 8.4, 11.3) — `FreshAuthCancelledError`, `isFreshAuthCancelled`,
     `isFreshAuthRequired` (403 `forbidden` + `action: 'login'`), `loginErrorText(e, now?)` (401 "Wrong password", 429 a
     countdown, else the server message), `useFreshAuth(): { open, pending, error, needed, submit, setOpen, run(task,
     { required? }), login(password), confirm, cancel }`: with `required` and a session that is not fresh the prompt comes
     first, otherwise the request runs and a 403 opens the prompt; after a prompt the task runs exactly once more (a
     second 403 is thrown); concurrent runs share one prompt; closing rejects every waiter with the (never shown) cancel
     error; `onScopeDispose` → `cancel()`; a 403 from login shows the server message. *Accept:* `useFreshAuth.test.ts`
     (prompt first, retry once, second 403 thrown, shared prompt, cancel, dispose, the three login texts, `login()`).
  2. **W6.11-T2 Call sites** — delete `plugins/code/fresh-auth.ts`, `plugins/detail/fresh-auth.ts` and
     `share/fresh-auth.ts` with their tests; `CodePluginForm` (scaffold), `ShareDialog`, `DataDangerZone`:
     `required: true` (`DataDangerZone` keeps its `@close-auto-focus`); `PluginSourceTab`: `attach(t => run(t, {
     required: isCode }))`; `PluginHeader` reload: `required: kind === 'code'`; `InstallDialog` and `TrustDialog`: the
     inline `trust-password` field calls `login()`, then `run(send, { required })`, the error alert's "Log in" calls
     `confirm()`; `McpServerDialog`: `required: requiresFreshAuth(request)` (drop `askPassword`, `pendingRequest` and the
     `auth` phase); `ProviderWizard`: `run(send)` (fixes the unbounded re-prompt and the missing rate-limit text); remove
     the duplicate helpers in `data.ts`, `install.ts` (`isFreshAuthError`, `passwordErrorText`) and `mcp-form.ts`
     (`needsLogin`, `loginFailureMessage`). *Accept:* the 8 call-site tests updated and green; the plugin, data and share
     e2e specs stay green at the gate.
  3. **W6.11-T3 Tablet rail (S9)** — `ui/sidebar/index.ts` (the menu button variants) +=
     `pointer-coarse:group-data-[collapsible=icon]:size-10! pointer-coarse:group-data-[collapsible=icon]:p-3!`;
     `SidebarProvider.vue`: the icon width moves from the inline style to classes `[--sidebar-width-icon:3rem]
     pointer-coarse:[--sidebar-width-icon:3.5rem]`; `AppBrand.vue` and `ThemeToggle.vue` += `pointer-coarse:size-10`;
     both `ui/sidebar` patches recorded in `apps/web/AI_ELEMENTS_PATCHES.md`. *Accept:* unit tests on the classes; the
     `tablet` spec of W6.12.
- **Tests.** The three tasks above.
- **Verify.** Web commands.

### Wave P6-A ownership

These globs are the plan's table verbatim (brace globs are supported by `scripts/audit-ownership.mjs`). The audit cannot
express "except": `S/chat/types.ts`, `S/providers/types.ts` and `S/services/{images,files,audio,chats}/types.ts` stay
frozen despite the globs, and `S/db/schema.ts` / `apps/server/drizzle/**` belong to nobody in this wave.

```json
{
  "wave": "P6-A",
  "agents": {
    "W6.1": [
      "apps/server/src/chat/**",
      "apps/server/src/http/routes/chat{,.test}.ts"
    ],
    "W6.2": [
      "apps/server/src/providers/**",
      "apps/server/src/catalog/**",
      "apps/server/src/registry/validate*"
    ],
    "W6.3": ["apps/server/src/builtin-plugins/core-providers/**"],
    "W6.4": [
      "apps/server/src/services/images/**",
      "apps/server/src/services/files/**",
      "apps/server/src/plugins/{context,host}*",
      "apps/server/src/builtin-plugins/core-tools/**"
    ],
    "W6.5": [
      "apps/server/src/services/audio/**",
      "apps/server/src/http/routes/audio{,.test}.ts"
    ],
    "W6.6": [
      "apps/server/src/services/chats/**",
      "apps/server/src/http/routes/chats{,.test}.ts",
      "apps/server/src/testing/fake-chats*"
    ],
    "W6.7": [
      "apps/web/app/composables/{useChatSession,useServerEvents}*",
      "apps/web/app/components/chat/{ChatMessage,MessageActions,MessageEditor,MessageMeta,ChatTranscript,ChatView,BranchSwitcher,UserMessageBubble,chat-format,chat-context,attachment-toasts,nuxt-imports}*",
      "apps/web/app/stores/chats*",
      "apps/web/app/utils/testing/fixtures.ts"
    ],
    "W6.8": [
      "apps/web/app/components/chat/parts/**",
      "apps/web/app/components/chat/ReadAloudButton*",
      "apps/web/app/composables/useSpeechPlayer*",
      "apps/web/app/utils/speech-text*",
      "apps/web/app/components/share/{SharedMessage,SharedChatView,share-view,share-links,ShareOptionSwitches,ShareToolRow}*"
    ],
    "W6.9": [
      "apps/web/app/components/chat/composer/**",
      "apps/web/app/composables/{useVoiceInput,useImageOptions}*",
      "apps/web/app/components/providers/ModelCaps*",
      "apps/web/app/stores/models*"
    ],
    "W6.10": [
      "apps/web/app/pages/settings/{media,models}.vue",
      "apps/web/app/components/settings/{media,images,voice}/**",
      "apps/web/app/components/settings/{SettingsModelSelect,ModelsTable,CustomModel,custom-model,models,Models,ProviderModelsSection,GeneralSettings}*"
    ],
    "W6.11": [
      "apps/web/app/composables/useFreshAuth*",
      "apps/web/app/components/plugins/**",
      "apps/web/app/components/settings/data/**",
      "apps/web/app/components/share/{ShareDialog,fresh-auth}*",
      "apps/web/app/components/app-shell/{AppBrand,ThemeToggle,AppSidebar}*",
      "apps/web/app/components/ui/sidebar/**",
      "apps/web/AI_ELEMENTS_PATCHES.md"
    ]
  },
  "allow": [
    "docs/ROADMAP.md",
    "docs/DECISIONS.md",
    "AGENT.md",
    "pnpm-lock.yaml"
  ]
}
```

### Wave P6-A cross-agent contracts

The props below are frozen in the P6-0b stubs or documented in UI.md 10.4; the server members in the frozen `types.ts`.

| Producer → consumer | Contract |
|---|---|
| C11 → W6.1, W6.4, W6.5 | `ImageService`, `AudioService`, the three resolvers and `ResolvedModelBase` (implemented by W6.2 / W6.4 / W6.5; fakes meanwhile) |
| W6.2 → W6.1, W6.4, W6.5 | resolver errors (`validation_error` for a wrong kind, `model_not_found` without `createImageModel`, `plugin_error` for a throwing factory); `CatalogModel.kind`, `capabilities.imageOutput`, `voices` |
| W6.3 → W6.1, W6.4 | `imageParams({ n, aspectRatio?, inputs }, model)` → `{ size?, aspectRatio?, providerOptions? }` (PROVIDERS.md 13) |
| W6.3 → W6.5 | `transcriptionOptions({ language })` → provider options |
| W6.4 → W6.1 | `files.saveGenerated`; the `generate_image` output of `core-tools` parses with `generateImageToolOutputSchema` (C10's) |
| W6.1 → W6.7, W6.8 | `metadata.image` (`n`, `aspectRatio?`, `inputs?`, `revisedPrompt?`) in the start and finish metadata; generated images as `file` parts with `/api/files/<id>` URLs and a `filename` once saved |
| W6.5 → W6.9, W6.8 | `POST /api/audio/transcriptions` (multipart `file`) → `AudioTranscription`; `POST /api/audio/speech` `{ text }` → audio bytes (API.md `audio.ts`) |
| W6.6 → W6.7 | `DELETE /api/chats/:id/messages/:messageId` → `ChatDetail`; 409 `only-version` / `run-active`; `chat.updated.activeLeafId` (C10's schema) |
| W6.8 → W6.7 | `ImageGallery { images, messageId }`, `GeneratingImages { n, aspectRatio?, startedAt }`, `ReadAloudButton { messageId, markdown }` |
| W6.9 → W6.7 | `useImageOptions(): { options, set, forModel(model) }` |
| W6.7 → W6.9 | `ChatComposer` prop `previousImages: number` (until W6.9's prop lands, the `:previous-images` binding is a fallthrough attribute; list any typecheck note in the report) |
| W6.8 → W6.10 | `useSpeechPlayer().toggle('voice-test', text, { modelRef, voice })` for Test voice |
| W6.11 only | `useFreshAuth` (every call site is W6.11's) |
| W6.10 only | `SettingsModelSelect kind` |
| W6.8 / W6.11 | the share option label lives only in `share-links.ts` (W6.8); `ShareDialog` tests (W6.11) select options by test id, never by label |

### Gate P6-A

1. `node scripts/audit-ownership.mjs .tmp/waves/P6-A.json`
2. **K5**: batch the CCRs → `nuxi prepare` → `pnpm check` → `pnpm build` → the CSP test with
   `HF_TEST_REQUIRE_WEB_BUILD=1`.
3. Probes on `pnpm start:e2e` (`b=http://127.0.0.1:8899/api`, log redirected to `.tmp/gates/P6-A/server.log`) and on
   probe servers (`HF_PORT=8897` / `8898`, `HF_DATA_DIR=.tmp/gates/P6-A/<name>`); loops run through `bash -c` (zsh does
   not word-split):
   - **Image turn** — `POST $b/chat` with `modelRef: 'mock:image'`, `imageOptions: { n: 2, aspectRatio: '16:9' }` and a
     user text "a red fox" → the stream carries 2 `file` chunks whose URLs start with `/api/files/`;
     `GET $b/chats/<id>` → 2 file parts with a `filename`; `sqlite3 .tmp/e2e/harness.db "SELECT count(*) FROM messages
     WHERE parts LIKE '%data:image%'"` → 0; `curl -sI http://127.0.0.1:8899/api/files/<fileId>` → `image/png`; the same
     request with `modelRef: 'mock:echo'` → 400 on `imageOptions`.
   - **Image-output chat** — `mock:image-chat` → text + one stored file part. **Tool** — `PUT $b/settings
     {"imageModelRef":"mock:image"}`, then `mock:image-tool` with `toolMode: 'auto'` → the tool output + one appended
     file part; reset `imageModelRef` to `null`.
   - **Transcription** — a WebM file (`printf '\x1a\x45\xdf\xa3\x9f\x42\x86\x81\x01\x42\xf7\x81\x01\x42\xf2\x81\x04\x42\xf3\x81\x08\x42\x82\x84webm\x42\x87\x81\x04\x42\x85\x81\x02' >
     .tmp/gates/P6-A/a.webm; head -c 256 /dev/urandom >> .tmp/gates/P6-A/a.webm`), then `curl -s -F
     'file=@.tmp/gates/P6-A/a.webm;type=audio/webm' -F modelRef=mock:transcribe $b/audio/transcriptions` →
     `{"text":"This is a mock transcription.",…}`; a PNG sent as `type=audio/webm` → 400; a 26 MB file → 413.
   - **Speech** — `curl -s -D - -o .tmp/gates/P6-A/s.wav $b/audio/speech -H 'Content-Type: application/json' -d
     '{"text":"Hello world","modelRef":"mock:speech"}'` → `Content-Type: audio/wav`, `Cache-Control: no-store`, the file
     starts with `RIFF`; 4097 characters → 400.
   - **Headers** — `curl -sI http://127.0.0.1:8899/` → `Permissions-Policy: camera=(), microphone=(self),
     geolocation=()` and a CSP with `media-src 'self' blob:`.
   - **Versions** — with `mock:echo`: send A, then B; regenerate B's reply (2 versions) and switch back to the first
     reply of B (remembered ≠ latest); edit A (A2); `POST $b/chats/<id>/branch {"messageId":"<A>"}` → the path ends at
     B's *first* reply (remembered), not the newest one; `DELETE $b/chats/<id>/messages/<A2>` → 200 with one version fewer;
     deleting the last version of a message → 409 `only-version`; the same delete during a long `mock:echo` reply → 409
     `run-active`; `curl -sN $b/events` shows `chat.updated` with `activeLeafId` on a switch.
   - **Logs** — `grep -c -e 'a red fox' -e 'Hello world' -e 'This is a mock transcription' .tmp/gates/P6-A/server.log`
     → 0 (no prompt, transcript or speech text at `info`).
4. `pnpm test:e2e` (projects `chromium` + `mobile`; `tablet` has no spec until P6-B) green.
5. `E2E_SCREENSHOTS=1 pnpm test:e2e --grep @screenshots` → review `.tmp/screenshots/{dark,light}/`.
6. `pnpm audit --prod --audit-level high` clean.
7. ROADMAP + wave log → commit (as made: `3e115cb` `feat: add image generation, voice and version improvements`).

---

## Wave P6-B — feature e2e, docs, live media checks, fix-ups

### Coordinator actions

- Before the launch: the P6-A checkpoint build for W6.12; W6.15 / W6.16 globs from the red P6-A gate items added to
  `.tmp/waves/P6-B.json` (launched only when needed); the P6-A reports handed to W6.13 as the digest
  `.tmp/waves/P6-A-notes.md` (contract facts, deviations, items marked "For W6.13").
- **K6**: the final gate below; ROADMAP (every Phase 6 box, backlog, wave log); the memory file; push only when the
  user asks.

### W6.12 e2e-features (e2e 8891)

- **Mission.** End-to-end specs for images, voice, versions, attachment editing and tablet touch targets, and
  screenshots of the new screens.
- **Owned.** `e2e/**`.
- **Read-only highlights.** UI.md 7.5, 7.7, 7.16 – 7.18, 9.9, 13.7, 14.6, 14.7; PROVIDERS.md 8 (mock media models);
  `playwright.config.ts` (microphone permission, fake media flags, the `tablet` project); `e2e/README.md`.
- **Tasks.**
  1. **W6.12-T1 `core/images.spec.ts`** — an image turn with `mock:image` (a "slow" prompt): placeholders
     (`image-generating`, `data-count`) then the gallery (`image-gallery`, 2 `image-tile`s); options n / aspect ratio
     through `image-options-trigger`; regenerate → "‹ 2/2 ›"; the lightbox (`image-lightbox`) with previous / next and the
     Download link (`image-download`, same origin); `mock:image-chat` → text + gallery; `generate_image` with
     `mock:image-tool` (Settings → Media → Image model set through the API) → the approval card, Allow → the image below
     the tool row.
  2. **W6.12-T2 `core/voice.spec.ts`** — `transcriptionModelRef: 'mock:transcribe'` set through the API; type "Hello ",
     record until the timer shows 0:01, stop → the request is multipart with `audio/webm` and the composer reads "Hello
     This is a mock transcription."; Esc cancels and sends no request; without a model the setup popover leads to
     `/settings/media`; read aloud with `mock:speech` on a `mock:echo` reply: the JSON body text, `data-state=playing`,
     Stop → `idle`, the natural end → `idle`, a second reply stops the first; the Media settings pickers and Test voice.
     If the fake-media flags fail in CI, mock `getUserMedia` / `MediaRecorder` with `page.addInitScript`.
  3. **W6.12-T3 `core/versions.spec.ts`** — delete a version (confirm dialog, "Version deleted", one version fewer); a
     remembered deep path (switch away and back restores it); two tabs: a switch in one moves the other.
  4. **W6.12-T4 `core/edit-attachments.spec.ts`** — edit a message, remove one attachment and add another; the new
     version carries the new set; Save is disabled while an upload runs.
  5. **W6.12-T5 `tablet/touch-targets.spec.ts`** — project `tablet`: collapse the sidebar; the rail is 56 px wide and
     every icon button is at least 40×40.
  6. **W6.12-T6 Mobile and screenshots** — mobile: a 40 px mic, the gallery at 390 px, no horizontal scroll while
     recording; the Media page, a gallery, the generating placeholders, the recording composer and the delete-version
     dialog join the `@screenshots` spec (dark + light).
  7. **W6.12-T7 README** — `e2e/README.md` lists the new specs, the `tablet` project and the media flags.
- **Verify.** `pnpm test:e2e --list`; slot runs (`HF_MOCK_PROVIDER=1 HF_OFFLINE=1 HF_PORT=8891
  HF_DATA_DIR=.tmp/W6.12/data node apps/server/dist/main.mjs`, `E2E_BASE_URL=http://127.0.0.1:8891 pnpm test:e2e`);
  three green runs of the new specs.

### W6.13 docs-final

- **Mission.** Reconcile every doc with the code and the agent reports.
- **Owned.** `README.md`, `.env.example`, `docs/**` except `DECISIONS.md` and `ROADMAP.md`.
- **Read-only highlights.** `.tmp/waves/P6-A-notes.md`, the code of every Phase 6 area.
- **Tasks.**
  1. **W6.13-T1 Reconcile** — API.md vs the route table and the implemented behavior (the audio errors and limits, the
     `imageOptions` 400 rules, the delete-version answers); UI.md 13.7 vs `utils/testids.ts`, the component contracts
     (10.4), the composables (11), the copy (15); ARCHITECTURE.md vs the implemented flows (the stream restructure,
     generated files, carry-forward, remembered versions, the sniff table, the log fields); PROVIDERS.md 13 vs
     `core-providers` (seeds, voices, listing filters) and 8 vs the mock models; PLUGINS.md 9 vs the SDK 1.1.0 names.
  2. **W6.13-T2 PROVIDERS.md 11** — live media results when the suite ran; otherwise it stays "Unverified" and says how
     to record results.
  3. **W6.13-T3 Status** — README "v1.2" (features: images, voice, versions; the HTTPS note for the microphone);
     refresh `docs/assets/screenshots/` only when a README image changed visibly (copied from `.tmp/screenshots/`).
  4. **W6.13-T4 This file** — describes what actually happened (status, deviations, gate results per wave).
- **Verify.** `pnpm check:english`; `pnpm -F @harness-forge/shared test` (doc-coupled tests).

### W6.14 live-media (k4)

- **Mission.** Opt-in live checks of image and voice models.
- **Owned.** `S/live/**`.
- **Read-only highlights.** PROVIDERS.md 12, 13; `apps/server/vitest.live.config.ts`; `S/live/{matrix,checks,summary}.ts`
  and `support.test.ts`.
- **Tasks.**
  1. **W6.14-T1 Media checks** — behind `HF_LIVE_MEDIA=1` (plus `HF_LIVE=1` and the keys; never without both): one small
     image per provider with an image model and a key (the cheapest seed; OpenAI at `1024x1024`), one short speech per
     provider with a speech model and a key, and that speech transcribed back by every transcription model with a key
     (the transcript contains the spoken words, case-insensitive). Each check starts its own in-process server like the
     chat checks (PROVIDERS.md 12).
  2. **W6.14-T2 Budget** — every media check counts against `HF_LIVE_MAX_COST_USD`; a check whose cost is unknown counts
     at a fixed estimate (for example $0.05 per image, $0.01 per speech or transcription call) marked `~`; 429 → SKIP.
  3. **W6.14-T3 Summary and matrix** — media columns (Image, Speech, Transcription) in the summary table; the media
     matrix and its caps unit-tested in `support.test.ts` (part of `pnpm test`, no paid call).
- **Verify.** Server commands (the live files must stay skipped by `pnpm test`); **never** `pnpm test:live`.

### W6.15 / W6.16 fix-ups

Launched only for red P6-A gate items (W6.15 server, W6.16 web), with the globs of those items. Not launched: the
P6-A gate was green; the one UI detail found after it (Favorite and Visible for chat and image models only) was fixed
by the coordinator in `6e96d85`.

### Wave P6-B ownership

```json
{
  "wave": "P6-B",
  "agents": {
    "W6.12": ["e2e/**"],
    "W6.13": [
      "README.md",
      ".env.example",
      "docs/API.md",
      "docs/ARCHITECTURE.md",
      "docs/PLUGINS.md",
      "docs/PROVIDERS.md",
      "docs/UI.md",
      "docs/phases/**",
      "docs/guides/**",
      "docs/assets/**"
    ],
    "W6.14": ["apps/server/src/live/**"]
  },
  "allow": [
    "docs/ROADMAP.md",
    "docs/DECISIONS.md",
    "AGENT.md"
  ]
}
```

### Final gate (K6)

1. `node scripts/audit-ownership.mjs .tmp/waves/P6-B.json` → `pnpm install --frozen-lockfile` → `pnpm check` →
   `pnpm build` → the CSP test with `HF_TEST_REQUIRE_WEB_BUILD=1`.
2. The P6-A probes again.
3. `for i in 1 2 3; do pnpm test:e2e || exit 1; done` (`chromium` + `mobile` + `tablet`), with the OS color scheme
   emulated as light.
4. `E2E_SCREENSHOTS=1 pnpm test:e2e --grep @screenshots` → dark + light reviewed.
5. `pnpm audit --prod --audit-level high`.
6. **Real v1.1 → v1.2 upgrade**: build `30da884` in a worktree (`git worktree add .tmp/v11 30da884`, then install and
   build there), run it on a fresh data directory, seed branched chats, stop it, start v1.2 on the same data directory →
   paths intact, remembered versions work (switch away and back), the image and voice routes answer (`mock:image`,
   `mock:transcribe`, `mock:speech`).
7. Optional, ask first: `pnpm test:live` (+ `HF_LIVE_MEDIA=1`) with the user's keys → PROVIDERS.md 11.
8. ROADMAP + wave log → commit `chore: final gate for harness-forge v1.2`; write the project memory (state, commits,
   user actions); push only when the user asks.

---

## Outcome

What actually happened, wave by wave (the gate results are copied from the ROADMAP wave log; "audit" is the ownership
audit of `scripts/audit-ownership.mjs`).

| Wave | Agents | Gate result | Commit |
|---|---|---|---|
| P6-00 | coordinator (hotfix) | `pnpm check` 4212 tests; `main.test.ts` 3× green (the new SIGTERM-during-boot test fails on the old `main.ts`); `actionlint` 1.7.12 exit 0 | `a5fd107` |
| P6-0a | coordinator (K1), C10, D6 | audit ok (67 paths; 7 compile-fix files accepted); 4256 tests; build ok; CSP 38/38; 3 new routes mounted (501); e2e 44 passed; CI on `a5fd107` green; Dependabot now opens separate katex / ai-sdk / minor pull requests (#2 – #4, green) | `11516c7` |
| P6-0b | coordinator (K3, K4), C11, C12 | audit ok (75 paths; 4 test / fake files accepted); 4374 tests; build ok; CSP 38/38 incl. `media-src 'self' blob:`; `Permissions-Policy: microphone=(self)`; e2e 44 passed (the fake-media Playwright config, an empty `tablet` project); upgrade probe on a seeded v1.1 copy: `0002` applied, remembered pointers only on the active path (A → RA → B → RB), 0 invalid, `GET /chats/:id` unchanged, 24 chats; FREEZE | `163f5e8` |
| P6-A | W6.1 – W6.11 (+ coordinator K5: 3 stale skeleton tests, 2 frozen doc comments, the plugins-list e2e with 3 core tools, builtin `engines ^1.1.0`, migration `0003`) | audit ok (199 paths, no frozen file touched); 5060 tests; build ok; CSP 38/38; probes 21/21 (image turn with 2 stored files + metadata, image-output chat, `generate_image` tool, no `data:` URL saved, transcription + 400 / 413, speech WAV `no-store` + 400, headers, remembered path, delete version 200 / `only-version` / `run-active`, `chat.updated.activeLeafId`, no transcript in the logs); e2e 44 passed; screenshots reviewed (versions trash icon, mic, Image models group, Media nav); `pnpm audit --prod` clean | `3e115cb`, post-gate fix `6e96d85` |
| P6-B | W6.12, W6.13, W6.14 (W6.15 / W6.16 not needed: the P6-A gate was green) | e2e 61 run tests (chromium 53, mobile 7, tablet 1) + 4 screenshot tests; new specs 17/17 ×3; docs reconciled; live media checks 52 unit tests (never run live); the three agents were interrupted once by an account usage limit and resumed from their transcripts | final gate commit |
| Final gate | coordinator (K6) | audit ok (39 paths; only the approved plugin-sdk doc comment among frozen files); frozen install ok; 5091 tests; build ok; CSP 38/38; probes 21/21; e2e 61 passed ×3 (chromium + mobile + tablet); screenshots incl. the 5 new screens reviewed (dark + light); `pnpm audit --prod` clean; real v1.1 → v1.2 upgrade (v1.1 built from `30da884` in a worktree, data seeded by it, then v1.2 on the same data dir): 9/9 (4 migrations, remembered pointers only on the active path, paths intact, remembered switch, old chat continues, cached listing refreshed after `0003`, image and transcription routes) | `chore: final gate for harness-forge v1.2` |

### P6-0a and P6-0b

- **C10** — `pnpm check` 261 files / 4256 tests (shared 154, plugin-sdk 22, server 3075, web 982); 76 routes. Seven
  compile or test fixes outside its list were accepted at the audit: `S/plugins/host.test.ts` (the version string),
  `S/providers/testing.ts` (the fake host's `ctx.images` answered `not_implemented`), `W/stores/chats.test.ts` and
  `W/components/app-shell/ChatNav.test.ts` (`activeLeafId: null`), `W/components/chat/parts/NoticePart.vue` (the
  exhaustive notice icon map: `generated-file-dropped` → `ImageOffIcon`) and
  `examples/plugins/{dice-roller,echo-provider}/harness-forge.d.ts` (regenerated from the template types). Beyond the
  planned names the SDK re-exports `ImageAspectRatio` and `ModelKind`, and shared exports `generatedImageRefSchema`
  and `generatedImageMimeTypeSchema` (it checks only the URL prefix; the pipeline checks that the URL matches
  `fileId`). API.md already described the P6-A behavior (remembered paths, totals with image usage, the stream
  restructure).
- **D6** — this file, UI.md, ARCHITECTURE.md, PROVIDERS.md, PLUGINS.md, the code-plugin guide, README and
  `.env.example`.
- **C11** — server 144 files / 3135 tests. Out-of-list files accepted: `S/services/secrets/testing.ts` (the fake
  `ProviderService` gets the three resolver stubs), `S/http/routes/models.test.ts` and `S/providers/index.test.ts` (the
  mock listing shows 6 visible models instead of 4). Type names as built: `ResolvedModelBase` (includes `info`),
  `ResolvedImageModel.imageModel`, `ResolvedTranscriptionModel`, `ResolvedSpeechModel`; `ImageGenerationInput` /
  `ImageGenerationResult` / `StoredImage`; `GeneratedFileInput` (`saveGenerated`); `AudioTranscribeInput`
  (`file: Blob`), `SpeechAudio` (a strict `mediaType`); the constants `AUDIO_UPLOAD_TYPES` and
  `SPEECH_AUDIO_MIME_TYPES`. The mock media models work in full (PROVIDERS.md 8). The frozen `services/chats/types.ts`
  comment now says that `chat.updated` carries `ChatUpdatedData`.
- **C12** — 31 test ids (UI.md 13.7), the Media nav link (`ImagePlayIcon`) after Models, the `/settings/media` page
  (the page frame renders the "Images and voice" header; `MediaSettings` is the body), 9 stub components, 3
  composables and `W/utils/testing/fake-media.ts`; the command palette test needed the `go-settings-media` command
  (fixed by the coordinator). `useImageOptions` already worked in full; `useVoiceInput().supported` means
  `MediaRecorder` exists (browsers hide `navigator.mediaDevices` on plain HTTP, so the insecure state stays reachable).
- **K3 / K4** — migration `0002_remembered_versions` exactly as planned (one `ADD COLUMN` + the backfill);
  `playwright.config.ts` got the microphone permission, the fake media flags and the `tablet` project (no spec until
  P6-B). The upgrade probe ran on the `.tmp/upgrade-v11` copy.

### P6-A

- **K5 CCR batch** (applied at the gate): the stale P6-0b skeleton tests (`S/http/routes/models.test.ts`: the visible
  mock list is `echo, image, image-chat, image-tool, reasoning, tool-approval`; `S/deps.test.ts` "phase 6 skeleton" no
  longer expects `not_implemented` from the resolvers, `chats.deleteMessage`, `images.generate`,
  `files.saveGenerated`, `audio.transcribe` and `audio.speak`; `S/testing/fakes.test.ts`: the image service stub
  answers `not_found`); two frozen doc comments (`S/providers/types.ts`: `alibaba:qwen3-asr-flash` is left out of the
  catalog; `S/catalog/types.ts`: the media-seed and factory rules); `e2e/specs/plugins/plugins-list.spec.ts` expects
  3 core tools; the builtin manifests (`engines ^1.1.0`); migration `0003_refresh_model_listings` (see "Implementation
  deviations" above). W6.1's changes were verified at the gate (audit, a diff review of `S/chat/**`, the full suite,
  the probes) because the harness safety classifier was unavailable when that agent's work was reviewed.
- **Post-gate fix** (`6e96d85`, coordinator): Settings → Models shows Favorite and Visible only for chat and image
  models; DECISIONS.md lists migration `0003`.
- **Implementation facts** (the docs were reconciled in P6-B; API.md, ARCHITECTURE.md, UI.md and PROVIDERS.md carry
  the details):
  - W6.1 image pipeline — 433 chat and route tests (373 before). Stream: `start` → `start-step` → `message-metadata`
    keep-alive every 15 s (`ChatRunnerOptions.imageKeepAliveMs`) → one `file` chunk per image → `finish-step` →
    `finish`; a failure is an `error` chunk (saved as `metadata.error`), Stop an `abort` (`aborted: true`); a refused
    image becomes an inline `generated-file-dropped` notice. Saved file parts carry `filename` (`image-<n>.<ext>` or
    the name of the existing file); failed or aborted image turns keep `metadata.image` + `finishedAt` but no files.
    History: `[Generated image: <name>]` / `[Generated file: <name>]` in place, the latest images carried for vision
    models after "(Images generated earlier in this chat:)". Tool images follow the final `tool-output-available`
    (core-tools only; the URL is checked against the file id and the stored file) and the tool's `costUsd` is added
    to the message cost.
  - W6.2 model runtime — the factory rule and the classification above; resolver messages such as
    `modelRef: The model "x" is not an image model.`; async factories are awaited inside the 5 s guard
    (`factoryTimeoutMs`); `voices` are deduplicated and capped at 100; the credential ping and the default choice take
    chat models only; `models-dev.test.ts` requires only the chat seeds to exist in models.dev.
  - W6.3 provider media — 266 core-providers tests. xAI transcription and speech instances have an empty `modelId`
    (logs use the resolved model ref); models.dev lacks all six OpenAI voice seeds (PROVIDERS.md 13); only
    `gpt-image-2` has a catalog price, so `costUsd` is null for the `gpt-image-1`, `-1-mini` and `-1.5` seeds; the
    voice lists are unverified and Mistral has none; xAI documents `language` as text normalization (its effect on
    recognition is unverified).
  - W6.4 image host — cost = (input tokens × input price + output tokens × output price) / 1e6, rounded to 1e-10;
    null without a catalog price, without token counts (xAI) or when a used token kind has no price. Exactly one usage
    row per generation, written by the service. `dropped` counts images refused by `saveGenerated` or undecodable;
    other storage errors are `internal_error`. Abort rejects with the signal's reason and records no provider outcome;
    a late answer still writes the usage row and stores nothing; `maxRetries` 1; the same bytes reuse one file row
    (concurrent-safe, an earlier upload's row and name included). `ctx.images` throws `provider_error` when every
    image was dropped.
  - W6.5 voice server — 102 tests; `services/audio/{index,sniff}.ts`. The transcript is trimmed (`''` = no speech);
    413 carries `details.limitBytes: 26214400` (the body limit answers first above 25 MiB + 64 KiB); a client
    disconnect aborts the provider call and answers 400 "The request was canceled." (logged only: no outcome, no usage
    row); the usage row and the provider outcome are written only for 200 answers; one info log line per call
    (`audio transcription` / `audio speech`); a provider error that repeats the speech text is replaced by a generic
    one.
  - W6.6 chats server — `TreeRow.selectedChildId` is optional; `rememberPathSql(chatId, leafId, when?)`;
    `deleteSubtreeSql` needs planner hints (a 3,000-message subtree went from 4.9 s to 6 ms; a plan test guards it);
    after a lost race the delete error is derived again (404 / `only-version`); `chat.updated` carries the stored
    `active_leaf_id` (null or dangling while the detail falls back to the newest message), and an off-path delete
    still emits it unchanged.
  - W6.7 chat surface — web suite 130 files / 1373 tests at its end. `followActiveLeaf()` coalesces bursts; a null or
    dangling leaf gets one reload and is then skipped until a different leaf arrives; `deleteVersion` shares
    `changePath` with `switchBranch`; `edit(id, text, files?)`; the editor's hidden file input has only
    `data-slot="message-edit-file-input"` (e2e uses the file chooser of `message-edit-attach`); the meta image line
    omits the ratio for Auto and "edited" without input images; galleries are not split by invisible parts;
    `reasoning-file` parts stay thumbnails.
  - W6.8 media parts — a loading reply already counts as pressed ("Stop reading", `aria-busy`); the Esc shortcut
    `read-aloud-stop` is registered only while something plays; a system pause (media keys) ends the reading; inline
    math reads "formula", `\[…\]` blocks "Formula omitted."; the gallery's `data-count` counts the shown tiles;
    Download only for same-origin, `blob:` or image `data:` URLs; the share option is labelled "Files and images".
  - W6.9 composer — `MicButton` exposes `activate()` (Alt+V calls it); the `RecordingIndicator` root has
    `data-state`, `role="group"` and `aria-label`; the transcription request sends the clip as a `File` named
    `dictation.<ext>` and no model or language (the server settings decide); `groupedByProvider` lists chat models
    only; `defaultRef` skips a default that names a known non-chat model; the picker's Favorites / Recent show chat and
    image models only; default image options (1 image, Auto, edit the previous image) are stored as absent keys; the
    image options menu closes after each pick.
  - W6.10 media settings — the Media page loads the providers, the catalog and the settings (a Retry alert "Could not
    load the media settings" on failure); the image select lists visible image models only, the speech-to-text and
    read-aloud selects include hidden models; Voice saves on blur or Enter; changing Read aloud clears the voice; Test
    voice (`VOICE_TEST_ID`) stops on leave or when Read aloud is turned off; the Kind select of `CustomModelDialog` has
    no test id; `ModelsTable` shows a kind badge for non-chat models.
  - W6.11 app web — `useFreshAuth` and its 8 call sites (the three `fresh-auth.ts` copies and their tests deleted,
    the duplicate helpers removed); both `ui/sidebar` patches are recorded in `apps/web/AI_ELEMENTS_PATCHES.md`; the
    user-visible fresh-auth changes are listed in "Implementation deviations" above.
  - Test timeouts raised for slow renders under full-suite load: the ShareDialog test with 20 link cards (30 s) and
    two ModelsSettings tests with 72-model popovers (20 s).
- **Backlog from P6-A:** a `modelName` in the plugin API image result (the tool text names the model ref).

### P6-B

| Agent | Work | State |
|---|---|---|
| W6.12 e2e-features | specs `core/images`, `core/voice`, `core/versions`, `core/edit-attachments`, `mobile/media`, `tablet/touch-targets`; the 5 new `@screenshots` screens (`settings-media`, `chat-images`, `chat-images-generating`, `composer-recording`, `chat-delete-version`); `e2e/README.md` | done: new specs 17/17 ×3 (chromium 13, mobile 3, tablet 1); full suite 61 passed; the fake-media launch flags work in headless Chromium (no `addInitScript` mocks); multipart bodies are read through `page.route()` (Playwright's `postDataBuffer()` is empty for file uploads). Found: the expanded sidebar's "Toggle sidebar" button was 32 px on touch tablets — fixed by the coordinator (`AppBrand.vue` `pointer-coarse:size-10`, header `pointer-coarse:h-10`) with a new assertion in the tablet spec |
| W6.13 docs-final | API.md, UI.md, ARCHITECTURE.md, PROVIDERS.md, PLUGINS.md and the guides reconciled with the code and the P6-A reports; README "v1.2"; this file | done (below) |
| W6.14 live-media | the `HF_LIVE_MEDIA` image and voice checks, their budget, the summary columns and the unit-tested media matrix | done: `live/media.ts` + matrix / checks / summary changes; 52 unit tests (was 23); the live file stays skipped without `HF_LIVE`; never run live. The coordinator rewrote PROVIDERS.md 12 from the implementation and added the `media` input to `.github/workflows/live.yml` |

- **W6.13** — README reads "v1.2": the feature list covers images, voice, remembered and deletable versions,
  attachment editing, the single password prompt, tablet touch targets and the microphone's HTTPS requirement. Four
  README screenshots changed visibly and were replaced by the P6-A gate captures: `chat-dark.png` ←
  `dark/chat-desktop.png` and `chat-light.png` ← `light/chat-approval-desktop.png` (the composer's microphone
  button), `settings-dark.png` ← `dark/settings-providers-desktop.png` (the Media item), `plugins-dark.png` ←
  `dark/plugins-desktop.png` (three core tools, version 1.1.0); `provider-wizard-dark.png` is unchanged. PROVIDERS.md
  11 stays "Unverified" for the media checks (the live media suite has not run) and explains how to record results.
  Where the code and the plan or a code comment disagree, the docs describe the code. Suspected code issues, for the
  final gate:
  - **Fixed before the final gate — Migration `0003` hid cached listings** (`apps/server/drizzle/0003_refresh_model_listings.sql` with
    `S/catalog/index.ts` `buildEntries`, which uses a cached listing only when `fetchedAt !== null`). Expected (the
    migration comment): the stale listing stays visible until it is refreshed. Actual: after the upgrade every provider
    serves its seeds (plus plugin and custom models) until a refresh succeeds, and a failed refresh keeps `fetched_at`
    null, so a provider that is down or offline at the upgrade (Ollama not running, a network outage) loses its listed
    models meanwhile (a chat on such a model answers `model_not_found`). Fix options: a follow-up migration that sets
    `fetched_at = 0` where `models` is not empty, or a catalog that serves a cached non-empty listing as stale.
  - **Unknown provider on the media routes** (`S/services/audio/index.ts`, also `S/services/images/index.ts` for
    `ctx.images` / `generate_image`): the resolvers' `404 not_found` "Unknown provider" passes through, while the chat
    pipeline answers `400 provider_not_configured` with `action: 'configure-provider'` (API.md 2.2), e.g. for a
    `speechModelRef` that names the provider of an uninstalled plugin. Documented as built (the 404 is tested).
  - **Stale comments** (no behavior change): `S/builtin-plugins/mock/index.ts`, `core-providers/providers/google.ts`
    and `openrouter.ts` still say an id containing "image" is classified as an image model; the frozen
    `packages/plugin-sdk/src/types.ts` comment on `seedModels` still says seeds are used only without a listing (media
    seeds are always listed; a CCR).

---

## Risks

State after Gate P6-A; "held" means the mitigation worked so far.

| Risk | Mitigation |
|---|---|
| The stream restructure (`createUIMessageStream` around every chat run) breaks streaming, resume or approvals | held: W6.1 kept `pipeline.test.ts` green (433 chat and route tests) and added a test that fails on any streamed or saved `data:` URL; the resume, approval and keyboard e2e specs passed at Gate P6-A (44 passed) and run again at the final gate |
| Unverified provider behavior (Gemini image output and thought signatures, the carry-forward, voice ids and voice lists, a Gemini transcription id, the xAI `language` option) | unverified seeds and voice lists marked, `gemini-3.5-transcribe` left out, provider 404s mapped to `model_not_found`; the opt-in live media checks (W6.14) exist but have not run with real keys: PROVIDERS.md 11 stays "Unverified" |
| Image cost | the tool's policy is `ask`; costs are labelled "estimated"; `costUsd` is null when the catalog has no price (every OpenAI image seed except `gpt-image-2`) or no token counts are reported (xAI); the live media checks are opt-in with a budget |
| Migration `0002` data loss | held: one nullable `ADD COLUMN` plus the backfill, an upgrade test with a no-backfill negative copy (C11), the `.tmp/upgrade-v11` probe (Gate P6-0b: 0 invalid pointers, chats unchanged); a real v1.1 → v1.2 upgrade at the final gate |
| Stale model listings after the upgrade (a v1.1 cache hides the v1.2 media ids and image-output flags for up to 24 h) | found at Gate P6-A; migration `0003` ages every successful cached listing by one TTL (stale once, still served until a refresh succeeds; `S/db/upgrade.test.ts`); the first version (`fetched_at = NULL`) would have hidden cached listings until a refresh succeeded — found by W6.13, fixed before the final gate |
| Hot files (`useChatSession`, `ChatMessage`, `MessageActions`, `share/**`, `settings/**`, the composer) | held: one owner per file per wave (P6-A table); new components as P6-0b stubs with frozen props; the P6-A audit found no path outside the globs and no frozen file touched |
| Doc-coupled route count (76) | held: all three routes landed in P6-0a together with API.md 8 and the DECISIONS table |
| The microphone needs a secure context; fake media flags may fail in headless CI | UI states (a disabled mic with the tooltip "Voice input needs HTTPS or localhost") and docs (README: HTTPS or localhost); the P6-A e2e run was green with the fake media flags; W6.12 falls back to `page.addInitScript` mocks of `getUserMedia` / `MediaRecorder` if needed |
| Media selects list a transcription / speech model whose provider has no factory (e.g. a models.dev-only `alibaba:qwen3-asr-flash`) | settled: W6.2 lists a media model only when its provider has the matching factory (custom models excepted; the resolver then answers `validation_error` naming the model) |
| Alt+V opens the View menu in Firefox on Windows | `preventDefault` on a match in the shortcut registry; Alt+V kept (no Alt+J fallback); Firefox on Windows is unverified |
| The fresh-auth behavior changes in eight places | held: one `useFreshAuth` composable, UI.md 8.4 rewritten, the plugin, data and share e2e specs green at Gate P6-A |
| Slow version deletes on large chats (a recursive subtree delete) | `deleteSubtreeSql` with planner hints (a 3,000-message subtree in 6 ms instead of 4.9 s) and a query-plan test |
| Disk growth from generated images | the same bytes reuse one file row; delete-all purges files; orphan-file cleanup is in the backlog |
| Wave size (11 agents) | held: the P6-A gate was green, W6.15 / W6.16 were not needed and nothing was cut (`generate_image` shipped) |
| Dependabot still misbehaves on pnpm 11 | the P6-0a gate saw separate katex / ai-sdk / minor pull requests (#2 – #4, green); Renovate stays the documented fallback |
| Privacy (audio and reply text leave for the provider) | explicit opt-in, the settings notice, nothing stored or logged (ARCHITECTURE.md 10.8); the P6-A log probe found no prompt, transcript or speech text |
