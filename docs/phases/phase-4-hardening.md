# Phase 4 — Hardening and release

Part of the harness-forge build plan. Progress is tracked in `docs/ROADMAP.md` (coordinator only). Shared names come
from `docs/DECISIONS.md`.

## Goal

Ship v1: close the security checklist, polish the UX to Claude Code desktop parity (mobile, a11y, states, light
theme, performance), package for production and Docker with CI, finish the docs and example plugins, and prove
stability with a full e2e suite that is green three times in a row.

## Entry criteria

- Phase 3 exit criteria met; W3 checkpoint commit exists; `@smoke` + `@plugins` green.
- The coordinator has built the W3 checkpoint for the e2e agent.

## Exit criteria

- ROADMAP items W4.1–W4.6 checked; final gate green; final checkpoint commit.
- The full e2e suite is green 3× in a row.
- Production starts from an empty data dir (`pnpm start` and Docker).
- The security checklist and the release checklist below are closed.

## Rules for every Phase 4 agent

- The FREEZE list still applies inside owned globs (W4.2 owns `apps/web/app/**`, but `components/{ui,ai-elements}/**`,
  layouts, store signatures and CSS tokens change only through CCRs; W4.2 may add test ids but never renames them).
- Security findings outside your owned paths go into your report (file, issue, proposed fix); the coordinator routes
  them to the owner of the next fix-up agent. Web findings from W4.1 go to W4.2.
- `pnpm build`, `pnpm start:e2e`, Docker and CI runs are executed by the coordinator at the gate; agents report the
  exact commands they expect to pass.
- Verify commands — server: `pnpm -F @harness-forge/server test` · `pnpm typecheck`; web:
  `pnpm -F @harness-forge/web test` · `pnpm -F @harness-forge/web typecheck:fast`; all: `pnpm check:english`.

---

## Wave W4

As scheduled in the ROADMAP: **Wave C** runs W2.6 and W3.6 (e2e of Phases 2 and 3), W4.1–W4.4 and W4.6 (core fixes)
in one launch; **Wave D** runs W4.5 (full e2e, 3 green runs) plus fix-ups.

### W4.1 security

- **Mission.** Audit the server against the security checklist, fix what lies in the owned paths, and add a test for
  every checklist item.
- **Owned.** `apps/server/src/http/middleware/**`, `apps/server/src/security/**`,
  `apps/server/src/plugins/install/**`, `apps/server/src/http/routes/plugin-files.ts` (+ test).
- **Read-only highlights.** the whole server, `docs/ARCHITECTURE.md` (security model), `docs/API.md` (auth rules).
- **Tasks.**
  1. **W4.1-T1 Audit** — walk every item of the security checklist; mark each with its test (file + test name) or
     evidence; list findings by owner.
  2. **W4.1-T2 Auth + CSRF** — close SEC-A* and SEC-B* in the middleware and security modules.
  3. **W4.1-T3 Headers** — close SEC-C* (CSP hashes regenerated from the built `200.html`, nosniff on icons).
  4. **W4.1-T4 Redaction** — close SEC-D* (logger, error envelopes, provider error sanitizing); findings in
     `providers/` or `chat/` are reported for fix-up.
  5. **W4.1-T5 Install + traversal** — close SEC-E* and SEC-F* in `plugins/install/**` and `plugin-files.ts`
     (archive name fuzz table, encoded and double-encoded paths, symlinks).
  6. **W4.1-T6 Report** — SSRF (SEC-G*), XSS (SEC-H*) and pins (SEC-I*) verified or forwarded with exact findings.
- **Tests.** One test per checklist item in the owned paths (route-table-driven where possible); the report lists
  the test that covers each item owned elsewhere.
- **Verify.** Server commands.

### W4.2 ux-polish

- **Mission.** Bring the web app to Claude Code desktop parity and production quality: mobile, accessibility, every
  empty/loading/error state, light theme and performance.
