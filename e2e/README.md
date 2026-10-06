# End-to-end tests

Playwright specs that drive the production build (`apps/web/.output/public` served by `apps/server/dist/main.mjs`)
in Chromium with the dev-only `mock` provider (`HF_MOCK_PROVIDER=1`, docs/PROVIDERS.md 8), including its media models
(images, speech to text, read-aloud), `mock:workspace` (the workspace tools of a project chat, Phase 7) and
`mock:checkpoint` / `mock:shell` (checkpoints, rewind, the sticky working folder and shell rules, Phase 8) and the agent
mocks `mock:compact`, `mock:plan`, `mock:todo`, `mock:subagent` and `mock:steer` (compaction, plan mode, todos,
sub-agents and the steer queue, Phase 9) and the customization mocks `mock:agents` and `mock:background` (custom agents,
commands and skills, background agents, Phase 10). Tests tagged `@smoke` in their title run at every gate (`--grep
@smoke`); every core test is.

```
e2e/
  helpers/            shared helpers (this file documents their API; keep it stable)
  specs/core/         core app: theme, navigation, chat, resume, keyboard, composer, settings, login (W2.6, W5.8),
                      branching, data (backup, delete-all, import), share links (W5.10), images, voice, versions,
                      edit attachments (W6.12), projects, workspace tools, key rotation and storage cleanup (W7.14),
                      changes panel, rewind, shell rules, sticky folder, automatic cleanup (W8.12), compaction, plan mode,
                      todos, sub-agents, file mentions, steer queue (W9.13), Customize, custom commands, custom agents,
                      skills, background agents, Remember, plan files (W10.13)
  specs/plugins/      plugins tab, install, wizard, code plugins, MCP (W3.6), plugin agents and skills (W10.13)
  specs/mobile/       phone layout, project `mobile` only (W5.8, W6.12, W7.14, W8.12, W9.13, W10.13)
  specs/tablet/       touch tablet (icon rail, Phase 7 – 10 controls), project `tablet` only (W6.12, W7.14, W8.12, W9.13,
                      W10.13)
  specs/screenshots/  screenshots for the visual review and the README images, opt-in with `E2E_SCREENSHOTS=1` (W5.8,
                      W6.12, W7.14, W8.12, W9.13, W10.13)
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

# screenshots (skipped without E2E_SCREENSHOTS=1); @screenshots includes the README images
E2E_SCREENSHOTS=1 pnpm test:e2e --grep @screenshots

# only the README images (.tmp/screenshots/readme/<name>.png, the file names of docs/assets/screenshots/)
E2E_SCREENSHOTS=1 pnpm test:e2e --grep @readme
```

