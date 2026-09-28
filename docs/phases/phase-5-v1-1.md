# Phase 5 — v1.1: stabilization, branching, data, share links

Part of the harness-forge build plan. Progress is tracked in `docs/ROADMAP.md` (coordinator only). Shared names come
from `docs/DECISIONS.md` (ADR-023 … ADR-027 and the contract seed; it wins on conflict); endpoints and DTOs from
`docs/API.md`; components, props, store members and test ids from `docs/UI.md`; tables, flows and security rules
from `docs/ARCHITECTURE.md`; the live provider suite from `docs/PROVIDERS.md` section 12.

## Goal

Ship v1.1. Pay the v1 debt (the missing W4.5 e2e specs, the built-page CSP test that never ran in CI, dependency
automation, the unused `vue-stream-markdown`, a login limiter that cannot see clients behind a reverse proxy, a
provider layer exercised only with the mock provider) and add three features:

- **Conversation branching** (ADR-023): editing a user message or regenerating a reply adds a sibling version instead
  of deleting later messages; a `‹ 2/3 ›` switcher shows the versions.
- **Bulk data** (ADR-024, supersedes ADR-020): a streamed zip backup of every chat and attachment, import of a backup
  or a single-chat JSON, and delete-all, in Settings → Data.
- **Read-only share links** (ADR-025): a sanitized snapshot of a chat's active path at `/share/<token>`.

Out of scope (ROADMAP backlog): multimodal/RAG, plugin isolation and registry, multi-user, desktop/CLI clients,
attachment editing on edit, deleting a message version, a remembered version per message, master-key rotation.

Totals after Phase 5: routes 62 → **73** (11 new), tables 14 → **15** (`chat_shares`), migrations
`0000_initial_schema` + **`0001`** (message tree + `chat_shares`), ADR-023 … ADR-027.

## Entry criteria

- v1 is on `main` (`6e3b442` final gate, `4c461a0` docs); `pnpm check`, `pnpm build` and e2e 27/27 are green.
- The approved plan exists; K1 and K2 (below) are done: DECISIONS.md carries ADR-023 … ADR-027 and the Phase 5
  contract seed, ROADMAP.md has the Phase 5 section, AGENT.md lists `HF_TRUST_PROXY` and `pnpm test:live`.

## Exit criteria

- Every Phase 5 item in `docs/ROADMAP.md` is checked; every wave gate is green; the final checkpoint commit
  `chore: final gate for harness-forge v1.1` exists (pushed only when the user asks).
- `pnpm check` and `pnpm build` are green; the built-page CSP test passes with `HF_TEST_REQUIRE_WEB_BUILD=1`.
- `pnpm test:e2e` (projects `chromium` + `mobile`) is green 3× in a row, including the new specs resume, keyboard,
  settings, mobile, branching, data and share; the `@screenshots` run (dark + light) was reviewed.
- A v1 data directory boots on v1.1 with every chat intact (linear parent chain, active leaf = last message), both
  with `pnpm start` and with Docker.
- `pnpm test` never calls a paid API, even with provider keys exported; `ANTHROPIC_API_KEY=… pnpm test:live` prints a
  per-provider PASS / SKIP / FAIL table.
- CI: the `check`, `e2e` (with the CSP test after the build), `docker` and `audit` workflows are green; Dependabot is
  configured.
- README status reads "v1.1"; the phase-4 checklists are ticked with evidence.

Manual acceptance (coordinator, `pnpm dev`):

- Edit a message in the middle of a transcript → "‹ 2/2 ›" appears and switching back restores the old tail;
  regenerate a reply → the switcher appears on the assistant message; a reload keeps the chosen version; switching
  while a reply streams shows the toast "A response is already running in this chat." (409).
- Settings → Data: the export zip contains no secret; delete-all asks for the password when one is set; import
  restores chats with their versions, pinned / archived state, dates and attachments; importing again skips all.
- Share: create a link, open it in a private window of a server with `HF_PASSWORD` → a read-only transcript whose
  images load; revoke → "This link is unavailable"; logs show only masked tokens; responses carry `X-Robots-Tag`.
- `HF_TRUST_PROXY=loopback` behind Caddy or nginx: the login limiter sees the real client addresses;
  `X-Forwarded-Host` is ignored.

## Steps

| Step | Owner | Output |
|---|---|---|
| P5-0a | coordinator (K1, K2) + C7, D5 | decisions, configs, shared contracts + 501 stubs, API.md, every other doc |
| Gate P5-0a | coordinator | audit, check, build, CSP test, 501 probes, e2e regression, commit |
| P5-0b | coordinator (K3, K4) + C8, C9 | schema + migration `0001`, server and web skeletons, test ids, FREEZE |
| Gate P5-0b | coordinator | audit, check, build, CSP test, e2e regression, v1 upgrade probe, FREEZE, commit |
| P5-A | W5.1 – W5.9 (one launch) | features + stabilization |
| Gate P5-A | coordinator (K5) | CCR batch, `nuxi prepare`, check, build, probes, e2e (both projects), screenshots, audit, commit |
| P5-B | W5.10, W5.11, W5.12/13 | feature e2e, docs reconciliation, fix-ups |
| Final gate | coordinator (K6) | e2e ×3, Docker upgrade, optional live suite, ROADMAP, commit |

## Deviations from the plan (binding)

- **No `audit:` key in `pnpm-workspace.yaml`**: it cannot be verified in pnpm 11.20's help. CI passes the flags on
  the command line: `pnpm audit --prod --audit-level high --ignore-registry-errors`.
- **Chat JSON export v2** follows the branching design: `{ format: 'harness-forge.chat', version: 2, exportedAt,
  chat }` where `chat` = summary + settings + totals + `messages` (every version, `seq` order) + `parentIds`
  (aligned by index; `null` for a first message) + `activeLeafId`. Messages carry **no** `parentId` field.
  `chatExportAnySchema` is a discriminated union on `version` (1 | 2).