- **Owned.** `apps/web/app/**` (FREEZE still applies).
- **Read-only highlights.** `docs/UI.md`, `.tmp/gates/W2/`, `.tmp/gates/W3/` screenshots, W4.1 web findings.
- **Tasks.**
  1. **W4.2-T1 Parity pass** — spacing, typography, row heights, hover and focus states, header, composer and tool
     rows against UI.md; the "Removed vs Claude Code desktop" items stay absent.
  2. **W4.2-T2 Mobile** — sidebar as Sheet, composer pinned with safe-area insets, touch targets ≥40px, no
     horizontal scroll at 390px width.
  3. **W4.2-T3 Accessibility** — keyboard access to every menu and dialog, visible focus rings, `aria-label` on
     icon-only buttons, `aria-live` status for streaming, WCAG AA contrast in both themes, `prefers-reduced-motion`.
  4. **W4.2-T4 States** — empty, loading (skeletons) and error (with retry) for every page and list.
  5. **W4.2-T5 Light theme** — every screen reviewed in light; token changes go through a CCR.
  6. **W4.2-T6 Performance** — `v-memo` on finished messages, long transcripts stay smooth (1000 messages),
     Shiki/KaTeX/mermaid loaded on demand, route-level code splitting; initial JS size reported from
     `.output/public/_nuxt`.
  7. **W4.2-T7 Web security findings** — fix what W4.1 forwards (XSS, unsafe links, secrets in the DOM).
- **Tests.** component tests for new states and a11y roles; no test id renamed.
- **Verify.** Web commands.

### W4.3 packaging