| Variable | Meaning |
|---|---|
| `E2E_BASE_URL` | server under test (disables the config's webServer) |
| `E2E_AUTH_BASE_URL` | optional server started with `HF_PASSWORD`, used by the login and share specs; without it they start their own password server from `apps/server/dist/main.mjs` on a free port with a temporary data directory. The data spec never uses it: delete-all wipes every chat, so it always starts a server of its own |
| `E2E_AUTH_PASSWORD` | password of `E2E_AUTH_BASE_URL` (default `secret`) |
| `E2E_SCREENSHOTS` | `1` runs the `@screenshots` spec, `@readme` included (otherwise its tests are skipped) |
| `E2E_WORKSPACE_ROOT` | optional: the workspace root the Phase 7 specs create their project folders in; it must be one of the server's roots. Default: the first available root the server reports (`GET /api/projects/browse`), e.g. `<dataDir>/workspaces` |

Specs assume a server with `HF_MOCK_PROVIDER=1`, no provider keys in its environment and no password. They may
share one data directory across runs: every spec creates its own data (unique titles and texts from `uniqueId()`)
and restores any global state it changes (settings, provider switches, credentials, custom models, chats) through
the `cleanup` fixture, or in `finally` / `afterEach`. Prefer `cleanup`: it also runs after a timeout, when a
`finally` block can no longer reach the API (the test's request context is closed by then). Anything that needs a
password (login, share links, delete-all) runs on a second server from `startPasswordServer()`, never on the shared
one; a spec that wipes data asks for a server of its own (`dedicated: true`). The Phase 7 specs create their project
folders below the server's workspace root (`seedProject` / `seedWorkspaceFolder`, `workspace.ts`), with unique names, and
remove the projects and the folders through `cleanup`; they run on the host of the server (the folders are written
with Node's `fs`), never into a hard-coded `.tmp/e2e`. Phase 8: a git repository comes from `seedGitProject` (git
through `execFile` with argument arrays, inside the spec's own folder only; the test is skipped when `gitAvailable()`
is false); a global shell rule applies to every project of the server, so specs give it a unique prefix and remove it
through `cleanup`; the changes panel state (open, width, view) lives in the browser's `localStorage`, which every test
starts empty (a new browser context). Phase 9: specs that change Agent settings (`subagentModelRef`, `compactModelRef`,
`autoCompact`, `shiftTabModes`) restore them through `useAgentSettings` (`agent.ts`); the todo strip's open state
(`hf-todo-expanded`) lives in `localStorage` too. Phase 10: personal agents, commands and skills are global state of the
server, so every spec gives them unique names (`uniqueId`) and removes them by kind and name through `cleanup`
(`createPersonalDefinition` / `cleanupPersonalDefinition`, `customize.ts`; a delete with Undo re-creates a definition
under a new id); project definitions are files in the spec's own project folder (`seedProject` with `.harness/…` and
`.claude/…` files); plugins with agents, skills or commands are declarative plugins made through `POST /api/plugins` and
uninstalled through `cleanup` (`createCustomizationPlugin`); the background agent specs clear `subagentModelRef` (the
children run on the chat's model) and delete their chats, which stops every agent still running; the plan-file
settings are restored through `usePlanSettings`; `hf-background-expanded` and `hf-remember-target` live in
`localStorage`.

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
| `keyboard.spec.ts` | the chat without clicks: Mod+Shift+O, Alt+M (type + Enter picks), Enter, Esc (stop), Shift+Esc, ↑ (edit; checks only that the edited text is the last user message and a reply streams), Alt+R, Alt+P, Shift+Tab / Tab / Enter on the approval card, Mod+/, Mod+B, Mod+K; `toBeFocused()` after every step. Phase 8: Alt+C from the composer opens the changes panel on its active view tab (the arrow keys switch This chat / Git), Alt+C inside the panel closes it with focus on the toggle, Enter on the toggle opens it, Alt+C from the composer closes it with focus kept; Mod+/ lists "Show or hide changes"; a chat without a project has no toggle and ignores Alt+C. Phase 9: in a project chat Shift+Tab cycles Ask -> Accept edits -> Plan -> Ask ("Permission mode: …" in the composer's live region, focus kept), Enter while a `mock:steer` reply runs queues the message, Esc closes the `@` menu first (the reply keeps running), then stops the reply and the queued `/compact` returns to the composer. The shortcuts dialog's "Switch the permission mode" entry is a `test.fixme` (missing from the P9-A build; the working tree registers it) Phase 10: Esc in the composer stops a `mock:background` reply (`bg explore loop steps 10`) but never its background agent (the dock row and the API stay `running`); the Remember dialog opens on the selected target, the arrow keys switch it (held down: reka checks a radio the arrows focus only while the key is down), Mod+Enter saves to the custom instructions and focus returns to the composer, an empty dialog opens in the note and Esc cancels; the Customize editor opens on Name from the keyboard, Esc with changes asks "Discard changes?" (Keep editing), Tab leaves the body editor (no trap) and Mod+Enter in the body (`ControlOrMeta`, CodeMirror's host `Mod`) saves, focus back on New |
| `settings.spec.ts` | General (send key Mod+Enter in the composer, custom instructions), Appearance (theme, `data-reading-font` / `data-text-size` / `data-density` on `<html>`, "Expand thinking by default"), Models (default model, a custom model as favorite and hidden in the picker, removed), About (Copy diagnostics with clipboard permission: an allow-list report without secrets). Phase 9: General -> Agent (Automatic compaction, the compaction model, the sub-agent model with the warning "Mock Echo can't call tools, …" for a model without tools, Sub-agent max steps refusing 500 inline and saving 12 on Enter) and the Shift+Tab switch save at once and survive a reload Phase 10: Save approved plans (`settings-plan-files`) enables the Plan folder (`settings-plan-directory`), `../plans` is refused inline ("Use a folder inside the project, like .harness/plans.", the saved value stays), Esc restores, `docs/plans` saves on Enter, a reload keeps both |
| `branching.spec.ts` | message versions with `mock:echo` (docs/UI.md 7.5): A, then B; editing A shows "2/2" on the user message; "Previous version" brings back A, B and their replies (focus stays on the control); Regenerate on the last reply shows "2/2" on it; a reload keeps the versions; ArrowLeft in a switcher picks the previous version, which survives a reload; the server's `branches` match. Asserted through `message-branch*` (`data-index`, `data-count`, `data-message-id`, `aria-disabled`) |
| `data.spec.ts` | Settings -> Data on a password server of its own (`dedicated: true`): Export backup downloads a zip (`PK` magic, `manifest.json` counts, `chats/<id>.json` per chat, no share link or token); Delete all data needs exactly `DELETE` and, with the browser clock 11 minutes past the login (`page.clock.fastForward`), the password prompt, and also deletes the share links; importing the zip brings the chats back into the sidebar with their messages (no share link); a second import skips every chat Phase 10: the backup holds `customizations.json` with the seeded personal agent and command; delete-all keeps them, so the spec removes them before the import, and "Restore settings from the backup" brings them back ("2 personal definitions restored"); the second import keeps them ("0 personal definitions restored · 2 kept") |
| `share.spec.ts` | share links on a password server: "Share…" in the chat header menu, "Create link" (defaults, focused absolute URL); a browser context without cookies opens the link as the read-only transcript (title, messages; no sidebar, composer, actions or switchers; no session); Revoke… in the dialog, then a reload of the link shows "This link is unavailable". Phase 8 parity: a `mock:checkpoint` run in Accept edits whose shell calls the project rules `mkdir` and `ls` allowed shows the same on the chat page and the share page (tool details): `tool-row-rule` with `data-value` and its sr-only ", allowed by rule …", the spoken summaries ("Exit code 0", "New file, 1 line"), the terminal output (`$ mkdir …` with "Now in mock-dir", then `mock-dir $ ls`) and "Allowed by rule: …". Phase 9: a project chat with a steered `steps 3` turn (sent from the chat page after the first step), `mock:todo`, two `mock:subagent` sub-agents, an approved `mock:plan` plan (Accept edits), `/compact` and a `seen?` turn: with tool details the share page shows the steer as a user message between the two parts of its reply (the second starts with `Steered: …`), the todo rows ("3/3", the finished list), the sub-agents ("Explore" + description, the `list_directory` step, the report) and the plan ("Approved · Accept edits", `plan-body`); no `/compact` message, no divider, no `MOCK-SUMMARY` Phase 10: a project chat with a custom agent (`mock:agents` `agent <name>`), a project skill and a `bg explore` whose result came back through a server-started turn: with tool details the share page shows the custom task row (its name and description, its report), the background row ("· in the background") and "Loaded skill {name}" with the skill's content; no `task-result` note, no "Sent to the agent", the carrier message is dropped (three user messages) and the reply to the result stays |
| `images.spec.ts` | image generation (docs/UI.md 7.7, 7.16): `mock:image` from the picker's "Image models" group (`model-picker-group` `data-value="images"`), "Describe an image…", no effort / permission / context ring; `image-options-trigger` 16:9 and 2 images; a "slow" prompt shows `image-generating` (`data-count` 2, "Generating 2 images… Ns") until the gallery (`image-gallery` `data-count` 2, two `image-tile`s, `/api/files/` images of 320x180, no Copy or Read aloud); the stored reply has two file parts and `metadata.image`, never a `data:` URL; the lightbox (Previous disabled, Next focused, ArrowLeft, "1 / 2") and its same-origin Download (`image-download`, the stored file name, a PNG); Esc returns focus to the tile; Regenerate shows the placeholders again, then "2/2"; `mock:image-chat` (aspect ratio only, 3:2 → 318x212): text + a one-image gallery; `generate_image` with `mock:image-tool` (`imageModelRef` set through the API): the approval card, Allow → the tool row, the image below it, "Image tool result: 1 image(s)" |
| `voice.spec.ts` | voice (docs/UI.md 7.17, 7.18, 9.9) with `transcriptionModelRef` / `speechModelRef` set through the API: type "Hello ", record until the timer shows 0:01 (the indicator replaces the left tools, Send disabled), Stop → one multipart request with the part `file` (`dictation.webm`, `audio/webm…`, the WebM magic) and "Hello This is a mock transcription." with the focus back in the textarea; Alt+V starts and stops; Esc in the textarea, Esc on the mic and the indicator's Cancel drop a recording without a request; without a model the mic's setup popover leads to `/settings/media`; read aloud: the request body `{ text }`, `playing` (`aria-pressed`, "Stop reading"), the natural end of a 2 s clip, a second reply stops the first, Stop and Esc → `idle`; Settings → Media: the image, speech-to-text and read-aloud selects list only their kind, the language, the voice suggestions (`mock-voice-a`, `mock-voice-b`) and the speed save, Test voice sends `{ text, modelRef, voice }`, plays and stops; everything survives a reload |
| `versions.spec.ts` | version management (docs/UI.md 7.5, 14.1; ADR-030): "Delete this version" asks first (Cancel keeps every version and refocuses the button), "Delete version" shows the previous version (3 → 2 versions), announces "Version deleted" and focuses the switcher; down to one version: no switcher, focus on Copy; a remembered deep path (B'1 chosen under B, then an edit of A and back: B'1, not the newest B'2, also after a reload; deleting the edit returns to that path); two tabs: a switch in either tab and a deletion move the other one |
| `projects.spec.ts` | projects (docs/UI.md 2.12, 2.13, 7.20, 9.10): the switcher's "Add project…" opens the Add dialog, the folder browser opens the workspace root (a root itself cannot be submitted) and a seeded folder (name = its basename), "Project added", the switcher filters by the new project ("No chats in {name} yet"), and the folder shows the disabled "Project" badge afterwards; Settings -> Projects: "New folder" (a leading dot is refused inline) creates the folder on disk, the row shows the path and "0 chats", the same new folder again is `409` "A folder with this name already exists."; the switcher filters All chats / No project / a project (path and chat count in the menu, `hf-project-filter` in `localStorage`, the new-chat pill defaults to the filter's project) and a reload keeps the filter; Accept edits (`permission-option` `edits`) in a project chat is saved with the chat and survives a reload; a chat moves into the project from the header menu (toast "Moved to {name}", the chip), Undo moves it back, the row menu moves it again, and the chip's "No project" moves it out ("Moved out of {name}") and off a filtered list; deleting a project (confirm "Delete {name}?", "Project deleted") keeps its chat (no project) and its folder with its files |
| `workspace-tools.spec.ts` | `mock:workspace` in a project chat (docs/UI.md 2.14, 7.3, 7.19): in `ask` the write card previews the new file ("Create or overwrite mock-workspace.txt · 1 line", "Accept all edits in this chat", no "Always allow"), the edit card previews the diff, the edit row reads `+1 −1` (U+2212, `data-tone` success; `aria-hidden`, spoken "1 line added, 1 removed") and the write row "New · 1 line" (spoken "New file, 1 line"); the shell card ("Run this command?", "Approval needed: run cat mock-workspace.txt", the server warning) has neither "Always allow" nor the accept-edits checkbox and its button reads Run; then "Workspace done: Hello from the workspace agent.", `exit 0`, the expanded diff (`diff-view` `modified`, `diff-line` del / add) and terminal (`terminal-output` `ok`, `$ cat mock-workspace.txt`, stdout, "Exit code 0"), and the file on disk holds the edit; Accept edits: no write / edit card, the shell asks, Deny -> Denied + "The tool call was denied."; the checkbox switches the chat to `edits` (composer and server) and the edit runs without a card; a share link with tool details shows the row summaries and the diff on the share page. Phase 8, the sticky working folder with `mock:checkpoint`: the first shell row starts in the project folder (no `terminal-cwd`) and shows "Now in mock-dir" (`terminal-cwd-change`), the second reads `mock-dir $ ls`; a second turn in `ask` shows "In {project}/mock-dir" on the `mkdir` card and "In {project}/mock-dir/mock-dir" on the `ls` card (`data-slot="command-meta"`; the folder nests) |
| `data-maintenance.spec.ts` | Settings -> Data maintenance (docs/UI.md 9.8) on a password server of its own (`dedicated: true`, a rotation changes every session): the Encryption key rows (file, version 1, Never, "1 encrypted"), the Rotate dialog's effects with the counts ("(1 link)", "(1 waiting)"), exactly ROTATE, the password prompt 11 minutes after the login, the toast "Master key rotated" with "1 secret encrypted again · 1 approval expired", version 2; this browser stays signed in, another session is signed out; the old share URL is unavailable and the new one opens the transcript; the pending `mock_approval_tool` approval shows Denied without a card; Storage cleanup: a rowless blob two days old in `<dataDir>/files/<aa>/` -> "1 leftover file on disk can be removed", Remove… asks ("This deletes 1 leftover file on disk."), "Removed 1 leftover file from disk", the re-check reads "No unused files." with "Last cleanup", and the blob is gone. Automatic cleanup (Phase 8): off by default (`data-cleanup-auto-status` `off`, the interval disabled), on writes `fileSweep: 'daily'` and shows "Next automatic cleanup in …" (`never`), Every week writes `weekly` (`GET /data` `fileSweep`: no last attempt, `nextRunAt` in the future), a reload keeps both, off hides the next run and keeps the interval |
| `changes-panel.spec.ts` | the changes panel with `mock:checkpoint` (docs/UI.md 7.21): the toggle counts the files (`data-count` 1, "Show changes, 1 file changed", focus stays after a click); This chat: "1 file changed · +1 −1", the untracked note "2 shell commands in this chat may have changed files too. …", the row (`modified`, spoken "Modified … checkpoint.txt, 1 line added, 1 removed") expands to the diff; Revert asks ("Revert checkpoint.txt?", "… goes back to how it was before this chat changed it.") and writes the old text to disk, the row leaves ("No file changes in this chat yet.", count 0), the toast's Undo brings the agent's text back ("Restored checkpoint.txt"); Git on a `seedGitProject`: "On main · 1 file changed", the diff, Revert to the last commit, then "No changes since the last commit." / "On main"; another project's folder outside git keeps the Git view: "This project isn't a Git repository." (`not-a-repo`, panel `unavailable`), This chat still lists the file (`added`); Alt+C and the palette's "Show changes" open the pane on the focused view tab, Alt+C closes it with focus on the toggle; a mouse drag on `changes-resize` widens the pane and stores `hf-changes-width`, a reload keeps the pane open at that width, Close returns focus to the toggle and a reload keeps it closed. The arrow-key resize is a `test.fixme` (app bug: the handle ignores the arrow keys) |
| `rewind.spec.ts` | "Rewind files to here" with `mock:checkpoint` (docs/UI.md 7.22): only the user message an edit follows has `message-rewind` (not a later `mock:echo` turn, never a reply); the preview lists `checkpoint.txt` (`restore`) and the shell commands newest first (`ls`, then `mkdir -p mock-dir && cd mock-dir`), focus on Restore files; Restore writes the old text back, the toast "Restored 1 file" has Undo, focus returns to the button, Undo brings the agent's text back (its toast without Undo); Restore files and edit deletes a file the chat created (`delete`) and opens the editor on the message; a file changed by hand is a conflict (`data-conflict`, `rewind-force` unchecked): skipped ("Nothing was restored.", "Skipped 1 file changed outside this chat") unless forced; while another chat of the project runs a 400-word `mock:echo` reply the restore is refused ("Wait for the responses in this project to finish before rewinding files.", the dialog closes, focus on the button, the file unchanged) |
| `shell-rules.spec.ts` | shell rules with `mock:shell` (docs/UI.md 7.23, 9.10): the card's "Always allow commands starting with" suggests `echo` (This project), an edited prefix is checked (`ls` -> `no-match` "This doesn't match the command.", `sudo` -> `command-runner`; Run disabled meanwhile), Run saves the project rule, the next `echo` runs without a card with `tool-row-rule` `echo` and "Allowed by rule: echo"; a combined command shows one chip per part (`echo`, `pwd`) and the several-parts note, Deny saves nothing; a redirection shows the always-ask note instead of the option; a narrowed prefix with All projects saves a global rule another project's chat then runs without asking; Settings -> Projects: "Allowed commands…" (focus in the input, empty state), Enter adds and keeps focus, the same rule again is `409` "This rule already exists.", a one-word rule warns and is saved (sorted), `syntax` and `empty` are refused inline, Remove moves focus to the next rule, the row reads "1 allowed command"; "Allowed in every project" refuses `interpreter`, `cd`, `command-runner`, adds a unique global rule (`409` again for a repeat), keeps it after a reload and removes it |
| `compaction.spec.ts` | Phase 9 (docs/UI.md 7.24): `/compact` from the slash menu (`slash-menu-item` `compact`, server) with a focus in a `mock:echo` chat whose `compactModelRef` is `mock:compact`: the reply holds only `compaction-divider` (`manual`, `history`, `data-count` 6, "Conversation compacted", "6 messages summarized"), every row above it has `data-compacted`, the summary toggles (focus, `MOCK-SUMMARY:`, the footnote; focus stays on the toggle), a reload keeps it; two long `mock:compact` turns (`compactFiller`) fill the 2000-token window, the third reply opens with the automatic divider ("Conversation compacted automatically", 4 messages), the kept user message is not dimmed, the context ring drops and "Conversation compacted" is announced; with `autoCompact` off the third turn shows the `context-trimmed` notice and no divider. The announcement of a manual `/compact` is a `test.fixme` (app bug: the reply arrives within one tick, so ChatView's watcher sees `ready`) |
| `plan-mode.spec.ts` | Phase 9 (docs/UI.md 7.11, 7.25): the permission menu offers Plan (5 options) only in project chats; Shift+Tab cycles Ask -> Accept edits -> Plan -> Ask with "Permission mode: …"; `/mode plan` saves `settings.toolMode` (a reload keeps it); outside a project 3 options, "Plan mode works in project chats." and Shift+Tab moves the focus; `mock:plan` in Plan: the card (region "Plan", "from core-agent", no write yet), Keep planning with feedback ("Feedback sent. …", "Kept planning", `Revising: …`, a revised card, "Your feedback: …" in the row), "Approve, accept edits" ("Plan approved. Permission mode: Accept edits.", `write_file` without a card, `Plan done in mode edits.`, `notes.txt` on disk and in the changes panel); "Approve, ask before edits" -> the write card, then `Plan done in mode ask.`; with `shiftTabModes` off Shift+Tab moves the focus |
| `todos.spec.ts` | Phase 9 (docs/UI.md 7.25): a `mock:todo` run from the composer: the strip (recorded with `recordStates`) goes `0/3` -> `1/3 · Changing the code` -> `All tasks done` and hides after the run; three `todo_write` rows, the last "3/3" with the finished list, also after a reload; a pending `mock:plan` keeps an unfinished list (0/2): the strip stays after the run, its toggle ("Show tasks, 0 of 2 done" / "Hide tasks", "Tasks 0/2") shows the items, `hf-todo-expanded` remembers the state across a reload |
| `subagents.spec.ts` | Phase 9 (docs/UI.md 7.27) with `subagentModelRef` `mock:subagent`: two `task-block`s run at the same time (one recorded snapshot with both `running`), the live line shows `└ list_directory …` and then the report's first sentence, the triggers are named "Explore sub-agent: …, completed, 1 tool call" / "Sub-agent: …", expanding shows the prompt, the step, the report and the meta line, no approval anywhere, a reload keeps them; `loop` + Stop: both blocks `aborted` ("Stopped"), also after a reload; `write` in Accept edits: the general sub-agent's `subagent.txt` is in the changes panel and "Rewind files to here" deletes it ("Restored 1 file") |
| `mentions.spec.ts` | Phase 9 (docs/UI.md 7.26): `@pars` in a project chat: `mention-menu` ready with "Files in {project}", the first row `src/parser.ts` highlighted (`mention-highlight` "pars"), Enter inserts `@src/parser.ts ` and a project chip (`data-state` done), the sent message's echo holds the file's content; "Mention a file" (`composer-mention`) inserts `@` and the focus returns to the textarea; `@sr` + Enter opens the folder (`@src/`, two rows, no chip); Esc closes the menu and keeps the text; `a@b` searches nothing (`recordRequests` sees only the queries of the token after the blank); a chat without a project opens no menu and has no "Mention a file"; a removed project folder: `data-state` error, "The project folder is unavailable." |
| `steer-queue.spec.ts` | Phase 9 (docs/UI.md 7.26) with `mock:steer`: after the first step of `steps 10`, Enter and "Queue message" queue two messages ("Message queued"), each becomes a `steer-note` ("You · while it worked", `data-message-id` `msg_…`) and the final text lists both, also after a reload; `/compact` waits in the list ("Runs after this response", "Queued · 2 · sent at the next step"), Cancel moves the focus to the next row's Cancel, Edit moves the message back into the composer (toast), nothing starts afterwards; a message queued after the last step of `steps 2` becomes the next turn, started by the server (one `POST …/queue`, no `POST /api/chat` from the page); Stop empties the queue and restores the text and the file chip (toast); a second page sees the queue and its Cancel empties the first page's list |
| `edit-attachments.spec.ts` | attachments on edit (docs/UI.md 7.5, S8): the editor's chips (`message-edit-attachment`), "Remove {name}", the paperclip (`message-edit-attach`, Playwright's `filechooser` event: the hidden input has no test id) with an upload held by `page.route` (chip `uploading`, Send disabled and `aria-busy`), then Send: a new version with exactly the kept and the added file (UI, echo and server), the old version keeps its files; Cancel discards removals and uploads |
| `customize.spec.ts` | Phase 10 (docs/UI.md 2.17, 9.12): the settings nav and the palette ("Settings: Customize", `go-settings-customize`) open Customize on the Agents tab with the Built-in `explore` and `general`; New agent: an empty name ("Add a name." once left) and `explore` ("explore is a built-in name.") keep Save disabled, a name you already have is a 409 on the name field ("You already have an agent named {name}.", focus back on it); "Only these tools" with `read_file` and `list_directory` (no `task` in the list), the model `mock:agents`, an instructions body; the row shows "Mock Agents" and "2 tools" and the server stored them; Turn off (`off`, "Off"), Edit (focus on the description, focus back on the row's menu), Delete ("Delete {name}?", "Delete agent") and the toast's Undo (a new id, still off); a reload keeps it. Import… (the `filechooser` of the header button) reads a Claude Code file: the notes ("Imported from {file}. …", "Ignored: color, permissionMode", the model alias), `Read, Grep` mapped to `read_file`, `search_files`; Export .md downloads exactly the stored content (`download` event), which imports again with one note. A project: `.harness/agents` wins over `.claude/agents` (Shadowed, "Not used: the project's .harness/agents/{name}.md wins."), a file without a description is Invalid with "Add a description." in its diagnostics; View… shows the file (`customization-viewer`, the path, the body); Copy to personal saves a copy that the project's file shadows; a reload keeps `?project=`; without a project the copy is active. The server lists the scanned folders `.claude` first (the spec accepts both orders) |
| `custom-commands.spec.ts` | Phase 10 (docs/UI.md 7.8, 7.28): in a project chat the slash menu's group headings are `app`, `project`, `personal`, `plugin` in that order; `/remember` and `/compact` in App, a project command with its hint (`slash-menu-hint` `<file> [focus]`, named "/{name}, {description}, arguments <file> [focus]"), a subfolder command with its namespace (`slash-menu-detail` `frontend`), a personal command, a plugin command (its detail is not empty); a prefix keeps one group; `/{name} ` shows the ghost hint (`slash-argument-hint`, the textarea described "Arguments: …") until the first argument character; outside the project only App, Personal and Plugins. A project command with `model: mock:agents` and `allowed-tools: Read` sent from a `mock:echo` chat answers "Agents mock: On agents: hi there" (the chat keeps `mock:echo`), a `$ARGUMENTS` command on the chat's model echoes its expansion; after a reload the badges (`command-badge`, they come with the stored `metadata.command`) show "· Mock Agents", and on focus "Project command", "Runs on Mock Agents", "Tools limited to read_file". The plugin's name on the right of a freshly loaded chat page is a `test.fixme` (app bug: chat pages never load the plugins store, so the slash menu shows the plugin id) |
| `custom-agents.spec.ts` | Phase 10 (docs/UI.md 7.27) with `mock:agents` and `subagentModelRef` cleared: `agent {name}` for a project agent whose `tools` are `read_file`, `list_directory`, `write_file` gives a `task-block` with `data-kind="custom"` and `data-agent-type`, the label (`task-agent-label`) is the name, the trigger is named "Sub-agent {name}: Run {name}, completed, 1 tool call" and described by the agent's description and "Project: .harness/agents/{name}.md", hovering the label opens the card (`task-agent-card`, `task-agent-source`); the report lists only `list_directory, read_file` (Ask never offers `write_file`), no approval, the stored output keeps the agent snapshot, a reload keeps the block |
| `skills.spec.ts` | Phase 10 (docs/UI.md 7.28) with `mock:agents`: `skills?` lists the project skill, `skill {name}` gives the `skill` row ("Loaded skill", the name, "Project", named "Loaded skill {name}, Project") without an approval and "Skill loaded: …"; expanded, `skill-body` shows the description, the folder, the files (`ref.md`), the instructions and "The agent read these instructions."; a reload keeps it; an unknown skill reads "Couldn't load skill" and the reply "The tool call failed: … Unknown skill …" |
| `background-agents.spec.ts` | Phase 10 (docs/UI.md 7.27, 7.29) with `mock:background` and `subagentModelRef` cleared: `bg explore slow 6`: the launching block is `data-background="true"`, "In background" (named "…, running in the background"); the dock (open on a wide screen) reads "Background agents · 1 running" with the row's live line (`└ current_time`), its Stop named "Stop Background explore", Stop all and the footnote; when it finishes the server starts a turn: the carrier message holds the `task-result` note (`turn`, `completed`, "Background agent finished · Explore · Background explore", the summary) and "Sent to the agent", the reply "Background result: completed \| Report: background done", the announcement "Background agent finished: Background explore", the dock is gone, Show report opens the report, the block offers "Go to the result", a reload keeps it. `bg explore loop steps 10`: the composer's Stop aborts the reply and the agent keeps running; its row Stop ends it ("Stopped", "Report pending", no Stop all) and the next turn's reply holds its inline `aborted` note. Two loop agents: Stop all ends both, collapsed the line reads "2 background agents finished · reports pending", and the next turn delivers both notes ("Background result: aborted \| …"). `bg explore steps 10`: the result joins the running reply as an inline note ("Finished: in-run result completed", no extra turn); a running agent's row is back after a reload, and a second page sees it and its Stop reaches the first page |
| `remember.spec.ts` | Phase 10 (docs/UI.md 7.30) in a saved project chat: `/remember {text}` opens the dialog prefilled, on the checked project file ("AGENTS.md in {project} (new file)", the counter); Save writes `- {text}` into a new `AGENTS.md` ("Created AGENTS.md in {project}"), focus returns to the composer, the changes toggle counts it and the panel lists it; the project's instructions ("Saved to the instructions of {project}", shown by its Instructions dialog in Settings -> Projects) and the custom instructions ("Saved to your custom instructions", in Settings -> General); the last target is the next default and `hf-remember-target` holds it. On the new-chat page the project targets are disabled (`data-disabled`, `aria-disabled`, described "Open a chat in a project to use this."), the custom instructions are checked and an empty note keeps Save disabled; 2,001 characters show "Use at most 2,000 characters." ("2,001 / 2,000"); a project whose instructions hold 19,990 characters refuses the note inline (`remember-error` `validation_error`, "The instructions would be longer than 20,000 characters. Shorten them in Settings first.") and keeps the dialog open |
| `plan-files.spec.ts` | Phase 10 (docs/UI.md 7.25, 9.11) with "Save approved plans" on: a `mock:plan` plan approved with "Approve, accept edits"; the expanded plan row starts with the `plan-file` chip (`saved`, `data-path` `.harness/plans/<date>-plan.md`, "Saved to", "Plan saved to …"), the file holds the plan; Show changes opens the panel, which lists the plan file (`added`) and `notes.txt`; "Rewind files to here" lists both as deletes and removes them ("Restored 2 files") |

## Mobile specs (`specs/mobile`, project `mobile`)

docs/UI.md 14.6, with the existing test ids (Phases 5 and 6 add none for mobile). They are not tagged `@smoke`: the
full suite runs them, or `pnpm test:e2e --project=mobile`.

| Spec | Covers |
|---|---|
| `shell.spec.ts` | the sidebar is a sheet (dialog on the left edge, narrower than the screen) opened by the header's `sidebar-trigger`, closed by a navigation; its rows are touch targets of at least 40x40 px |
| `layout.spec.ts` | no sideways scroll at 390 px (`scrollWidth <= 390`) on `/`, a chat with wide markdown, `/plugins`, a plugin and every settings page; the composer inside the viewport on `/` and under a long transcript |
| `chat.spec.ts` | the model picker is a bottom drawer (full width, on the bottom edge); a `mock:echo` reply streams and finishes; composer toolbar buttons and message actions are touch targets of at least 40x40 px |
| `projects.spec.ts` | Phase 7 at 390 px: the new-chat project pill and its options are 40 px targets and a pick shows the project; the switcher is a 40 px row of the sheet, its menu fits the screen, a filter keeps the sheet open and filters the list; the header chip is icon-only (at most 44 px wide, named "Project: {name}") and a 40 px target; an expanded write diff whose removed line is long scrolls inside its own block (its scroller is wider than its box) and the page never scrolls sideways |
| `changes.spec.ts` | Phase 8 at 390 px: the changes toggle is a 40 px target; the panel is a right sheet (a dialog named "Changes", `data-variant="sheet"`, x = 0 and 390 px wide) with 40 px Close and Refresh; a row is 40 px tall and its Revert shows without hover (opacity 1) at 40 px; a diff whose removed line is long scrolls inside its block and the page never scrolls sideways; the revert confirmation fits the screen (Cancel keeps the sheet); Esc closes the sheet and focus returns to the toggle; "Rewind files to here" is a 40 px target without hover and the rewind dialog fits the screen with 40 px buttons. Phase 9: a pane opened at 1280 px closes when the viewport narrows to 390 px (no sheet opens by itself, also after a reload) while `hf-changes-open` stays `1`, and the pane is back at 1280 px |
| `agent.spec.ts` | Phase 9 at 390 px: while a `mock:steer` reply runs after a finished `mock:todo` list, the strip ("All tasks done"), the queue (a `/compact`) and the composer lie inside the screen in that order, with 40 px targets (strip toggle, Queue message, Edit, Cancel) and no sideways scroll; Stop restores the text; an expanded compaction summary (meta line hidden, 40 px toggle) and an expanded sub-agent block (40 px trigger) never scroll the page sideways; the plan card's buttons stack full width at 40 px, "Approve, accept edits" on top; the `@` menu spans the composer inside the screen with 40 px rows Phase 10: with a finished `mock:todo` list, a running `bg explore loop` agent and a running `mock:steer` reply with a queued `/compact`, the strip, the background agents (collapsed below md: one 40 px line "1 background agent · Background explore · …"), the queue and the composer lie inside the screen in that order without sideways scroll; opened, the row's Stop and Stop all are 40 px targets; the grouped slash menu spans the composer inside the screen, at most 40 % of its height; the Remember dialog fits the screen with 40 px targets, Save and Cancel |
| `customize.spec.ts` | Phase 10 at 390 px (docs/UI.md 9.12, 14.6): with a project selected (long names and paths, a shadowed and an invalid file) and a personal agent with a long description, Settings -> Customize never scrolls sideways (also on the Skills tab); the kind tabs sit in a row of their own (`overflow-x: auto`) with 40 px tabs; every row's `⋯` menu is a 40 px target and opens inside the screen; the editor is a full-width sheet inside the screen, its body editor at most half the screen tall, Save, Cancel and the model select 40 px targets; the viewer of a project file is a full-width sheet with 40 px Export .md and Copy to personal |
| `media.spec.ts` | Phase 6 at 390 px: the mic is a 40x40 target; recording and transcribing keep the layout (no sideways scroll, the indicator and the composer inside the viewport) and the textarea gets no focus afterwards (touch); a four-image gallery keeps two columns inside the column; the lightbox fits the screen; the image options trigger, Read aloud, Delete this version and the version switcher are 40x40 targets (sizes are polled: a dialog zooms in from 95%) |

## Tablet specs (`specs/tablet`, project `tablet`)

docs/UI.md 14.5, 14.7 (S9), with the existing test ids; not tagged `@smoke` (`pnpm test:e2e --project=tablet`).

| Spec | Covers |
|---|---|
| `touch-targets.spec.ts` | `pointer: coarse` and the sidebar in the page (not a sheet); collapsed with its own trigger, the icon rail is 56 px wide (the page, `getByRole('main')`, starts at x = 56; the sidebar fills the rail inside its 1 px border) in the chat, plugins and settings modes, every visible button and link of the rail is at least 40x40 px and inside the rail (the project switcher and the Projects settings link among them); the rail's "Expand sidebar" expands it again; Phase 7: in a project chat with a pending `mock:workspace` approval the expanded sidebar's project switcher, the header chip and the card's Deny and Allow are 40x40 px targets, and so is the "Accept all edits in this chat" checkbox (its `::after` hit area); Phase 8: the changes toggle, "Rewind files to here", the pane's Close and Refresh (1024 px: the desktop pane), a changes row (height), its Revert (shown without hover) and a 24 px hit area of `changes-resize`; on a pending `mock:shell` card the "Always allow commands starting with" checkbox, the prefix input (height), both scope options and Run; Phase 9: while a `mock:steer` reply runs, the todo strip toggle, "Queue message" and the queue's Edit and Cancel; in a project chat with sub-agents and a pending plan, both task triggers, the three plan buttons and the `@` mention rows (height) Phase 10: with two running background agents (1024 px: the dock opens by default) the dock's toggle, Stop all and both rows' Stop; the Remember dialog's three targets, Save and Cancel; the `⋯` menus of Settings -> Customize, the editor's Cancel and Save (height), its model select and its Tools options |

## Screenshots (`specs/screenshots`)

`screenshots.spec.ts` (`@screenshots`) runs only with `E2E_SCREENSHOTS=1`. It starts its own password-protected server
from the build (`startServer`, fresh data directory, whatever `E2E_BASE_URL` says), creates a few chats (markdown,
reasoning, tool result, pending approval, provider error, a chat whose first message and reply have two versions, a
chat with an outdated share link that includes reasoning and tool details, and a chat of two `mock:image` turns: one
16:9 image, then two variations of it), Phase 7 data (two projects and a plain folder with subfolders below the server's
workspace root; three `mock:workspace` chats in the `harness-forge` project: a finished auto run, a reply waiting for
its edit approval (the write allowed through `answerApprovals`) and an Accept edits reply waiting for its shell
approval; a two-day-old leftover blob in the file store), Phase 8 data (a few files in the `harness-forge` folder, then,
when git is installed, `initGitRepository` commits all of it; the project rules `ls`, `mkdir`, `pnpm test` and the
global rule `git status`; "Prepare the release checklist": a `mock:checkpoint` turn in Accept edits, then a `mock:shell`
turn that deletes `docs/old-notes.md` and creates `docs/release-notes.md`; "Check the build folder": a `mock:checkpoint`
run whose shell rows show the rule badges and the sticky folder; "Build the web app": a `mock:shell` reply waiting for
the approval of `pnpm build --filter web`), Phase 9 data (created first, so the sidebar lists it last; nothing writes into
the project folder: "Plan the cookie settings", a `mock:plan` reply in the `harness-forge` project waiting for its plan
approval; "Map the auth code", two finished `mock:subagent` sub-agents there; "Parser crash on empty input", three
`mock:echo` questions and `/compact keep the parser details`; "Fix the parser crash", a `mock:todo` run streamed with
`fetch` and stopped right after its second list, so the list stays at 1/3), Phase 10 data (created before Phase 9's:
agent, command and skill files in the `notes` project folder (`.harness/agents/test-writer.md` over
`.claude/agents/test-writer.md`, an invalid `.claude/agents/broken.md`, `/review` with its hint, `frontend/lint`, the
`release-notes` skill), never in `harness-forge`, whose files show in the mention and Git screens; the personal agents
`code-reviewer` and `test-writer` (shadowed in `notes`), the command `standup` and the skill `pdf-forms`; with the
sub-agent model cleared for a moment: "Find the flaky tests", a `mock:background` agent that reported through a
server-started turn, and "Review the release notes", a `mock:agents` chat in `notes` that ran `code-reviewer`), sets the
image, speech-to-text, sub-agent (`mock:subagent`) and compaction (`mock:compact`) models (no visible change elsewhere),
and
captures every screen in dark and light (stored color mode set by an init script), at 1440x900 and on a 390x844 phone
(Pixel 7, touch), with reduced motion and a browser clock that starts at a fixed time two minutes after the seed
(relative times read "2m ago"; the clock then runs, because a frozen clock stalls the transcript's scroll-to-bottom).
Files: `.tmp/screenshots/{dark,light}/<screen>-{desktop,mobile}.png`, for example `chat-desktop.png`,
`sidebar-mobile.png`. Screens: login, new-chat, chat, chat-reasoning, chat-tools, chat-approval, chat-error,
chat-versions (the "‹ 2/2 ›" switchers), chat-delete-version (the "Delete this version?" dialog), chat-images (the
galleries), chat-images-generating (a "slow" two-image turn in a chat of its own: the placeholder tiles),
composer-recording (the recording indicator at 0:02), project-switcher (the menu open; on the phone inside the
sheet), new-chat-project (the pill's menu), add-project (the Add dialog inside the plain folder), settings-projects,
chat-edit-approval, chat-shell-approval, chat-diff (the edit row expanded; also the phone's diff), chat-terminal (the
shell row expanded), Phase 8: chat-changes-panel (desktop: This chat with the diff open and the untracked note),
chat-changes-git (desktop: the Git view, three files, a diff open), chat-changes-sheet (mobile: the sheet with the diff),
chat-revert-confirm, chat-rewind-dialog (the file and three shell commands), chat-shell-approval-rule (the rule option
checked: `pnpm build`, the scope), chat-terminal-cwd (both shell rows expanded: "Now in mock-dir", `mock-dir $ ls`,
"Allowed by rule: …"), settings-projects-allowlist (the Allowed commands dialog of `harness-forge`),
settings-data-auto-cleanup (Automatic cleanup on, "Next automatic cleanup in 24h."), Phase 9: chat-plan-approval (the plan
card and the strip at 0/2), chat-todo-strip (the strip expanded at 1/3), chat-subagents (desktop: the explore block
expanded), chat-compacted (desktop: the dimmed rows and the open summary), chat-steer (a live `steps 20` run of its own:
a steer note, a queued `/compact`, text in the composer; the chat is deleted in `close`), composer-mention (`Update @re`
in a project chat), Phase 10: composer-slash-groups (desktop: `/` in the `notes` chat: App, Project, Personal, Plugins),
chat-background-agents (a live chat of its own with two `loop` agents, the sub-agent model cleared and the page clock at
the real time while it is shown; the chat is deleted and the model set back in `close`), chat-task-result (desktop: the
carrier note with its report open), remember-dialog (`/remember …` in the `notes` chat), settings-general-agent (desktop:
the Agent section with the plan-file fields), settings-customize (the Agents tab with `notes`: personal, project,
shadowed and invalid rows), customization-editor (the editor of `code-reviewer`), plugin-detail-agents (desktop: the
Agents and Skills sections of a declarative plugin `db-tools` made in `open` and removed in `close`), then share-dialog, share-page, share-unavailable, model-picker,
command-palette, shortcuts (desktop), sidebar (mobile), plugins, plugin-detail, plugin-mcp, plugin-new-provider,
plugin-new-code, settings-providers, settings-provider-key, settings-models, settings-media (every model chosen, voice
and speed), settings-general, settings-appearance, settings-data (with the share link), settings-data-key (the Encryption key
section), settings-data-cleanup (after "Check for unused files": one leftover file), settings-about,
chat-not-found, page-not-found. A screen that starts something undoes it in its `close` step after the picture (cancels the dialog or
the recording, deletes its chat, turns read-aloud off again, puts the clock offset back, closes the changes panel on
This chat, turns the automatic cleanup off again), so the other screens look the
same in every run; the image-turn screen runs the page clock at the real time while it is shown, because its
"Generating… Ns" counter counts from the server's start time.

`@readme` (tagged `@screenshots @readme`, desktop 1440x900, the same server and data): the README images as full frames
(no crops) in `.tmp/screenshots/readme/`, named like `docs/assets/screenshots/`: chat-dark (the markdown chat),
workspace-dark (the Accept edits shell approval), changes-panel-dark (This chat with the diff), plugins-dark,
provider-wizard-dark (the API step with the LM Studio template; the draft is discarded afterwards), settings-dark
(Settings -> Providers) and chat-light (the tool approval card); Phase 10 adds customize-dark (the settings-customize
screen), a candidate for the README.

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
- Short-lived states (Phase 9: a `mock:todo` or `mock:steer` step lasts 400 ms): Playwright's assertions retry after 100,
  250, 500 and then every 1000 ms and can miss them. Record them with `recordStates` (a MutationObserver from an init
  script) and check the order afterwards with `expectStatesInOrder`, or wait with `waitForTestId` (checks on every
  animation frame). A polite live region keeps only its latest text: record it with `recordAnnouncements` and check it
  with `expectAnnounced`.
- `page.waitForFunction` with a string predicate fails: the app's CSP forbids `eval`. Pass a function (see
  `waitForTestId`); `page.evaluate` with a string expression is fine.
- A steer queued before the first step of a `mock:steer` turn opens the turn instead of steering it: queue once the
  first `current_time` row exists (`waitForTestId`).
- The root `tsconfig.json` type-checks `e2e/**` without the DOM library: inside `evaluate` callbacks reach browser
  globals through the element (`element.ownerDocument`, `ownerDocument.defaultView`), or pass a string expression
  (`page.evaluate<string>('navigator.clipboard.readText()')`).
- Phase 10: reka-ui checks a radio that the arrow keys focused only while the key is still down (its focus handler
  looks at the key after a `setTimeout`), so a spec holds it: `keyboard.down('ArrowDown')`, assert, then
  `keyboard.up('ArrowDown')` (a `press` moves the focus only).
- Phase 10: the command badge of a user message comes with the stored `metadata.command`; the live message of the page
  has none, so specs check badges after a reload. The definition editor's body and the viewer are CodeMirror
  (`fillMarkdownEditor`, `markdownEditorInput`): CodeMirror's `Mod` follows the host, so Mod+Enter there is
  `ControlOrMeta+Enter`, while the dialogs and the composer take `pressShortcut(page, 'Mod+Enter')`.
- Phase 10: `mock:background` children run on `subagentModelRef ?? the chat's model`; clear the setting
  (`useAgentSettings(api, cleanup, { subagentModelRef: null })`) so they run on `mock:background`. A message sent right
  after a reply that was stopped during a tool step is a steer of that turn for the mocks (their Turn rule), so its answer
  is the stopped turn's, not a new one.

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
| `createChat({ id?, title?, modelRef?, projectId? })` | `POST /api/chats` (a title here is a user title; `projectId` puts the chat into a project) |
| `getChat(id)` / `searchChats(q)` / `deleteChat(id)` | chat detail, `GET /api/chats?q=`, delete (404 ignored) |
| `stopChat(id)` / `removeChat(id)` | `POST /api/chat/:id/stop` (resolves to whether a run was stopped); stop, then delete (for `cleanup`) |
| `sendChat({ chatId?, text, parentId?, modelRef?, toolMode?, reasoningEffort?, imageOptions?, projectId? })` | `POST /api/chat` (default `mock:echo`, `ask`, `auto`; `projectId` only when the request creates the chat); resolves when the run finished with `{ chatId, userMessageId, chunks, text }`. `parentId`: omitted = the active leaf, `null` = a first message; an edit sends the parent of the edited message. `imageOptions` (`{ n?, aspectRatio?, editPrevious? }`) only with image models and chat models with image output, e.g. `{ modelRef: 'mock:image', imageOptions: { n: 2, aspectRatio: '16:9' } }` |
| `answerApprovals({ chatId, approved, modelRef?, toolMode? })` | answers every pending approval of the chat's active leaf (an approval continuation: the leaf goes back with its `approval-requested` parts marked `approval-responded`) and resolves like `sendChat` when the continued run finished; e.g. allow the write of `mock:workspace` so its edit asks next |
| `regenerateChat({ chatId, messageId?, modelRef?, toolMode?, reasoningEffort?, imageOptions? })` | `POST /api/chat` with `regenerate-message`: a new version of the reply `messageId` (default: the active leaf); resolves like `sendChat` (`userMessageId` = the answered user message) |
| `waitForChatTitle(id, timeout?)` | polls until the chat has a title and returns it |

Also exported: `requestFetch(context)` (a `fetch` over an `APIRequestContext`), `parseUiMessageStream(body)`,
`streamText(chunks)`, `isUsableProvider(provider)`.

### Chat UI (`chat.ts`)

| Export | Description |
|---|---|
| `openNewChat(page)` | `/`, waits for the greeting and an editable composer |
| `selectModel(page, modelRef)` | picks `provider:model` in the composer's model picker and verifies the trigger |
| `selectPermissionMode(page, mode)` | sets the composer's permission mode (`ask` / `edits` / `auto` / `off`; only for models with tools, `edits` only in project chats) |
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
| `recordRequests(page, method, path)` · `RequestLog` · `RecordedRequest` | records every matching request of the page from now on (`requests`: method, path, `query` (Phase 9), headers, `body` with file bytes; `jsonBodies()`), lets it through, `stop()` removes the route |

### Workspace and projects (`workspace.ts`, Phase 7)

| Export | Description |
|---|---|
| `workspaceRoot(api)` | the root the specs create folders in: `E2E_WORKSPACE_ROOT` (checked against the server's roots), else the first available root of `GET /api/projects/browse` |
| `seedWorkspaceFolder(api, { prefix?, files? })` · `WorkspaceFolder` | a uniquely named folder (`<prefix>-<id>`, default prefix `demo`) below that root with optional files (relative paths, subfolders created): `{ root, name, path, remove() }` |
| `seedProject(api, cleanup, { name?, prefix?, files? })` · `SeededProject` | a seeded folder plus a project for it (name default: the folder name), both undone through `cleanup` (the project first, then the folder): `{ project, folder }` |
| `createProject(api, { name, path })` · `listProjects(api)` · `projectByPath(api, path)` | `POST /api/projects` (no password on the server, or a fresh session), the list, the project of a folder |
| `removeProject(api, id)` · `removeProjectAt(api, path)` | delete a project (404 ignored; the folder stays), or the project of a folder if any (for projects created through the UI) |
| `MOCK_WORKSPACE_FILE` · `MOCK_WORKSPACE_CONTENT` · `MOCK_WORKSPACE_EDITED` · `MOCK_WORKSPACE_COMMAND` · `MOCK_WORKSPACE_DONE` | what `mock:workspace` writes, edits, runs and answers |
| `MOCK_CHECKPOINT_FILE` · `mockCheckpointContent(turn)` · `MOCK_CHECKPOINT_DIR` · `MOCK_CHECKPOINT_MKDIR` · `MOCK_CHECKPOINT_LS` · `MOCK_CHECKPOINT_DONE` | what `mock:checkpoint` writes (`checkpoint.txt`, `Turn <n>\n`), the folder it makes and enters, its two shell commands and its answer (Phase 8) |
| `gitAvailable()` | whether `git --version` runs on this host (checked once); skip git tests with `test.skip(!(await gitAvailable()), 'git is not installed')` |
| `seedGitProject(api, cleanup, { name?, prefix?, files?, commit? })` · `SeededGitProject` | `seedProject` whose folder is a repository on branch `main` with the seeded files in one commit "Initial commit" (`commit: false`: none); `git(...args)` runs more git commands there; undone through `cleanup` (the project, the folder with `.git`, the temporary HOME) |
| `initGitRepository(path, { ceiling, commit? })` · `GitRepository` | the same for an existing folder (a realpath; `ceiling` = the workspace root): `{ git(...args), dispose() }` (`dispose` removes the temporary HOME). Git runs only through `execFile('git', [...])` with argument arrays inside that folder, with HOME and `GIT_CONFIG_GLOBAL` in a temporary folder, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CEILING_DIRECTORIES` at the root, the author through `-c user.name=… -c user.email=…`, and a check that the repository's top level is the folder itself before the first write (the roots lie inside the harness-forge checkout) |

### Changes panel and rewind (`changes.ts`, Phase 8)

| Export | Description |
|---|---|
| `changesToggle(page)` · `changesPanel(page)` · `changesPane(page)` | the header toggle, the panel (pane or sheet) and the desktop `aside#hf-changes-pane` |
| `changesViewTab(page, view)` · `ChangesView` | the This chat (`chat`) / Git (`git`) tab |
| `changesFile(page, path)` · `changesFileButton(row)` · `changesFileDiff(row)` | a row, its accordion button (the one with `aria-expanded`), its lazy diff (`data-slot="changes-diff"`, `data-state`) |
| `changesUntrackedNote(page)` | This chat's untracked note (`data-slot="changes-untracked"`) |
| `CHANGES_STORAGE_KEYS` · `storageItem(page, key)` | `hf-changes-width` / `hf-changes-open` / `hf-changes-view` and a `localStorage` read |
| `toastWith(page, text)` | a vue-sonner toast with that text (custom toasts such as "Reverted {path}" with `toast-undo` too) |
| `openRewind(page, message)` | hovers a user message, clicks its `message-rewind` and returns the visible `rewind-dialog` |

### Agent 2.0 (`agent.ts`, Phase 9)

| Export | Description |
|---|---|
| `MOCK_TODO_ITEMS` · `MOCK_TODO_DONE` | the three items of `mock:todo` (`id`, `content`, `activeForm`) and its answer |
| `MOCK_PLAN_TODOS` · `MOCK_PLAN_FILE` · `MOCK_PLAN_FILE_CONTENT` · `MOCK_PLAN_HEADING` · `MOCK_PLAN_REVISED_HEADING` · `mockPlanDone(mode)` · `mockPlanRevising(reason)` | what `mock:plan` writes and answers |
| `MOCK_SUBAGENT_TASKS` · `MOCK_SUBAGENT_FILE` · `MOCK_SUBAGENT_FILE_CONTENT` | the two default `task` calls of `mock:subagent` (`description`, `prompt`, `kind`) and the file a general sub-agent writes for `write` |
| `mockSteerFinished(steps, steers)` | the final text of a `mock:steer` turn `steps <n>` |
| `compactFiller(label)` | a long user text for `mock:compact`: two such turns stay below 80 % of its 2000-token window, the third passes it |
| `AGENT_SETTINGS_KEYS` · `AgentSettings` · `agentSettingsOf(settings)` | `autoCompact`, `compactModelRef`, `subagentModelRef`, `subagentMaxSteps`, `shiftTabModes` |
| `useAgentSettings(api, cleanup, patch)` | changes Agent settings and restores them through `cleanup` (on that `api`'s server, so it also works for a password server) |
| `seedProjectChat(api, cleanup, { modelRef, files?, prefix?, name?, title? })` · `ProjectChat` | `seedProject` plus an empty chat in it: `{ project, folder, chatId }` |
| `queueMessage(api, chatId, text, { modelRef?, toolMode?, timeout? })` | `POST /api/chat/:id/queue` while a run is active, retrying the 409 `run-idle` of a run that has not started |
| `composerAnnouncement(page, text)` | the composer's polite live region with that text ("Permission mode: Plan") |
| `noticeLine(scope, code)` | a `data-notice` line (`data-slot="notice-part"`) by `data-code`, e.g. `context-trimmed` |
| `waitForTestId(page, id, attributes?, { count?, timeout? })` | waits, on every animation frame, until `count` matching elements exist |
| `recordStates(page, name, id, snapshot)` · `recordSelectorStates(page, name, selector, snapshot)` · `StateRecorder` | records every distinct snapshot of the matching elements (`snapshot` = a function body of `el` returning a string; elements joined with `" \|\| "`), also across reloads; `states()` reads the history |
| `expectStatesInOrder(states, patterns, message)` | the snapshots contain matches of the patterns in this order |
| `recordAnnouncements(page)` · `expectAnnounced(recorder, text)` | the history of every polite live region, and a poll until `text` was announced |

### Agent customization (`customize.ts`, Phase 10)

| Export | Description |
|---|---|
| `MOCK_AGENTS_MODEL` · `MOCK_BACKGROUND_MODEL` · `MOCK_BACKGROUND_REPORT` · `MOCK_AGENT_FILE` | the customization mocks (docs/PROVIDERS.md 8) and what a background child reports |
| `mockAgentReport(persona, tools)` · `mockBackgroundResult(status, firstLine?)` · `mockBackgroundDescription(type?)` | a `mock:agents` child's report (`Report: persona=… \| tools: … \| model=agents`, tools sorted), the answer to a delivered result, the description of a `bg` launch (`Background explore`) |
| `definitionFile(fields, body)` · `DefinitionValue` | a definition file (YAML frontmatter, lists as `[a, b]`, keys in order) |
| `createPersonalDefinition(api, cleanup, { kind, name, content, enabled? })` · `cleanupPersonalDefinition(cleanup, kind, name)` · `removePersonalDefinitions(api, kind, name)` · `personalDefinition(api, kind, name)` | personal definitions through the API, removed by kind and name (Undo re-creates under a new id); the stored definition of a name |
| `customizationPluginManifest(id, name, contributes)` · `createCustomizationPlugin(api, cleanup, manifest)` | a declarative plugin for plugin API 1.4.0 (agents, skills, commands) created through `POST /api/plugins` and uninstalled through `cleanup` |
| `usePlanSettings(api, cleanup, patch)` · `PlanSettings` | `planFiles` / `planDirectory` for one test, restored through `cleanup` |
| `customizationRow(scope, attributes)` · `customizeSection(page, source)` · `chooseRowAction(page, row, itemTestId)` · `selectCustomizeProject(page, projectId \| null)` | Settings -> Customize: a row by its data attributes, a section by source, a `⋯` menu item (the action runs once the menu closed), the Project select (`?project=`) |
| `markdownEditorInput(editor)` · `fillMarkdownEditor(page, editor, text)` | the editable area of a `MarkdownEditor` and a replace of its text (`ControlOrMeta+A`, then `insertText`) |
| `backgroundAgents(page)` · `backgroundAgentRow(page, attributes?)` · `openBackgroundAgents(page)` | the dock's background agents, a row, the list opened |
| `chatTasks(api, chatId)` · `waitForChatTask(api, chatId, match, options?)` · `stopChatTasks(api, chatId)` | `GET /api/chat/:id/tasks`, a poll until a task matches, a stop of every running task |

### Other helpers

| Export | Description |
|---|---|
| `startPasswordServer({ password?, dedicated?, label? })` | `{ baseURL, password, dataDir?, stop() }` (`dataDir` only for a started server): `E2E_AUTH_BASE_URL`, or a password-protected server started with `startServer` (`auth-server.ts`); `dedicated: true` always starts one with an empty data directory (for specs that wipe data); `label` names its temporary directory |
| `startServer({ env?, label? })` | `{ baseURL, dataDir, stop() }`: the build on a free port of 127.0.0.1 with a temporary data directory (`dataDir`, a realpath; its workspace root is `<dataDir>/workspaces`), `HF_MOCK_PROVIDER=1`, `HF_OFFLINE=1` and every provider key variable set empty (which also beats a repository `.env`); `stop()` removes the directory (`server.ts`) |
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

`mock:workspace` (Phase 7) walks through the workspace tools of a project chat: `write_file` `mock-workspace.txt` ("Hello
from the mock agent."), `edit_file` ("mock agent" -> "workspace agent"), `shell` `cat mock-workspace.txt`, then
`Workspace done: Hello from the workspace agent.`; in `ask` all three ask, in `edits` only the shell does, in `auto`
none. Without a project it answers `Workspace tools are not available.`. A file that exists before makes the write an
update (`+a −r`, the old lines in its diff); server diff lines are cut at `WORKSPACE_LIMITS.diffLineMaxChars`.

`mock:checkpoint` (Phase 8) writes `checkpoint.txt` (`Turn <n>`, n = the user messages so far), runs `mkdir -p mock-dir
&& cd mock-dir`, then `ls` in `mock-dir` (the sticky working folder), and answers `Checkpoint done.`; a second turn
starts in `mock-dir` and nests `mock-dir/mock-dir`. In `edits` the write runs without a card; the project rules `mkdir`
and `ls` let both shell calls run too, but only when `mock-dir` already exists (a `cd` needs no rule only into a folder
that exists when the command is checked), so the specs seed `mock-dir/.keep`. `mock:shell` runs the user text as one
shell command and answers `Shell done: <stdout>` (`Shell done: (empty)` without output).

Media models (Phase 6): `mock:image` (an image model in the picker's "Image models" group: 300 ms, 5 s when the prompt
contains "slow", "fail" fails; solid-color PNGs with a 320 px long edge at the requested aspect ratio, square for Auto),
`mock:image-chat` (a chat model with image output: `Image for: <text>`, then one PNG), `mock:image-tool` (calls
`generate_image` when offered, which needs `imageModelRef`; then `Image tool result: <n> image(s)`),
`mock:transcribe` (`This is a mock transcription.` for any accepted recording) and `mock:speech` (a silent WAV, 400 ms
per word, 1 s to 6 s; voices `mock-voice-a`, `mock-voice-b`). Read-aloud ends every block with sentence punctuation:
end a reply you compare with the `{ text }` of `POST /api/audio/speech` with a period.

Agent mocks (Phase 9, docs/PROVIDERS.md 8 "Agent mocks (Phase 9)"): `mock:compact` (a 2000-token window; as the
summarizer `MOCK-SUMMARY: …`; `seen?` answers `summary:<yes|no> seen:<sentinels>`; otherwise the text plus 150 filler
words), `mock:plan` (in plan mode `todo_write`, `list_directory`, then `exit_plan_mode`; Keep planning -> `Revising:
<feedback>` and a revised plan; approved -> `notes.txt` and `Plan done in mode <mode>.`), `mock:todo` (three `todo_write`
calls 400 ms apart, then `All 3 tasks done.`), `mock:subagent` (two parallel `task` calls, explore and general, 300 ms
per child step; `write`, `loop`, `parallel <n>`; set `subagentModelRef: 'mock:subagent'`) and `mock:steer` (`steps <n>`:
n `current_time` steps 400 ms apart, `Steered: <text>.` per steer, `Finished <n> steps. Steers: <list>`; other turns
echo the text).

Customization mocks (Phase 10, docs/PROVIDERS.md 8 "Customization mocks (Phase 10)"): `mock:agents` (`agents?` /
`skills?` / `tools?` list what the instructions offer; `agent <type> [write]` starts one `task` and answers `Agent
report: <the result>`; a child lists the folder and reports `Report: persona=<its PERSONA: line> | tools: <offered> |
model=agents`; `skill <name>` loads the skill and answers `Skill loaded: <the first 80 characters>`; any other turn
`Agents mock: <the text the model got>`, so a command's expansion is visible) and `mock:background` (`bg [type] [steps
<N>] [slow <K> | loop]` launches a background `task` and answers `Started in background: bgt_…`; a child takes K steps of
500 ms (2 by default, `loop` until its step limit) and reports `Report: background done`; a delivered result is
answered `Background result: <status> | <first report line>`; `steps <N>` keeps the launching reply busy for N steps of
400 ms and ends with `Finished: in-run result <status>` once a result is injected).