- **Share tokens** are HMACs of the share id with the keyring subkey `share` and are never stored (not "stored
  hashed"). Token format `^[0-9A-Za-z]{16}[\w-]{22}$`; share id `shr_` + 16 chars `[0-9A-Za-z]`.
- **Docs** are written by D5 (UI, ARCHITECTURE, PROVIDERS, README, `.env.example`, this file) and C7 (API.md) in
  P5-0a and reconciled by W5.11 in P5-B. P5-A agents never edit docs, except W5.9's phase-4 checklist.
- **Feature e2e specs** (branching, data, share) are written in P5-B by W5.10, not by the P5-A web agents.
- **Every new web test id** is added by C9 in P5-0b, copied verbatim from UI.md 13.6; `utils/testids.ts` is frozen
  during P5-A.
- **Route modules**: `data` (`http/routes/data.ts`) and `shares` (`http/routes/shares.ts`, which also serves the public
  `/share/:token` routes). Route keys: `chats.switchBranch`, `data.summary`, `data.export`, `data.import`,
  `data.deleteAll`, `shares.list`, `shares.create`, `shares.update`, `shares.remove`, `shares.view`, `shares.file`.

## Rules for every Phase 5 agent

- Read `AGENT.md` fully, your section of this file and the docs it names. Paths: `S` = `apps/server/src`,
  `W` = `apps/web/app`. Stay inside your OWNED globs; the FREEZE list below overrides any owned glob.
- Never run: package installs or CLIs (`pnpm add`, `drizzle-kit`, `nuxi`, `shadcn-vue`), git write commands,
  `nuxt dev` / `nuxt build` / `nuxt prepare`, servers on :3000 / :8787 / :8899, and **never `pnpm test:live`** (the
  repository `.env` may hold real keys; the suite makes paid calls). Existing scripts are allowed.
- Your own server uses your slot: `HF_PORT=879k HF_DATA_DIR=.tmp/<agent-id>`; e2e agents use `889k` (k ≠ 9) with
  `E2E_BASE_URL`. Stop every process you started before reporting. Prefer `createTestApp()` + `app.request()`.
- Contracts: DTOs and route keys only from `@harness-forge/shared`; server services only through the frozen
  `types.ts` interfaces. A missing member, a contract change, a frozen-file edit or a **new test id** is a CCR in your
  report (file, current shape, proposed shape, reason) plus a local adapter so you can keep working.
- New components are imported explicitly by path (`import BranchSwitcher from './BranchSwitcher.vue'`): the
  coordinator runs `nuxi prepare` only at the gates, so auto-import types do not know files created mid-wave.
- Verify before reporting — server: `pnpm -F @harness-forge/server test` · `pnpm typecheck`; shared:
  `pnpm -F @harness-forge/shared test`; web: `pnpm -F @harness-forge/web test` ·
  `pnpm -F @harness-forge/web typecheck:fast`; all: `pnpm check:english`.
- Report ≤ 300 words in the AGENT.md format (tasks, files, commands + results, CCRs, dependency requests, open
  issues, suggested ROADMAP updates).

## FREEZE in Phase 5

In force since Phase 0 (AGENT.md): `packages/*/src`, `S/app.ts`, `S/db/schema.ts`, `apps/server/drizzle/**`, every
`*/types.ts` under `S`, `S/builtin-plugins/index.ts`, `W/layouts/**`, store signatures in `W/stores/**`,
`apps/web/nuxt.config.ts`, every `package.json` and config file, `W/components/{ui,ai-elements}/**`, the CSS design
tokens in `W/assets/css/main.css`.

P5-0a and P5-0b open the frozen files **only** for their named owners (C7: shared contracts, `S/app.ts`; K3:
`S/db/schema.ts` + `drizzle/**`; C8: the listed `types.ts` files; C9: `W/layouts/**`, `stores/ui.ts`). Added to the
freeze after Gate P5-0b: `S/services/{data,shares}/types.ts`, `W/layouts/share.vue`, the `stores/ui.ts` signature
(`shareChatId`, `openShare`, `closeShare`) and `W/utils/testids.ts`.

Pre-approved CCR for P5-A: W5.1 edits `S/services/chats/types.ts` to drop `replaceFrom` and make `parentId` required
on `appendMessage` / `upsertMessage` (owned glob `S/services/chats/**`).

---

## Wave P5-0a — decisions, docs, contracts

Two agents in one launch (C7, D5) while the coordinator finishes K1 and K2.

### Coordinator actions

- **K1 (done)** — `docs/DECISIONS.md`: ADR-020 → "Superseded by ADR-024"; ADR-023 branching, ADR-024 bulk data,
  ADR-025 share links, ADR-026 trusted proxies, ADR-027 live suite + dependency automation; ADR-007 notes the
  removal of `vue-stream-markdown`; contract seed: `HF_TRUST_PROXY`, test-only `HF_LIVE*`,
  `HF_TEST_REQUIRE_WEB_BUILD`, `E2E_SCREENSHOTS`, share id and token, keyring subkey `share`, the message tree, the
  HTTP API table (`data.ts`, `shares.ts`, `POST /chats/:id/branch`), 15 tables, the chat request (`parentId`,
  `messageId` regenerate-only), chat export v2 and the backup zip. `docs/ROADMAP.md`: Phase 5 section, backlog,
  wave-log rows. `AGENT.md`: env var, `pnpm test:live`, the "never run the live suite" rule.
- **K2 (done)** — S5: deleted `W/components/ai-elements/message/MessageResponse.vue` and
  `W/components/ai-elements/reasoning/ReasoningContent.vue` with their barrel lines, the `apps/web/package.json`
  dependency and the `pnpm-workspace.yaml` override; `pnpm install`; `pnpm why vue-stream-markdown` is empty;
  ADR-007 and `apps/web/AI_ELEMENTS_PATCHES.md` updated. Configs: `playwright.config.ts` project `mobile`
  (`devices['Pixel 7']`, viewport 390×844, `testMatch: /specs\/mobile\/.*\.spec\.ts$/`; `chromium` ignores
  `specs/mobile/`); root script `"test:live": "vitest run --config apps/server/vitest.live.config.ts"`;
  `apps/server/vitest.live.config.ts` (`src/**/*.live.test.ts`, `env: { HF_LIVE: '1' }`, 60 s timeouts, one file at a
  time, `passWithNoTests`); the server `vitest.config.ts` excludes `src/**/*.live.test.ts`; no workspace `audit` key.
- Ownership file `.tmp/waves/P5-0a.json` (below).

### C7 contracts (k2)

- **Mission.** Write every shared contract of Phase 5, the 11 new routes as 501 stubs, and `docs/API.md`, keeping
  `pnpm check` green.
- **Owned.** `packages/*/src/**`, `docs/API.md`, `S/app.ts`, `S/http/routes/{data,shares}.ts` (new stubs),
  `S/http/routes/chats.ts` (the `switchBranch` stub only), `S/testing/api-samples.ts`,
  `S/http/middleware/body-limit.ts`, `S/http/middleware/session-auth.test.ts`,
  `S/security/{fresh-auth-routes,secret-leaks}.test.ts`, `S/services/chats/{index,export}.ts` + `export.test.ts`
  (compile stubs), `W/utils/testing/fixtures.ts`, plus any test file that builds a `ChatDetail` and only needs the new
  required field (listed in the report; the coordinator accepts them in the audit).
- **Read-only highlights.** `.tmp/p5-designs/**` (branching, data-share, reconciliation), `docs/DECISIONS.md`,
  `packages/shared/src/api/routes.test.ts` and `contract.test.ts` (doc-coupled), `S/http/routes-mounted.test.ts`.
- **Tasks.**
  1. **C7-T1 Ids, params, limits** — `SHARE_ID_PATTERN`, `SHARE_TOKEN_PATTERN`, `shareIdSchema`,
     `shareTokenSchema`, `createShareId()`; `shareParamsSchema`, `sharePublicParamsSchema`, `shareFileParamsSchema`;
     `LIMITS` gains `backupImportBytes` (256 MiB), `backupEntriesMax` (50 000), `backupChatEntryBytes` (64 MiB),
     `backupChatMessagesMax` (20 000), `shareSnapshotBytes` (10 MiB), `shareToolValueChars` (16 KB),
     `sharesPerChatMax` (20).
  2. **C7-T2 Chats and the chat request** — `ChatRequestBody.parentId?: MessageId | null` (submit-message with a user
     message only; omitted = the active leaf); `messageId` only for `regenerate-message`; `messageBranchSchema`
     (`siblings` ≥ 2 in `seq` order, `index`), `ChatDetail.branches: Record<MessageId, MessageBranch>`,
     `chatBranchBodySchema`; `chatCreateSchema` + `parentIds` + `activeLeafId`; chat export v2 and
     `chatExportAnySchema` (union on `version`); conflict reason `busy` (import / delete-all mutex).
     *Accept:* a v1 export file still parses; a v2 export round-trips through the schema.
  3. **C7-T3 Data and share schemas** — `schemas/data.ts` (`BackupManifest`, `BackupFileEntry`, `BackupFileIndex`,
     `DataSummary`, `DataExportQuery`, `DataImportForm`, `DataImportResult`, `DataDeleteBody` with
     `confirm: 'DELETE'`, `DataDeleteResult`) and `schemas/shares.ts` (`ShareOptions`, `ShareCreate`, `ShareUpdate`,
     `SharesQuery`, `ShareSummary`, `SharePart`, `ShareMessage`, `ShareSnapshot`, `ShareView`), reusing existing
     primitives.
  4. **C7-T4 Route table** — modules `data` and `shares` in `ApiModule`; the 11 keys of "Deviations"; `public` on
     `shares.view` / `shares.file`; `fresh` on `data.deleteAll`, `shares.create`, `shares.update`; 73 routes.
     *Accept:* `routes.test.ts` (API.md section 8 index + the DECISIONS module table) and `contract.test.ts` green.
  5. **C7-T5 `docs/API.md`** — sections 3 (module names), 4 (chat request, branches, export v2, data, shares),
     5 (`chats.ts` + branch route, `chat.ts` rule changes incl. the removed in-place edit, new `data.ts` and
     `shares.ts`), 6.2 (edit = a new user message with `parentId`), 8 (73-route index); the login limiter note points
     at ADR-026 (trusted proxies).
  6. **C7-T6 Server stubs and compile fixes** — `S/app.ts` mounts `data` and `shares`; every new route answers
     `501 not_implemented`; `body-limit.ts` gives `data.import` 256 MiB + 64 KiB; `session-auth.test.ts` treats the
     two share routes as public; fresh-auth and secret-leak route tables updated; `services/chats/{index,export}.ts`
     compile with `branches: {}`; `W/utils/testing/fixtures.ts` builds a valid `ChatDetail`.
     *Accept:* `routes-mounted.test.ts` green (no new route answers 404); `pnpm check` green.
- **Tests.** Schema tests for every new DTO (valid + invalid samples: token pattern, `confirm` literal, expiry,
  `parentIds` length), route-table tests, updated route-driven security tests.
- **Verify.** Shared, server and web commands.

### D5 docs (k1)

- **Mission.** Write this file and update the user-facing and architecture docs so P5-0b and P5-A agents can build
  against them.
- **Owned.** `docs/phases/phase-5-v1-1.md` (new), `docs/UI.md`, `docs/ARCHITECTURE.md`, `docs/PROVIDERS.md`,
  `README.md`, `.env.example`.
- **Tasks.**
  1. **D5-T1 Phase doc** — this file: waves, agents, owned globs, tasks with acceptance criteria, gates, ownership
     JSON, risks.
  2. **D5-T2 UI.md** — `BranchSwitcher` and the new message actions (7.5), `useChatSession` branching members (11.1),
     "Share…" menu items (5.3, 5.6), `ShareDialog` (7.14), the shared chat page and its `share` layout (5, 6, 7.15),
     Settings → Data (9.8), component contracts (10.4), AI Elements removals (10.2), every new test id (13.6), mobile
     e2e notes (14.6).
  3. **D5-T3 ARCHITECTURE.md** — message tree, migration `0001` and backfill (8), pipeline kinds and the active leaf
     (6.1, 6.3, 6.8), bulk data (6.9), share links (6.10), public endpoints, trusted proxies and share security (10),
     reverse-proxy topology (11), log masking (12).
  4. **D5-T4 PROVIDERS.md** — section 12 "Live provider suite" (env var names verified against
     `core-providers` `credentials[].envVar`).
  5. **D5-T5 README.md** — status line, features, `HF_TRUST_PROXY`, reverse-proxy examples (Caddy, nginx, Compose),
     `pnpm test:live`.
  6. **D5-T6 `.env.example`** — `HF_TRUST_PROXY` and a commented test-only block.
- **Verify.** `pnpm check:english`; no test reads these files.

### Wave P5-0a ownership

```json
{
  "wave": "P5-0a",
  "agents": {
    "C7": [
      "packages/shared/src/**",
      "packages/plugin-sdk/src/**",
      "docs/API.md",
      "apps/server/src/app.ts",
      "apps/server/src/http/routes/data.ts",
      "apps/server/src/http/routes/shares.ts",
      "apps/server/src/http/routes/chats.ts",
      "apps/server/src/testing/api-samples.ts",
      "apps/server/src/http/middleware/body-limit.ts",
      "apps/server/src/http/middleware/session-auth.test.ts",
      "apps/server/src/security/fresh-auth-routes.test.ts",
      "apps/server/src/security/secret-leaks.test.ts",
      "apps/server/src/services/chats/index.ts",
      "apps/server/src/services/chats/export.ts",
      "apps/server/src/services/chats/export.test.ts",
      "apps/web/app/utils/testing/fixtures.ts"
    ],
    "D5": [
      "docs/phases/phase-5-v1-1.md",
      "docs/UI.md",
      "docs/ARCHITECTURE.md",
      "docs/PROVIDERS.md",
      "README.md",
      ".env.example"
    ]
  },
  "allow": [
    "apps/server/src/http/middleware/fresh-auth.test.ts",
    "apps/server/src/security/request-guards.test.ts",
    "AGENT.md",
    "docs/DECISIONS.md",
    "docs/ROADMAP.md",
    "apps/web/AI_ELEMENTS_PATCHES.md",
    "apps/web/app/components/ai-elements/message/**",
    "apps/web/app/components/ai-elements/reasoning/**",
    "apps/web/package.json",
    "package.json",
    "pnpm-workspace.yaml",
    "pnpm-lock.yaml",
    "playwright.config.ts",
    "apps/server/vitest.config.ts",
    "apps/server/vitest.live.config.ts"
  ]
}
```

The two route-table-driven security tests in `allow` (`fresh-auth.test.ts`, `request-guards.test.ts`) follow the new
routes. C7 adds the test files it had to touch for the new required `ChatDetail.branches` field to its report; the
coordinator accepts them in the audit.

### Gate P5-0a

1. `node scripts/audit-ownership.mjs .tmp/waves/P5-0a.json`
2. `pnpm install --frozen-lockfile` → `pnpm check` → `pnpm build`.
3. `HF_TEST_REQUIRE_WEB_BUILD=1 pnpm -F @harness-forge/server exec vitest run src/http/static.test.ts` (after the
   build the built-page CSP test runs instead of skipping).
4. `pnpm start:e2e` → `curl -sf :8899/api/health`; every new route answers 501 with the `not_implemented` envelope:
   ```sh
   b=http://127.0.0.1:8899/api; c=0199a0b0-0000-7000-8000-000000000001; t=AAAAAAAAAAAAAAAAbbbbbbbbbbbbbbbbbbbbbb
   for r in "GET /data" "GET /data/export" "POST /data/import" "POST /data/delete" "GET /shares" "POST /shares" \
            "PATCH /shares/shr_AAAAAAAAAAAAAAAA" "DELETE /shares/shr_AAAAAAAAAAAAAAAA" "GET /share/$t" \
            "GET /share/$t/files/file_AAAAAAAAAAAAAAAA" "POST /chats/$c/branch"; do
     set -- $r; curl -s -o /dev/null -w "%{http_code} $1 $2\n" -X "$1" "$b$2"
   done   # every line prints 501 (routes-mounted.test.ts covers the full matrix)
   ```
5. `pnpm test:e2e` → 27 passed (the `mobile` project has no specs yet).
6. `pnpm why vue-stream-markdown` (empty) · `pnpm why typescript` (only 6.0.x).
7. ROADMAP + wave log → commit `feat: add phase 5 contracts and docs`.

---

## Wave P5-0b — schema, migration, skeletons, FREEZE

**Entry:** Gate P5-0a green. The coordinator lands K3 first; C8 and C9 start in one launch once the migration
exists (C8's upgrade test needs it).

### Coordinator actions

- **K3 Schema and migration `0001`** —
  1. Before any P5-0b build touches it: `rm -rf .tmp/upgrade-v1 && cp -R .tmp/e2e .tmp/upgrade-v1` (a v1-era data
     directory with only `0000` applied, for the upgrade probe).
  2. `S/db/schema.ts`: `messages.parentId` (`parent_id text`, nullable, **no** `references`) + index
     `messages_chat_parent_idx (chat_id, parent_id)`; `chats.activeLeafId` (`active_leaf_id text`, nullable, **no**
     `references`); table `chat_shares` (ARCHITECTURE.md 8) with FK `chat_id → chats.id ON DELETE CASCADE` and index
     `chat_shares_chat_idx`; `TABLE_NAMES` gains `chat_shares` (15).
  3. `pnpm db:generate` (suggested: `pnpm db:generate --name message_tree_and_shares`).
  4. Inspect the SQL: exactly two `ALTER TABLE … ADD` (`messages.parent_id`, `chats.active_leaf_id`), `CREATE INDEX
     messages_chat_parent_idx`, `CREATE TABLE chat_shares` + `CREATE INDEX chat_shares_chat_idx`. **Reject** any
     `DROP TABLE`, `__new_` or `PRAGMA foreign_keys` statement (foreign keys are on; a table rebuild would
     cascade-delete messages inside the migration transaction).
  5. Append the backfill after the generated statements, each separated by `--> statement-breakpoint`:
     ```sql
     UPDATE `messages` SET `parent_id` = (SELECT p.`id` FROM `messages` p WHERE p.`chat_id` = `messages`.`chat_id`
       AND p.`seq` < `messages`.`seq` ORDER BY p.`seq` DESC LIMIT 1);
     UPDATE `chats` SET `active_leaf_id` = (SELECT m.`id` FROM `messages` m WHERE m.`chat_id` = `chats`.`id`
       ORDER BY m.`seq` DESC LIMIT 1);
     ```
     Never re-run `db:generate` after the hand edit. `migrate()` applies the file in one transaction.
- **K4 After C8 and C9** — `nuxi prepare` (auto-import types for the new components), the gate below, then the
  FREEZE additions.
- Ownership file `.tmp/waves/P5-0b.json` (below).

### C8 server skeleton (k3)

- **Mission.** Freeze the server side of Phase 5: additive interfaces, stub services, the `share` subkey, the robots
  header, `hasRun`, fakes and the database tests.
- **Owned.** `S/db/**` (except `schema.ts`; `apps/server/drizzle/**` is the coordinator's), `S/**/types.ts` (listed
  in T1), `S/deps*.ts`, `S/services/{data,shares}/**`, `S/services/files/index.ts`,
  `S/services/chats/{store,index}.ts` (stub members only), `S/chat/{index,runs}.ts` (`hasRun`),
  `S/security/{keyring,headers}*`, `S/testing/**` (except `api-samples.ts`).
- **Read-only highlights.** `.tmp/p5-designs/{branching,data-share}.md`, ARCHITECTURE.md 6.8 – 6.10 and 8,
  `packages/shared/src/**` (C7's contracts), `apps/server/drizzle/0001_*.sql`.
- **Tasks.**
  1. **C8-T1 Types (additive)** — `services/chats/types.ts`: `ChatRecord.activeLeafId`; store `listPath(chatId,
     leafId)`, `appendMessage(chatId, message, parentId)`, `upsertMessage(chatId, message, parentId?)`,
     `setActiveLeaf(chatId, leafId, onlyFrom?)` (compare-and-set → boolean); service `switchBranch(id, messageId)`,
     `allIds()`, `importChat({ exported, id: 'keep' | 'new', restore })`, `removeAll({ usage })`; `replaceFrom` stays
     for now. `services/files/types.ts`: `importFile({ preferredId, sha256, name, mime, data, createdAt }) →
     { file, reused }`, `purge()`. New `services/data/types.ts` (`DataService`: `summary`, `exportBackup →
     { filename, stream }`, `importData`, `deleteAll`) and `services/shares/types.ts` (`ShareService`: `list`,
     `create`, `update`, `remove`, `view(token)`, `openFile(token, fileId)`). `chat/types.ts`: `ChatRunner.hasRun`.
     `security/types.ts`: `SubkeyName` + `'share'`. `S/types.ts`: `AppServices.data`, `AppServices.shares`.
  2. **C8-T2 Stub services** — `services/{data,shares}/index.ts` factories whose members throw `not_implemented`;
     wired in `deps.ts`; new store / service / files members stubbed the same way.
  3. **C8-T3 `hasRun`** — `ChatRunner.hasRun(chatId)` = the runs registry holds the chat in any phase (including
     `preparing`), unlike `isActive`.
  4. **C8-T4 Keyring** — HKDF subkey `share` (same salt and length as the others).
  5. **C8-T5 Robots header** — `SECURITY_HEADERS` gains `X-Robots-Tag: noindex, nofollow` (every response).
  6. **C8-T6 Fakes** — `S/testing/**` fakes for `DataService`, `ShareService` and the new `ChatsService` / files
     members, so W5.3 and W5.4 can test without W5.1.
  7. **C8-T7 Database tests** — `db.test.ts` expects 15 tables; an upgrade test migrates a temporary folder holding
     only `0000` (the copied SQL + a one-entry journal), inserts linear data including an empty chat, then migrates
     the real folder and checks the parent chain, the active leaf, `null` for the empty chat and the new index.
     *Accept:* the upgrade test fails if the backfill is removed from `0001`.
- **Tests.** Keyring (`share` differs from the other subkeys and is stable), headers (`X-Robots-Tag` on API and SPA
  responses), `runs.test.ts` (`hasRun` during `preparing`), the database tests above.
- **Verify.** Server commands.

### C9 web skeleton (k4)

- **Mission.** Freeze the web side of Phase 5: the `share` layout, the Share dialog mount, the ui store members, stub
  pages and components with their root test ids, every new test id and the "Data" settings link.
- **Owned.** `W/layouts/share.vue` (new), `W/layouts/default.vue` (mount `ShareDialog`), `W/stores/ui.ts` (+ test),
  stub pages `W/pages/settings/data.vue` and `W/pages/share/[token].vue`, stub components
  `W/components/settings/data/DataSettings.vue` and `W/components/share/{ShareDialog,SharesSettingsSection,
  SharedChatView}.vue`, `W/utils/testids.ts`, `W/components/app-shell/navigation.ts` (+ test),
  `W/components/settings/GeneralSettings.vue` (comment only). Those files only.
- **Read-only highlights.** UI.md 5, 6, 7.14, 7.15, 9.8, 10.4, 11, 13.6.
- **Tasks.**
  1. **C9-T1 `layouts/share.vue`** — no sidebar, no palette, no shortcuts dialog, no Share dialog: a header bar
     (h-12: `BrandMark` + `harness-forge` wordmark as plain text, `ThemeToggle collapsed` on the right) and a `<main>`
     with the page slot (UI.md 5).
  2. **C9-T2 `layouts/default.vue`** — mounts `<ShareDialog />` once, next to `CommandPalette` and `ShortcutsDialog`.
  3. **C9-T3 ui store** — `shareChatId: string | null`, `openShare(chatId)`, `closeShare()` (UI.md 11).
  4. **C9-T4 Stubs** — `pages/settings/data.vue` renders `DataSettings`; `pages/share/[token].vue`
     (`definePageMeta({ layout: 'share' })`) renders `SharedChatView :token`; each stub component has its UI.md 10.4
     props and renders its root test id (`data-settings`, `share-dialog` bound to `ui.shareChatId`, `shares-section`,
     `share-page`).
  5. **C9-T5 Test ids** — every id of UI.md 13.6 in `utils/testids.ts` (key = camelCase of the id, as listed there).
  6. **C9-T6 Settings link** — "Data" (`DatabaseIcon`, `/settings/data`, `testIds.settingsNavData`) in
     `SETTINGS_LINKS` between Appearance and About; `GeneralSettings.vue` comment: bulk data lives in Settings → Data
     (ADR-024).
- **Tests.** `ui.test.ts` (open / close the Share dialog), `navigation.test.ts` (link order), a stub mount test per
  new page.
- **Verify.** Web commands (`typecheck:fast` needs the coordinator's `.nuxt`; import new components by path).

### Wave P5-0b ownership

`?token?.vue` matches the literal Nuxt file `[token].vue`. The audit cannot express "except": `S/db/schema.ts` matches
C8's glob, but it is the coordinator's K3 edit.

```json
{
  "wave": "P5-0b",
  "agents": {
    "C8": [
      "apps/server/src/db/**",
      "apps/server/src/types.ts",
      "apps/server/src/services/chats/types.ts",
      "apps/server/src/services/chats/store.ts",
      "apps/server/src/services/chats/index.ts",
      "apps/server/src/services/files/types.ts",
      "apps/server/src/services/files/index.ts",
      "apps/server/src/services/data/**",
      "apps/server/src/services/shares/**",
      "apps/server/src/chat/types.ts",
      "apps/server/src/chat/index.ts",
      "apps/server/src/chat/runs.ts",
      "apps/server/src/chat/runs.test.ts",
      "apps/server/src/security/types.ts",
      "apps/server/src/security/keyring*",
      "apps/server/src/security/headers*",
      "apps/server/src/deps*.ts",
      "apps/server/src/testing/**"
    ],
    "C9": [
      "apps/web/app/layouts/share.vue",
      "apps/web/app/layouts/default.vue",
      "apps/web/app/stores/ui.ts",
      "apps/web/app/stores/ui.test.ts",
      "apps/web/app/pages/settings/data.vue",
      "apps/web/app/pages/share/?token?.vue",
      "apps/web/app/components/settings/data/DataSettings.vue",
      "apps/web/app/components/share/ShareDialog.vue",
      "apps/web/app/components/share/SharesSettingsSection.vue",
      "apps/web/app/components/share/SharedChatView.vue",
      "apps/web/app/utils/testids.ts",
      "apps/web/app/components/app-shell/navigation.ts",
      "apps/web/app/components/app-shell/navigation.test.ts",
      "apps/web/app/components/settings/GeneralSettings.vue"
    ]
  },
  "allow": [
    "apps/server/drizzle/**",
    "docs/ROADMAP.md",
    "docs/DECISIONS.md",
    "AGENT.md"
  ]
}
```

### Wave P5-0b cross-agent contracts

| Producer → consumer | Contract |
|---|---|
| C8 → W5.1 | `services/chats/types.ts` (store + service members), implemented in P5-A; the pre-approved CCR drops `replaceFrom` |
| C8 → W5.3, W5.4 | `services/{data,shares}/types.ts`, `FilesService.importFile` / `purge`, fakes in `S/testing/**` |
| C8 → W5.4 | keyring subkey `share`; `X-Robots-Tag` already on every response |
| C9 → W5.5 | `DataSettings` stub + page (UI.md 9.8) |
| C9 → W5.6 | `ShareDialog`, `SharesSettingsSection`, `SharedChatView` stubs; `ui.openShare` / `closeShare` / `shareChatId`; the `share` layout |
| C9 → everyone | `utils/testids.ts` (frozen after the gate) |

### Gate P5-0b

1. `node scripts/audit-ownership.mjs .tmp/waves/P5-0b.json`
2. `nuxi prepare` (K4) → `pnpm check` → `pnpm build` → the CSP test with `HF_TEST_REQUIRE_WEB_BUILD=1`.
3. `pnpm start:e2e` → `pnpm test:e2e` (27 still green).
4. **Upgrade probe** on the copy made in K3 (never on `.tmp/e2e` itself, which step 3 already migrated):
   ```sh
   HF_MOCK_PROVIDER=1 HF_OFFLINE=1 HF_PORT=8898 HF_DATA_DIR=.tmp/upgrade-v1 node apps/server/dist/main.mjs &
   db=.tmp/upgrade-v1/harness.db
   sqlite3 $db "SELECT count(*) FROM messages m WHERE m.parent_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM
     messages p WHERE p.id = m.parent_id AND p.chat_id = m.chat_id AND p.seq < m.seq)"          # 0
   sqlite3 $db "SELECT count(*) FROM messages WHERE parent_id IS NULL"                   # = chats with messages
   sqlite3 $db "SELECT count(*) FROM chats c WHERE active_leaf_id IS NOT (SELECT id FROM messages m
     WHERE m.chat_id = c.id ORDER BY seq DESC LIMIT 1)"                                  # 0 (null for empty chats)
   sqlite3 $db "SELECT name FROM sqlite_master WHERE name IN ('messages_chat_parent_idx', 'chat_shares')"  # 2 rows
   ```
   `GET /api/chats` lists the same chats as before; `GET /api/chats/<id>` of a few chats returns every message with
   `branches: {}`. Stop the probe server afterwards. (Without the `sqlite3` CLI, run the same queries through `node` +
   `@libsql/client`.)
5. FREEZE additions (see "FREEZE in Phase 5") → ROADMAP + wave log → commit
   `feat: add phase 5 schema, migration and skeletons`.

---

## Wave P5-A — features + stabilization

Nine agents in one launch against the P5-0b checkpoint (the coordinator builds it for W5.8).

### Coordinator actions

- Before the launch: `pnpm build` of the P5-0b checkpoint (W5.8 runs its specs against it on its own slot), the
  ownership file `.tmp/waves/P5-A.json` (below), agent prompts with the "what exists now" section.
- **K5 at the gate**: audit; batch the CCRs (a missing test id, contract changes, W5.1's `types.ts` change, W5.4's
  `clientAddress` call sites switched to the trusted form); `nuxi prepare`; the gate commands and probes below; the
  screenshot review; `pnpm audit`; red items become W5.12 / W5.13 tasks with their globs.

### Wave rules

- Import new components explicitly by path; no `nuxt prepare` mid-wave.
- A new test id, a contract change or a frozen-file edit is a CCR in the report (with a local adapter).
- W5.3 and W5.4 use the C8 fakes for the `ChatsService` members W5.1 implements (`allIds`, `importChat`,
  `removeAll`, the active path of `get`); the real round trip is probed at the gate.
- No doc edits, except W5.9's `docs/phases/phase-4-hardening.md` checklist.
- Hot files have exactly one owner: `ChatHeader.*` → W5.6 (the rest of `W/components/chat/**` → W5.2);
  `W/stores/chats*` → W5.2 (implementation only); `useServerEvents*` → W5.2; `http/middleware/**` → W5.7.

### W5.1 branching-server (k1)

- **Mission.** Implement the message tree on the server: store, service, switch route, pipeline kinds, export v2 and
  import v1 + v2, plus the members the data feature needs.
- **Owned.** `S/services/chats/**` (incl. `types.ts` for the pre-approved CCR), `S/chat/**` except `chat/types.ts`,
  `S/http/routes/{chat,chats}{,.test}.ts`.
- **Read-only highlights.** `.tmp/p5-designs/branching.md`, ARCHITECTURE.md 6.1, 6.3, 6.8, 8; API.md (chat request,
  `chats.ts`, `chat.ts`); `S/db/schema.ts`, `drizzle/0001_*.sql`.
- **Tasks.**
  1. **W5.1-T1 Tree helpers** — new `services/chats/tree.ts`: `pathTo`, `branchesOf`, `latestLeafUnder`,
     `resolveLeaf`, pure functions over light rows `(id, parent_id, seq, role)`.
     *Accept:* siblings in `seq` order; first messages (parent `null`) are siblings of each other; the latest leaf
     under X is the highest `seq` in X's subtree; bad data (a cycle, a parent in another chat) terminates.
  2. **W5.1-T2 Store** — `listMessages` (every version, `seq` order); `listPath(chatId, leafId)` (recursive query up
     `parent_id` with the guard `m.seq < path.seq`); `appendMessage(chatId, m, parentId)` (404 `not_found` when the
     parent is not in the chat, 409 `conflict` `exists` for a used id); `upsertMessage(chatId, m, parentId)` (the parent
     is used on insert only); `setActiveLeaf(chatId, leafId, onlyFrom?)` (compare-and-set); `seq` = creation order
     (max + 1); `replaceFrom` removed and `parentId` required (pre-approved CCR).
  3. **W5.1-T3 Service** — `get`: `messages` = the active path, `branches` = the path messages with ≥ 2 versions;
     `switchBranch(id, messageId)`: active leaf = the latest leaf under `messageId`, `pending_approval` recomputed,
     `chat.updated` emitted, `updated_at` unchanged, 404 for an unknown chat or message, 409 `conflict`
     (`details.reason: 'run-active'`) while `runs.hasRun(id)` (checked by the route or through an injected check: the
     chats service does not depend on the runner); `allIds()`; `importChat({ exported, id, restore })`
     (validates the tree, remaps message ids / `parentIds` / `activeLeafId`, restores pinned, archived, dates and title
     when `restore`, emits `chat.created`); `removeAll({ usage })` (one batch, shares cascade, emits `chat.deleted` per
     chat, returns counts); search covers every version; totals sum every usage row.
  4. **W5.1-T4 Create / import** — `POST /chats` with `parentIds` (aligned by index; each parent an earlier message;
     ids unique; else 400 with the field path) and `activeLeafId` (active leaf = `latestLeafUnder(activeLeafId ?? last
     message)`); `messages` alone stays a linear import.
  5. **W5.1-T5 Export** — `format=json` writes v2 (every version + `parentIds` + `activeLeafId`); Markdown shows the
     active path; import accepts v1 and v2 (`chatExportAnySchema`).
     *Accept:* export → import round-trips versions and the active leaf.
  6. **W5.1-T6 Pipeline** — `RequestKind = 'new' | 'regenerate' | 'continuation'`; `classifyRequest`: 400 for
     `messageId` on a user submit, 400 for `parentId` on a regenerate or a continuation, 404 for an unknown parent;
     **new**: parent = `body.parentId ?? active leaf`, an existing id → 409, history = `listPath(parent)` + the user
     message, approvals superseded on that path only, the commit appends the user message and sets the active leaf to
     it; **regenerate**: target = `messageId ?? active leaf`, answered = the target when it is a user message, else the
     previous message on its path (must be a user message, else 400), nothing deleted, active leaf = answered;
     **continuation**: the message must be the active leaf (else 404); `#persist` runs `upsertMessage(reply,
     replyParentId)` and `setActiveLeaf(reply.id, [replyParentId, reply.id])` in one transaction, then `touch`; a
     force-released run stores nothing (the leaf stays on the user message); approvals on other versions stay pending.
  7. **W5.1-T7 Route** — `POST /chats/:id/branch` (`chats.switchBranch`) → `ChatDetail`.
- **Tests.** `tree.test.ts`; `index.test.ts` (append, CAS, `listPath`, `branches` in `get`, `switchBranch`: pending
  approval, event, `updatedAt` unchanged, 404, 409 through a fake `hasRun`; search hitting a hidden version);
  import/export (v2 round trip, v1 accepted, 400 cases); `history.test.ts` (new `classifyRequest` rules);
  `chat.test.ts` with `createTestApp` + `mock:echo` (an edit keeps the old version and switching back restores the
  later messages; regenerate mid-transcript; regenerate on a user message; omitted `parentId` appends; unknown parent
  404; `messageId` on a user submit 400; an approval pending on the other version is re-armed on switch and its
  continuation completes; `GET` during a regenerate run ends at the answered user message; resume replays exactly
  once); `chats.test.ts` (branch route 200, 400, 404, 409 during a gated run).
- **Verify.** Server commands.

### W5.2 branching-web (k2)

- **Mission.** Implement branching in the web app: request body rules, edit and regenerate flows, failed-message
  tracking, version switching and the `BranchSwitcher`.
- **Owned.** `W/composables/{useChatSession,useServerEvents}*`, `W/components/chat/**` except `ChatHeader*`,
  `W/stores/chats*` (implementation only), `W/utils/testing/fixtures.ts`.
- **Read-only highlights.** UI.md 7.5, 10.4, 11.1, 13.6; API.md (chat request, `chats.switchBranch`);
  `.tmp/p5-designs/branching.md` section 6.
- **Tasks.**
  1. **W5.2-T1 Request body** — user submit: `parentId: messages.at(-2)?.id ?? null`; regenerate: `messageId`;
     approval continuation: neither.
  2. **W5.2-T2 Edit** — `edit(messageId, text)`: truncate the local messages before the edited one, then
     `sendMessage({ text, files })` (new client id; the edited message's files are kept).
     *Accept:* the request carries `parentId` and no `messageId`; the old version stays on the server.
  3. **W5.2-T3 Failed unstored messages** — remember a user message whose request failed with an HTTP error
     (`APICallError` with `statusCode`: the server stored nothing); `send()` drops it first so `parentId` never names
     an unstored message; `regenerate()` re-sends only such a message, otherwise `chat.regenerate({ messageId })`.
  4. **W5.2-T4 Session state** — `branches`, `switching`, `switchBranch(messageId)` (calls `chats.switchBranch`
     directly; no-op while busy; keeps the message objects of the shared id prefix; 409 → the conflict toast +
     `resumeIfRunning()`; 404 → `refresh()`), `refreshBranches()` on `run.finished` after the session's own edit or
     regenerate (same path ids → only `branches` replaced; else the full detail).
  5. **W5.2-T5 `BranchSwitcher.vue`** — UI.md 7.5 / 10.4: first in the action row of user and assistant messages,
     always visible, `aria-disabled` at the ends and while busy or switching, ArrowLeft / ArrowRight, focus kept on the
     same control of the new version; `v-memo` gains `branches[message.id]` and `branches[message.id] !== undefined &&
     (busy || switching)`.
  6. **W5.2-T6 Regenerate everywhere** — offered on every finished assistant message (older ones hidden while busy,
     like Edit).
- **Tests.** `useChatSession` (body rules, edit, dropping failed messages, `switchBranch`, a branch refresh keeping
  message objects), `BranchSwitcher` (labels, counter, ends, keys, emits), `ChatMessage`, `ChatTranscript` (focus after
  a switch), `ChatView`.
- **Verify.** Web commands.

### W5.3 data-server (k3)

- **Mission.** Implement bulk data: summary, streamed zip export, import of a backup or a single chat, delete-all.
- **Owned.** `S/services/data/**` (except the frozen `types.ts`), `S/services/files/**` (except `types.ts`),
  `S/http/routes/data{,.test}.ts`, `S/plugins/install/zip{,.test}.ts` (additive).
- **Read-only highlights.** `.tmp/p5-designs/data-share.md` sections 1, 5, 7, 9; ARCHITECTURE.md 6.9; API.md
  (`data.ts`); C8 fakes.
- **Tasks.**
  1. **W5.3-T1 Summary** — `GET /data` → `DataSummary` (chats, archived chats, messages of every version, files, bytes).
  2. **W5.3-T2 Streamed export** — fflate `Zip` with `ZipPassThrough` / `ZipDeflate` in a pull-based
     `ReadableStream` (one chat or one 64 KB file chunk per pull); layout of ARCHITECTURE.md 6.9; `manifest.json`
     written last with exact counts; `settings.json` = public `Settings` only, when `settings=true`; files stored for
     images / PDF and deflated for text; entries mode 0644 with mtime = `exportedAt`; a pre-check answers 413
     (suggesting `files=false`) above 3.5 GiB or 65k entries (no zip64); HEAD cancels the stream at once.
     *Accept:* a seeded secret sentinel never appears in the zip.
  3. **W5.3-T3 `openZip()`** — additive lazy reader in `plugins/install/zip.ts` reusing the installer guards
     (traversal, symlinks, duplicates, entry count, declared size, exact inflation, CRC, overlapping entries).
  4. **W5.3-T4 Import** — sniff `PK` (backup) vs `{` (single chat v1 / v2); caps 64 MiB per chat entry and 20 MiB per
     file before inflating; a single top-level folder is accepted; unknown entries → warning; a newer manifest version
     → 400; per chat in order: `skip` (idempotent) or `copy` (new ids, " (imported)" appended); files re-hashed against
     the index, re-sniffed and remapped through `files.importFile`; `/api/files/<id>` URLs rewritten in `file` and
     `reasoning-file` parts; `chats.importChat({ exported, id: copy ? 'new' : 'keep', restore: true })`; one failing
     chat is reported without stopping the others; `restoreSettings` applies known keys only, each validated.
  5. **W5.3-T5 Delete-all** — mutex → `chats.allIds()` → `runs.stop` for every id (covers `preparing`) →
     `chats.removeAll({ usage })` (shares cascade) → optional `files.purge()` (rows and blobs) → stop any run whose chat
     appeared meanwhile; no new event types.
  6. **W5.3-T6 Mutex** — one import or delete-all at a time: 409 `conflict` with `details.reason: 'busy'`.
  7. **W5.3-T7 Files** — `FilesService.importFile` (dedupe by sha256, keep the preferred id when free) and `purge`.
- **Tests.** Round trip into a second app (chat ids, pinned / archived / dates, `parentIds` / `activeLeafId`,
  attachment bytes); lazy pulls, manifest last, public settings only, secret scan, `files=false`, zip64 limits; zip
  guards (traversal, symlink, bomb, count, CRC, oversized entry, missing manifest, newer version, blob hash mismatch,
  disallowed type); `skip` idempotent, `copy` remaps ids; file remapping (reused, new id, missing); v1 and v2 JSON; a
  failing chat does not stop the rest; mutex 409; events; delete-all (confirm literal, fresh auth, stops preparing and
  streaming runs, usage detached or deleted, shares cascade, rows and blobs removed); 413 above the body limit.
- **Verify.** Server commands.

### W5.4 shares-server (k4)

- **Mission.** Implement read-only share links: tokens, the sanitized snapshot, owner routes, the public view and
  file routes, expiry and rate limits.
- **Owned.** `S/services/shares/**` (except the frozen `types.ts`), `S/http/routes/shares{,.test}.ts`.
- **Read-only highlights.** `.tmp/p5-designs/data-share.md` sections 1, 2, 4, 7, 9; ARCHITECTURE.md 6.10 and 10.7;
  API.md (`shares.ts`); `S/http/middleware/request-info.ts`.
- **Tasks.**
  1. **W5.4-T1 Token** — the 16-char suffix of the share id + the first 22 base64url chars of `HMAC-SHA256(subkey
     'share', 'harness-forge/share/v1:' + shareId)`; timing-safe comparison; recomputed for `ShareSummary.path`
     (`/share/<token>`); nothing token-like is stored.
  2. **W5.4-T2 Snapshot** — the active path (`chats.get(id).messages`) through the allowlist sanitizer of
     ARCHITECTURE.md 6.10: drop system messages, instructions, `metadata.error`, usage and cost,
     `command.expansion`, provider metadata, approvals, `data-*`, `step-start`, `reasoning-file`, unknown parts and
     non-raster data URLs; keep reasoning and tool details sanitized (16 KB cap per value) so the options can be
     applied when the view is served; collect `file_ids`; snapshot > 10 MiB → 413.
  3. **W5.4-T3 Owner routes** — `GET /shares?chatId`, `POST /shares` (201, fresh, ≤ 20 per chat, `expiresAt` in the
     future and ≤ 365 days ahead), `PATCH /shares/:id` (title, options, `expiresAt`, `refresh: true`; fresh; the token
     never changes; changed options apply to the page at once, `refresh: true` re-snapshots), `DELETE /shares/:id`
     (not fresh).
     `outdated` = the chat changed after the snapshot (`chats.updated_at > snapshot_at`, or the active path length
     differs from `message_count`); `expired` = `expires_at <= now`.
  4. **W5.4-T4 Public routes** — `GET /share/:token` → `ShareView` (the options applied: reasoning, tool details and
     file parts left out when disabled; file URLs rewritten to `/api/share/<token>/files/<id>`);
     `GET /share/:token/files/:fileId` (only ids in `file_ids` and only with `options.attachments`; `Cache-Control:
     no-store`, `nosniff`, a sandbox CSP, `inline` only for raster images and PDF, `HEAD` supported). The same 404 for
     an invalid, bad-MAC, revoked or expired token and for a deleted chat (re-checked per request); GET routes write
     nothing.
  5. **W5.4-T5 Rate limits** — in memory, 429 + `Retry-After`: view 60 / min per address, files 600 / min per address,
     invalid tokens 20 / 10 min per address, 6000 / min globally; the address comes from `clientAddress(c)` of
     `http/middleware/request-info.ts` (W5.7 makes it proxy-aware; see the contracts table).
- **Tests.** Deterministic token per key; anonymous view on a password server; owner routes 401 without a session; a
  foreign host without a password still 403; revoked / expired / deleted-chat / bad-MAC → 404; kitchen-sink
  sanitization; snapshot = active path only; options applied per request (reasoning, tool details, attachments and
  the file route); file scoping, HEAD and headers; 429 + `Retry-After`; refresh and option changes keep the token;
  create / update need fresh auth, remove does not.
- **Verify.** Server commands.

### W5.5 data-web (k5)

- **Mission.** Build Settings → Data.
- **Owned.** `W/pages/settings/data.vue`, `W/components/settings/data/**`.
- **Read-only highlights.** UI.md 2.7, 9.8, 10.4, 13.6; `components/share/SharesSettingsSection.vue` (W5.6, a C9 stub
  until the gate); `components/common/ConfirmPasswordDialog.vue`; `utils/download.ts`.
- **Tasks.**
  1. **W5.5-T1 Summary + Export** — `GET /data` summary line; "Include attachments" / "Include settings" switches;
     the import-limit warning; "Export backup" → `data.export` + `downloadResponse` (413 → toast).
  2. **W5.5-T2 Import** — `.zip` / `.json` file (≤ 256 MB, checked before upload), "If a chat already exists" (skip /
     copy), "Restore settings" (zip only), result panel; afterwards `chats.fetchPage({ reset: true })` and, when
     settings were restored, `settings.fetch()`; 409 `busy` → toast.
  3. **W5.5-T3 Shared links** — mounts `SharesSettingsSection` (imported by path).
  4. **W5.5-T4 Danger zone** — the delete dialog (type `DELETE`, files / usage checkboxes), fresh auth through
     `ConfirmPasswordDialog` (8.4), then clear `hf-composer-draft:*` (sessionStorage) and `hf-unread`
     (localStorage), `chats.fetchPage({ reset: true })`, navigate to `/`.
- **Tests.** Type-to-confirm gating, import result rendering (every status), fresh-auth retry, export query from the
  switches, the import-limit warning.
- **Verify.** Web commands.

### W5.6 shares-web (k6)

- **Mission.** Build the Share dialog, the "Share…" menu items, the shared links settings section and the public,
  store-free share page with its auth exemptions.
- **Owned.** `W/components/share/**`, `W/pages/share/**`, `W/components/chat/ChatHeader{.vue,.test.ts}`,
  `W/components/app-shell/chat-nav/{chat-actions.ts,ChatNavRow.vue}`, `W/components/app-shell/ChatNav.test.ts`,
  `W/utils/redirect{,.test}.ts`, `W/middleware/auth.global.ts`, `W/plugins/api.ts`.
- **Read-only highlights.** UI.md 2.8, 2.9, 5.3, 5.6, 6, 7.14, 7.15, 10.4, 13.6; the reused part components in
  `W/components/chat/**` (W5.2's; import them, never edit them).
- **Tasks.**
  1. **W5.6-T1 Share page** — `SharedChatView` (UI.md 7.15): calls only `shares.view`; states loading / ready /
     unavailable (404) / error; reuses `TextPart`, `ReasoningPart`, `FilePart`, `SourcesPart`, `UserMessageBubble`,
     `ToolValueBlock` and a new `ShareToolRow` (never `ToolPart`, `ErrorPart`, `ChatMessage`, `MessageMeta` or
     `ModelLabel`, which need stores); `noindex` + `no-referrer` meta.
  2. **W5.6-T2 Auth exemptions** — `/share/*`: `auth.global.ts` returns before loading the auth status (so no login
     redirect and no event stream), `authRedirectFor` returns null, `plugins/api.ts` never redirects to `/login`.
  3. **W5.6-T3 `ShareDialog`** — UI.md 7.14: list, create, copy (`location.origin + path`), options, expiry, update
     snapshot with the outdated badge, revoke, the passwordless warning, fresh auth.
  4. **W5.6-T4 Menus** — "Share…" in `ChatHeader` and `ChatNavRow` → `ui.openShare(chatId)`.
  5. **W5.6-T5 `SharesSettingsSection`** — every share (copy, manage, revoke), refetched when the dialog closes.
- **Tests.** The share tree calls only `shares.view` (mocked `$api`); redirect exemptions; `ShareDialog` flows
  (create, copy, an option change sends only `options`, revoke confirm) + the passwordless warning + fresh-auth retry;
  `SharesSettingsSection`; menu items.
- **Verify.** Web commands.

### W5.7 security-proxy (k7)

- **Mission.** Trusted reverse proxies (S6), the CSP test gating (S3) and share-token masking in logs.
- **Owned.** `S/{env,main}{,.test}.ts`, `S/http/middleware/**`, `S/http/routes/auth{,.test}.ts`,
  `S/http/static.test.ts`, `S/security/{proxy-trust,redact}*`.
- **Read-only highlights.** `.tmp/p5-designs/stabilization.md` S3 and S6; ARCHITECTURE.md 10.1, 10.2, 10.6, 12.
- **Tasks.**
  1. **W5.7-T1 Env** — `HF_TRUST_PROXY` = comma list of `loopback`, `private`, IP addresses and CIDRs →
     `Env.trustProxy: readonly string[] | null` (unset = null = v1); `1`, `true`, hop counts and unknown tokens fail
     the boot with an `EnvError` that explains the format.
  2. **W5.7-T2 Matcher** — `security/proxy-trust.ts` on `node:net` `BlockList`: `loopback` = 127.0.0.0/8 + ::1;
     `private` = 10/8, 172.16/12, 192.168/16, fc00::/7; IPv4-mapped IPv6 normalized.
  3. **W5.7-T3 Resolution** — `http/middleware/request-info.ts`: only when the TCP peer is trusted, the client address
     = `X-Forwarded-For` walked right to left skipping trusted hops (≤ 32 entries, stop at a malformed entry,
     IPv4-mapped normalized; `Forwarded` ignored); `X-Forwarded-Proto` honored only from trusted peers when
     `HF_TRUST_PROXY` is set (unset = v1: always honored); `X-Forwarded-Host` is never honored (Origin check,
     `checkPasswordlessHost`). The helpers take the trust setting as a parameter; a call without it (`clientAddress(c)`)
     keeps compiling with the v1 behavior.
  4. **W5.7-T4 Effects** — the login limiter keys by the resolved address (the global 50 / 15 min cap stays); auth
     warnings log `address` and `peer`; the boot log lists the trusted ranges; one warning per untrusted peer that sends
     forwarded headers.
  5. **W5.7-T5 CSP test (S3)** — `static.test.ts`: `skipIf(!existsSync(built) && process.env.HF_TEST_REQUIRE_WEB_BUILD
     !== '1')`, and the first assertion checks that the build exists.
  6. **W5.7-T6 Token masking** — the access log writes `/api/share/[redacted]…` for share paths; `redactText` masks
     `/share/<token>` in any text.
- **Tests.** `env.test.ts` (valid / invalid table); `request-info.test.ts` (proxy chains, forged left-hand entries,
  untrusted peers, malformed entries, IPv6); `auth.test.ts` through `t.request(…, { remoteAddress })`: separate
  buckets per client behind a trusted proxy vs one bucket without trust, rotating forged `X-Forwarded-For` still hits
  the global cap, Secure / HSTS / Origin with trusted vs untrusted `X-Forwarded-Proto`, `Host: evil.example` +
  `X-Forwarded-Host: localhost` from 127.0.0.1 → 403; access-log and redactor masking.
- **Verify.** Server commands.

### W5.8 e2e-stabilization (e2e 8896)

- **Mission.** Close the W4.5 e2e gaps against the P5-0b build.
- **Owned.** `e2e/**`.
- **Read-only highlights.** `e2e/README.md` (helper API), UI.md 12, 13, 14.6; `playwright.config.ts`;
  `builtin-plugins/mock/models.ts` (`mock:echo` waits 50 ms, then 25 ms per word: 600 words ≈ 15 s).
- **Tasks.**
  1. **W5.8-T1 `core/resume.spec.ts` @smoke** — a reload mid-stream resumes (`streaming` again, first words shown,
     ends `done` with the last word, persisted once as the only reply); leaving the chat and returning; a second tab.
  2. **W5.8-T2 `core/keyboard.spec.ts` @smoke** — no clicks: Mod+Shift+O, Alt+M (pick a model), Enter, Esc, Shift+Esc,
     ↑ (edit), Alt+R, Alt+P, the approval card with Tab / Enter, Mod+/, Mod+B, Mod+K; `toBeFocused()` after each step.
  3. **W5.8-T3 `core/settings.spec.ts` @smoke** — General (send key, instructions), Appearance (`<html>` attributes,
     show thinking), Models (default model, hide / favorite, custom model), About (copy diagnostics with clipboard
     permission); every setting restored in `finally`.
  4. **W5.8-T4 `mobile/*.spec.ts`** — project `mobile` (UI.md 14.6): sheet sidebar, no horizontal scroll at 390 px,
     composer inside the viewport, model picker drawer, touch targets ≥ 40 px, a streamed reply.
  5. **W5.8-T5 `screenshots/screenshots.spec.ts` @screenshots** — skipped unless `E2E_SCREENSHOTS=1`; dark and light;
     1440×900 and 390×844; fixed `page.clock`; reduced motion; `.tmp/screenshots/{dark,light}/<screen>.png`.
  6. **W5.8-T6 README** — `e2e/README.md` lists the new specs, the `mobile` project and `E2E_SCREENSHOTS`.
- **Verify.** `pnpm test:e2e --list`; slot runs (`HF_MOCK_PROVIDER=1 HF_OFFLINE=1 HF_PORT=8896
  HF_DATA_DIR=.tmp/W5.8/data node apps/server/dist/main.mjs`, `E2E_BASE_URL=http://127.0.0.1:8896 pnpm test:e2e`);
  a fallback `mock:slow` model is a CCR, only if CI turns flaky.

### W5.9 quality (k9)

- **Mission.** The live provider suite (S7), the CSP step in CI (S3), dependency automation (S4) and the phase-4
  checklist (S2).
- **Owned.** `S/live/**`, `.github/**`, `docs/phases/phase-4-hardening.md`.
- **Read-only highlights.** PROVIDERS.md section 12; `.tmp/p5-designs/stabilization.md` S2, S3, S4, S7;
  `apps/server/vitest.live.config.ts`; `S/builtin-plugins/core-providers/providers/*.ts` (`credentials[].envVar`,
  `smallModelId`); `S/testing/**`.
- **Tasks.**
  1. **W5.9-T1 Live suite** — `S/live/matrix.ts` (env var names from `PROVIDER_DEFINITIONS` `credentials[].envVar`,
     aliases included; Ollama when `http://localhost:11434/api/tags` answers within 1 s, with the first model of its
     listing since it has no `smallModelId`; the `HF_LIVE_PROVIDERS` filter; the repository `.env` is read like
     `env.ts` does, variables already set win), `S/live/providers.live.test.ts`
     (`describe.runIf(process.env.HF_LIVE === '1')`; per provider, sequentially,
     `createTestApp({ env: { HF_OFFLINE: '1', <its key only> } })`; the six checks of PROVIDERS.md 12), caps through a
     test `chat.params` hook (256 output tokens, 2048 with reasoning, `maxSteps` 3), `HF_LIVE_MAX_COST_USD`
     (default 0.50), 429 → SKIP, a summary table (env var names, never values) to stdout and
     `$GITHUB_STEP_SUMMARY`, a check that no log record contains a key; `S/live/support.test.ts` unit-tests the
     matrix and the table in `pnpm test`.
  2. **W5.9-T2 CSP step** — `.github/workflows/ci.yml` `e2e` job, right after `pnpm build`: env
     `HF_TEST_REQUIRE_WEB_BUILD: '1'`, `pnpm -F @harness-forge/server exec vitest run src/http/static.test.ts`.
  3. **W5.9-T3 Audit workflow** — `.github/workflows/audit.yml` (push to `main`, pull requests, weekly, manual):
     `pnpm audit --prod --audit-level high --ignore-registry-errors` (no install needed).
  4. **W5.9-T4 Dependabot** — `.github/dependabot.yml`: `github-actions` weekly (one group); `npm` weekly with
     `cooldown` (7 days, 30 for majors), one `minor-and-patch` group, `open-pull-requests-limit: 5`, prefix
     `chore(deps)`, ignoring `typescript` majors and minors (ADR-013), `@types/node` majors and `pnpm`. If the first
     npm run fails on pnpm 11, drop the npm block and document Renovate as the fallback.
  5. **W5.9-T5 Live workflow** — `.github/workflows/live.yml`: `workflow_dispatch` only, a GitHub environment with a
     required reviewer holding the provider keys, `pnpm test:live`.
  6. **W5.9-T6 Phase-4 checklist** — tick 34 of the 39 boxes with `Evidence: <file> › <test>` or a wave-log commit;
     leave SEC-A3 (rewritten for `HF_TRUST_PROXY`), SEC-C1, SEC-I1, SEC-I3 and the release `actionlint` box to W5.11.
- **Tests.** `support.test.ts`; YAML passes `pnpm exec eslint .github --fix`.
- **Verify.** Server commands (the live file must be skipped by `pnpm test`); never `pnpm test:live`.

### Wave P5-A ownership

The audit reports `apps/web/app/components/chat/ChatHeader.*` under W5.2 and W5.6 (a warning, expected: they are
W5.6's); `apps/server/src/chat/types.ts` and `services/{data,shares,files}/types.ts` stay frozen despite the globs.

```json
{
  "wave": "P5-A",
  "agents": {
    "W5.1": [
      "apps/server/src/services/chats/**",
      "apps/server/src/chat/**",
      "apps/server/src/http/routes/chat.ts",
      "apps/server/src/http/routes/chat.test.ts",
      "apps/server/src/http/routes/chats.ts",
      "apps/server/src/http/routes/chats.test.ts"
    ],
    "W5.2": [
      "apps/web/app/composables/useChatSession*",
      "apps/web/app/composables/useServerEvents*",
      "apps/web/app/components/chat/**",
      "apps/web/app/stores/chats*",
      "apps/web/app/utils/testing/fixtures.ts"
    ],
    "W5.3": [
      "apps/server/src/services/data/**",
      "apps/server/src/services/files/**",
      "apps/server/src/http/routes/data.ts",
      "apps/server/src/http/routes/data.test.ts",
      "apps/server/src/plugins/install/zip.ts",
      "apps/server/src/plugins/install/zip.test.ts"
    ],
    "W5.4": [
      "apps/server/src/services/shares/**",
      "apps/server/src/http/routes/shares.ts",
      "apps/server/src/http/routes/shares.test.ts"
    ],
    "W5.5": [
      "apps/web/app/pages/settings/data.vue",
      "apps/web/app/components/settings/data/**"
    ],
    "W5.6": [
      "apps/web/app/components/share/**",
      "apps/web/app/pages/share/**",
      "apps/web/app/components/chat/ChatHeader.vue",
      "apps/web/app/components/chat/ChatHeader.test.ts",
      "apps/web/app/components/app-shell/chat-nav/chat-actions.ts",
      "apps/web/app/components/app-shell/chat-nav/ChatNavRow.vue",
      "apps/web/app/components/app-shell/ChatNav.test.ts",
      "apps/web/app/utils/redirect.ts",
      "apps/web/app/utils/redirect.test.ts",
      "apps/web/app/middleware/auth.global.ts",
      "apps/web/app/plugins/api.ts"
    ],
    "W5.7": [
      "apps/server/src/env.ts",
      "apps/server/src/env.test.ts",
      "apps/server/src/main.ts",
      "apps/server/src/main.test.ts",
      "apps/server/src/http/middleware/**",
      "apps/server/src/http/routes/auth.ts",
      "apps/server/src/http/routes/auth.test.ts",
      "apps/server/src/http/static.test.ts",
      "apps/server/src/security/proxy-trust*",
      "apps/server/src/security/redact*"
    ],
    "W5.8": ["e2e/**"],
    "W5.9": [
      "apps/server/src/live/**",
      ".github/**",
      "docs/phases/phase-4-hardening.md"
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

### Wave P5-A cross-agent contracts

| Producer → consumer | Contract |
|---|---|
| W5.1 → W5.2 | `ChatDetail.messages` = active path, `ChatDetail.branches`, `POST /chats/:id/branch`, the chat request rules (`parentId`, `messageId` regenerate-only) |
| W5.1 → W5.3 | `chats.allIds()`, `importChat()`, `removeAll()`, export v2 (frozen types; W5.3 tests with fakes) |
| W5.1 → W5.4 | `chats.get()` returns the active path; `chats.find()` for existence checks |
| W5.3 → W5.5 | `GET /data`, `GET /data/export`, `POST /data/import`, `POST /data/delete` (API.md) |
| W5.4 → W5.6 | `ShareSummary` (`path`, `outdated`, `expired`), `ShareView` (API.md) |
| W5.6 → W5.5 | `SharesSettingsSection` (no props), imported by path into `DataSettings` |
| W5.7 → W5.4 | `clientAddress(c)` keeps compiling with the v1 behavior; the coordinator switches W5.4's call sites to the trusted form at the gate (K5) |
| W5.7 ← W5.4 | share tokens never reach logs unmasked (access log + `redactText`) |
| W5.8 → W5.10 | the e2e helper API of `e2e/README.md` stays stable |

### Gate P5-A

1. `node scripts/audit-ownership.mjs .tmp/waves/P5-A.json`
2. **K5**: batch the CCRs (including W5.4's `clientAddress` call sites) → `nuxi prepare` → `pnpm check` →
   `pnpm build` → the CSP test with `HF_TEST_REQUIRE_WEB_BUILD=1`.
3. Probes on `pnpm start:e2e` (`b=http://127.0.0.1:8899/api`) and on probe servers (`HF_PORT=8897` / `8898`,
   `HF_DATA_DIR=.tmp/gates/P5-A/<name>`):
   - **Branch switch** — with `mock:echo`: send A, then B (no `parentId`), then an edit of A (a new user message id,
     `parentId: null`) → `GET $b/chats/<id>` shows 2 messages and
     `branches[<A2>] = { siblings: [<A>, <A2>], index: 1 }`; `POST $b/chats/<id>/branch {"messageId":"<A>"}` → 4
     messages (A, its reply, B, its reply); the same call during a long `mock:echo` reply → 409 `conflict`
     `run-active`.
   - **Export v2 round trip** — `GET $b/chats/<id>/export?format=json` → `version: 2` with `parentIds` and
     `activeLeafId`; `POST $b/chats` with that `chat` and a new id → the same versions and active leaf.
   - **Backup** — seed a sentinel key (`PUT $b/providers/openai/credentials {"values":{"apiKey":"sk-sentinel-p5a"}}`),
     `curl -s -o .tmp/gates/P5-A/backup.zip $b/data/export`; `unzip -l` lists `manifest.json`, `chats/*.json`,
     `files/index.json`; `unzip -p .tmp/gates/P5-A/backup.zip | grep -c sentinel` → 0; clear the key. Import the zip
     into a fresh probe server → the same chats; import again → every item `skipped`.
   - **Share** — probe server with `HF_PASSWORD=probe-password`: log in (cookie jar), create a chat, `POST $b/shares
     {"chatId":"<id>"}` → 201 with `path`; without cookies `curl -s <server>/api<path>` → 200 `ShareView`,
     `curl -sI` shows `X-Robots-Tag: noindex, nofollow`, `GET /api/chats` → 401; the server log never contains the
     token; `DELETE /api/shares/<shareId>` → the view answers 404.
   - **Trusted proxy** — probe server with `HF_TRUST_PROXY=loopback HF_PASSWORD=probe-password`: 5 wrong logins with
     `X-Forwarded-For: 203.0.113.10` → 401 ×5, the 6th → 429; a wrong login with `X-Forwarded-For: 203.0.113.20` →
     401 (a separate bucket). A second probe server with `HF_TRUST_PROXY=loopback` and no password:
     `curl -H 'Host: evil.example' -H 'X-Forwarded-Host: localhost' <server>/api/settings` → 403.
4. `pnpm test:e2e` (projects `chromium` + `mobile`) green.
5. `E2E_SCREENSHOTS=1 pnpm test:e2e --grep @screenshots` → review `.tmp/screenshots/{dark,light}/`.
6. `pnpm audit --prod --audit-level high` clean.
7. ROADMAP + wave log → commit `feat: add branching, data backup, share links and v1.1 hardening`.

---

## Wave P5-B — feature e2e, docs, fix-ups, final gate

### Coordinator actions

- Before the launch: the P5-A checkpoint build for W5.10; W5.12 / W5.13 globs from the red P5-A gate items added to
  `.tmp/waves/P5-B.json`; the agent reports of P5-A handed to W5.11.
- **K6**: the final gate below; ROADMAP (every Phase 5 box, backlog, wave log); the memory file; push only when the
  user asks.

### W5.10 e2e-features (e2e 8891)

- **Mission.** End-to-end specs for branching, data and share links, and screenshots of the new screens.
- **Owned.** `e2e/**`.
- **Read-only highlights.** UI.md 7.5, 7.14, 7.15, 9.8, 13.6; `e2e/helpers/auth-server.ts` (a separate password server
  with its own data directory: the shared e2e server is never wiped).
- **Tasks.**
  1. **W5.10-T1 `core/branching.spec.ts`** — send A, then B; edit A → "2/2" on the user message; "Previous version"
     brings back A and B; regenerate the last reply → "2/2" on the assistant message; a reload keeps the choice.
  2. **W5.10-T2 `core/data.spec.ts`** (own server through the `auth-server` helper) — export (the download is a zip),
     delete-all (type `DELETE`, password prompt), import → the chats return; import again → every item skipped.
  3. **W5.10-T3 `core/share.spec.ts`** (password server) — create a link in the Share dialog, open it in a fresh
     browser context without cookies → the read-only transcript; revoke → a reload shows "This link is unavailable".
  4. **W5.10-T4 Screenshots** — the Data page, the Share dialog, the share page and a message with versions join the
     `@screenshots` spec.
- **Verify.** `pnpm test:e2e --list`; slot runs on 8891; three green runs of the new specs.

### W5.11 docs-final (k2)

- **Mission.** Reconcile every doc with the code and the agent reports.
- **Owned.** `README.md`, `.env.example`, `docs/**` except `DECISIONS.md` and `ROADMAP.md`.
- **Tasks.**
  1. **W5.11-T1 Reconcile** — API.md vs the route table, UI.md 13 vs `utils/testids.ts`, component contracts,
     ARCHITECTURE.md vs the implemented flows (tokens, sanitizer, limits, `outdated`), README env table vs `env.ts`.
  2. **W5.11-T2 Deferred phase-4 ticks** — SEC-A3 rewritten for `HF_TRUST_PROXY`, SEC-C1, SEC-I1, SEC-I3, `actionlint`.
  3. **W5.11-T3 PROVIDERS.md** — live results into section 11 (when the coordinator ran the suite).
  4. **W5.11-T4 Status** — README "v1.1"; refresh `docs/assets/screenshots/` when the UI changed visibly.
- **Verify.** `pnpm check:english`; `pnpm -F @harness-forge/shared test` (doc-coupled tests).

### W5.12 / W5.13 fix-ups

Red gate items only; their globs are assigned at the P5-A gate and added to `.tmp/waves/P5-B.json`.

### Wave P5-B ownership

```json
{
  "wave": "P5-B",
  "agents": {
    "W5.10": ["e2e/**"],
    "W5.11": [
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
    ]
  },
  "allow": [
    "docs/ROADMAP.md",
    "docs/DECISIONS.md",
    "AGENT.md"
  ]
}
```

### Final gate (K6)

1. `node scripts/audit-ownership.mjs .tmp/waves/P5-B.json`
2. `pnpm install --frozen-lockfile` → `pnpm check` → `pnpm build` → the CSP test with `HF_TEST_REQUIRE_WEB_BUILD=1`.
3. The P5-A probes again.
4. `for i in 1 2 3; do pnpm test:e2e || exit 1; done` (both projects), with the OS color scheme emulated as light.
5. `E2E_SCREENSHOTS=1 pnpm test:e2e --grep @screenshots` → dark + light reviewed.
6. `pnpm audit --prod --audit-level high`.
7. Docker: `docker compose up -d --build`; `docker compose restart` keeps chats, keys and share links; **v1 upgrade**:
   build the v1 image from `4c461a0` (`git worktree add .tmp/v1 4c461a0 && docker build -t harness-forge:v1
   .tmp/v1`), run it on a fresh volume, create two chats, stop it, start the v1.1 image on the same volume → both
   chats load with a linear parent chain and new messages work.
8. Optional: `pnpm test:live` with the user's keys (ask first) → results to W5.11 / PROVIDERS.md 11.
9. ROADMAP + wave log → commit `chore: final gate for harness-forge v1.1`; update the memory file
   `harness-forge-rebuild.md`; push only when the user asks.

---

## Risks

| Risk | Mitigation |
|---|---|
| Migration data loss (foreign keys on; a drizzle table rebuild would cascade-delete inside the migration) | nullable `ADD COLUMN` only, no foreign keys on the new columns, reject SQL with `DROP TABLE` / `__new_`, two-stage upgrade test (C8), upgrade probe (P5-0b), Docker upgrade (final gate) |
| Doc-coupled tests (`routes.test.ts` vs API.md 8 + the DECISIONS table; `contract.test.ts`; `db.test.ts` vs `TABLE_NAMES`) | contracts, API.md and DECISIONS land in the same gate (P5-0a); schema and `db.test.ts` together in P5-0b |
| W5.1 is the critical path (store, pipeline, import/export and the members others need) | frozen types after P5-0b; fakes for W5.3 / W5.4; round-trip probe at the P5-A gate; fix-up agents in P5-B |
| Client and server paths drift (failed unstored message, second tab) | explicit `parentId` (404 → refresh), `send()` drops unstored messages, a switch returns the full detail, CAS on the active leaf, switching refused during runs |
| Branching regressions in resume, approvals and Stop | the resume spec lands in P5-A, before the P5-B e2e ×3; pipeline tests for every request kind |
| Share token leakage | HMAC tokens never stored, masked in logs, `no-referrer` + `noindex`, a share-scoped file route, the same 404 for every failure, fresh auth to create or update |
| Large imports and memory | 256 MiB body cap, lazy inflation, per-entry caps, the mutex, idempotent `skip`; docs recommend copying the data directory for full migrations |
| Proxy misconfiguration (`private` on a LAN) | docs recommend the proxy's exact IP; the global limiter cap; a warning per untrusted peer |
| `clientAddress` call-site drift between W5.7 and W5.4 | W5.7 keeps the v1 call compiling; the coordinator switches W5.4's call sites at the gate |
| Live-suite cost and key exposure | double opt-in (`HF_LIVE=1` + keys), token caps, a budget, no key output, manual-only CI, agents never run it |
| Dependabot vs pnpm 11 | probe the first run; Renovate as the documented fallback; pnpm upgrades stay manual |
| Hot files (`ChatHeader`, stores, test ids, the settings nav, `useServerEvents`) | exactly one owner per wave; test ids frozen after P5-0b |
| Audit flakes | a separate workflow with `--ignore-registry-errors` |
| CI time | mobile specs only in the `mobile` project; screenshots only with `E2E_SCREENSHOTS=1` |