- **Mission.** Make production builds, `pnpm start`, Docker and CI work from a clean checkout and an empty data dir.
- **Owned.** `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `.github/workflows/**`,
  `apps/server/tsdown.config.ts`, root `package.json` (the `scripts` field only; the coordinator approves the diff).
- **Read-only highlights.** `apps/server/src/main.ts`, `apps/server/src/http/static.ts`, `apps/server/drizzle/**`,
  `apps/server/assets/**`, `pnpm-workspace.yaml`.
- **Tasks.**
  1. **W4.3-T1 Server build** — tsdown bundles `apps/server/dist/main.mjs` (ESM, Node 22 target, runtime deps
     external); migrations and the catalog snapshot resolve from the package at runtime.
  2. **W4.3-T2 Start** — `pnpm start` serves API + SPA on :8787 and creates `HF_DATA_DIR`, `harness.db` and
     `secret.key` (0600) on first boot.
  3. **W4.3-T3 Docker** — multi-stage `node:24-alpine`; pnpm 11; `pnpm install --frozen-lockfile` + `pnpm build`
     in the build stage; production deps only in the runtime stage; non-root user; `HF_DATA_DIR=/data`,
     `VOLUME /data`, `EXPOSE 8787`, `HF_HOST=0.0.0.0` (so `HF_PASSWORD` or `HF_INSECURE=1` is required);
     `HEALTHCHECK` on `/api/health`.
  4. **W4.3-T4 Compose** — `docker-compose.yml`: port `8787:8787`, named volume on `/data`, `HF_PASSWORD` from
     `.env`, `restart: unless-stopped`.
  5. **W4.3-T5 CI** — `.github/workflows/ci.yml`: Node 24, pnpm 11, `pnpm install --frozen-lockfile`,
     `pnpm check`, `pnpm build`, `pnpm exec playwright install --with-deps chromium`, `pnpm start:e2e` in the
     background + wait for `/api/health`, `pnpm test:e2e`, Playwright report uploaded on failure; no secrets needed
     (mock provider).
- **Verify.** `pnpm typecheck`, `pnpm check:english`; the report lists the build, start and Docker commands the
  coordinator runs at the gate.

### W4.4 docs-examples

- **Mission.** Finalize the documentation against the real code and ship five example plugins that load and pass
  tests.
- **Owned.** `README.md`, `docs/{ARCHITECTURE,API,PLUGINS,PROVIDERS,UI}.md`, `docs/phases/**`, `docs/guides/**`,
  `docs/assets/**`, `examples/**`.
- **Read-only highlights.** `apps/server/src/env.ts`, `packages/shared/src/api/routes.ts`,
  `apps/server/src/db/schema.ts`, `apps/web/app/utils/testids.ts`, `apps/server/src/testing/**`.
- **Tasks.**
  1. **W4.4-T1 Reconcile docs** — README, ARCHITECTURE, API, PLUGINS, PROVIDERS and UI match the code (endpoints,
     env vars, tables, test ids, shortcuts) and the ROADMAP "Doc follow-ups" are applied; README env table and quick
     start use W4.3's final commands; README screenshots (dark + light) in `docs/assets/screenshots/`, captured from
     the production build with the mock provider (<= 300 KB each).
  2. **W4.4-T2 Guides** — `docs/guides/writing-a-declarative-provider.md`, `docs/guides/writing-a-code-plugin.md`
     (tool, provider, command, hooks; JSDoc and TypeScript entries; in-browser editor; linked-folder development;
     zip packaging; trust) and `docs/guides/adding-an-mcp-server.md`.
  3. **W4.4-T3 Examples** — `examples/plugins/{lmstudio,together-ai,dice-roller,echo-provider,mcp-everything}`
     (declarative LM Studio provider, declarative Together AI provider, code tool `roll_dice`, code provider, and
     `npx @modelcontextprotocol/server-everything` over stdio; PLUGINS.md section 15), each with a README; manifest
     `id` equals the directory name.
  4. **W4.4-T4 Example tests** — `examples/plugins/examples.test.ts` parses every manifest with
     `pluginManifestSchema`, loads every example through `createTestApp()` and asserts `active` (stdio MCP: trusted
     and registered, never started), runs the dice tool, streams a chat from the echo provider, runs the LM Studio
     and Together AI manifests against a fake OpenAI-compatible server, and checks that the PLUGINS.md section 15
     snippets equal the example files. The coordinator adds `'examples'` to `test.projects` of the root
     `vitest.config.ts` (a folder without its own config: project name `examples`, default include).
- **Verify.** `pnpm exec vitest run --project examples`, `pnpm check:english`.

### W4.5 e2e-full

- **Mission.** Complete e2e coverage, remove flakiness, produce screenshots and prove the suite green 3× in a row.
- **Owned.** `e2e/**`.
- **Read-only highlights.** `docs/UI.md`, `apps/web/app/utils/testids.ts`, `playwright.config.ts`.
- **Tasks.**
  1. **W4.5-T1 Coverage** — every page; settings flows; plugin flows; shortcuts (Mod+K, Mod+Shift+O, Mod+B, Mod+/,
     Shift+Esc, Alt+M / Alt+R / Alt+P); mobile viewport; keyboard-only chat; `mock:error` alert; resume after a
     reload mid-stream.
  2. **W4.5-T2 Flake hardening** — no fixed sleeps, web-first assertions, unique ids per test, cleanup of created
     chats/plugins.
  3. **W4.5-T3 Screenshots** — `@screenshots` spec: every main screen in dark and light at 1440×900 (plus 390×844
     for chat and sidebar) into `.tmp/screenshots/{dark,light}/<screen>.png`.
  4. **W4.5-T4 Stability** — `for i in 1 2 3; do pnpm test:e2e || exit 1; done` on the agent slot against the W3
     build for the parts that exist; the final run happens at the gate.
- **Verify.** `pnpm test:e2e --list`, slot runs (`HF_MOCK_PROVIDER=1 HF_PORT=889k HF_DATA_DIR=.tmp/W4.5
  pnpm start`, `E2E_BASE_URL=http://127.0.0.1:889k`).

### W4.6 core-fixes

- **Mission.** Fix the core issues found at the Wave B gate (ROADMAP "Core fixes for Wave C").
- **Tasks.**
  1. Tool-call history when the chat's `toolMode` is `off` or the model has no tool support (earlier tool parts must
     still convert into valid model messages).
  2. `PluginHost.refresh(id)` after a trust re-pin, so the plugin detail never shows a stale `trust.hash`.
  3. `CredentialService.setFor(providerId, fields, values)` for the provider drafts, instead of writing the secret
     layout directly.
  4. `PluginHost.onStateChange` instead of the `core-mcp` bridge.
  5. Stable `plugins/host.test.ts` fs.watch tests under full-suite load; the body-limit streamed-multipart cancel no
     longer causes an unhandled rejection (with W4.1).
- **Verify.** Server commands.

### Wave W4 ownership

```json
{
  "wave": "W4",
  "agents": {
    "W4.1": [
      "apps/server/src/http/middleware/**",
      "apps/server/src/security/**",
      "apps/server/src/plugins/install/**",
      "apps/server/src/http/routes/plugin-files.ts",
      "apps/server/src/http/routes/plugin-files.test.ts"
    ],
    "W4.2": ["apps/web/app/**"],
    "W4.3": [
      "Dockerfile",
      "docker-compose.yml",
      ".dockerignore",
      ".github/workflows/**",
      "apps/server/tsdown.config.ts",
      "package.json"
    ],
    "W4.4": [
      "README.md",
      "docs/ARCHITECTURE.md",
      "docs/API.md",
      "docs/PLUGINS.md",
      "docs/PROVIDERS.md",
      "docs/UI.md",
      "docs/phases/**",
      "docs/guides/**",
      "examples/**"
    ],
    "W4.5": ["e2e/**"]
  }
}
```

### Wave W4 cross-agent contracts

| Producer → consumer | Contract |
|---|---|
| W4.1 → W4.2 | web findings (file, issue, fix) forwarded by the coordinator |
| W4.2 → W4.5 | existing `data-testid` values never change; new states get new ids in `utils/testids.ts` |
| W4.3 → W4.4 | final `pnpm start` / Docker commands and env defaults feed the README |
| W4.4 → README | README screenshots are captured by W4.4 into `docs/assets/screenshots/` (W4.5 screenshots stay in `.tmp/screenshots/` for review) |
| W4.4 → W4.5 | examples are read-only e2e inputs |

## Hardening notes (from earlier gates)

Known issues collected at the Wave A and B gates; each is either fixed in Wave C or stays documented here.

| Note | Where | Status / owner |
|---|---|---|
| `plugins/host.test.ts` hot-reload (fs.watch) tests are timing-sensitive under full-suite load | server tests | W4.6 |
| markstream-vue CSS ships unscoped `.container` rules that can leak into the app layout | web (`Markdown.vue`) | W4.2 to scope or override |
| The copied AI Elements components that import `vue-stream-markdown` are unused (candidate to drop the dependency and its `overrides` pin) | web dependencies | coordinator decision |
| The login rate limiter ignores `X-Forwarded-For` | server | documented (reverse-proxy caveat, SEC-A3) |
| `apps/server/assets/catalog/` (models.dev snapshot) and `apps/server/drizzle/` must ship next to `dist/` | packaging | W4.3 (Dockerfile copies both; ARCHITECTURE.md section 11) |

## Security checklist

Each item is closed by a named test or documented evidence (W4.1-T1). Items owned outside W4.1's paths are verified
by W4.1 and fixed by the owner or a fix-up agent.

**A. Auth**
- [ ] SEC-A1 With a password set, every non-public `/api/*` route returns 401 `unauthorized` without a session
  (route-table-driven test; public: `GET /health`, `GET /auth/status`, `POST /auth/login`, `POST /auth/logout`,
  `GET /icons/lobe`, `GET /icons/lobe/:slug`).
- [ ] SEC-A2 `hf_session` is HttpOnly, SameSite=Strict, Secure on HTTPS, HMAC-verified, expires, and is invalidated
  by a password change.
- [ ] SEC-A3 Login is rate-limited with backoff; password checks are constant-time scrypt. The limiter keys on the
  socket address and ignores `X-Forwarded-For`, so behind a reverse proxy every client shares one bucket
  (documented in ARCHITECTURE.md section 10 and the README).
- [ ] SEC-A4 A non-loopback bind is refused without `HF_PASSWORD` or `HF_INSECURE=1`.
- [ ] SEC-A5 Fresh auth (ADR-017, API.md): with a password set, installing or trusting code / stdio-MCP plugins,
  scaffolding and building code plugins, creating or changing stdio MCP servers and changing the password need a
  login within the last 10 minutes, else 403 `forbidden` (route-table-driven test). So do file writes/deletes,
  build and reload of code plugins; afterwards a `created` plugin re-pins its trust automatically (ADR-017).

**B. Origin / CSRF**
- [ ] SEC-B1 Every state-changing request needs a same-origin `Origin` (or `Sec-Fetch-Site: same-origin`); otherwise
  403 `forbidden`.
- [ ] SEC-B2 No CORS headers are ever sent; GET/HEAD never change state (including `GET /events`).
- [ ] SEC-B3 JSON endpoints reject non-JSON content types (no form-encoded CSRF).

**C. CSP and headers**
- [ ] SEC-C1 CSP on SPA and API responses: `default-src 'self'`, inline scripts only by hash, no `unsafe-eval`,
  `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`.
- [ ] SEC-C2 `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy:
  same-origin`.
- [ ] SEC-C3 SVG icons are served as `image/svg+xml` with `nosniff` and rendered only via `<img>` or CSS mask.

**D. Secret redaction**
- [ ] SEC-D1 No API response contains a stored secret (sentinel secrets in every scope; all GET responses grepped).
- [ ] SEC-D2 Logs redact `authorization`, `cookie`, `x-api-key` and fields matching `key|secret|password|token`;
  message contents never appear at info level.
- [ ] SEC-D3 Provider error messages are sanitized before they reach clients or logs.
- [ ] SEC-D4 Secrets use AES-256-GCM with AAD `<scope>/<name>`; `secret.key` is 0600; `HF_MASTER_KEY` is validated.
- [ ] SEC-D5 Chat exports, diagnostics and plugin exports contain no secrets.

**E. Install guards**
- [ ] SEC-E1 Zip-slip, absolute, drive-letter, backslash and symlink entries are rejected; 20 MB / 100 MB / 2000
  entry limits hold.
- [ ] SEC-E2 npm `dist.integrity` (sha512) and URL `integrity` are verified; lifecycle scripts never run.
- [ ] SEC-E3 Staging + atomic swap; a failed install leaves the previous version active.
- [ ] SEC-E4 Code and stdio-MCP plugins load only when `trusted_hash` matches, re-checked at every load.
- [ ] SEC-E5 Reserved plugin ids and the `<pluginId>` / `<pluginId>-*` provider id rule are enforced.

**F. Path traversal**
- [ ] SEC-F1 Plugin file API, plugin icon, file download, LobeHub slug, static serving and export filenames reject
  `..`, encoded and double-encoded separators, absolute paths, NUL bytes and symlink escapes (realpath checks).

**G. SSRF**
- [ ] SEC-G1 `web_fetch` blocks loopback, private, link-local, CGNAT, cloud-metadata and IPv6 ULA/link-local targets
  and re-checks every redirect. The `core-tools` setting `allowLocalhost` (default off) admits loopback only.
- [ ] SEC-G2 Documented by design: user-configured provider base URLs and MCP URLs may target localhost; plugin
  `ctx.fetch` is unrestricted in v1 (code plugins run with server permissions).

**H. XSS**
- [ ] SEC-H1 No `v-html` anywhere (`vue/no-v-html` is an error; `grep -r "v-html" apps/web/app` finds nothing
  outside `components/ui` and `components/ai-elements`, and those are reviewed).
- [ ] SEC-H2 Markdown escapes raw HTML; links are limited to `http`, `https`, `mailto` with
  `rel="noopener noreferrer"`.
- [ ] SEC-H3 Plugin-provided strings (names, descriptions, logs, tool input/output) render as text; plugin icons
  only via `<img>` or CSS mask.

**I. Dependency pins**
- [ ] SEC-I1 `pnpm why typescript` shows only 6.0.x; `pnpm why vue-stream-markdown` shows only 1.x (or none once the
  copied AI Elements components no longer import it).
- [ ] SEC-I2 CI installs with `--frozen-lockfile`; `allowBuilds` lists only reviewed packages.
- [ ] SEC-I3 `pnpm audit --prod` reviewed by the coordinator; high/critical findings fixed or documented.

## Release checklist

- [ ] **Build** — `pnpm install --frozen-lockfile && pnpm check && pnpm build` green.
- [ ] **Empty data dir** — `rm -rf .tmp/release && HF_DATA_DIR=.tmp/release pnpm start` creates the directory,
  `harness.db` and `secret.key` (0600); `GET /api/health` → 200; http://localhost:8787 loads dark.
- [ ] **Password mode** — `HF_PASSWORD=secret pnpm start` shows the login page; `/api/providers` → 401 without a
  session.
- [ ] **Docker** — `docker compose up -d --build` serves http://localhost:8787; `docker compose restart` keeps
  chats and keys in the volume; the container runs as non-root.
- [ ] **CI** — `.github/workflows/ci.yml` runs the gate commands (install, check, build, e2e); validated with
  `actionlint` when available (agents never push).
- [ ] **Docs** — README quick start verified from a clean checkout; env table matches `env.ts`; API.md matches the
  route table test; plugin tutorial walked through; ROADMAP fully checked.
- [ ] **Examples** — the 5 example plugins load `active` in tests; declarative examples appear in
  `GET /api/providers`.
- [ ] **Screenshots** — dark + light screenshots in `docs/assets/screenshots/` (<= 300 KB each), linked from README.
- [ ] **English** — `pnpm check:english` clean.

## Final gate (W4)

1. `node scripts/audit-ownership.mjs .tmp/waves/W4.json`
2. `pnpm install --frozen-lockfile` → `pnpm check` → `pnpm build`.
3. `pnpm start:e2e` → `curl -sf :8899/api/health` → `curl -N` chat stream with `mock:echo` (as in the W2 gate).
4. Full suite 3× with the OS color scheme emulated as light:
   `for i in 1 2 3; do pnpm test:e2e || exit 1; done`.
5. Screenshots (dark + light) of every main screen into `.tmp/gates/W4/`; refresh `docs/assets/screenshots/` when
   the UI changed visibly.
6. Security checklist and release checklist closed → ROADMAP + wave log → final checkpoint commit.

## Final acceptance (from the plan's Verification)

- `pnpm dev` → http://localhost:3000 loads dark with the OS in light mode; Light/Dark/System persists.
- Settings → Providers: a real key (e.g. DeepSeek or Anthropic) → Test ✓ → models with brand icons; chat streams
  markdown/code, the reasoning row, Stop, an auto title and the usage ring.
- Plugins: "Core providers" visible; a wizard-created provider (Ollama/LM Studio or the mock OpenAI fixture) chats;
  a Tool-template code plugin edited in the browser → tool call → approval card → result row; an MCP stdio server
  (`npx @modelcontextprotocol/server-everything`) works.
- `HF_PASSWORD=secret pnpm start` → login required; `/api/*` returns 401 without a session.
- `docker compose up` → app on :8787 with data persisted across restarts.
