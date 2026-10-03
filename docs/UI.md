# UI — harness-forge web app

The complete UI/UX specification for `apps/web` (Nuxt 4 SPA, shadcn-vue, Tailwind 4, AI Elements Vue).
Agents build the UI from this document. Names, props, emits, routes, store actions, shortcuts and `data-testid`
values defined here are **contracts**: several agents build components in parallel against them.

- Source of truth for shared names: `docs/DECISIONS.md` (wins on conflict). DTO names come from `docs/API.md`.
- Owners (C3, C5, W2.x, W3.x, W4.x; Phase 5: C9, W5.x; Phase 6: C12, W6.x; Phase 7: C15, W7.x) follow the phase
  tables in `docs/phases/`. A component contract marked **cross-owner** must not change without a CCR.
- Everything is English. Every UI string is sentence case (see [Copy guidelines](#15-copy-guidelines)).

Contents: [1 Principles](#1-principles) · [2 Wireframes](#2-wireframes) · [3 Design tokens](#3-design-tokens) ·
[4 Theme behavior](#4-theme-behavior) · [5 App shell](#5-app-shell) · [6 Routes and pages](#6-routes-and-pages) ·
[7 Chat rendering](#7-chat-rendering-spec) · [8 Plugins UX](#8-plugins-ux-spec) · [9 Settings UX](#9-settings-ux-spec) ·
[10 Components](#10-component-inventory-and-contracts) · [11 Stores](#11-pinia-stores-and-composables) ·
[12 Shortcuts](#12-keyboard-shortcuts) · [13 Test ids](#13-data-testid-contract) ·
[14 Accessibility](#14-accessibility-and-responsiveness) · [15 Copy](#15-copy-guidelines)

---

## 1. Principles

1. **Claude Code desktop look, simplified.** The "Code" tab of the Claude Code desktop app is the reference:
   darker sidebar with a session list, one centered transcript column, a rounded composer docked at the bottom,
   collapsed one-line tool rows, quiet chrome. Warm neutral grays and one ember accent.
2. **Removed on purpose** (never add them back without a user request):
   - environment selectors and free folder / working-directory pickers (amended in Phase 7: the user asked for
     **projects**, so a chat can belong to a project folder chosen from the server's allowed roots through the project
     switcher, the new-chat picker and Settings → Projects, 7.20 and 9.10; there is still no working-directory selector
     in the composer);
   - the Views menu;
   - Dispatch;
   - Routines;
   - Customize;
   - session filters (status/branch/environment filters above the session list; Phase 7: the project switcher is the
     only filter);
   - diff, terminal and browser panes (no split panes next to the transcript; Phase 7 keeps this: diffs and shell
     output render **inside tool rows**, 7.19);
   - usage-limit UI (plan limits, quota meters, upgrade prompts).
   What stays: sidebar with `Chat | Plugins`, New chat, Search, date-grouped chats, Settings, theme toggle,
   transcript, composer (`+`, model, effort, permission, context ring, send/stop; Phase 6: image options and the mic);
   Phase 7: the project switcher above New chat.
3. **Dark by default.** `html.dark` on first load even when the OS prefers light. Light and System are opt-in.
   No light flash, ever (see [4](#4-theme-behavior)).
4. **Keyboard-first.** Every action is reachable from the keyboard: palette (Mod+K), new chat (Mod+Shift+O),
   composer menus (Alt+M / Alt+R / Alt+P), shortcut list (Mod+/). Focus is always visible and predictable.
5. **No layout shift while streaming.** Rows have fixed heights, action bars reserve their space, the send button
   morphs into stop in place, collapsed rows never auto-expand, the transcript keeps a stable scrollbar gutter.
   Nothing the user is reading moves unless they asked for it.
6. **Tokens only.** Colors, radii, fonts and durations come from CSS variables (section 3). No hex values in
   components. `v-html` is forbidden; untrusted content is text or goes through `Markdown` (HTML escaped).
7. **Quiet by default, detail on demand.** Reasoning and tool details collapse to one line; usage, cost and
   timings live in tooltips and hover cards.

---

## 2. Wireframes

Legend: `◆` ember brand mark · `◧` sidebar trigger · `⌘` Mod (Ctrl on Windows/Linux) · `●` status dot ·
`◉` switch on · `○` switch off · `▸`/`▾` collapsed/expanded row · `(↑)` send · `(■)` stop · `☾ ☀ ▭` dark / light /
system · `▣` icon tile · `✱` provider icon · `◔` context ring.

### 2.1 Chat mode (`/chat/[id]`, desktop)

```
┌──────────────────────┬─────────────────────────────────────────────────────────────────┐
│ ◆ harness-forge    ◧ │ Refactor auth flow                                          ⋯   │ header h-12
│ ┌─────────┬────────┐ │─────────────────────────────────────────────────────────────────│ border after scroll
│ │  Chat   │Plugins │ │                                                                 │
│ └─────────┴────────┘ │                         ┌──────────────────────────────────┐    │
│ ＋ New chat      ⌘⇧O │                         │ Can you move the auth flow to    │    │ user bubble
│ ⌕  Search         ⌘K │                         │ server sessions?                 │    │ bg-muted, right
│                      │                         └──────────────────────────────────┘    │
│ Today                │    ▸ Thought for 12s                                            │ reasoning row
│  Refactor auth flow ●│    ▸ web_search  "nuxt 4 sessions"                        ✓     │ tool row
│  Kimi vs Qwen       ●│    Here is the plan:                                            │ markdown
│ Yesterday            │    1. Move the cookie logic into a server middleware.           │
│  Plugin idea         │    ┌ ts ──────────────────────────────────────────── ⧉ ┐        │ code block
│ Previous 7 days      │    │ export function createSession(userId: string) {  │        │
│  Provider wizard     │    └──────────────────────────────────────────────────┘        │
│ September            │    ⧉  ↻   Claude Sonnet 5 · 14s                                 │ actions + meta
│  Old experiments     │                                 ( ↓ )                           │ scroll pill
│                      │    ┌────────────────────────────────────────────────────────┐   │
│                      │    │ Reply…                                                  │   │ composer
│                      │    │ ＋  ✱ Claude Sonnet 5 ▾  High ▾          Ask ▾  ◔  (↑)  │   │
│                      │    └────────────────────────────────────────────────────────┘   │
│ ⚙ Settings    ☾ ☀ ▭ │                                                                 │
└──────────────────────┴─────────────────────────────────────────────────────────────────┘
  sidebar 16.5rem          transcript column max-w-3xl, centered
```

Row states in the list: `●` pulsing ember = running, amber = awaiting approval, foreground = unread. On hover
the dot slot shows `⋯` (Rename / Share… / Export / Delete). Messages with several versions show a `‹ 2/3 ›`
switcher first in their action row (7.5).

### 2.2 Empty state (`/`)

```
┌──────────────────────┬─────────────────────────────────────────────────────────────────┐
│ ◆ harness-forge    ◧ │                                                                 │ no title, no ⋯
│ [ Chat  | Plugins  ] │                                                                 │
│ ＋ New chat      ⌘⇧O │                                ◆                                │ ember mark 28px
│ ⌕  Search         ⌘K │                      What's next, Maks?                         │ Source Serif 32px
│                      │                                                                 │
│ Today                │    ┌ ⌁ Connect a provider to start ─────────────────────────┐   │ only when no
│  …                   │    │ Add an API key for Anthropic, OpenAI, DeepSeek and more,│   │ usable provider
│                      │    │ or run models locally with Ollama.                      │   │
│                      │    │                                  [ Connect a provider ] │   │
│                      │    └──────────────────────────────────────────────────────────┘   │
│                      │    ┌────────────────────────────────────────────────────────┐   │
│                      │    │ Ask anything…                                           │   │ same composer
│                      │    │ ＋  ✱ Claude Sonnet 5 ▾                             (↑) │   │
│                      │    └────────────────────────────────────────────────────────┘   │
│ ⚙ Settings    ☾ ☀ ▭ │                                                                 │
└──────────────────────┴─────────────────────────────────────────────────────────────────┘
```

The greeting block sits at ~38% of the viewport height. The first send creates the chat and replaces the URL
with `/chat/<id>` without remounting the transcript (the stream keeps running).

### 2.3 Plugins mode — list (`/plugins?filter=`)

```
┌──────────────────────┬─────────────────────────────────────────────────────────────────┐
│ ◆ harness-forge    ◧ │ Plugins                    [⌕ Search plugins   ] [Install…] [New plugin ▾] │
│ ┌─────────┬────────┐ │                                                                 │
│ │  Chat   │Plugins │ │ ┌───────────────────────────┐ ┌───────────────────────────┐     │
│ └─────────┴────────┘ │ │ ▣ Core providers  v1.0 ◉ │ │ ▣ Together AI     v0.1 ◉ │     │
│ ＋ New plugin      ▾ │ │ Built-in LLM providers    │ │ Together inference API    │     │
│ ⇩  Install…          │ │ [Core] 13 providers       │ │ [Declarative] 1 provider  │     │
│                      │ └───────────────────────────┘ └───────────────────────────┘     │
│ Browse               │ ┌───────────────────────────┐ ┌───────────────────────────┐     │
│  All               6 │ │ ▣ Dice tool       v1.0 ◉ │ │ ▣ Broken plugin   v0.3 ○ │ red │
│  Providers         2 │ │ Rolls dice                │ │ setup() threw: …          │ border
│  Tools             2 │ │ [Code] [Runs code] 1 tool │ │ [zip] Error · View logs   │     │
│  MCP servers       1 │ └───────────────────────────┘ └───────────────────────────┘     │
│  Commands          1 │                                                                 │
│  Disabled          1 │                                                                 │
│ Installed            │                                                                 │
│  ▣ Core providers  ● │                                                                 │
│  ▣ Together AI     ● │                                                                 │
│  ▣ Broken plugin   ● │ (error = destructive dot)                                      │
│ ⚙ Settings    ☾ ☀ ▭ │                                                                 │
└──────────────────────┴─────────────────────────────────────────────────────────────────┘
```

### 2.4 Plugins mode — detail (`/plugins/[id]?tab=overview|configuration|source|logs`)

```
┌──────────────────────┬─────────────────────────────────────────────────────────────────┐
│ (plugins sidebar)    │ ← Plugins                                                       │
│                      │ ▣ Dice tool   v1.0.0  [Code] [Runs code] [Active]   ◉ Enabled  ↻  ⋯ │
│                      │ ┌──────────┬───────────────┬────────┬──────┐                    │
│                      │ │ Overview │ Configuration │ Source │ Logs │                    │
│                      │ └──────────┴───────────────┴────────┴──────┘                    │
│                      │ Rolls dice for tabletop games.  By maksqi · homepage ↗          │
│                      │ Permissions  [storage]                                          │
│                      │ Tools                                                           │
│                      │  roll_dice   Roll N dice with S sides  [Safe]  Approval [Default ▾] ◉ │
│                      │ Commands                                                        │
│                      │  /roll       Roll dice from a formula                           │
└──────────────────────┴─────────────────────────────────────────────────────────────────┘
```

Source tab (code plugins):

```
│ index.mjs ●  plugin.json  README.md             Saved 12:04   [Save ⌘S] [Build & reload] │
│ ┌────────────────┬─────────────────────────────────────────────────────────────────────┐ │
│ │ ▾ dice-tool    │  1  /** @type {import('@harness-forge/plugin-sdk').PluginModule} */ │ │
│ │    index.mjs   │  2  export default {                                               │ │
│ │    plugin.json │  3    setup(ctx) {                                                 │ │
│ │    README.md   │  4      ctx.tools.register({ name: 'roll_dice', … })               │ │
│ │ ＋ New file    │                                                                     │ │
│ ├────────────────┴─────────────────────────────────────────────────────────────────────┤ │
│ │ Build  12:04:11  ✓ Built in 38 ms · reloaded                                     ⌄  │ │
│ │ Log    12:04:11  info   setup complete                                              │ │
│ └──────────────────────────────────────────────────────────────────────────────────────┘ │
   file tree 13rem | CodeMirror tabs (flex) — build/log panel resizable, 30% height
```

### 2.5 Settings mode (`/settings/*`)

```
┌──────────────────────┬─────────────────────────────────────────────────────────────────┐
│ ◆ harness-forge    ◧ │ Providers                                                       │
│ ← Back to app        │ Bring your own API keys. Keys are encrypted on this server.     │
│                      │ ┌ ⚠ You're using plain HTTP. Keys you enter can be read on the ┐ │ HTTP banner
│ ⚿  Providers         │ │   network. Use HTTPS or localhost.                            │ │ (non-local only)
│ ▦  Models            │ └───────────────────────────────────────────────────────────────┘ │
│ ▷  Media             │                                                                 │
│ ⚙  General           │ ▣ Anthropic (Claude)   23 models        [Connected]    Configure ◉ │
│ ◐  Appearance        │ ▣ OpenAI (ChatGPT)                      [Not configured] Add key ◉ │
│ ▤  Data              │ ▣ DeepSeek             4 models         [From env]     Configure ◉ │
│ ⓘ  About             │ ▣ Moonshot AI (Kimi)                    [Error 401]    Configure ◉ │
│                      │ ▣ Ollama (local)       Local — no key   [Connected]    Configure ◉ │
│                      │ ▣ Together AI  via Together AI plugin   [Connected]    Configure ◉ │
│ ⚙ Settings    ☾ ☀ ▭ │                                                                 │
└──────────────────────┴─────────────────────────────────────────────────────────────────┘
```

Provider key dialog:

```
┌ ▣ Anthropic (Claude) ──────────────────────────────────── × ┐
│ API key                                        Get a key ↗   │
│ [ ••••••••••••••••  sk-ant-…9fQ2 · stored            (eye) ] │
│ [From env] Using ANTHROPIC_API_KEY. A saved key takes priority.│
│ ▸ Advanced                                                   │
│     Base URL [ https://api.anthropic.com/v1              ]   │
│ ✓ Connected · 23 models · 380 ms                             │ test result
│ [Remove key]                               [Test]   [Save]   │
└──────────────────────────────────────────────────────────────┘
```

### 2.6 Mobile (< 768px): sidebar as a sheet

```
┌───────────────────────────────┐        ┌──────────────────────────────┐
│ ≡  Refactor auth flow      ⋯  │        │ ◆ harness-forge            × │ Sheet, 18rem,
│───────────────────────────────│        │ [ Chat      |    Plugins ]   │ slides from left
│         ┌───────────────────┐ │        │ ＋ New chat                  │
│         │ Move auth to      │ │        │ ⌕  Search                    │
│         │ server sessions?  │ │        │ Today                        │
│         └───────────────────┘ │        │  Refactor auth flow        ● │
│ ▸ Thought for 12s             │        │  Kimi vs Qwen                │
│ ▸ web_search "nuxt 4"      ✓  │        │ Yesterday                    │
│ Here is the plan: …           │        │  Plugin idea                 │
│┌─────────────────────────────┐│        │                              │
││ Reply…                      ││        │                              │
││ ＋ ✱ Sonnet 5 ▾   Ask ▾ (↑) ││        │ ⚙ Settings        ☾  ☀  ▭   │
│└─────────────────────────────┘│        └──────────────────────────────┘
└───────────────────────────────┘
  composer full width (12px gutters), safe-area bottom padding; model picker opens as a bottom drawer
```

### 2.7 Settings → Data (`/settings/data`)

```
┌──────────────────────┬─────────────────────────────────────────────────────────────────┐
│ ◆ harness-forge    ◧ │ Data                                                            │
│ ← Back to app        │ Back up and restore your chats, or delete them all.             │
│                      │ 12 chats (2 archived) · 348 messages · 18 files, 24 MB          │ summary
│ ⚿  Providers         │ Export                                                          │
│ ▦  Models            │ ◉ Include attachments   ◉ Include settings    [Export backup]   │
│ ▷  Media             │                                                                 │
│ ⚙  General           │ Import                                                          │
│ ◐  Appearance        │ [Choose file…] backup.zip   If a chat exists [Skip | Copy]      │
│ ▤  Data              │ ○ Restore settings from the backup                   [Import]   │
│ ⓘ  About             │ ┌ ✓ Imported 10 chats · skipped 2 · failed 1 · 18 files ──────┐ │ result panel
│                      │ │ Refactor auth flow             Imported                     │ │
│                      │ │ Broken chat                    Failed: invalid tree         │ │
│                      │ └─────────────────────────────────────────────────────────────┘ │
│                      │ Shared links                                                    │
│                      │ Refactor auth flow · 12 messages [Outdated]  ⧉ Manage… Revoke…  │
│                      │ Danger zone                                                     │
│                      │ Delete every chat and share link.        [Delete all data…]     │ destructive
│ ⚙ Settings    ☾ ☀ ▭ │                                                                 │
└──────────────────────┴─────────────────────────────────────────────────────────────────┘
```

### 2.8 Share dialog (opened by "Share…" in the chat menus)

```
┌ Share chat ───────────────────────────────────────────────────── × ┐
│ Anyone with a link can read a snapshot of this chat. Messages you  │
│ add later are not shared until you update the snapshot.            │
│ ┌ ⚠ No password set ─────────────────────────────────────────────┐ │ only when auth is off
│ │ Links open only where the app is reachable without a password  │ │
│ │ (normally just this computer). Set HF_PASSWORD before exposing │ │
│ │ the server.                                                    │ │
│ └────────────────────────────────────────────────────────────────┘ │
│ ┌────────────────────────────────────────────────────────────────┐ │ one card per link
│ │ [ https://chat.example.com/share/0bN3…xQ7f     ]  [Copy link]  │ │
│ │ 12 messages · snapshot 3h ago   [Outdated]                     │ │
│ │ ◉ Files and images ○ Reasoning ○ Tool details Expires [Never ▾]│ │
│ │ [Update snapshot]                                    [Revoke…] │ │
│ └────────────────────────────────────────────────────────────────┘ │
│ New link                                                           │
│ ◉ Files and images  ○ Reasoning  ○ Tool details  Expires [Never ▾] │
│                                                     [Create link]  │
└────────────────────────────────────────────────────────────────────┘
```

### 2.9 Shared chat page (`/share/[token]`, `share` layout)

```
┌────────────────────────────────────────────────────────────────────────────┐
│ ◆ harness-forge                                                        ☾   │ header, theme menu
│────────────────────────────────────────────────────────────────────────────│
│        Refactor auth flow                                                  │ h1
│        Read-only snapshot · Sep 28, 2026                                   │
│                                   ┌──────────────────────────────────┐     │
│                                   │ Can you move the auth flow to    │     │ user bubble
│                                   │ server sessions?                 │     │
│                                   └──────────────────────────────────┘     │
│        ▸ Thought                                                           │ only with reasoning
│        ▸ web_fetch  "https://nuxt.com/docs"                          ✓     │ ShareToolRow
│        Here is the plan:                                                   │ markdown
│        1. Move the cookie logic into a server middleware.                  │
│        claude-sonnet-5                                                     │ model id, muted mono
└────────────────────────────────────────────────────────────────────────────┘
  no sidebar, no composer, no message actions; column max-w-3xl
```

Unavailable link (404): the same header, then a centered `Empty` state "This link is unavailable" · "It may have
expired or been revoked, or the chat was deleted."

### 2.10 Settings → Media (`/settings/media`, Phase 6)

```
┌──────────────────────┬─────────────────────────────────────────────────────────────────┐
│ ◆ harness-forge    ◧ │ Images and voice                                                │
│ ← Back to app        │ Models for generated images, dictation and reading replies      │
│                      │ aloud.                                                          │
│ ⚿  Providers         │ Images                                                          │
│ ▦  Models            │ Image model        [ ✱ GPT Image 1                          ▾ ] │ none = "None (the
│ ▷  Media             │ The generate_image tool uses this model. To generate images     │ generate_image tool
│ ⚙  General           │ directly, pick an image model in the composer.                  │ is off)"
│ ◐  Appearance        │ Voice                                                           │
│ ▤  Data              │ Audio and text go to the provider you choose; harness-forge     │ privacy notice
│ ⓘ  About             │ doesn't store them.                                             │
│                      │ Speech to text     [ ✱ Whisper large v3 turbo               ▾ ] │ none = "Off"
│                      │ Language           [ Detect automatically                   ▾ ] │
│                      │ Read aloud         [ ✱ GPT-4o mini TTS                      ▾ ] │ none = "Off"
│                      │ Voice              [ Provider default                         ] │ suggestions: voices
│                      │ Speed              [ 1×                                     ▾ ] │ 0.75× … 2×
│                      │                                                [ Test voice ]   │
│ ⚙ Settings    ☾ ☀ ▭ │                                                                 │
└──────────────────────┴─────────────────────────────────────────────────────────────────┘
```

### 2.11 Composer with an image model, recording and transcribing (Phase 6)

```
Image model selected: image options instead of effort / permission, no context ring
┌──────────────────────────────────────────────────────────────────────┐
│ Describe an image…                                                   │
│ [+] [✱ GPT Image 1 ▾] [▢ 16:9 · 2 ▾]                   [mic]  [(↑)]  │
└──────────────────────────────────────────────────────────────────────┘
Recording: the indicator replaces the left tools (permission menu and context ring step aside too), the mic becomes
Stop (level ring), Send disabled
┌──────────────────────────────────────────────────────────────────────┐
│ Reply…                                                               │
│ [● 0:07] [Cancel]                                      [■ mic] [(↑)] │
└──────────────────────────────────────────────────────────────────────┘
Transcribing: the timer stops, the dot stops pulsing; a click on the mic cancels
│ [● 0:12] [Cancel]                            [◌ Transcribing…] [(↑)] │
```

A reply of an image turn (7.16): the gallery spans the transcript column, the actions row follows.

```
   ┌─────────────────────────────┐ ┌─────────────────────────────┐
   │                             │ │                             │   2 columns for 2–4 images,
   │          image 1            │ │          image 2            │   one full-width image for 1
   └─────────────────────────────┘ └─────────────────────────────┘
   ‹ 2/2 ›  ↻   Mock Image · 3s                                          no Copy and no Read aloud
                                                                          without text; Delete this
                                                                          version follows Regenerate
```

### 2.12 Projects in the sidebar, a new chat and the header (Phase 7)

Legend additions: `▢` folder icon · `⇕` `ChevronsUpDown` · `✎` / `❯` the `FilePenLine` / `SquareTerminal` tool icons.

```
┌──────────────────────┬─────────────────────────────────────────────────────────────────┐
│ ◆ harness-forge    ◧ │ Fix the parser                       [▢ harness-forge]      ⋯   │ ChatProjectChip
│ [ Chat  | Plugins  ] │─────────────────────────────────────────────────────────────────│
│ ▢ harness-forge    ⇕ │                                                                 │ ProjectSwitcher
│ ＋ New chat      ⌘⇧O │    ▸ ✎ edit_file  "src/parser.ts"             +12 −3   ✓        │ workspace tool rows
│ ⌕  Search         ⌘K │    ▸ ❯ shell  "pnpm test"                     exit 0   ✓        │ (7.19)
│ Today                │    Fixed: the parser now rejects empty input.                   │
│  Fix the parser     ●│                                                                 │
│  Add a CLI flag      │    ┌────────────────────────────────────────────────────────┐   │
│ Yesterday            │    │ Reply…                                                  │   │
│  Release notes       │    │ ＋  ✱ Claude Sonnet 5 ▾  High ▾   Accept edits ▾  ◔ (↑) │   │
│ ⚙ Settings    ☾ ☀ ▭ │    └────────────────────────────────────────────────────────┘   │
└──────────────────────┴─────────────────────────────────────────────────────────────────┘
  the list shows only the chats of the switcher's filter (All chats · No project · a project)
```

Switcher menu (`DropdownMenu` radio group, `max-h-80`, scrolls):

```
┌──────────────────────────────────────────┐
│ ◉ All chats                              │
│ ○ No project                             │
│ ──────────────────────────────────────── │
│ ○ harness-forge                       12 │ chat count
│   /home/me/workspaces/harness-forge      │ path in mono, muted
│ ○ notes                     ⚠          3 │ folder missing (FolderX, warning)
│   /home/me/workspaces/notes              │
│ ──────────────────────────────────────── │
│ ⊞ Add project…                           │
│ ⚙ Manage projects                        │
└──────────────────────────────────────────┘
```

A new chat (`/`): `NewChatProjectPicker` under the greeting, defaulting to the switcher's project.

```
                                ◆
                      What's next, Maks?
                      [ ▢ harness-forge ▾ ]                    ghost pill, rounded-full
    ┌────────────────────────────────────────────────────────┐
    │ Ask anything…                                           │
    │ ＋  ✱ Claude Sonnet 5 ▾              Accept edits ▾ (↑) │
    └────────────────────────────────────────────────────────┘
```

### 2.13 Settings → Projects and the Add project dialog (Phase 7)

```
┌──────────────────────┬─────────────────────────────────────────────────────────────────┐
│ ◆ harness-forge    ◧ │ Projects                                        [Add project]   │
│ ← Back to app        │ Folders on the server that chats can read and edit.             │
│                      │                                                                 │
│ ⚿  Providers         │ harness-forge                                  12 chats     ⋯   │ project-row
│ ▦  Models            │ /home/me/workspaces/harness-forge                               │ mono, muted
│ ▷  Media             │ notes                    [Folder not found]     3 chats     ⋯   │ warning badge
│ ▢  Projects          │ /home/me/workspaces/notes                                       │
│ ⚙  General           │                                                                 │
│ ◐  Appearance        │                                                                 │
│ ▤  Data              │                                                                 │
│ ⓘ  About             │                                                                 │
│ ⚙ Settings    ☾ ☀ ▭ │                                                                 │
└──────────────────────┴─────────────────────────────────────────────────────────────────┘
```

```
┌ Add project ───────────────────────────────────────────────── × ┐
│ workspaces › harness-forge › packages                     [↑]   │ breadcrumb, Parent folder
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ ▢ plugin-sdk                                                │ │ FolderBrowser entries
│ │ ▢ shared                                        [Project]   │ │ already a project: disabled
│ └─────────────────────────────────────────────────────────────┘ │
│ [⊞ New folder]                                                  │ reveals "Folder name"
│ Selected: /home/me/workspaces/harness-forge/packages            │ mono
│ Name [ packages                                             ]   │ defaults to the basename
│                                         [Cancel] [Add project]  │ fresh auth first
└─────────────────────────────────────────────────────────────────┘
```

### 2.14 Workspace tool rows and approvals (Phase 7)

Diffs and shell output render inside the expanded tool row (7.19), never in a side pane.

```
   ▾ ✎ edit_file  "src/parser.ts"                               +2 −1   ✓
     ┌ src/parser.ts                                      +2 −1   ⧉ ┐   DiffView
     │ @@ −12,3 +12,4 @@                                            │   bg-muted/60
     │ 12  12    const tokens = lex(input)                          │   context, muted
     │ 13      − if (!tokens) return null                           │   bg-destructive/10
     │     13  + if (tokens.length === 0)                           │   bg-success/10
     │     14  +   return null                                      │
     │ 14  15    return parse(tokens)                               │
     └──────────────────────────────────────────────────────────────┘
     Raw input and output ▸
   ▾ ❯ shell  "pnpm test"                                       exit 0   ✓
     ┌──────────────────────────────────────────────────────────────┐   TerminalOutput
     │ $ pnpm test                                                  │
     │ 42 tests passed                                              │
     │ [Exit code 0] [3.2s]                                         │
     └──────────────────────────────────────────────────────────────┘
```

```
┌───────────────────────────────────────────────────────────────┐   shell approval
│ Run this command?                         from core-workspace │
│ Run the parser tests                                          │   description
│ ┌───────────────────────────────────────────────────────────┐ │
│ │ pnpm test --filter parser                                 │ │   command, mono
│ └───────────────────────────────────────────────────────────┘ │
│ In harness-forge · timeout 120s                               │
│ ⚠ Runs on the server with the server user's permissions.      │
│                                                [Deny]  [Run]  │   no "Always allow"
└───────────────────────────────────────────────────────────────┘
┌───────────────────────────────────────────────────────────────┐   edit approval
│ Allow edit_file?                          from core-workspace │
│ ┌ src/parser.ts                                       +2 −1 ┐ │   DiffView of the
│ │ −  if (!tokens) return null                               │ │   old → new strings
│ │ +  if (tokens.length === 0)                               │ │
│ │ +    return null                                          │ │
│ └───────────────────────────────────────────────────────────┘ │
│ ☐ Accept all edits in this chat                               │
│                                              [Deny]  [Allow]  │
└───────────────────────────────────────────────────────────────┘
```

---

## 3. Design tokens

All tokens live in `apps/web/app/assets/css/main.css` (C3; frozen after Phase 0). Components use Tailwind
utilities mapped to these variables (`bg-background`, `text-muted-foreground`, `border-border`, `bg-success/15`).

### 3.1 Colors

Warm neutrals (hue 60–90, chroma ≤ 0.012), one ember accent (hotter than Claude's `#d97757`). `--accent` stays
neutral (it is the hover/selection gray, not the brand color). `:root` is light; `.dark` is dark and is the
default (`@nuxtjs/color-mode` puts `dark` on `<html>`).

```css
@import "tailwindcss";
@import "tw-animate-css";
@import "@fontsource-variable/hanken-grotesk";
@import "@fontsource-variable/source-serif-4";
@import "@fontsource-variable/jetbrains-mono";

@custom-variant dark (&:is(.dark *));

:root {
  color-scheme: light;
  --radius: 0.625rem;

  --background: oklch(0.984 0.005 90);
  --foreground: oklch(0.22 0.006 60);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.22 0.006 60);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0.22 0.006 60);
  --primary: oklch(0.57 0.165 40);
  --primary-foreground: oklch(0.99 0 0);
  --secondary: oklch(0.945 0.007 85);
  --secondary-foreground: oklch(0.22 0.006 60);
  --muted: oklch(0.945 0.007 85);
  --muted-foreground: oklch(0.52 0.012 70);
  --accent: oklch(0.945 0.007 85);
  --accent-foreground: oklch(0.22 0.006 60);
  --destructive: oklch(0.55 0.21 25);
  --border: oklch(0.90 0.008 85);
  --input: oklch(0.88 0.008 85);
  --ring: oklch(0.57 0.165 40);            /* opaque; utilities apply /50 (see 3.7) */

  --chart-1: oklch(0.57 0.165 40);          /* ember */
  --chart-2: oklch(0.55 0.09 245);          /* blue */
  --chart-3: oklch(0.55 0.11 140);          /* green */
  --chart-4: oklch(0.68 0.15 70);           /* amber */
  --chart-5: oklch(0.52 0.13 300);          /* violet */

  --sidebar: oklch(0.965 0.006 85);
  --sidebar-foreground: oklch(0.22 0.006 60);
  --sidebar-primary: oklch(0.57 0.165 40);
  --sidebar-primary-foreground: oklch(0.99 0 0);
  --sidebar-accent: oklch(0.93 0.008 85);
  --sidebar-accent-foreground: oklch(0.22 0.006 60);
  --sidebar-border: oklch(0.90 0.008 85);
  --sidebar-ring: oklch(0.57 0.165 40);

  --success: oklch(0.55 0.11 140);
  --warning: oklch(0.68 0.15 70);
  --info: oklch(0.55 0.09 245);
}

.dark {
  color-scheme: dark;

  --background: oklch(0.215 0.004 60);
  --foreground: oklch(0.955 0.006 85);
  --card: oklch(0.255 0.005 60);
  --card-foreground: oklch(0.955 0.006 85);
  --popover: oklch(0.255 0.005 60);
  --popover-foreground: oklch(0.955 0.006 85);
  --primary: oklch(0.70 0.155 45);
  --primary-foreground: oklch(0.18 0.02 45);
  --secondary: oklch(0.285 0.005 60);
  --secondary-foreground: oklch(0.955 0.006 85);
  --muted: oklch(0.285 0.005 60);
  --muted-foreground: oklch(0.72 0.012 75);
  --accent: oklch(0.285 0.005 60);
  --accent-foreground: oklch(0.955 0.006 85);
  --destructive: oklch(0.64 0.21 22);
  --border: oklch(1 0 0 / 9%);
  --input: oklch(1 0 0 / 13%);
  --ring: oklch(0.70 0.155 45);

  --chart-1: oklch(0.70 0.155 45);
  --chart-2: oklch(0.72 0.08 245);
  --chart-3: oklch(0.72 0.10 135);
  --chart-4: oklch(0.80 0.14 80);
  --chart-5: oklch(0.68 0.12 300);

  --sidebar: oklch(0.185 0.004 60);
  --sidebar-foreground: oklch(0.955 0.006 85);
  --sidebar-primary: oklch(0.70 0.155 45);
  --sidebar-primary-foreground: oklch(0.18 0.02 45);
  --sidebar-accent: oklch(0.26 0.005 60);
  --sidebar-accent-foreground: oklch(0.955 0.006 85);
  --sidebar-border: oklch(1 0 0 / 7%);
  --sidebar-ring: oklch(0.70 0.155 45);

  --success: oklch(0.72 0.10 135);
  --warning: oklch(0.80 0.14 80);
  --info: oklch(0.72 0.08 245);
}
```

Derivation rules for tokens not in the plan table: `*-foreground` on neutral surfaces = `--foreground`;
`--secondary` = `--muted`; `--sidebar-primary*` = `--primary*`; `--sidebar-border` = `--border` (dark: 7% so the
darker sidebar edge stays subtle); `--sidebar-ring` = `--ring`; charts = ember, then the info / success / warning
hues, then violet at the same lightness as the status colors.

Usage rules:

| Token | Use for | Never for |
|---|---|---|
| `primary` | send/stop button, primary buttons, running dot, active tab indicator, links' underline | large backgrounds |
| `accent` | hover and selected rows, menu highlight | brand emphasis |
| `muted` | user bubble, code block body, chips, skeletons | text |
| `success` / `warning` / `info` | dots, icons, borders, tinted backgrounds (`bg-warning/10`) | small body text in light mode (contrast) |
| `destructive` | errors, delete actions, error borders | warnings |

Tailwind mapping (in the same file):

```css
@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  /* …one --color-* entry per variable above, including chart-1..5 and sidebar-*… */
  --color-success: var(--success);
  --color-warning: var(--warning);
  --color-info: var(--info);

  --radius-sm: calc(var(--radius) - 4px);   /* 6px  */
  --radius-md: calc(var(--radius) - 2px);   /* 8px  — rows, menu items, chips */
  --radius-lg: var(--radius);               /* 10px — buttons, inputs, cards */
  --radius-xl: calc(var(--radius) + 4px);   /* 14px — dialogs, popovers */

  --font-reading: var(--reading-font);
  --animate-hf-pulse: hf-pulse 1.6s ease-in-out infinite;
  --animate-hf-shimmer: hf-shimmer 2s linear infinite;
}

@theme {
  --font-sans: "Hanken Grotesk Variable", ui-sans-serif, system-ui, sans-serif;
  --font-serif: "Source Serif 4 Variable", ui-serif, Georgia, serif;
  --font-mono: "JetBrains Mono Variable", ui-monospace, SFMono-Regular, Menlo, monospace;
}
```

Verify the family names in the installed `@fontsource-variable/*/index.css` before shipping.

### 3.2 Fonts

| Role | Package | Family | Where |
|---|---|---|---|
| UI (sans) | `@fontsource-variable/hanken-grotesk` | Hanken Grotesk Variable | everything by default (`font-sans` on `body`) |
| Serif | `@fontsource-variable/source-serif-4` | Source Serif 4 Variable | empty-state greeting; assistant text when `readingFont = serif` |
| Mono | `@fontsource-variable/jetbrains-mono` | JetBrains Mono Variable | code, tool args, ids, model ids, `harness-forge` wordmark, kbd |

Weights: 400 body, 500 labels/buttons/active rows, 600 headings and markdown `strong`. No 700+.
`font-feature-settings: "cv11", "ss01"` is not used; keep defaults. Numbers in tables and meters use `tabular-nums`.

### 3.3 Type scale

| Name | Size / line height | Tailwind | Use |
|---|---|---|---|
| micro | 11px / 16px | `text-[11px]` | badges, kbd, token counts |
| caption | 12px / 16px | `text-xs` | sidebar group labels, timestamps, hints, meta rows |
| ui | 14px / 20px | `text-sm` | default UI text, buttons, inputs, sidebar rows, menus |
| transcript | `var(--transcript-font-size)` / `var(--transcript-line-height)` | `.hf-transcript` | user bubble and assistant text (15px / 1.65 default) |
| title | 16px / 24px, 500 | `text-base font-medium` | chat title in header, dialog titles |
| page | 20px / 28px, 600 | `text-xl font-semibold` | settings and plugins page titles |
| greeting | 32px / 1.2, Source Serif 4, 400 | `font-serif text-[32px]` | empty-state greeting (24px below `sm`) |

Markdown inside the transcript: `h1` 1.35em, `h2` 1.2em, `h3` 1.05em (all 600, margin-top 1.4em); inline code
0.9em mono on `bg-muted` with `rounded-sm px-1`; code blocks 13px / 1.55 mono; tables `text-sm`.

### 3.4 Radius

| Element | Radius |
|---|---|
| base `--radius` | `.625rem` (10px) — buttons, inputs, cards (`rounded-lg`) |
| composer | 20px (`rounded-[20px]`) |
| user bubble | 16px (`rounded-2xl`) |
| sidebar rows, tool rows, menu items, chips | 8px (`rounded-md`) |
| dialogs, popovers, palette | 14px (`rounded-xl`) |
| send/stop button, status dots, context ring | full circle |

### 3.5 Density, text size, reading font

Three global settings (`density`, `textSize`, `readingFont` in `GET /api/settings`) become attributes on
`<html>`: `data-density="comfortable|compact"`, `data-text-size="sm|md|lg"`, `data-reading-font="sans|serif"`.
`ui.applyAppearance()` sets them and caches them in `localStorage['hf-appearance']`; the client plugin
`plugins/appearance.client.ts` (C5) applies the cached values before the app mounts so nothing jumps.

```css
:root {
  --header-height: 3rem;                 /* 48px, both densities */
  --row-height: 2rem;                    /* 32px sidebar rows, tool/reasoning rows, menu items */
  --ts-base: 15px;                       /* data-text-size md */
  --ts-density-offset: 0px;
  --transcript-font-size: calc(var(--ts-base) - var(--ts-density-offset));
  --transcript-line-height: 1.65;
  --message-gap: 1.5rem;                 /* space between messages */
  --reading-font: var(--font-sans);
}
html[data-text-size="sm"] { --ts-base: 14px; }
html[data-text-size="lg"] { --ts-base: 16px; }
html[data-density="compact"] {
  --row-height: 1.75rem;                 /* 28px */
  --ts-density-offset: 1px;              /* md + compact = 14px, per plan */
  --transcript-line-height: 1.55;
  --message-gap: 1rem;
}
html[data-reading-font="serif"] { --reading-font: var(--font-serif); }
.hf-transcript { font-size: var(--transcript-font-size); line-height: var(--transcript-line-height); }
```

UI chrome stays 14px in every density; only rows, gaps and the transcript change. The reading font applies to
assistant markdown only (user bubbles, code and tool rows keep their fonts).

### 3.6 Motion

| Token | Value | Use |
|---|---|---|
| `--duration-fast` | 120ms | hover backgrounds, icon swaps (copy → check), press states |
| `--duration-base` | 180ms | menus, popovers, tooltips, collapsible rows, tab indicator |
| `--duration-slow` | 260ms | sheet, sidebar collapse, dialogs |
| `--ease-out` | `cubic-bezier(0.2, 0, 0, 1)` | everything that enters or expands |
| `--ease-in` | `cubic-bezier(0.4, 0, 1, 1)` | exits (use `--duration-fast`) |
| `hf-pulse` | 1.6s, opacity 1 → 0.35 → 1 and scale 1 → 0.85 | running status dot |
| `hf-shimmer` | 2s linear, gradient sweep over `text-muted-foreground` | "Thinking…", submitted placeholder |

Tooltips open after 400ms (`TooltipProvider :delay-duration="400"`). Nothing animates layout properties
(height animations only inside `Collapsible`, never in the streaming path). With `prefers-reduced-motion: reduce`
all durations become 0ms, `hf-pulse` becomes a static ring, `hf-shimmer` a static muted color.

### 3.7 Focus ring

- Recipe for every focusable custom element: `outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50
  focus-visible:border-ring` (the shadcn-vue default). `--ring` is **opaque** ember so the generated
  `ring-ring/50` utilities produce the plan's ~50% ember ring (the plan's "primary / 55%" describes the visible
  result; pre-multiplying alpha into the token would halve it again inside shadcn components).
- Focus is shown only for keyboard focus (`:focus-visible`). Mouse clicks do not paint rings.
- Rows inside the sidebar and menus use `focus-visible:ring-2 ring-sidebar-ring/50` inset (no layout change).
- The composer shows focus on the container: `focus-within:border-ring/60` (no outer ring; the caret is obvious).

### 3.8 Scrollbars

```css
* { scrollbar-width: thin; scrollbar-color: color-mix(in oklch, var(--foreground) 18%, transparent) transparent; }
*::-webkit-scrollbar { width: 8px; height: 8px; }
*::-webkit-scrollbar-thumb { background: color-mix(in oklch, var(--foreground) 18%, transparent);
  border-radius: 9999px; border: 2px solid transparent; background-clip: content-box; }
*::-webkit-scrollbar-thumb:hover { background-color: color-mix(in oklch, var(--foreground) 30%, transparent); }
*::-webkit-scrollbar-track { background: transparent; }
.hf-scroll-stable { scrollbar-gutter: stable; }   /* transcript, settings pages, plugin pages */
```

Layers: sticky chat header `z-10`, composer dock `z-20`, sidebar `z-30` (shadcn default), overlays
(dialogs, popovers, toasts) render in reka-ui portals at `z-50`.

---

## 4. Theme behavior

### 4.1 Configuration (`apps/web/nuxt.config.ts`, S0)

```ts
colorMode: {
  preference: 'dark',        // default for a first visit
  fallback: 'dark',          // used when preference is 'system' and the OS preference is unknown
  classSuffix: '',           // <html class="dark"> / <html class="light">
  storageKey: 'hf-color-mode',
},
app: {
  head: {
    meta: [
      { name: 'color-scheme', content: 'dark light' },
      { name: 'theme-color', content: '#1a1918' },         // sRGB approximation of dark --background
    ],
    style: [{ innerHTML: 'html{background:#1a1918}html.light{background:#faf9f5}' }],
  },
},
```

`@nuxtjs/color-mode` 4: write `useColorMode().preference = 'dark' | 'light' | 'system'`; read the resolved
`useColorMode().value` (read-only). The theme is stored only in `localStorage['hf-color-mode']` (never in server
settings) so it applies before boot.

### 4.2 Toggle UX (`ThemeToggle`, C3)

- Expanded sidebar footer: `ToggleGroup type="single"` with three icon items — `Moon` (dark), `Sun` (light),
  `Monitor` (system) — 28px square each, tooltip "Dark" / "Light" / "System", `aria-label` the same, group
  `aria-label="Theme"`. The value is `colorMode.preference`; clicking the active item does nothing (never empty).
- Collapsed sidebar: one icon button showing the current preference's icon; opens a `DropdownMenu` with a radio
  group (Dark / Light / System).
- Settings → Appearance shows the same choice as three preview cards (writes the same `preference`).
- Command palette actions: "Theme: Dark", "Theme: Light", "Theme: System".
- While switching, add `hf-theme-switching` to `<html>` for one frame (`* { transition: none !important }`) so
  colors swap at once instead of sweeping.

### 4.3 No light flash

1. The color-mode inline script must be in the `<head>` of the generated `200.html` / `index.html` (gate check:
   `grep -c hf-color-mode .output/public/200.html` > 0). It sets `html.dark`/`html.light` before first paint.
2. `app.head.style` paints the `<html>` background by class before any CSS file loads (4.1).
3. `app/spa-loading-template.html` (C3) is self-contained and dark-styled inline: centered ember ◆ (static when
   reduced motion) on `oklch(0.215 0.004 60)`, switched to `oklch(0.984 0.005 90)` under `html.light`. No
   external CSS, no fonts, no script.
4. `main.css` sets `color-scheme` per mode so native scrollbars and form controls match.
5. E2E (W2.6): with the OS emulated as light, a first visit asserts `html.dark`; toggling to Light and reloading
   keeps `html.light`.

### 4.4 Everything follows the mode

| Surface | Rule |
|---|---|
| `theme-color` meta | `useHead` in `app.vue` (C3): `#1a1918` when `colorMode.value === 'dark'`, else `#faf9f5` |
| Shiki (code blocks) | dual themes `github-light-default` / `github-dark-default` emitted as CSS variables and switched by `.dark`, so toggling never re-highlights; block background overridden to `bg-muted/50` (light) / `bg-card` (dark) |
| Markdown (`markstream-vue`) | `Markdown.vue` passes the resolved mode to the renderer's dark-mode prop (verify the prop name in the installed types) |
| Toasts (`vue-sonner`) | `<Toaster :theme="colorMode.value" position="bottom-right" />` in `app.vue`, styled with `--popover` tokens |
| CodeMirror | a `Compartment` swaps `@codemirror/theme-one-dark` (dark) and the default light theme on change |
| Mermaid / KaTeX (lazy, W4.2) | re-render with theme `dark` or `default` on change |
| Brand icons | mono icons use `currentColor` via CSS mask; color icons sit on a `bg-muted` tile in both modes |

---

## 5. App shell

`layouts/default.vue` (C3):

```vue
<SidebarProvider :style="{ '--sidebar-width': '16.5rem' }">
  <AppSidebar />
  <SidebarInset class="bg-background min-h-dvh">   <!-- pages render here -->
    <slot />
  </SidebarInset>
  <CommandPalette />      <!-- W2.4; C3 ships a stub -->
  <ShortcutsDialog />     <!-- W2.4; C3 ships a stub -->
  <ShareDialog />         <!-- Phase 5: W5.6; C9 mounts the stub; opened by ui.openShare(chatId), 7.14 -->
</SidebarProvider>
```

`layouts/auth.vue` (C3): no sidebar; a centered column on `bg-background` for `/login`.
`layouts/share.vue` (C9, Phase 5): the public share page (7.15). No sidebar, command palette, shortcuts dialog or
Share dialog: a `min-h-dvh` column on `bg-background` with a header bar (`--header-height`, bottom border) holding
`BrandMark` + the `harness-forge` wordmark as plain text (not a link: visitors cannot use the app) and
`ThemeToggle collapsed` on the right, then `<main>` (`flex-1`) with the page slot. It mounts nothing that loads a
store.
`app.vue` (C3): `<TooltipProvider>`, `<NuxtLayout><NuxtPage /></NuxtLayout>`, `<Toaster>`, theme-color `useHead`.

### 5.1 Sidebar (`AppSidebar`, C3)

`<Sidebar collapsible="icon" variant="sidebar">`, background `bg-sidebar`, right border `border-sidebar-border`.

| Part | Spec |
|---|---|
| Widths | expanded 16.5rem; icon mode 3rem (`--sidebar-width-icon`; 3.5rem on touch tablets, Phase 6, 14.5); mobile sheet 18rem (below `md`) |
| Toggle | Mod+B (built into `SidebarProvider`), `SidebarTrigger` (`PanelLeft` icon, `aria-label="Toggle sidebar"`); state persists in the shadcn cookie |
| Header | `AppBrand`: ember `BrandMark` (16px) + `harness-forge` in mono 13px/500; trigger at the right. In icon mode only the mark shows; clicking it expands |
| Mode tabs | `ModeTabs` below the brand: segmented `Tabs` [Chat \| Plugins], full width, h-8 (40px tabs on coarse pointers, 14.5), driven by the route (5.2). Hidden in settings mode |
| Content | `ChatNav` (chat mode) · `PluginsNav` (plugins mode) · `SettingsNav` (settings mode) |
| Footer | left: "Settings" (`Settings` icon) → `/settings/providers` (hidden in settings mode, where "← Back to app" is at the top); right: `ThemeToggle` |
| Icon mode | tabs become two stacked icon buttons (`MessageSquare` Chat, `Blocks` Plugins); New chat (`SquarePen`) and Search (`Search`) icons; lists hidden; footer: Settings icon + single theme button; every icon has a tooltip with its label and shortcut |

### 5.2 Modes and route mapping

| Route prefix | Mode | Sidebar content | Tab state |
|---|---|---|---|
| `/`, `/chat/*` | chat | `ChatNav` | Chat active |
| `/plugins`, `/plugins/*` | plugins | `PluginsNav` | Plugins active |
| `/settings/*` | settings | "← Back to app" + `SettingsNav` | tabs hidden |
| `/login` | — | no sidebar (`auth` layout) | — |
| `/share/*` | — | no sidebar (`share` layout, public) | — |

`AppSidebar` watches the route and remembers the last route per mode in
`useSessionStorage('hf-last-routes', { chat: '/', plugins: '/plugins', app: '/' })` (VueUse; no store needed).
Clicking the Chat tab goes to `lastRoutes.chat`; Plugins goes to `lastRoutes.plugins`; "← Back to app" goes to
`lastRoutes.app` (the last non-settings route). Tabs are links (`NuxtLink`), so middle-click works.

### 5.3 Chat mode contents (`ChatNav`, W2.4)

1. "Project" row (Phase 7, `ProjectSwitcher`, W7.9; 7.20, wireframe 2.12) — the first row, above New chat:
   `Folders` + "All chats", `Folder` + a project name, or `FolderX` in `text-warning` when that project's folder is
   missing, then `ChevronsUpDown`. Its menu filters the list below (All chats · No project · a project;
   `chats.setProjectFilter`) and its project is the default project of new chats.
2. "New chat" row — `SquarePen` icon, label, `KbdCombo keys="mod+shift+o"` right-aligned (hidden below `lg`).
   Navigates to `/` and focuses the composer.
3. "Search" row — `Search` icon, `KbdCombo keys="mod+k"`. Opens `CommandPalette` (chats first; search ignores the
   project filter).
4. Date groups from `chats.groups`: **Today**, **Yesterday**, **Previous 7 days**, **Previous 30 days**, then one
   group per month ("September", "August 2025" when not the current year). Group label: caption, muted, sticky
   while scrolling the list.
5. Row (`--row-height`, `rounded-md`, px-2): title (truncate, `text-sm`), trailing 20px slot. Active row:
   `bg-sidebar-accent font-medium`. Untitled chats show "New chat" in muted italic until the title arrives. Rows show
   no project badge (the filter tells the project).
6. Trailing slot: `StatusDot` when the chat has a status; on hover/focus-within/menu-open it shows the `⋯` button
   (`MoreHorizontal`, `aria-label="Chat actions"`) instead. Menu: Rename, Move to project ▸ (Phase 7, `FolderInput`,
   `chat-row-move`, 7.20), Share… (`Share2` icon), Export as Markdown, Export as JSON, separator, Delete
   (destructive). Share… opens the Share dialog through `ui.openShare(chatId)` (7.14; W5.6 owns the item and
   `chat-actions.ts`).
7. Rename: the row turns into `InlineRename` (Enter saves, Esc cancels, blur saves; empty = cancel).
8. Delete: the row disappears at once; toast "Chat deleted" with **Undo** (5s). The API call runs when the toast
   expires (see `chats.remove` in 11). Deleting the open chat navigates to `/`.
9. Infinite scroll: `useIntersectionObserver` on a sentinel → `chats.fetchPage()` (with `projectId` while a project
   filter is set, Phase 7); skeleton rows while loading.
10. Empty list: caption "No chats yet"; with a filter (Phase 7) "No chats in {name} yet" or "No chats without a
    project".

### 5.4 Plugins mode contents (`PluginsNav`, W3.1)

1. "New plugin" row with `ChevronDown` → dropdown: "Provider" (`/plugins/new?type=provider`), "Code plugin"
   (`/plugins/new?type=code`).
2. "Install…" row (`Download` icon) → `ui.openInstall()` (dialog mounted by `pages/plugins.vue`, see 6).
3. "Browse" group: All, Providers, Tools, MCP servers, Commands, Disabled — each with a count badge from
   `plugins.counts`; links to `/plugins?filter=all|providers|tools|mcp|commands|disabled` (no param = `all`;
   DECISIONS "UI query parameters"). Active filter row is highlighted.
4. "Installed" group: every plugin sorted by name (builtins first): `ProviderIcon` (sm) + name + `StatusDot`
   (`active` → ok, `disabled` → off, `loading` → running, `untrusted`/`incompatible` → warning, `error` → error).
   Links to `/plugins/<id>`.

### 5.5 Settings mode contents (`SettingsNav`, C3)

"← Back to app" row, then Providers (`KeyRound`), Models (`Boxes`), Media (`ImagePlay`, Phase 6: right after
Models, `/settings/media`, 9.9), Projects (`Folders`, Phase 7: right after Media, `/settings/projects`, 9.10), General
(`SlidersHorizontal`), Appearance (`Palette`), Data (`Database`, Phase 5: between Appearance and About,
`/settings/data`, 9.8), About (`Info`). The order is therefore Providers, Models, Media, Projects, General, Appearance,
Data, About. Active item from the route. Footer shows only `ThemeToggle`. The links live in `SETTINGS_LINKS`
(`components/app-shell/navigation.ts`; the Media entry has the key `media` and the test id `settings-nav-media`, the
Projects entry the key `projects` and the test id `settings-nav-projects`); the command palette lists them too
(`go-settings-projects`). The wireframes 2.5, 2.7 and 2.10 predate the Projects entry (2.13 shows it).

### 5.6 Main header

- **Chat pages** (`ChatHeader`, W2.2; W5.6 in Phase 5): h-12 (`--header-height`), `z-10 bg-background`, above the
  transcript in the chat view's `h-dvh` column (only the transcript scrolls); bottom border appears only after the
  transcript scrolls (`border-b border-border` when `scrollTop > 0`, fixed 1px reserved so nothing moves). Left:
  `SidebarTrigger` (only when the sidebar is collapsed or on mobile), then the title (`text-base font-medium`,
  truncate). Clicking the title starts `InlineRename`. Phase 7: `ChatProjectChip` follows the title when the chat
  belongs to a project (7.20, wireframe 2.12). Right: `⋯` menu
  (`aria-label="Chat options"`): Rename · Move to project ▸ (Phase 7, `chat-menu-move`, 7.20) · Show thinking
  (checkbox) · Share… · Export as Markdown · Export as JSON · separator · Delete. Share… calls `ui.openShare(chatId)`
  (7.14). The empty state `/` shows no title and no menu (its project is picked under the greeting, 7.20).
- **Other pages** (`PageHeader`, C3): same height and trigger rule; title (`text-xl font-semibold`) +
  optional description (muted) below the bar, actions slot on the right.

### 5.7 Transcript column

- Scroll container: the whole `SidebarInset` area above the composer, `hf-scroll-stable`.
- Column: `mx-auto w-full max-w-3xl px-4 md:px-6`, messages separated by `--message-gap`, `hf-transcript` type.
- User message: right-aligned bubble `bg-muted rounded-2xl px-4 py-2.5 max-w-[85%]`, plain text with
  `whitespace-pre-wrap break-words` (not markdown). Attachments render above the bubble, right-aligned.
- Assistant message: no bubble, full column width, parts in order (section 7), actions row below.
- Bottom padding = composer height + 24px so the last line never hides behind the composer.

### 5.8 Composer dock

`ChatComposer` sits in a sticky dock at the bottom of `SidebarInset` (`sticky bottom-0 z-20`), with a
`bg-gradient-to-t from-background` fade above it, the same `max-w-3xl` column, and
`pb-[max(12px,env(safe-area-inset-bottom))]`. Composer body: `rounded-[20px] border bg-card shadow-sm`. Full spec
in 7.7.

### 5.9 Scroll behavior

- Built on `AiConversation` (stick-to-bottom). Opening a chat jumps to the bottom instantly (no smooth scroll).
- While streaming, the view follows new content only if the user is within 80px of the bottom.
- Scrolling up stops following and shows the scroll-to-bottom pill (`ArrowDown`, 32px circle, centered 12px
  above the composer, `aria-label="Scroll to bottom"`). Clicking it smooth-scrolls and resumes following.
- Sending a message always scrolls to the bottom and resumes following.
- Expanding a row never scrolls the page; the expanded content grows downward.

### 5.10 Status dots (`StatusDot`, C3)

8px circle in a fixed 20px slot (no layout change when it appears or disappears).

| `status` | Look | Meaning / where |
|---|---|---|
| `running` | `bg-primary` + `animate-hf-pulse` | a run is streaming for this chat |
| `approval` | `bg-warning` | the chat waits for a tool approval |
| `unread` | `bg-foreground` | a run finished while the chat was not open; cleared on open |
| `ok` | `bg-success` | plugin active, MCP connected |
| `off` | 1.5px ring `border-muted-foreground`, hollow | disabled |
| `warning` | `bg-warning` | untrusted / incompatible plugin |
| `error` | `bg-destructive` | plugin or MCP error |

Chat priority: `approval` > `running` > `unread`. Each dot has a visually hidden label ("Running",
"Needs approval", "Unread", …) and a tooltip. Chat dots come from the chats store: `running` from
`ChatSummary.running` and `run.started` / `run.finished`; `approval` from `ChatSummary.pendingApproval` and
`run.finished` `awaitingApproval` (persisted server-side, so it survives reloads); `unread` is client-side.

---

## 6. Routes and pages

All pages are `ssr: false` SPA routes. C5 creates every page as a stub in Phase 0; the listed owner builds it.

| Route | File | Contents | Owner |
|---|---|---|---|
| `/` | `pages/index.vue` | empty state: `ChatView` with `isNew` for the draft chat id (`useDraftChatId()`: a uuidv7 kept until the first send, so an unsent draft survives leaving `/`); `ChatGreeting` + `NoProviderCallout` fill its `empty` slot (Phase 7: `NewChatProjectPicker` right under the greeting, 7.20); the first send replaces the route with `/chat/<id>` | W2.2; W7.10 (Phase 7) |
| `/chat/[id]` | `pages/chat/[id].vue` | `ChatView` for an existing chat with `ChatHeader` in its `header` slot; `ChatNotFound` ("Chat not found" + "New chat") for malformed ids and on 404 | W2.2 |
| (parent) | `pages/plugins.vue` | plugins shell: `<NuxtPage />` + the single `InstallDialog` instance bound to `ui.installDialogOpen` (`@installed` → `/plugins/<id>`) | W3.1 |
| `/plugins` | `pages/plugins/index.vue` | `PageHeader` "Plugins" (search, Install…, New plugin ▾), filter from `?filter=` and `?q=`, `PluginCard` grid | W3.1 |
| `/plugins/new?type=provider` | `pages/plugins/new.vue` | `ProviderWizard` (`?edit=<id>` edits an existing declarative plugin); without `type` the page shows a Provider / Code plugin chooser | W3.3 |
| `/plugins/new?type=code` | `pages/plugins/new.vue` | `CodePluginForm` (W3.4 component) | W3.3 (page), W3.4 (form) |
| `/plugins/[id]` | `pages/plugins/[id].vue` → `PluginDetailView` | `PluginHeader` + tabs from `?tab=`: Overview · Configuration (only with a settings schema) · Source (`PluginSourceTab`: code plugins, and declarative plugins whose files are editable, 8.7) · Logs; `McpServersPanel` inside Overview for `core-mcp` | W3.1 (page), W3.4, W3.5 |
| `/settings` | `pages/settings/index.vue` | redirects to `/settings/providers` | W2.5 |
| `/settings/providers` | `pages/settings/providers.vue` | provider list, key dialog (`?configure=<providerId>` opens it) | W2.5 |
| `/settings/models` | `pages/settings/models.vue` | default + title model (chat models only), per-provider model tables | W2.5; W6.10 (Phase 6) |
| `/settings/media` | `pages/settings/media.vue` → `MediaSettings` | "Images and voice": the Images section (image model of the `generate_image` tool) and the Voice section (speech to text, language, read aloud, voice, speed, test voice), 9.9 | C12 (stub), W6.10 |
| `/settings/projects` | `pages/settings/projects.vue` → `ProjectsSettings` | Projects (Phase 7): the project list with rename, instructions and delete, and the Add project dialog with the folder browser (`?add=1` opens it), 9.10 | C15 (stub), W7.9 |
| `/settings/general` | `pages/settings/general.vue` | display name, send key, defaults, max steps (Phase 7: also in project chats), Alt shortcuts, instructions, password | W2.5; W7.12 (Phase 7) |
| `/settings/appearance` | `pages/settings/appearance.vue` | theme cards, reading font, text size, density, expand thinking | W2.5 |
| `/settings/about` | `pages/settings/about.vue` | versions, license, copy diagnostics | W2.5 |
| `/settings/data` | `pages/settings/data.vue` → `DataSettings` | summary, export, import, storage cleanup (Phase 7), shared links (`SharesSettingsSection`), encryption key (Phase 7), danger zone (9.8) | C9 (stub), W5.5; W5.6 (`SharesSettingsSection`); W7.13 (Phase 7 sections) |
| `/share/[token]` | `pages/share/[token].vue` (`layout: 'share'`) → `SharedChatView :token` | public, read-only, store-free transcript of the share snapshot; "This link is unavailable" on 404; `noindex` (7.15) | C9 (stub), W5.6 |
| `/login` | `pages/login.vue` (`layout: 'auth'`) | password form; `?redirect=` | W2.5 |
| unknown | `app/error.vue` (`auth` layout) | "Page not found" (404) or "Something went wrong" (other errors, no raw details) + "Back to chats" (`clearError({ redirect: '/' })`) | C5 |

Route middleware `middleware/auth.global.ts` (C5): loads `auth.fetchStatus()` once; when a password is required
and there is no session, redirects to `/login?redirect=<path>`; `/login` redirects to `/` when already
authenticated. The `$api` plugin (C5) turns any 401 into the same redirect. `redirect` is accepted only when it
starts with `/` and not `//`.

`/share/*` is public (Phase 5, W5.6): `auth.global.ts` returns before loading the auth status (so there is no login
redirect, and `plugins/events.client.ts`, which waits for a loaded status, never opens `/api/events`),
`authRedirectFor()` in `utils/redirect.ts` returns null for it (`isSharePath()`, case-insensitive), and on a 401 the
`$api` plugin neither marks the auth store unauthenticated nor redirects to `/login` while the current route (or the
page being loaded) is under `/share/`. The share page calls only `GET /api/share/:token`.

Query parameters used by the UI: `/plugins?filter=&q=` (`filter` = `all | providers | tools | mcp | commands |
disabled`; not `kind`, which is the plugin kind enum), `/plugins/[id]?tab=`, `/plugins/new?type=&edit=`,
`/settings/providers?configure=`, `/settings/projects?add=1` (Phase 7: opens the Add project dialog), `/login?redirect=`.
Model refs and project ids never appear in paths (the project filter lives in `localStorage`, 7.20).

---

## 7. Chat rendering spec

Owner: W2.2 (transcript, parts, messages), W2.3 (composer and its menus). Part types and states follow the AI SDK
v7 UI message stream; verify the exact names in `node_modules/ai/dist/index.d.ts` before coding.

### 7.1 Message parts

| Part | Renderer | Spec |
|---|---|---|
| `text` | `TextPart` → `Markdown` | `content` = part text; `final` = the part is done (message not streaming, or a later part exists). Assistant only; user text is plain (5.7) |
| `reasoning` | `ReasoningPart` (`AiReasoning` + `AiReasoningTrigger`) | one row, height `--row-height`: while streaming `▸ Thinking… 4s` (shimmer label, live seconds); done: `▸ Thought for 12s` (from `metadata.reasoningMs` when present, so it survives reloads; else "Thought"). Collapsed unless Show thinking is on; expanded body = `Markdown` inside a shadcn `CollapsibleContent` (the copied AI Elements `ReasoningContent` was removed together with vue-stream-markdown, ADR-007), muted, `text-sm`, left border `border-l-2 border-border pl-3` |
| `tool-*` / `dynamic-tool` | `ToolPart` (`AiTool`) | one row, see 7.2 (Phase 7: the `core-workspace` tools render diffs, terminal output, file content and file lists in their row, 7.19) |
| approval request (tool part in approval state) | `ToolApprovalCard` (`AiConfirmation`) | below its tool row, see 7.3 |
| `file` (not an image), `reasoning-file` | `FilePart` → `FileChip` | images (a `reasoning-file` holds a model's draft image): 64px thumbnail (`object-cover rounded-md`), click opens a lightbox `Dialog`; other files: chip with `FileText`, name, size |
| consecutive `file` parts with an `image/*` type (assistant messages) | `ImageGallery` (Phase 6, W6.8, 7.16) | one gallery block per run of images (`chat-format.ts` block kind `gallery`; parts that render nothing, such as `step-start`, never split a run, any rendered block does): generated images of an image turn, of a chat model with image output or of the `generate_image` tool; one image full width, two or more in two columns; a lightbox with previous / next and Download |
| `source-url` / `source-document` | `SourcesPart` (`AiSources`) | consecutive sources merge into one row "3 sources" (`Link2` icon); expanded: title + hostname links (`target="_blank" rel="noopener noreferrer"`) |
| `step-start` | — | renders nothing (no divider) |
| `data-notice` | `NoticePart` | one muted line with the server's message and an icon per code (codes in API.md 6.4; Phase 6 adds `generated-file-dropped`, icon `ImageOff`, level warning: a generated file that is not a PNG, JPEG, WebP or GIF image, or larger than 20 MB, was not kept; it stands where the file was; Phase 7 adds `workspace-unavailable`, icon `FolderX`, level warning: the chat's project folder could not be opened, so this run has no workspace tools; the message names the folder and the reason, 7.20) |
| `data-*` | — | ignored unless listed in `docs/API.md`; unknown data parts never render |
| error (message `metadata.error` or stream error) | `ErrorPart` | alert at the end of the message, see 7.4 |

A user message whose `metadata.command` is set shows `CommandBadge` (`SquareTerminal` + `/name`) above the
bubble text; the text stays as typed. A `reply` command answer shows "Command reply" instead of the model name
in the meta row.

An assistant message of an image turn (`metadata.image` set, ADR-028) that is streaming and has no file part yet
renders `GeneratingImages` (7.16) after its parts: `n` placeholder tiles at the requested aspect ratio. A finished,
failed or stopped turn keeps `metadata.image` without files, so `metadata.finishedAt`, an error or `aborted` ends the
placeholders even before the stream closes. User attachments keep rendering above the bubble (5.7); only assistant
images form galleries.

### 7.2 Tool rows

Layout (`--row-height`, `rounded-md`, `hover:bg-accent`, whole row is the collapsible trigger):

```
▸  [icon]  display_name  "first argument…"   [server badge]                 status
```

- Icon: `Wrench` for plugin/core tools; `Server` for MCP tools; Phase 7: each `core-workspace` tool has its own icon
  (7.19). Display name: the tool name; for `mcp__<server>__<tool>` show `<tool>` plus a small outline badge with the
  server name.
- First argument: the first string value of the input, one line, mono, max 60 chars, quoted, muted.
- Status by part state:

| State | Status cell | Row behavior |
|---|---|---|
| `input-streaming` | `Spinner` (12px) | args fill in as they stream |
| `input-available` | `Spinner` | tool is running |
| `approval-requested` | amber dot + "Needs approval" | `ToolApprovalCard` renders below; chat dot = `approval` |
| `approval-responded` | `Spinner` if approved, else like `output-denied` | |
| `output-available` | `Check` in `text-success` | |
| `output-error` | `X` in `text-destructive` | expanded body shows the error text |
| `output-denied` | `Ban` + "Denied" (muted) | tooltip "Skipped because you sent a new message" when superseded |

Expanded body (`pl-8`, `text-xs` mono, `bg-muted/50 rounded-md p-3`): **Input** (pretty JSON) and **Output**
(string → pre-wrap text; object → pretty JSON), each capped at 4 KB with "Show all" (another 60 KB max) and a
"Truncated by server" note when the server capped it. `CopyButton` on each block. Rows never auto-expand.

`generate_image` (Phase 6, `core-tools`, policy `ask`): a normal tool row whose first argument is always the prompt
(even when the model lists `aspectRatio` first; `toolRowArgument` in `parts/tool-row.ts`); its output holds file
references only (`{ modelRef, images: [{ fileId, url, mediaType, name }], costUsd?, revisedPrompt? }`).
The images themselves are `file` parts the server appends after the tool call, so they render as a gallery (7.16) right
below the row, in shares and backups too. Without an image model in Settings → Media the row ends in `output-error`
with "Choose an image model in Settings → Media." Phase 7: the output also carries `modelName` (the model's display
name; outputs saved before v1.3 lack it).

Workspace tools (Phase 7, ADR-032; `core-workspace`: `read_file`, `list_directory`, `find_files`, `search_files`,
`write_file`, `edit_file`, `shell`) use the same row with their own icon and first argument, plus a summary before the
status (`+12 −3`, `exit 1`, `lines 1–120 of 340`, `17 files`, `23 matches`; `tool-row-summary`), and their expanded body
shows a diff, terminal output, file content or a file list instead of the Input / Output blocks, with a "Raw input and
output" toggle (7.19). A row whose output does not parse with the shared schemas falls back to the generic blocks.

### 7.3 Approval card

`ToolApprovalCard` inside `AiConfirmation`, directly under its tool row:

```
┌───────────────────────────────────────────────────────────────┐   border-warning/50, bg-warning/5
│ Allow web_fetch?                              from core-tools │   tool name in mono 600
│ { "url": "https://nuxt.com/docs" }                            │   args JSON, max-h-48 scroll
│ ☐ Always allow web_fetch                                      │
│                                              [Deny]  [Allow]  │   outline / primary
└───────────────────────────────────────────────────────────────┘
```

- Allow → `addToolApprovalResponse({ id, approved: true })`; Deny → `approved: false`. With "Always allow"
  checked, Allow also sends `PATCH /api/tools/:name` with override `allow` (via `plugins.setToolPref`). The
  checkbox does nothing on Deny.
- The stream continues automatically when every pending approval of the message has a response
  (`sendAutomaticallyWhen`). After a decision the card collapses into the row status.
- No implicit keyboard approval: Enter in the composer never approves. The card is announced once through the
  polite live region ("Approval needed: web_fetch").
- Sending a new message while approvals are pending is allowed; the server marks the ones on the path of the new
  message denied (superseded). An approval pending on another version stays pending and its card works again after
  switching back to that version (ADR-023).
- **Workspace tools** (Phase 7, ADR-032; wireframe 2.14, renderers 7.19): `ToolApprovalPreview`
  (`tool-approval-preview`, `data-kind`) replaces the JSON block whenever the registry has a view for the call.
  `edit_file` → a `DiffView` of `old_string` → `new_string` (an "All occurrences" badge with `replace_all`);
  `write_file` → "Create or overwrite {path} · {n} lines" and a 20-line `FileContent` preview (the client does not
  have the old file, so no diff); `shell` → the card title "Run this command?", the `description` as text when
  present, the command in a large mono block, "In {project}" and the timeout when set, and the warning
  (`TriangleAlert`, `text-warning`) "Runs on the server with the server user's permissions."; its buttons are Deny /
  **Run**.
- **"Always allow" is hidden** for tools with workspace access `execute` (`ToolApprovalCard.workspace`, from
  `ToolSummary.workspace`): a shell command is approved one call at a time.
- **"Accept all edits in this chat"** (`tool-approval-accept-edits`) replaces "Always allow {tool}" for tools with
  workspace access `write` while the chat is not already in Accept edits: Allow with it checked sets the chat's
  permission mode to `edits` before the approval is sent (`ToolApprovalDecision.acceptEdits`, 11.1), so the
  continuation already runs in Accept edits; it writes no tool override. A hidden or secret path still asks in Accept
  edits (policy `always`); its card then shows neither checkbox.
- The polite live region announces a shell approval as "Approval needed: run {command}" (the first line, at most 60
  characters).

### 7.4 Errors

Errors arrive as a `HarnessError` envelope (`{ error: { code, message, status?, action?, providerId?,
retryAfterMs?, details? } }`; `status` is the upstream provider status, e.g. "Error 401", while the HTTP status
comes from `code`), parsed by `toHarnessError()` in `utils/errors.ts` (C5), a thin wrapper over
`HarnessError.from()` from `@harness-forge/shared`. `ErrorPart` renders an `Alert`
(`variant="destructive"` for errors, default + `warning` icon for `rate_limited`) with a one-line title, the
server message as description, and at most two actions.

| `code` | Title | Actions |
|---|---|---|
| `provider_not_configured` | "No API key for {provider}" | **Open settings** → `/settings/providers?configure={providerId}` |
| `auth_invalid` | "{provider} rejected the API key" | **Open settings** |
| `rate_limited` | "Rate limited by {provider}" | **Retry** (disabled with a countdown while `retryAfterMs` runs) |
| `model_not_found` | "Model not found" | **Refresh models** (`models.refresh(providerId)`), **Choose model** (opens picker) |
| `context_overflow` | "This chat no longer fits the model's context" | **New chat**, **Choose model** |
| `provider_unreachable` | "Can't reach {provider}" | **Retry** |
| `provider_error` | "{provider} returned an error" | **Retry**; `details` in a collapsible |
| `plugin_error` | "A plugin failed" | **View logs** → `/plugins/{details.pluginId}?tab=logs` when known, else **Retry** |
| `internal_error` | "Something went wrong" | **Retry** |

The envelope `action` wins over the table: `configure-provider` → Open settings, `refresh-models` → Refresh
models, `login` → Log in, `retry` → Retry. Exception: `403 forbidden` with `action: 'login'` while a session exists
means fresh auth is missing (API.md): the caller opens `ConfirmPasswordDialog` and retries the request once (8.4).
Retry = `regenerate()` of the failed message: on the last message it retries the last request (a user message the
server never stored is sent again, 11.1); on an older failed reply it adds a new version of that reply (7.5).

Two answers to a chat request show a toast instead of the alert, and the user message the server did not store goes
back into the composer (`takeBackUnstored()`, 11.1):

- 409 `conflict` with `details.reason: 'run-active'` (a run already holds the chat, e.g. one started in another tab)
  → toast "A response is already running in this chat."; the transcript follows the running reply. A version switch
  during a run gets the same answer and toast.
- 404 `not_found` (an unknown `parentId` or `messageId`: the chat changed in another tab, so the shown path is stale)
  → toast "This chat changed elsewhere and was reloaded."; the session reloads the path. A version switch answered
  404 does the same.

409 `conflict` with `details.reason: 'busy'` (a data import, delete-all, key rotation or file cleanup is running, 9.8)
→ toast "Another data task is running. Try again when it finishes." (Phase 7; v1.2 said "Another import or delete is
running. Try again when it finishes."). A **chat request** answered 409 `busy` (Phase 7: a master-key rotation stops
the runs and holds new ones off, ADR-034) → toast "The server is rotating its encryption key. Try again in a moment.",
and the unstored user message goes back into the composer as for `run-active`. Moving a chat to another project
during a run → 409 `run-active` → toast "Wait for the response to finish before moving this chat." (7.20). Every
other failed request outside the transcript → `toast.error(title, { description })` with the same titles.

### 7.5 Message actions, versions and meta

Messages form a tree on the server (ADR-023): editing a user message or regenerating a reply adds a **version** (a
sibling with the same parent) instead of deleting later messages. The transcript shows one path, the active path
(`ChatDetail.messages`); `ChatDetail.branches` maps every message of that path that has at least two versions to its
sibling ids (`seq` order) and the index of the shown one (API.md, `MessageBranch`).

```
                                  ┌───────────────────────────────┐
                                  │ Try it with server sessions   │   user message, version 2 of 2
                                  └───────────────────────────────┘
                                                 ‹ 2/2 ›  ⧉  ✎      switcher first, always visible
   Here is the plan: …
   ‹ 1/3 ›  ⧉  ↻   Claude Sonnet 5 · 14s                            a reply with three versions
```

- The actions row has a fixed height (28px; 40px on coarse pointers) and is always laid out; its buttons are
  `invisible` until hover or focus-within, and always visible on the last assistant message once it finished (no
  layout shift).
- **Version switcher** (`BranchSwitcher`, W5.2, contract in 10.4) — rendered only for messages listed in `branches`,
  **first** in the action row of user and assistant messages and always visible (outside the hover fade): `‹`
  "Previous version", the counter "2/3" (screen-reader text "Version 2 of 3"), `›` "Next version". The buttons are
  `aria-disabled` (not `disabled`, so focus is never lost) at the first / last version, while a request is in flight
  (`busy`) and while a switch is pending (`switching`). Selecting a version calls `session.switchBranch(siblingId)`
  (`POST /api/chats/:id/branch`): the transcript shows the path last shown under that version (Phase 6, ADR-030: each
  message remembers the child shown under it, `messages.selected_child_id`; a version never shown before shows its most
  recent path) and focus lands on the same control of the new version's switcher; the polite live region announces
  "Version 1 of 3". The server keeps the choice (the chat's active leaf), so a reload shows it again. During a run the
  server refuses the switch with 409 and a stale path gets 404 (both 7.4); any other failure → toast "Could not switch
  versions" with the server message. Keyboard: Tab, Enter and Space on the buttons; ArrowLeft / ArrowRight anywhere
  inside the switcher.
- Assistant: **Copy** (all text parts as markdown; icon swaps to `Check` for 1.5s, no toast; hidden when the reply has
  no text, e.g. an image turn), **Read aloud** (Phase 6, `ReadAloudButton`, 7.18: right after Copy on finished replies
  with text, only when a speech model is set), **Regenerate** (every finished assistant message; hidden while busy
  through the transcript's `data-busy`, like Edit; uses the model currently selected in the composer;
  `trigger: 'regenerate-message'` with `messageId`), **Delete this version** (below), then the meta text:
  `ModelLabel` (sm) · duration ("14s") · "Stopped" when `metadata.aborted` · "Max tokens reached" when
  `finishReason === 'length'`. Hovering the meta opens a `HoverCard`: input / output / reasoning / cache tokens, cost
  ("$0.004"), started time; an image turn adds the line "2 images · 16:9 · edited 1 image" above the rows (from
  `metadata.image`: `n`, `aspectRatio`, `inputs`; the ratio is left out for Auto and the edit part when no input image
  was sent) and labels its cost "Estimated cost" (image turns only: a chat model with image output and the
  `generate_image` tool keep the label "Cost"). Regenerating adds a new version of that reply
  under the same user message; the path continues from the new version, and the older version keeps the messages that
  followed it.
- User: **Copy**, **Edit** (any user message while no run is active), **Delete this version** (below). Edit turns the
  bubble into `MessageEditor` (textarea at the bubble's width, the message's attachments, Cancel / Send). Send creates
  a **new version** of that message: the session drops the local messages from the edited one on and sends a new user
  message (a new id) whose `parentId` is the edited message's parent (11.1); the old version and everything after it
  stay reachable through the switcher. Enter/Mod+Enter follows `sendKey`; Esc cancels.
- **Attachments on edit** (Phase 6, S8, W6.7): the editor shows the edited message's attachments as removable
  `FileChip`s (`message-edit-attachment`, "Remove {name}") and a paperclip button (`message-edit-attach`, "Attach
  files", 40px on coarse pointers) that opens a hidden file input with the composer's accept list (the input has no
  test id, only `data-slot="message-edit-file-input"`); pasting files adds them too (rich text with HTML is pasted as
  text). New files upload at once through a private `useComposerAttachments()` instance (chips show the upload state;
  rejected files show the composer's toasts from `attachment-toasts.ts`: "{name} is too large" / "Files can be up to 20
  MB.", "{name} can't be attached" / "Attach images, PDFs or text files."). Send waits for the uploads, is disabled
  while one runs or failed, and is allowed with attachments and no text; Cancel (or Esc) discards the editor and aborts
  its uploads. The new version carries exactly the chips left in the editor, then the new uploads.
- ↑ in an empty composer opens `MessageEditor` on the last user message.
- **Delete this version** (Phase 6, ADR-030, W6.7; `Trash2`, `message-delete-version`, 40px on coarse pointers): on
  user and assistant messages listed in `branches` (they have at least two versions), while no request is in flight and
  no switch is pending. It opens one `ConfirmDialog` owned by `ChatView`: title "Delete this version?", text "This
  version and every message after it are deleted. Other versions stay.", confirm "Delete version"
  (`message-delete-version-confirm`, destructive). Confirm → `session.deleteVersion(messageId)` (`DELETE
  /api/chats/:id/messages/:messageId`): the transcript shows the previous version (else the next) with the path last
  shown under it; the polite live region announces "Version deleted"; focus moves to the switcher of the version now
  shown (its first enabled control), or to its Copy button when only one version is left (no switcher). 409
  `run-active` → the conflict toast of 7.4 and the session follows the run; 404 → the stale-path toast of 7.4 and a
  reload; every other failure (including 409 `only-version`) → toast "Could not delete the version" with the server
  message. While the request runs the dialog cannot be dismissed and the switchers are disabled (`switching`).
  Canceling the dialog, a failure, or a deletion that changed nothing returns focus to "Delete this version" (when that
  message is still shown). Usage totals, share snapshots and files are kept. Search (Mod+K) covers every version, so a
  match may come from a version that is not on the active path.
- **Other tabs** (Phase 6, ADR-030): `chat.updated` carries the chat's `activeLeafId`, so a switch or a deletion made in
  another tab moves this tab too: an idle session whose last stored message is not that leaf reloads the path
  (`followActiveLeaf()`, 11.1; nothing happens while a request or a switch runs). Known limit: deleting a version that is
  not on the active path does not move the leaf (the event repeats the unchanged leaf), so other tabs keep an old
  counter until they reload the chat. After the session's own edit or regenerate, the new switcher ("2/2") appears once
  `run.finished` arrives (`refreshBranches()`, 11.1).

### 7.6 Streaming states

| Session status | Transcript | Composer |
|---|---|---|
| `ready` | stable | Send (disabled when text and files are empty, no usable model, or voice input runs, 7.17) |
| `submitted` | assistant placeholder: one line (`--transcript-line-height` tall) with `AiShimmer` "Thinking…" | Stop |
| `streaming` | parts render incrementally (`Markdown final=false` on the growing text part) | Stop; Esc stops |
| `streaming`, image turn (Phase 6) | once the `start` chunk carries `metadata.image` and until the first `file` part: `GeneratingImages` (7.16), `n` placeholder tiles at the aspect ratio + "Generating image… 12s"; then the gallery | Stop; Esc stops (the reply is saved "Stopped", without images) |
| `error` | `ErrorPart` on the last assistant message | Send |

Stop = `session.stop()`: calls `POST /api/chat/:id/stop`, then aborts the client request (the server run
survives disconnects, so a client abort alone would only disconnect). Leaving the page never stops a run;
returning resumes it: `@ai-sdk/vue` 4 has no `resume` option, so the session calls `chat.resumeStream()` on mount
when the chat has an active run (11.1).

### 7.7 Composer (`ChatComposer`, W2.3)

Structure inside `AiPromptInput`:

```
┌──────────────────────────────────────────────────────────────────────┐
│ [chip: screenshot.png ×] [chip: notes.md ×]                           │ attachments (only when any)
│ Reply…                                                                │ autosize textarea, 1 line → 40vh
│ [+] [✱ Claude Sonnet 5 ▾] [High ▾]           [Ask ▾]  [◔]  [(↑)]     │ toolbar, h-10
└──────────────────────────────────────────────────────────────────────┘
```

- Left tools: `ComposerAddMenu` (`Plus`, `aria-label="Add"`): "Attach files" (`Paperclip`), "Commands"
  (inserts `/` and opens `SlashMenu`). Then `ModelPicker`, then `EffortMenu` (only when the model reasons), then
  `ImageOptionsMenu` (Phase 6, only for image models and chat models with image output, below). While dictation
  records or transcribes, `RecordingIndicator` replaces the left tools (7.17; wireframe 2.11).
- Right tools: `PermissionMenu` (only when at least one tool exists and the model has `capabilities.tools`),
  `ContextRing` (only after the first assistant message with usage; never for image models), `MicButton` (Phase 6,
  7.17: right before Send; hidden when the browser cannot record), `SendStopButton`: 32px circle,
  `bg-primary text-primary-foreground`, `ArrowUp` (Send) / filled `Square` (Stop); disabled = `bg-muted
  text-muted-foreground`. Same size in every state. Send is also disabled while voice input runs (tooltip "Finish
  dictation first"). While the recording indicator shows, `PermissionMenu` and `ContextRing` step aside as well, and
  Alt+M / Alt+R / Alt+P and the `/model`, `/effort`, `/mode` menus do nothing.
- Placeholder: "Reply…" in a chat, "Ask anything…" on `/`, "Describe an image…" whenever an image model is selected.
  Textarea font 15px (16px below `md`, iOS zoom).
- **Image models** (Phase 6, ADR-028): the message text is the prompt (at most 32,000 characters: a longer one keeps
  Send disabled with the tooltip "The prompt can be up to 32,000 characters"; an empty prompt keeps it disabled too,
  also when files are attached). Image models have no reasoning and no tools, so `EffortMenu` and `PermissionMenu` hide
  themselves; attached images are sent as input images when the model has vision (else the warning line below keeps
  Send disabled); a reply with images makes the next message an edit of those images unless "Edit the previous image"
  is off. `ImageOptionsMenu` (W6.9, `image-options-trigger`): a ghost h-8 trigger (40px on coarse pointers) with the
  `Image` icon and a summary ("16:9 · 2", "Auto"; the text hides below `sm`), tooltip "Image options", accessible name
  "Image options: 16:9, 2 images" ("Image options: 16:9" for chat models with image output). Its `DropdownMenu` has
  "Aspect ratio" (radio items drawn as shape tiles in a four-column grid: Auto, 1:1, 3:2, 2:3, 4:3, 3:4, 16:9, 9:16;
  `image-aspect-option`, `data-value` `auto` or the ratio; opening focuses the current one), "Images" (radio 1–4, image
  models only; `image-count-option`, `data-value`) and the checkbox "Edit the previous image" (image models only, shown
  only when the last reply on the path has images, checked by default; `image-edit-previous`). Chat models with image
  output get the aspect ratio only; the menu closes after each pick and gives focus back to the textarea (desktop).
  Choices are remembered per browser (`useImageOptions`, `localStorage['hf-image-options']`, 11; 1 image, Auto and
  "Edit the previous image" on are the defaults and are stored as absent keys) and sent as `imageOptions` only with
  image-capable models.
- Send key: `sendKey = enter` → Enter sends, Shift+Enter newline; `mod-enter` → Mod+Enter sends, Enter newline.
  Ignore Enter while `event.isComposing` (IME).
- Attachments: `+` → file picker (multiple), paste of files/images, drag and drop onto the chat pane (overlay
  "Drop files to attach", dashed `border-ring` inset). Each file uploads at once to `POST /api/files`; chips show
  `Spinner` while uploading, destructive border + "Retry" on failure, `X` to remove. Send waits for uploads.
  A file over 20 MB → toast "{name} is too large" ("Files can be up to 20 MB."); another type → "{name} can't be
  attached" ("Attach images, PDFs or text files."). When the model lacks vision and an image is attached (or lacks PDF
  input and a PDF is attached), a warning line shows under the chips ("Claude Haiku can't see images. Remove them or
  choose another model." / "… can't read PDFs. Remove them or choose another model.") and Send stays disabled with that
  text as its tooltip.
- Drafts: unsent text per chat is kept in `sessionStorage` (`useComposerDraft`) and restored on return.
- Client commands never reach the server (7.8). Server commands are sent as typed; the server expands them.
- Focus: autofocus on desktop when a chat opens and after sending; never on touch devices. Shift+Esc focuses.

### 7.8 Slash menu (`SlashMenu`, W2.3)

Opens when the textarea starts with `/` (caret in the first token); a popover anchored above the composer,
`Command` list filtered by prefix, max 8 visible rows.

| Group | Items |
|---|---|
| App (client) | `/new` Start a new chat · `/model` Switch model · `/effort` Set reasoning effort · `/mode` Set permission mode · `/help` Show shortcuts and commands |
| Commands (server) | from `plugins.commands` (`GET /api/commands`): `/name`, description, source plugin name (muted, right) |

↑/↓ move, Enter or Tab completes, Esc closes. Client commands without arguments run at once; `/model`,
`/effort`, `/mode` without an argument open their menu; with one (`/effort high`, `/mode auto`,
`/model anthropic:claude-sonnet-5`) they apply it on Enter and clear the input. `/help` opens `ShortcutsDialog`.
Server commands insert `/name ` and keep the menu closed. Phase 7: `/mode edits` (aliases `/mode accept-edits` and
`/mode accept edits`) selects Accept edits in a project chat; in a chat without a project it changes nothing and shows
the error "Accept edits works in project chats." (7.11).

### 7.9 Model picker (`ModelPicker`, W2.3)

- Trigger (composer variant): ghost button h-8, `ProviderIcon` (sm, auto) + model display name + `ChevronDown`;
  name truncates at 18ch. If the selected model is unavailable (provider disabled or removed), the trigger shows
  `TriangleAlert` in `text-warning` and Send is disabled with tooltip "This model is unavailable".
- Content: `Popover` 22rem wide (bottom `Drawer` below `md`) with a `Command`: search input "Search models…"
  (matches display name, model id, provider name), then groups:
  1. **Favorites** (starred), 2. **Recent** (last 5 used, `models.recentRefs`), 3. one group per connected
  provider in settings order, chat models only (`models.groupedByProvider`); group header = `ProviderIcon` (md, color)
  + provider name, 4. **Image models** (Phase 6, ADR-028; `model-picker-group` with `data-value="images"`, header
  `Image` icon + "Image models"): the visible `kind: 'image'` models of connected providers in provider order (an image
  model is visible only when its provider can generate images), each with its provider icon; a search (display name,
  model id or provider name) matches them too and shows the provider groups and this group only. Favorites and Recent
  hold chat and image models only: transcription and speech models never show here (they are chosen in Settings →
  Media, 9.9), and neither does any other kind. `/model <query>` resolves chat and image models only.
- Item: `ProviderIcon` (sm, auto) · name · `ModelCaps` (Eye = vision, Wrench = tools, Brain = reasoning, Image = image
  output (Phase 6, `capabilities.imageOutput`, tooltip "Image output"), each with a tooltip) · context size right-aligned
  in `text-xs tabular-nums` ("200K", "1M") · a star button on hover (`aria-label="Favorite"`) toggling
  `models.setPref(ref, { favorite })`. Hidden models never show.
- Footer (sticky): "Manage models" → `/settings/models`, "Connect providers" → `/settings/providers`.
- Selecting sets the chat's model (`chats.update(id, { modelRef })` through the session), records it in recents
  and closes. New chats start with `settings.defaultModelRef` (skipped when it names a known model that is not a chat
  model), else the most recent visible chat model, else the first visible chat model (`models.defaultRef` never picks
  an image model). Opened by click, Alt+M, or `/model`.

### 7.10 Effort menu (`EffortMenu`, W2.3)

`DropdownMenu` radio group. Trigger: ghost h-8, `Brain` icon + label (label hidden below `sm`). Options: Auto
("Provider default"), then only the efforts the model lists in `reasoningEfforts` in the order Off, Low, Medium,
High, Max. Hidden when the model has no reasoning capability; the value still travels with the request
(`auto` sends nothing). Alt+R opens it.

### 7.11 Permission menu (`PermissionMenu`, W2.3)

`DropdownMenu` radio group bound to `ToolMode`; trigger ghost h-8 with icon + label:

| Value | Label | Icon | Description |
|---|---|---|---|
| `ask` | Ask | `Hand` | Ask before tools that can change things (default) |
| `edits` | Accept edits | `FilePenLine` | Edit project files without asking; ask before shell commands (Phase 7) |
| `auto` | Auto | `Zap` | Run tools without asking, except ones marked always-ask |
| `off` | Off | `CircleSlash` | Don't use tools |

The options come from `TOOL_MODE_OPTIONS` (`composer/permission.ts`) in this order. **Accept edits** (Phase 7,
ADR-032) is shown only in project chats or while it is the current value: `ChatComposer` passes `modes` to
`PermissionMenu` from its `projectId` prop (10.4). In Accept edits, safe tools and `ask` tools with workspace access
`write` (`write_file`, `edit_file` on ordinary paths) run without a card; the shell, hidden or secret-looking paths
(policy `always`) and every other tool that asks in Ask still ask. In a chat without a project the stored value
`edits` behaves like Ask (no workspace tool is offered there). Alt+P opens it. Default for new chats:
`settings.defaultToolMode` (Settings → General offers Accept edits too, 9.4).

### 7.12 Context ring (`ContextRing`, W2.3)

`AiContext` trigger: 18px circular progress = context used by the last assistant turn (input + output tokens of
its last step) / model `contextWindow`. Color: `text-muted-foreground`; ≥ 80% `text-warning`; ≥ 95%
`text-destructive`. `HoverCard`: "42% of context used", "84K / 200K tokens", input / output / reasoning / cache
rows, "Chat cost $0.12" (sum of message `costUsd`, hidden when unknown). Hidden when the model has no
`contextWindow`, and always for image models (Phase 6: an image turn sends no history). With versions (7.5) the chat
cost sums the **visible** messages only (the active path); the server's `ChatDetail.totals` sums every usage row,
including hidden versions and image generations (the cost actually paid).

### 7.13 Empty state and no-provider callout (W2.2)

- `ChatGreeting`: `BrandMark` 28px, then "What's next, {displayName}?" (Source Serif 4, 32px; "What's next?" when
  `displayName` is empty). Phase 7: `NewChatProjectPicker` sits right under the heading when at least one project
  exists (7.20). The composer follows.
- `NoProviderCallout` shows when `providers.hasUsableProvider` is false: `Alert` with `PlugZap` icon, title
  "Connect a provider to start", text "Add an API key for Anthropic, OpenAI, DeepSeek and more, or run models
  locally with Ollama.", button "Connect a provider" → `/settings/providers`. Send stays disabled with tooltip
  "Connect a provider first".

### 7.14 Share dialog (`ShareDialog`, W5.6)

A share link is a read-only link to a **snapshot** of the chat's active path (ADR-025): later messages are not shared
until the owner updates the snapshot. One `ShareDialog` lives in `layouts/default.vue`; "Share…" in the chat header
menu (5.6) and the sidebar row menu (5.3) call `ui.openShare(chatId)`, closing calls `ui.closeShare()`. Wireframe:
2.8. `Dialog` (`sm:max-w-lg`, at most the viewport height minus 2rem, scrolling inside), title "Share chat",
description "Anyone with a link can read a snapshot of this chat. Messages you add later are not shared until you
update the snapshot."

- **Loading**: on open, `shares.list({ query: { chatId } })`; skeleton cards meanwhile; a failure shows the inline
  error with **Try again**. A chat without links shows "This chat has no links yet." above the new-link form.
- **Passwordless warning** (`share-passwordless-warning`, warning `Alert` with `TriangleAlert`) when
  `auth.status.enabled === false`: title "No password set", text "Links open only where the app is reachable without
  a password (normally just this computer). Set HF_PASSWORD before exposing the server." (Without a password the
  server answers 403 to every host name that is not local, share routes included; ARCHITECTURE.md 10.1.)
- **Link cards** (`share-link`, newest first, one per link of the chat, at most 20):
  - a read-only `Input` with the absolute URL `location.origin + summary.path` (mono, selects all on focus,
    `share-url`) and **Copy link** (`CopyButton`, `share-copy`);
  - meta "{n} messages · snapshot {RelativeTime(snapshotAt)}", an **Outdated** badge (`share-outdated`, warning
    outline, tooltip "The chat changed after this snapshot. Update the snapshot to share the latest messages.") when
    `outdated`, an **Expired** badge (`share-expired`, destructive outline) when `expired`;
  - what is included: three `Switch`es (`share-option`, `data-value` `attachments` / `reasoning` / `tool-details`;
    labels "Files and images" (Phase 6: it also covers generated images; the label lives only in `share-links.ts`, W6.8;
    it was "Attachments" in v1.1), "Reasoning", "Tool details") with the hint "Changes apply to the link at once."; a change
    sends `shares.update({ options: { <key>: value } })` (no new snapshot: the server applies options when it serves
    the page);
  - an expiry `Select` (`share-expiry`): Never · 1 day · 7 days · 30 days · 90 days (items `share-expiry-option`,
    `data-value` `never` / `1d` / `7d` / `30d` / `90d`); the trigger shows the current state ("Never expires",
    "Expires in 5 days", "Expired"); choosing an item sends `shares.update({ expiresAt })` computed from now (`null`
    for Never), which also revives an expired link (choosing the same item again extends the link from now);
  - **Update snapshot** (outline, `share-update`): `shares.update({ refresh: true })`; the URL never changes;
  - **Revoke…** (ghost destructive, `share-revoke`) → `ConfirmDialog` "Revoke this link?" / "People with the link can
    no longer open it. This can't be undone." / confirm "Revoke" (`share-revoke-confirm`) → `shares.remove`; the card
    disappears (also when the link was already revoked elsewhere: 404).

  A card disables its controls while one of its requests runs and replaces itself with the returned `ShareSummary`;
  an update answered 404 (the link was revoked elsewhere) removes the card and shows the error.
- **New link** (`share-create-form`, heading "New link"): the same three switches (Files and images on, Reasoning
  off, Tool details off), the expiry `Select` (trigger "Never expires", "Expires in 7 days", …) and **Create link**
  (primary, `share-create`) → `shares.create({ chatId, options, expiresAt })` → the new card appears on top with its
  URL focused and selected. At 20 links the button is disabled with the hint "A chat can have up to 20 links."
- **Fresh auth** (ADR-017, 8.4): create and update are fresh-auth routes, run through `useFreshAuth` with
  `required: true` (Phase 6). When `auth.fresh` is false the dialog first opens `ConfirmPasswordDialog` ("Confirm your
  password to create or change a share link.") and calls `auth.login(password)`; a `403 forbidden` + `action: 'login'`
  answer (the window ran out meanwhile) prompts the same way and retries once. Concurrent requests share one prompt;
  closing it cancels them without an error. Revoke is not a fresh-auth route.
- **Errors**: an inline `Alert` (`share-dialog-error`) with the 7.4 title and message; `payload_too_large` → "This
  chat is too large to share (the snapshot would exceed 10 MB)."
- A running chat can be shared: the snapshot ends at the last stored message (the reply in flight is not included).
  The share title is not editable here (the API accepts `title`); the page shows the snapshot title.

### 7.15 Shared chat page (`/share/[token]`, `SharedChatView`, W5.6)

Public and read-only (wireframe 2.9). `pages/share/[token].vue` uses the `share` layout (5) and renders
`<SharedChatView :token>`. The component is **store-free**: it calls only `useApi().shares.view({ params: { token } })`
(`GET /api/share/:token` → `ShareView`, API.md) and never loads the auth status, settings, models, providers or
chats (6: the route is exempt from the auth middleware).

- **States** (`share-page`, `data-state`): `loading` (title and message skeletons) · `ready` · `unavailable` (the
  API answered 404, or the token does not match `SHARE_TOKEN_PATTERN` and no request is made: `Empty` "This link is
  unavailable" / "It may have expired or been revoked, or the chat was deleted.", `share-unavailable`) · `error` (any
  other failure: "Couldn't load this chat" + the server message +
  **Try again**, `share-page-error` / `share-page-retry`; 429 reads "Too many requests. Try again in {n}s." from
  `retryAfterMs`).
- **Header**: `h1` = the snapshot title ("Untitled chat" when null, `share-title`), then "Read-only snapshot · {date
  of snapshotAt}" (`share-meta`, muted `text-sm`).
- **Transcript** (`share-transcript`): the `hf-transcript` type, the `max-w-3xl` column and `--message-gap` of 5.7;
  no composer, actions, version switchers or status dots. Each `ShareMessage` (`share-message`, `data-role`,
  `data-status`) renders with the chat components, adapted to the shape they read (a generated key, `role`, `parts`,
  `metadata.command`):
  - user → `UserMessageBubble` (attachments, command badge, plain text);
  - assistant → parts in order: `text` → `TextPart` (final), `reasoning` → `ReasoningPart` (`streaming` false,
    collapsed, label "Thought"; present only when the share includes reasoning), `tool` → `ShareToolRow`, a `file`
    that is not an image → `FilePart`, consecutive image files → one `ImageGallery` (Phase 6, 7.16; its
    `data-message-id` is the message's generated key `share-message-<index>`), consecutive `source-url` /
    `source-document` → one `SourcesPart`; then the model id of `modelRef` in
    muted mono `text-xs` (not `ModelLabel`, which reads the models store); `status: 'stopped'` adds "Stopped",
    `status: 'failed'` adds "This reply failed." (error details are never shared).
  - Never used here: `ChatMessage`, `ToolPart`, `ErrorPart`, `MessageMeta`, `ModelLabel` (they need stores, actions
    or error details).
- **`ShareToolRow`**: the one-line row of 7.2 without approval states: `Wrench` (or `Server` + the server badge for
  `mcp__<server>__<tool>`), display name, first argument when the input is shared (the prompt for `generate_image`,
  `parts/tool-row.ts` like `ToolPart`), status from `status` (`done` →
  `Check`, `error` → `X`, `denied` → `Ban` + "Denied", `stopped` → `CircleSlash` + "Stopped"). It expands (chevron,
  `share-tool-row-output`) only when the part carries `input`, `output` or `errorText`, which the server sends only
  when the share includes tool details: **Input** / **Output** through `ToolValueBlock` (a value the server cut
  arrives as JSON text ending in `[truncated]` and shows the "Truncated by server" note), `errorText` as an **Error**
  block in the error tone. Otherwise the row is static (no button).
- **Files**: part URLs are `/api/share/<token>/files/<id>` (images load through `<img>`, other files download);
  attachments are absent when the share excludes them. Phase 6 (W6.8): consecutive image file parts of an assistant
  message (generated images) render as an `ImageGallery` (7.16) with its lightbox and Download link; the share option
  that includes them is labelled "Files and images" (7.14).
- **Head**: `useHead()` sets the title ("{title} · harness-forge", "Link unavailable · harness-forge", else "Shared
  chat · harness-forge") and the meta tags `robots: noindex, nofollow` and `referrer: no-referrer` (the server also
  sends `X-Robots-Tag` and `Referrer-Policy` on every response).

### 7.16 Image gallery and generating state (`ImageGallery`, `GeneratingImages`, W6.8)

Generated images (ADR-028) are ordinary `file` parts with `/api/files/<id>` URLs (the server stores every image before
it streams or saves it), so the transcript, share links, backups and history treat them like attachments. Three
sources produce them: image turns (an image model picked in the composer, 7.7), chat models with image output
(Gemini `*-image` and `nano-banana*`, OpenRouter image models) and the `generate_image` tool (7.2).

- **Gallery** (`ImageGallery`, `image-gallery`, `data-message-id`, `data-count`): `chat-format.ts` turns every run of
  consecutive `image/*` file parts of an assistant message into one block (parts that render nothing, such as
  `step-start`, do not split a run; a `reasoning-file` draft image stays a `FilePart` thumbnail). One image renders at
  the full column width at its natural aspect ratio (at most `70dvh` tall, `object-contain`); two to four render in a
  two-column grid (`gap-2`), each tile keeping its image's aspect ratio. Tiles (`image-tile`, `data-index` 0-based) are
  buttons ("Open image {n} of {m}") with `rounded-lg border bg-muted`, lazy `<img>` elements (alt "Generated image {n}
  of {m}", `referrerpolicy="no-referrer"`) and a hover ring. URLs go through `safeAssetUrl` (a same-origin path,
  http(s), `blob:` or an image `data:` URL); an image whose URL fails that check is left out, and `data-count` counts
  the tiles shown. The component reads no store (the share page renders it too).
- **Lightbox** (`image-lightbox`, `data-index`): the `FilePart` dialog pattern (`Dialog`, at most `90vw` × `85dvh`),
  the image `object-contain`, and a top row with **Previous image** / **Next image** (`ChevronLeft` / `ChevronRight`,
  `aria-disabled` at the ends so focus is never lost; ArrowLeft / ArrowRight keys), the counter "2 / 4" (read as "Image
  2 of 4" by a polite live region; the buttons and the counter show only for two or more images), **Download** and
  **Close**. Opening focuses Next image (else Download). **Download** (`image-download`, `data-action="download"`) is
  an `<a download>` link named by the part's `filename` (the server sets it, e.g. `image-1.png`), else
  `image-<n>.<ext>`; it exists only for a same-origin URL, a `blob:` URL or an image `data:` URL (browsers ignore
  `download` across origins and would navigate away). Esc closes and focus returns to the tile the lightbox was opened
  from; images that change while it is open (a streaming turn, a version switch) keep the index in range.
- **Generating** (`GeneratingImages`, `image-generating`, `data-count`): while an image turn streams (`metadata.image`
  set by the `start` chunk) and the message has no file part yet, `n` placeholder tiles (clamped to 1–4) at the
  requested aspect ratio (Auto = square; one tile full width and at most `70dvh` tall, two to four in the grid),
  `bg-muted` with a shimmer (static under reduced motion), and the caption "Generating image… 12s" / "Generating 2
  images… 12s" (seconds since `metadata.startedAt`, updated every second, `aria-live` off); the root is
  `aria-busy="true"` with the sr-only text "Generating images". The placeholders give way to the gallery; they also end
  as soon as the message has `metadata.finishedAt`, an error or `aborted` (a failed or stopped turn keeps
  `metadata.image` but has no files): a stopped turn shows no images and the meta says "Stopped"; a failed one shows
  `ErrorPart` (7.4). A resumed stream (reload, second tab) shows the placeholders again from the replayed `start`
  metadata.
- **Actions and meta** (7.5): no Copy and no Read aloud without text; Regenerate makes a new version (a new image);
  the meta hover adds "2 images · 16:9 · edited 1 image" (no ratio for Auto, no edit part without input images) and
  labels the cost "Estimated cost" (image prices are estimates; xAI reports none, and a model without a catalog price
  has no cost).
- **Editing the previous image**: after a reply with images, the next message to an image model sends those images
  as input images (at most 4), unless the message has its own image attachments or "Edit the previous image" is off
  (7.7).
- **Share page** (7.15): the same gallery, lightbox and Download link, with share URLs.

### 7.17 Voice input (dictation: `MicButton`, `RecordingIndicator`, `useVoiceInput`, W6.9)

Dictation records in the browser and transcribes through the speech-to-text model chosen in Settings → Media
(`transcriptionModelRef`, 9.9; ADR-029). Nothing is transcribed in the browser and nothing is stored.

- **Mic button** (`composer-mic`, `data-state`): a ghost icon button (32px, 40px on coarse pointers) right before
  `SendStopButton`, `Mic` icon, tooltip "Dictate" + `KbdCombo` Alt+V, `aria-keyshortcuts="Alt+V"`, `aria-pressed`
  always `true` / `false`. It is hidden when the browser cannot record (`useVoiceInput().supported` is false: no
  `MediaRecorder`, or a secure context without `navigator.mediaDevices.getUserMedia`; browsers leave `mediaDevices` out
  of insecure contexts, so there `MediaRecorder` alone counts and the button stays visible in the `insecure` state).
  Click or **Alt+V** (12; the composer calls the exposed `activate()`, which does exactly what a click does) toggles.
  The button stays enabled while dictation runs even if the composer becomes disabled.
- **States** (`data-state`; an insecure origin wins over a missing model, which wins over the voice input state):

  | State | Look | A click |
  |---|---|---|
  | `setup` | no speech-to-text model is set (a dictation already running finishes even if the setting changes) | toggles a popover (`composer-mic-setup`): "Choose a speech-to-text model to dictate messages." + the **Open settings** link (`composer-mic-setup-link` → `/settings/media`); closing it returns focus to the mic unless the user went elsewhere |
  | `insecure` | not a secure context (plain HTTP on a LAN): `aria-disabled`, tooltip "Voice input needs HTTPS or localhost" | nothing |
  | `idle` | `Mic` | starts: asks for the microphone, then records |
  | `requesting` | spinner while the browser asks for permission | ignored (Esc or a chat switch cancels; the microphone is released as soon as it arrives) |
  | `recording` | `Square` (Stop) on `bg-destructive/10` with a ring that follows the input level (static under reduced motion), `aria-pressed="true"`, label "Stop and transcribe" | stops and transcribes |
  | `transcribing` | spinner + "Transcribing…" (the text shows from `sm`), label "Cancel transcription" | cancels (aborts the request) |

- **Recording indicator** (`composer-recording`, `data-state` `recording` | `transcribing`, `role="group"`,
  `aria-label` "Recording" / "Transcribing"; wireframe 2.11): while recording or transcribing it replaces the left
  tools (`+`, model, effort, image options), and `PermissionMenu` and `ContextRing` step aside: a red dot
  (`bg-destructive`, pulsing unless reduced motion; still while transcribing), the timer (`composer-recording-time`,
  `m:ss`, not announced; it stops while transcribing) and **Cancel** (`composer-mic-cancel`, 40px on coarse
  pointers), which drops the recording or aborts the transcription and gives focus back to the textarea (desktop).
- **Result**: the transcript is inserted at the caret (or over the selection) saved when the recording started, or at
  the current caret when the text changed meanwhile, with a space added before and after when needed
  (`insertDictation`); focus returns to the textarea on desktop only; the polite live region announces "Transcript
  added". An empty transcript shows the neutral toast "No speech detected" and changes nothing.
- **Esc** inside the composer cancels a recording or a transcription first (before its usual Stop, 12); the live
  region announces "Recording canceled" (only for a cancel, never after a transcript or an error). The region also
  announces "Recording started" and "Transcribing…". Starting a recording stops read-aloud (7.18); switching to
  another chat cancels a running dictation. Send and Enter stay disabled while voice input runs (also while the browser
  asks for the microphone).
- **Limits**: recording stops by itself after 10 minutes (`LIMITS.transcriptionMaxSeconds`) and is transcribed; a clip
  shorter than 0.5 s is discarded without a request; when the audio track ends (a mobile interruption) or the recorder
  stops by itself, the recording stops and is transcribed; a recorder error drops the clip (toast). The level ring
  comes from a Web Audio analyser and stays still where Web Audio is missing.
- **Recorder**: the first supported type of `audio/webm;codecs=opus`, `audio/webm`, `audio/ogg;codecs=opus`,
  `audio/mp4` (Safari), else the browser default (`pickRecorderMimeType`), at 32 kbps; the recording is sent as the
  multipart part `file` of `POST /api/audio/transcriptions`, a `File` named `dictation.<ext>` (`dictation.webm`,
  `dictation.m4a`, …; `recordingFileName`), without a model or language field (the server uses the model and language
  of Settings → Media); the microphone tracks are always stopped, also after an error.
- **Errors** (error toasts, `dictationErrorToast`): "Microphone access is blocked. Allow it in the browser's site
  settings." (permission denied), "No microphone was found.", "The microphone is in use by another app.", "The
  recording is too long." (413), and provider errors with the 7.4 title and the server message (for example "No API
  key for Groq"). A start that cannot happen reports "Voice input needs HTTPS or localhost" or "This browser can't
  record audio." (normally unreachable: the button is disabled or hidden then).
- **Mobile**: tap to start and stop, a 40px target, no autofocus, no horizontal scroll at 390px while recording.

### 7.18 Read aloud (`ReadAloudButton`, `useSpeechPlayer`, W6.8)

Read-aloud speaks a reply through the text-to-speech model chosen in Settings → Media (`speechModelRef`, 9.9;
ADR-029).

- **Button** (`message-read-aloud`, `data-state` `idle` | `loading` | `playing`): a ghost icon button (40px on coarse
  pointers) right after Copy on finished assistant replies with text (7.5), only while a speech model is set; `Volume2`
  icon, label "Read aloud". While this reply is being read, loading included, the button is pressed: label "Stop
  reading", `aria-pressed="true"`, and the tooltip adds the Esc hint; while it loads it shows a spinner and
  `aria-busy="true"`, while it plays `Square`. A click stops it. The action row stays visible while the reply is read
  (loading or playing).
- **One player for the app** (`useSpeechPlayer`, 11): starting another reply stops the first; switching chats, hiding
  the page (`visibilitychange` / `pagehide`), starting a dictation, and Esc outside inputs and overlays (12) stop it; a
  pause by the system (media keys, an interruption) ends the reading too; the natural end returns to `idle`. These
  stop triggers, the Esc shortcut `read-aloud-stop` included, exist only while something is read.
- **What is read** (`utils/speech-text.ts`, W6.8): the text parts only. A code fence becomes "{Language} code
  omitted." ("Code omitted." without a language; a `mermaid` fence "Diagram omitted."), a table "Table omitted.", a
  `$$` or `\[…\]` block "Formula omitted.", inline math (`$…$`, `\(…\)`) the word "formula"; code spans keep their
  text, links read their label, a bare URL or an autolink reads "link", an image reads its alt text; the remaining
  markdown and HTML are stripped. Every block (paragraph, heading, list item) ends with sentence punctuation, one block
  per line, so the voice pauses between them. A reply that leaves nothing to read does nothing.
- **Chunks**: the text is split at sentence ends: the first chunk at most 300 characters (a fast start,
  `LIMITS.speechFirstChunkChars`), then at most 1,500 (`speechChunkChars`), never more than 4,096
  (`speechTextMaxChars`); a longer sentence breaks at a clause break or a space. Each chunk is one `POST
  /api/audio/speech` `{ text }` (model and voice from the settings); the next chunk is fetched while the current one
  plays.
- **Playback**: one reused `HTMLAudioElement`, unlocked inside the click with a silent clip (Safari), object URLs
  revoked after use, one `AbortController` per chunk request (Stop aborts it), `playbackRate` = `speechSpeed` (clamped
  to 0.5–2; the speed never reaches the provider).
- **Errors**: toast "Could not read this reply aloud" with the server message ("The browser blocked audio playback."
  or "The browser could not play the audio." when playback itself fails); the player returns to `idle`.

### 7.19 Workspace tool rendering (`workspace-tools.ts`, `WorkspaceToolBody`, `DiffView`, `TerminalOutput`, `FileContent`, `FileList`, W7.11)

The builtin `core-workspace` tools (ADR-032, PLUGINS.md 1) return structured outputs with project-relative paths, diff
hunks and shell results (ARCHITECTURE.md 6.13; schemas in API.md, workspace tools). The web renders them inside the
tool row, never in a side pane (principle 1.2). Wireframe: 2.14.

- **Registry** (`components/chat/parts/tools/workspace-tools.ts`, pure and store-free, signatures in 11.4):
  `workspaceToolView(toolName, input, output)` parses the output with the shared schemas and returns a view of kind
  `diff` (`write_file`, `edit_file`), `terminal` (`shell`), `file` (`read_file`) or `list` (`list_directory`,
  `find_files`, `search_files`), else `null`. `null` (a plugin tool with the same name, an output cut to a
  `[truncated]` string on a share page or by the 64 KB cap, an unexpected shape) keeps the generic Input / Output blocks
  of 7.2. `workspaceRowArgument` gives the first argument (the path for read / write / edit / list, `.` by default; the
  pattern for find / search; the first line of the command for shell); `toolRowArgument` (`parts/tool-row.ts`) asks it
  first, so `ToolPart` and `ShareToolRow` agree.
- **Icons** (verified in `@lucide/vue`): `FileText` `read_file`, `ListTree` `list_directory`, `FileSearch`
  `find_files`, `TextSearch` `search_files`, `FilePlus` `write_file`, `FilePenLine` `edit_file`, `SquareTerminal`
  `shell` (`workspaceToolIcon`).
- **Row summary** (`tool-row-summary`, `data-tone` `muted` | `success` | `destructive` | `warning`), before the status
  and only once the output exists (`workspaceRowSummary`):

  | Tool | Summary |
  |---|---|
  | `edit_file` / `write_file` | `+a −d` (`text-success` / `text-destructive`, `tabular-nums`); a new file "New · 40 lines" |
  | `shell` | `exit 0` (muted), `exit 1` (destructive), `timed out` (warning), `killed SIGTERM` (warning) |
  | `read_file` | `lines 1–120 of 340` ("of …" only when the total is known) |
  | `list_directory` | `24 entries` |
  | `find_files` | `17 files` |
  | `search_files` | `23 matches` |

  Rows still never expand by themselves (principle 5).
- **Expanded body**: `WorkspaceToolBody` replaces the Input / Output blocks (the error block of `output-error` stays)
  and ends with the toggle **Raw input and output** (`tool-raw-toggle`), which shows the generic `ToolValueBlock`s.
- **DiffView** (`diff-view`, `data-path`, `data-state` `created` | `modified`): a header with the path in mono, a "New
  file" badge, `+a −d` and a `CopyButton` for the path; the lines are a grid (old line number | new line number | sign
  | text) in `font-mono text-xs whitespace-pre` inside an `overflow-x-auto rounded-md border` block, so a long line
  scrolls inside the block and never widens the page. Added lines `bg-success/10` with the sign in `text-success`,
  removed lines `bg-destructive/10` with the sign in `text-destructive`, context `text-muted-foreground`, hunk headers
  `@@ −12,5 +12,7 @@` on `bg-muted/60` (`diff-line`, `data-kind` `add` | `del` | `context`). Runs of more than 8
  unchanged lines fold into "⋯ {n} unchanged lines"; past `maxLines` (200) "Show {n} more lines" (`diff-expand`,
  `data-action` `unfold` | `show-all`); `truncated` → "Diff truncated by server"; a `null` diff (the server's 2 s diff
  timeout) → "The diff is too large to show." Below `sm` one line-number column. Each changed line has the sr-only
  label "Added" or "Removed". No syntax highlighting in v1.3.
- **TerminalOutput** (`terminal-output`, `data-status` `running` | `ok` | `error` | `timeout` | `killed`): a
  `bg-muted/60` block: the `$ command` line (`terminal-command`), then stdout (`terminal-stdout`, `whitespace-pre-wrap
  break-words`), then stderr under a small "stderr" label (`terminal-stderr`; `text-destructive` only when the exit code
  is not 0); ANSI codes are stripped on the client too (`utils/ansi.ts`); the last 40 lines show, with "Show all {n}
  lines" up to the 60 KB body cap of 7.2; footer badges: "Exit code {n}" (`terminal-exit`, `data-value`), "Timed out",
  the signal, and the duration (`formatDuration`); while running a Spinner + "Running…"; byte counts larger than the
  kept text → "Output truncated by server" (the server keeps the first 4 KiB and the last 16 KiB of each stream).
- **FileContent** (`file-content`, `data-path`): numbered lines starting at `startLine`, 20 lines, then **Show all**;
  "Showing lines {a}–{b} of {total}" and "Truncated by server" when the output says so.
- **FileList** (`file-list`; items `file-list-item` with `data-path`): up to 50 items, then "Show {n} more"; folders
  end with `/`; search matches are grouped by path with `line:` prefixes and the matched line in mono; "More results
  were cut by the server" when `truncated`.
- **While running**: a `shell` row shows `TerminalOutput` with "Running…" as soon as its input is available (expanded
  only when the user opens it); other tools keep the spinner status of 7.2.
- **Approval previews** (`ToolApprovalPreview`, `tool-approval-preview`, `data-kind` `diff` | `content` | `command`;
  7.3): `workspaceApprovalView(toolName, input)` builds `edit_file` → a `DiffView` of `diffLines(old_string,
  new_string)` (`utils/line-diff.ts`: a small LCS without a dependency; past its size cap one hunk with every old line
  removed, then every new line added), `write_file` → "Create or overwrite {path} · {n} lines" + a 20-line
  `FileContent`, `shell` → the command card. The server's hunks are what the user sees for finished edits; the client
  only diffs the small snippets of a preview.
- **Share page** (7.15): `ShareToolRow` uses the same `workspaceToolView`, `WorkspaceToolBody` and row summary when the
  share includes tool details; without tool details the row stays static, as before. Values longer than 16,384
  characters arrive as `[truncated]` strings and fall back to the generic text.

### 7.20 Projects in the chat (`ProjectSwitcher`, `NewChatProjectPicker`, `ChatProjectChip`, W7.9 / W7.10)

A project (ADR-031) is a named folder on the server host inside the allowed roots (`HF_WORKSPACE_ROOTS`); a chat
optionally belongs to one, and the workspace tools work only in chats whose project folder opened (ARCHITECTURE.md
6.13). Projects are managed in Settings → Projects (9.10); the chat UI picks, shows and changes them. Wireframe: 2.12.

- **Project switcher** (`ProjectSwitcher`, `project-switcher`, `data-value` `all` | `none` | the id): the first row
  of `ChatNav`, above New chat (5.3). Row: `Folders` + "All chats", `Folder` + the project name, or `FolderX` in
  `text-warning` when its folder is missing (`available: false`), then a trailing `ChevronsUpDown`. Menu: a
  `DropdownMenu` radio group (`max-h-80`, scrolls): All chats · No project · separator · the projects sorted by name
  (name, the path in mono muted text on a second line, the chat count on the right; `project-switcher-option`,
  `data-value`) · separator · **Add project…** (`FolderPlus`, `project-add`; the switcher mounts its own
  `AddProjectDialog`, and after a project is created the filter switches to it) · **Manage projects** (`project-manage`
  → `/settings/projects`). Without any project the menu holds All chats, Add project… and Manage projects.
- **Filtering**: a pick calls `chats.setProjectFilter()`, which resets the paged list and loads it again with
  `GET /api/chats?projectId=<id>` (`none` for No project; nothing for All chats). The filter is stored in
  `localStorage['hf-project-filter']`; an id that is unknown once the projects loaded falls back to All chats. Icon
  mode: an icon button with the tooltip "Project: {name}" ("All chats", "No project"). Mobile: the same row inside the
  sheet; picking a filter does not close the sheet. Empty list: "No chats in {name} yet" / "No chats without a
  project". Search (Mod+K) ignores the filter.
- **New chat** (`NewChatProjectPicker`, `new-chat-project`, `data-value` `none` | the id): a ghost pill (h-8,
  `rounded-full`, 40px on coarse pointers) right under the `ChatGreeting` heading on `/`: "No project ▾" or "{name} ▾"
  with a `Folder` icon; its menu lists `ProjectMenuItems` (`project-option`). Not a composer chip: the 390px toolbar is
  full. Default: the switcher's project when the filter names one, else No project. When the filter is not All chats,
  a pick also sets the filter (No project → `none`), so the new chat appears in the visible list. The first send
  carries `projectId` (11.1). Hidden while no project exists.
- **Chat header** (`ChatProjectChip`, `chat-project-chip`, `data-value` the id, `data-state` `ok` | `missing`): between
  the title and `⋯`, only when the chat has a project: ghost h-7, `Folder` (`FolderX` in `text-warning` when missing) +
  the name truncated at 14rem; below `sm` icon-only with `aria-label="Project: {name}"`. It opens a menu with the move
  items (`ProjectMenuItems` with No project) and **Project settings** (→ `/settings/projects`).
- **Move to project ▸** (`FolderInput`): a submenu in the header `⋯` menu (`chat-menu-move`, right after Rename) and in
  the sidebar row `⋯` menu (`chat-row-move`, right after Rename) listing No project and every project (`project-option`,
  the current one checked). Moving = `useMoveChat()(chatId, projectId)` (11.4): an optimistic `PATCH /api/chats/:id {
  projectId }`, then the toast "Moved to {name}" (or "Moved out of {name}") with **Undo**; the row leaves the list when
  it no longer matches the filter. 409 `run-active` → the change rolls back with the toast "Wait for the response to
  finish before moving this chat."; 404 (the project was deleted meanwhile) → "This project no longer exists." A move
  changes the instructions and tools of the chat's next run only; history is not rewritten.
- **Command palette** (W7.9): a "Projects" section, shown only while searching: Show all chats · Show chats without a
  project · Show {name} (checked when it is the current filter) · Add project… (→ `/settings/projects?add=1`) · with a
  chat open: Move chat to {name} · Move chat out of project (keywords: move, project). "Settings: Projects" comes from
  `SETTINGS_LINKS` (5.5).
- **States**: no workspace roots → the Add dialog's alert (9.10); a folder deleted or moved on disk → the `FolderX`
  warning in the switcher, the chip and the settings row, and the next run shows the `workspace-unavailable` notice
  (7.1) instead of offering workspace tools; a chat's project deleted (`project.changed` with `project: null`) → the
  chip disappears, the chats lose their `projectId` locally, and a filter on that project resets to All chats with the
  toast "The project was deleted. Showing all chats."; the permission mode Accept edits is offered only in project
  chats (7.11).
- **No new shortcuts** (12): the palette covers keyboard reach, and Alt+P still opens the permission menu.

---

## 8. Plugins UX spec

### 8.1 Plugin card (`PluginCard`, W3.1)

`Card` (`rounded-lg border bg-card p-4`, whole card links to `/plugins/<id>` except the switch):

| Area | Content |
|---|---|
| Top row | `ProviderIcon` (lg, color variant, plugin icon) · name (`font-medium`) · version (`text-xs mono muted`) · `Switch` (enabled) right |
| Middle | description, 2 lines max |
| Bottom | source badge · "Runs code" badge (outline warning, `Cpu` icon) when `kind === 'code'` or it declares a stdio MCP server · contributions summary ("2 providers · 3 tools · 1 MCP server · 2 commands") |

Source badge labels: `builtin` → Core · `created` + declarative → Declarative · `created` + code → Code · `zip` →
zip · `npm` → npm · `url` → URL · `link` / `copy` → Local. State overlays: `error` → `border-destructive/60` and
the error message (1 line) + "View logs" link (emits `view-logs`; the list opens `/plugins/<id>?tab=logs`);
`untrusted` → warning badge "Untrusted" + "Review" button (emits `review`; the list opens `TrustDialog`);
`incompatible` → badge "Incompatible" with tooltip "Needs harness {range}"; `loading` → `Spinner` next to the name;
`disabled` → card at 70% opacity, switch off. Builtins appear as one non-removable
"Core providers" card (plus `core-tools`, `core-commands`, `core-mcp` cards); they have no Uninstall.

### 8.2 List page (`/plugins`)

`PageHeader` "Plugins" with actions: search `Input` ("Search plugins", filters name/id/description, synced to
`?q=`), "Install…" (outline), "New plugin" split menu (Provider / Code plugin). Filter from `?filter=`:
`providers | tools | mcp | commands` = plugins contributing that type; `disabled` = plugins not enabled; `all`
(default) = everything. Below `md` the filters render as a `Select` above the grid. Grid: 1 column, 2 from `md`,
3 from `xl`, gap 12px.
Empty filter result: `Empty` "No plugins match" + "Clear filters". Loading: 6 skeleton cards.

### 8.3 Install dialog (`InstallDialog`, W3.2)

`Dialog` max-w-xl, title "Install plugin". One instance lives in `pages/plugins.vue`.

1. **Source** — `Tabs`: **Zip** (dropzone "Drop a .zip here or choose a file", ≤ 20 MB) · **npm** (package name,
   optional version; placeholder `@scope/harness-plugin-name`) · **URL** (https URL of a zip + required
   integrity `sha256-…`/`sha512-…`) · **Local folder** (absolute path on the server + `ToggleGroup` Link /
   Copy; hint "Link watches the folder and reloads on change"). Primary button: **Inspect**.
2. **Preview** (`InspectPreview`, from `PluginInspection`): icon, name, version, id, description, kind badge,
   contributions list, network hosts (base URLs, MCP URLs), requested permissions (advisory chips), declared
   secrets, sha256 (mono + `CopyButton`), warnings (e.g. "Replaces installed version 1.0.0").
3. **Trust** (code plugins and stdio MCP only): `TrustWarning` + required checkbox "I trust {source}" (source =
   the file name, package, URL host or folder). When a password is set (`AuthStatus.enabled`) and the session is
   not fresh (`AuthStatus.freshUntil` missing or past), a "Confirm your password" field (`trust-password`) is
   required too: installing such a plugin is a fresh-auth route (API.md, ADR-017).
4. **Install** (primary; disabled until the checkbox is checked and, when shown, the password is filled). With a
   password field, Install first calls `useFreshAuth().login(password)` (`POST /api/auth/login`, which makes the
   session fresh), then `POST /api/plugins/install` through `run(send, { required })` (8.4). On success: toast
   "Installed {name}", close, emit `installed(id)`. Errors show inline under the form (validation errors per field;
   under the password field the login's text: "Wrong password", "Too many attempts. Try again in {n}s." with the wait
   at the time of the answer, or the server message). The error alert's **Log in** action opens the password prompt and
   then submits the step again.

"Back" returns from Preview to Source keeping inputs. Closing the dialog discards the staged inspection.

### 8.4 Trust warning and trust dialog (W3.2)

`TrustWarning` = `Alert variant="destructive"` with `ShieldAlert`:

> Runs code on your server with harness-forge's permissions. It can read API keys and conversations and make
> network requests. Only install plugins from sources you trust.

(Exact text from PLUGINS.md section 13, "Trust warning".) Below the text: requested permissions and the sha256.
`TrustDialog` reuses it for an installed plugin in the `untrusted` state (after an update changed its hash, or its
files changed on disk): "I trust {source}" checkbox + the same "Confirm your password" field as the install dialog
(when a password is set and the session is not fresh) → `useFreshAuth().login(password)` → `POST
/api/plugins/:id/trust` (`{ sha256: trust.hash }`, through `run(pin, { required: true })`) → toast "Trusted {name}",
emits `trusted(id)`. A stale hash (the files changed meanwhile) reloads the plugin and asks for the consent again.

**Fresh auth everywhere** (Phase 6, S4: one composable, `useFreshAuth`, W6.11; signature in 11). Fresh-auth
actions (API.md **fresh**): installing or trusting a plugin that runs code (8.3, above), creating a plugin from a
template (8.6), saving or deleting files of a **code** plugin and Build & reload (8.10), reloading a code plugin (8.7),
saving a stdio MCP server (8.12), changing the password (9.4), creating or updating a share link (7.14), deleting
all data (9.8) and, since Phase 7, adding a project (9.10) and rotating the master key (9.8). Every component follows
the same rules:

- `run(task, { required })`: with `required` (the action is known to need fresh auth) and a session that is not fresh
  (`auth.fresh` false), `ConfirmPasswordDialog` opens **first**; otherwise the request runs, and a `403 forbidden` +
  `action: 'login'` answer (the 10-minute window ran out meanwhile) opens the prompt.
- After a successful prompt (`auth.login(password)`), the task runs **exactly once more**; a second 403 is thrown and
  shown as the error.
- Concurrent tasks share one prompt; closing it rejects every waiting task with a cancel error that is never shown;
  leaving the page (the component's scope ends) cancels too. While the prompt's login runs it cannot be closed.
- Prompt errors: 401 "Wrong password", 429 "Too many attempts. Try again in {n}s." (counting down every second and
  cleared when the wait is over; the same text everywhere, v1.1's install and trust dialogs wrote "{n} s"), anything
  else, a 403 from the login itself included, shows the server message (v1.1's plugin detail and data prompts said
  "Wrong password").
- Where `required` is set: the code plugin form (scaffold), the Share dialog and the delete-all dialog (always), the
  Add project dialog and the Rotate key dialog (always, Phase 7), the trust dialog (always), the install dialog (when the inspection says `requiresTrust`: code, or a stdio MCP server),
  the Source tab (code plugins: saving, deleting or renaming files and Build & reload ask for the password first when
  the session is not fresh; for a declarative plugin's `plugin.json` the prompt comes only after a refusal), the plugin
  header's Reload (code plugins), the MCP server dialog (when the request needs it: a stdio server); the provider wizard
  runs without `required` (a 403 prompts once, and a second refusal is shown as the error instead of prompting again).
- The install and trust dialogs keep their inline "Confirm your password" field (`trust-password`): it calls
  `login(password)` (its error text shows under the field, without a countdown), then the request runs through
  `run(send, { required })`; the error alert's **Log in** action calls `confirm()` (the prompt) and then submits again.
  `PasswordDialog` keeps its "Current password" field (`changePassword` logs in first).
- Prompt texts (`ConfirmPasswordDialog` description): "Creating a plugin that runs code needs your password." (code
  plugin form), "Changing the code of a plugin needs your password." (Source tab), "Reloading runs the plugin's code
  again. Confirm your password to continue." (Reload), "Saving a server that runs a local command needs your password."
  (MCP server dialog), "This provider starts a program on the server. Confirm your password to continue." (provider
  wizard), "Confirm your password to install a plugin that runs code on this server." (install), "Confirm your password
  to trust a plugin that runs code on this server." (trust), "Confirm your password to create or change a share link."
  (7.14), "Deleting all data needs your password." (9.8), "Adding a project needs your password." (9.10, Phase 7),
  "Rotating the master key needs your password." (9.8, Phase 7).

After a fresh-auth save of a `created` code plugin the server re-pins its trust automatically (ADR-017). The v1.1 copies
of this flow (`plugins/code/fresh-auth.ts`, `plugins/detail/fresh-auth.ts`, `share/fresh-auth.ts` and the helpers in
the data, install and MCP components) are gone; `ConfirmPasswordDialog` and its test ids are unchanged.

### 8.5 Provider wizard (`ProviderWizard`, W3.3)

`Stepper` with 5 steps; TanStack Form + the shared zod schema; the draft (without secret values) persists in
`localStorage['hf-wizard-draft']`; "Discard draft" link in the footer. Footer: Back (ghost) · Next (primary,
disabled until the step is valid) · on the last step **Create provider**. Completed steps are clickable.

| # | Step | Fields and behavior |
|---|---|---|
| 1 | Basics | Name ("Together AI"); Id (slug from the name, editable; validated against the plugin id pattern, reserved ids and existing plugins; hint "Model refs look like `together:model-id`"); Icon: `Tabs` Upload (svg/png ≤ 256 KB) · LobeHub (`LobeIconPicker`: search + virtualized grid from `GET /api/icons/lobe`) · Monogram (auto); Description (optional) |
| 2 | API | Templates row: Together · Fireworks · LM Studio · vLLM · LiteLLM (prefill everything); API format cards: OpenAI-compatible (`openai-chat`), OpenAI Responses (`openai-responses`), Anthropic-compatible (`anthropic`), Google (`google`); Base URL (warning when `http:` and not localhost) |
| 3 | Credentials | fields list (default: one required secret "API key"; add/edit key, label, type, required, options for `select`, "Get a key" link, default, "Advanced" flag; no env var: declarative providers cannot read environment variables); auth style `ToggleGroup` Bearer / Custom header (header name) / None; extra headers (key/value; values may use `{{credentials.apiKey}}`); values for testing (stored as secrets on create) |
| 4 | Models | "Fetch models" (runs `POST /api/plugins/drafts/test` in list mode → table with checkboxes) or manual rows: id, name, context window, max output, capabilities (Tools, Vision, Reasoning, PDF), reasoning efforts, $ per 1M input/output; switch "Fetch the model list at runtime" (`listModels`) |
| 5 | Review | read-only manifest JSON (CodeMirror, read-only); **Test connection** (1-token ping) → "Connected · 412 ms" or the error alert; **Create provider** → `POST /api/plugins` → toast "Provider created" → emit `created(id)` |

`?edit=<id>` loads an existing declarative plugin into the same steps and saves with `PUT /api/plugins/:id/manifest`
("Save changes" instead of "Create provider").

### 8.6 Code plugin creation (`CodePluginForm`, W3.4)

On `/plugins/new?type=code`: Name, Id (same rules as the wizard), template cards (one required): **Tool**
("Adds a tool the model can call"), **Provider** ("Adds an LLM provider written in code"), **MCP bridge**
("Connects an MCP server"), **Command pack** ("Adds slash commands"). Files are JavaScript ESM with JSDoc types
(`index.mjs`). **Create plugin** → `POST /api/plugins/scaffold` (fresh auth, 8.4) → emit `created(id)` → the page
navigates to `/plugins/<id>?tab=source`. Plugins created in the app are trusted by the server at creation (see
PLUGINS.md).

### 8.7 Detail page header and actions (W3.1)

`PluginHeader`: "← Plugins" link (to `lastRoutes.plugins` list state), then `ProviderIcon` (lg) · name
(`text-xl font-semibold`) · version · source badge · "Runs code" badge · state badge (Active / Disabled /
Loading / Untrusted / Incompatible / Error). Right: `Switch` "Enabled" · **Reload** (`RotateCw`, ghost,
`aria-label="Reload plugin"`) · `⋯` menu: Edit in wizard (declarative created plugins) · Export (downloads
`GET /api/plugins/:id/export`) · separator · Uninstall… (not for builtins). Untrusted → an inline
`TrustWarning`-style banner with "Review and trust". Error → destructive banner with the last error and
"View logs".

Uninstall uses `ConfirmDialog`: title "Uninstall {name}?", description "Its providers, tools and commands are
removed.", checkbox "Keep settings and stored data" (`keepData`), confirm "Uninstall".

Tabs (`Tabs`, value synced to `?tab=`): **Overview** · **Configuration** (only when the plugin has a settings
schema) · **Source** (not for builtins: every code plugin, read-only unless its files are editable, plus declarative
plugins with editable files, `PluginDetail.editable` = source `created`, `copy` or `link`, whose `plugin.json` is
edited there) · **Logs**. A missing or hidden tab falls back to Overview.

### 8.8 Overview tab (W3.1)

Description, author, homepage link, permission chips, then one section per contribution type:

| Section | Rows |
|---|---|
| Providers | `ProviderIcon` + name + `ProviderStatusBadge` + "Configure key" → `/settings/providers?configure=<id>` |
| Models | count per provider + "Manage models" → `/settings/models` |
| Tools | `PluginToolsTable`: name (mono) · description · policy badge (Safe / Ask / Always ask) · **Approval** `Select` (Default / Allow / Ask / Deny → tool pref override; Default clears it) · enabled `Switch` |
| MCP servers | status dot + name + transport badge + tool count + **Restart** (`POST /api/mcp/:id/reconnect`); for `core-mcp` the full `McpServersPanel` replaces this section |
| Commands | `/name` (mono) · description |

### 8.9 Configuration tab (`SchemaForm`, W3.1)

Rendered from the plugin's `SettingsSchema`; values from `GET /api/plugins/:id/settings`, saved with `PUT`.

| Schema | Control |
|---|---|
| `string` | `Input` |
| `string` + `enum` | `Select` |
| `string` + `format: url` | `Input type="url"` |
| `string` + `format: multiline` | `Textarea` (autosize) |
| `string` + `format: secret` | `SchemaSecretInput`, write-only: once stored it shows "Stored" + the masked hint (`secretHints`) with **Replace** (empty password `Input` + reveal toggle) and **Clear** (marks it for removal on save, "Undo" restores; not offered for required secrets); the value is never read back. Form value: omitted keeps, a string replaces, `''` clears |
| `number` / `integer` | `Input type="number"` with `min`/`max` (`step=1` for integer) |
| `boolean` | `Switch` |
| `array` of `string` + `enum` | checkbox group |
| `array` of `string` | tag input (Enter or comma adds, Backspace removes) |

`title` → label, `description` → help text, `required` → asterisk + validation, `default` → initial value.
Buttons (sticky footer): **Reset to defaults** sets every non-secret property back to its `default` (unset when it
has none; secret fields keep their pending value), disabled when already at defaults · **Discard** (only while
dirty) and the exposed `reset()` return to the values the form started from, without messages · **Save** is
disabled until dirty and shows a spinner while the parent saves (`saving`, which also locks the fields). A new
`modelValue` object from the parent (e.g. the saved settings) becomes the new starting point; the form's own
`update:modelValue` echo does not. Success toast "Settings saved". Validation messages come from
`settingsValuesSchema(schema, { secretsSet })` of `@harness-forge/plugin-sdk` (the same validator the server
uses); they show once a field was left or changed, and for every field after a submit attempt (focus moves to the
first invalid one).

### 8.10 Source tab (`PluginSourceTab`, W3.4)

- Layout: `ResizablePanelGroup` horizontal — `SourceFileTree` (13rem, min 10rem) | editor column; the editor
  column is a vertical group — `SourceEditorTabs` + `SourceEditor` (CodeMirror 6, JetBrains Mono 13px) over
  `BuildLogPanel` (30% height, collapsible).
- Toolbar: open-file tabs (dirty dot `●`, middle-click closes, closing a dirty tab asks "Discard changes?"),
  status text ("Saved 12:04", "3 problems"), **Save** (Mod+S, saves the active file with `PUT
  /api/plugins/:id/files/*`; code plugins need fresh auth, 8.4; for a `created` plugin the server then re-pins trust
  automatically, ADR-017, so edits never make it `untrusted`), **Build & reload** (primary; saves dirty files, `POST /api/plugins/:id/build`, a fresh-auth
  route, 8.4).
- Languages: `.js/.mjs/.ts` → JavaScript (TypeScript for `.ts`), `.json` → JSON, `.md` → Markdown, others plain.
  Build diagnostics show in the lint gutter and the build panel.
- `BuildLogPanel`: build output lines and live `plugin.log` events for this plugin (time, level, message);
  auto-scrolls unless the user scrolled up; "Clear".
- Declarative plugins with editable files (8.7) use the same tab: saving `plugin.json` reloads the plugin (the
  server validates the manifest; writes that would make it run code need fresh auth, and the tab prompts only after
  such a refusal, 8.4).
- Read-only when the files are not editable (code plugins from zip / npm / URL): banner "Installed from npm.
  Editing is disabled." Builtins have no Source tab.
- A save answered `409 conflict` (`details.reason: 'stale'`, the file changed on the server since it was opened)
  opens `SourceConflictDialog`: keep editing, load the server version (drops the edits) or overwrite. Unsaved edits
  survive tab switches (the workspace is cached per plugin); leaving the plugin with unsaved edits asks first.
- File tree: "New file" (name input, relative path, `.js/.mjs/.ts/.json/.md`), "Rename" (writes the new path, then
  `DELETE /api/plugins/:id/files/*` on the old one) and "Delete" (`ConfirmDialog`, then `DELETE`); `plugin.json`
  and the `main` entry cannot be renamed or deleted (items disabled).

### 8.11 Logs tab (W3.1)

Table-like list (mono `text-xs`): time · level badge (debug muted, info default, warn warning, error
destructive) · message. Level filter `ToggleGroup` All / Info / Warn / Error, "Copy", "Clear view". Initial
entries from `GET /api/plugins/:id/logs`, then live `plugin.log` SSE events; the client keeps 500 entries.

### 8.12 MCP servers panel (`McpServersPanel`, W3.5)

Shown in the Overview of `core-mcp`. Header "MCP servers" + **Add server**. Rows: `StatusDot` + name ·
transport badge (stdio / HTTP / SSE) · status text ("Connected · 12 tools", "Connecting…", "Error: {message}",
"Disabled") · enabled `Switch` · **Restart** · `⋯` Edit / Delete (confirm). `McpServerDialog` (add/edit): name,
id (slug), transport `Tabs` — stdio (command, args one per line, env `KEY=value` rows; values stored as secrets
in scope `mcp:<id>`), HTTP (URL, headers), SSE (URL, headers) — and policy `Select` Safe / Ask / Always ask
(default Ask). stdio shows the note "Runs a local command on your server."; saving a stdio server is a fresh-auth
action (8.4).

---

## 9. Settings UX spec

Owner W2.5. Every settings page: `PageHeader` + a `max-w-3xl` column of `SettingsSection`s (title, description,
content, separator). Settings save on change (optimistic `settings.update(patch)`, toast only on failure),
except dialogs and text fields, which save on blur or Enter.

### 9.1 Providers (`/settings/providers`, default)

- Subtitle: "Bring your own API keys. Keys are encrypted on this server."
- `InsecureBanner` (warning `Alert`) when `location.protocol === 'http:'` and the host is not loopback
  (`localhost`, `127.0.0.1`, `[::1]`): "You're using plain HTTP. Keys you enter can be read on the network. Use
  HTTPS or localhost."
- `ProviderList`: builtins in PROVIDERS.md order, then plugin providers by name. `ProviderRow`:
  `ProviderIcon` (lg, color) · name ("Anthropic (Claude)") · subtitle ("23 models", "Local — no key" for
  keyless providers, "via {plugin name}" for plugin providers) · `ProviderStatusBadge` · **Configure** (or
  **Add key** when not configured) · enabled `Switch` (`PATCH /api/providers/:id`).

| Provider status | Badge |
|---|---|
| `connected` | "Connected" (success tint) |
| `not_configured` | "Not configured" (outline, muted) |
| `env` | "From env" (info tint) |
| `error` | "Error 401" (destructive tint; the upstream status `lastError.status` when known, else "Error"); tooltip = last error |

### 9.2 Provider key dialog (`ProviderKeyDialog`, W2.5)

- Title: `ProviderIcon` + provider name. "Get a key ↗" link (provider `keyUrl`, new tab) next to the field label.
- One input per credential field (default: API key). Secret fields are password inputs with a reveal toggle
  (`Eye`/`EyeOff`, `aria-label="Show key"`/"Hide key"). When a value is stored, the placeholder shows the masked
  hint: "sk-ant-…9fQ2 · stored". The stored value is never loaded into the input.
- Env source: badge "From env" + text "Using ANTHROPIC_API_KEY from the server environment. A key saved here takes
  priority."
- `Collapsible` "Advanced": Base URL (placeholder = the provider default, "Reset" link when overridden).
- Keyless providers (Ollama): no key field; Base URL is shown expanded.
- Buttons: **Remove key** (ghost destructive, only when stored; confirm) · **Test** (outline) · **Save**
  (primary). Test calls `POST /api/providers/:id/test` with the draft values and shows the result inline:
  "Connected · 23 models · 380 ms" or the error title + message. **Save runs Test first**; when the test fails,
  the dialog shows the error and a "Save anyway" link.
- Saved → toast "{provider} connected", dialog closes, emit `saved(providerId)`, models refresh in the
  background.

### 9.3 Models (`/settings/models`)

- "Default model" and "Title model" rows, each a `SettingsModelSelect` (select-like trigger + searchable popover of
  the visible models grouped by connected provider; the composer's `ModelPicker` is not reused here). Both list
  **chat models only** (`kind="chat"`, the default; Phase 6: image, speech-to-text and text-to-speech models are chosen
  in Settings → Media, 9.9). Both have `allowNone`: "Automatic (last used model)" for the default model, "Automatic
  (small model of the chat's provider)" for the title model. Every option of the popover carries `model-select-option`
  with `data-model-ref` (empty for the "Automatic" choice); the trigger carries `data-value` and `data-kind`. Without a
  model of its kind the popover has no search field and says "No chat models from your connected providers." ("Loading
  models…" until the catalog arrived; the Media selects name their own kind, 9.9).
- Search input "Filter models"; then one `Collapsible` section per connected provider: header `ProviderIcon`
  + name + count + "Updated 3h ago" (`RelativeTime`) + **Refresh** (`RotateCw`, spinner while running) +
  **Add custom model**.
- `ModelsTable` columns: Model (name + mono id; "Custom" badge) · Capabilities (`ModelCaps`) · Context ·
  Price ("$3 / $15" per 1M, muted "—" when unknown) · Favorite (star toggle) · Visible (`Switch`; hidden models
  never appear in the picker) · `⋯` menu (`model-row-menu`, "Actions for {model}"): Rename (inline, saved as the
  display-name alias), Reset name (only when renamed), Remove (custom models only). Capabilities, Context and Price
  hide below `sm`, `md` and `lg`.
- Favorite and Visible (Phase 6) exist only for the models the chat picker can show: chat and image models. Speech to
  text, text to speech and every other kind show a muted dash in both columns (tooltip "Chosen in Settings → Media"; no
  `model-favorite` / `model-visible` in those rows): they are chosen in Settings → Media, whose selects list them even
  when hidden (9.9).
- `CustomModelDialog` ("Add a custom model", description "For a model {provider} serves but does not list." plus a
  line that depends on the kind: "It appears in the model picker right away." (Chat), "Image models appear in the
  model picker when the provider can generate images." (Image), "Choose it in Settings → Media." (Speech to text, Text
  to speech)): model id (required, mono), display name, **Kind** (Phase 6: `Select` Chat (default) · Image · Speech to
  text · Text to speech → `kind` `chat` / `image` / `transcription` / `speech`, always sent; the trigger has no test id
  and carries `data-value`), then for chat models only the context window and the capabilities checkboxes Tools ·
  Vision · Reasoning · PDF input · **Image output** (Phase 6, `capabilities.imageOutput`) → `POST /api/custom-models`.
  For the other kinds the context window and the capabilities are hidden, never validated and not sent. A custom image
  model appears in the composer's "Image models" group when its provider can generate images; custom speech-to-text
  and text-to-speech models appear in the Media selects.
- The Capabilities column shows `ModelCaps` for chat models (with the Phase 6 image-output icon for
  `capabilities.imageOutput`; a muted "—" when no capability applies); every other model shows its kind as a muted
  badge instead ("Image", "Speech to text", "Text to speech", "Embedding", "Audio", "Other"; `data-slot="model-kind"`,
  `data-kind`).

### 9.4 General (`/settings/general`)

| Field | Control | Setting key |
|---|---|---|
| Display name | `Input` ("Used in the greeting") | `displayName` |
| Send messages with | `ToggleGroup` Enter / ⌘ Enter (Ctrl Enter off macOS) | `sendKey` |
| Default permission mode | `Select` Ask / Accept edits / Auto / Off (the options of `TOOL_MODE_OPTIONS`, 7.11; Accept edits since Phase 7) | `defaultToolMode` |
| Default reasoning effort | `Select` Auto / Off / Low / Medium / High / Max | `defaultReasoningEffort` |
| Max steps per response | `Input type="number"` 1–200 (Phase 7; was 1–100), help "Chats without a project" | `maxSteps` |
| Max steps in project chats | `Input type="number"` 1–200 (Phase 7, `settings-project-max-steps`), help "Agent runs in project chats can take more steps." | `projectMaxSteps` |
| Alt shortcuts | `Switch` "Use Alt+M, Alt+R and Alt+P for composer menus, and Alt+V to dictate." (Phase 6 added Alt+V) | `altShortcuts` |
| Custom instructions | `Textarea` ("Sent with every chat") | `instructions` |

Both step fields save on blur or Enter; an invalid value shows "Enter a whole number from 1 to 200." and keeps the saved
value (defaults: 20 and 100).

Password section: status text "No password" / "Password set" / "Set by HF_PASSWORD" (read-only);
**Set password** / **Change password** (`PasswordDialog`: current, new, confirm → `PUT /api/auth/password`, a
fresh-auth route: when the session is not fresh, `changePassword` first calls `auth.login(current)`);
**Remove password** (ghost destructive, `password-remove`; the same dialog with the current password only →
`newPassword: null`); **Log out** when a session exists. Set / Change / Remove are hidden when the password comes
from `HF_PASSWORD`. Bulk export, import and delete-all live in Settings → Data (9.8, ADR-024); a single chat is still
exported from its chat menus (Markdown / JSON).

### 9.5 Appearance (`/settings/appearance`)

- Theme: three `ThemeCard`s (Dark, Light, System) with a mini preview drawn from tokens; writes
  `colorMode.preference`.
- Reading font: `ToggleGroup` Sans / Serif with a sample sentence in each font (`readingFont`).
- Text size: `ToggleGroup` Small / Medium / Large (`textSize`).
- Density: `ToggleGroup` Comfortable / Compact (`density`).
- Expand thinking by default: `Switch` (`showThinking`).
Changes apply instantly through `ui.applyAppearance()`.

### 9.6 About (`/settings/about`)

From `GET /api/health` (`Health`): app version (`version`), server Node version (`node`), uptime (`uptimeSec`),
key library versions (`versions.ai`, `versions.hono`, `versions.nuxt` when present); then license (MIT) with the
LICENSE link and the repository link. **Copy diagnostics** copies JSON (the `Health` fields, browser user agent,
provider statuses, plugin states and errors; never keys or chat content) and shows "Copied".

### 9.7 Login (`/login`, `auth` layout)

Centered card (max-w-sm): `BrandMark` + `harness-forge` wordmark, "Enter your password", password `Input`
(autofocus, `autocomplete="current-password"`), **Log in** (full width, `Spinner` while pending). Errors inline
under the field: "Wrong password", "Too many attempts. Try again in {n}s." Success → `?redirect=` or `/`.

### 9.8 Data (`/settings/data`, W5.5)

Bulk data (ADR-024). `DataSettings` (`data-settings`) in the usual `SettingsPage` frame: `PageHeader` "Data" with the
description "Back up and restore your chats, or delete them all." Wireframe: 2.7 (it predates the Phase 7 sections
Storage cleanup and Encryption key). On load it calls `GET /api/data`
(`DataSummary`); the summary line (`data-summary`) reads "12 chats (2 archived) · 348 messages · 18 files, 24 MB"
(messages count every version). A skeleton shows while it loads, "Could not load the data summary" with **Retry**
when it fails; it reloads after every import (and, since Phase 7, after a cleanup). Section order: the summary,
Export, Import, Storage cleanup (Phase 7), Shared links, Encryption key (Phase 7), Danger zone. Import, delete-all,
key rotation and cleanup share one lock on the server (ADR-034, ADR-035): a `409 busy` answer to any of them shows the
toast "Another data task is running. Try again when it finishes." (7.4).

**Export** (`SettingsSection` "Export"): "Download a zip with every chat, including archived chats and every message
version. API keys, passwords, plugins, MCP servers and share links are never included."

- `Switch` "Include attachments" (`data-export-files`, on; hint "{files} files, {size}");
- `Switch` "Include settings" (`data-export-settings`, on; hint "General and appearance settings. They are restored
  only when you choose to.");
- a warning (`data-export-warning`) while attachments are included and `fileBytes` exceeds the import limit
  (`LIMITS.backupImportBytes`, 256 MB): "This backup may be too large to import through the browser (limit 256 MB).
  Export without attachments, or copy the data directory to move a whole server.";
- **Export backup** (`data-export`, `Download` icon) → `data.export({ query: { files, settings } })` →
  `downloadResponse(response, 'harness-forge-backup.zip')`; a spinner while downloading; `payload_too_large` (the
  zip would exceed the server's size or entry limits) → toast with the server message.

**Import** (`SettingsSection` "Import"): "Restore a backup zip or a chat exported as JSON. Chats are imported one by
one; a failed chat does not stop the others."

- **Choose file…** opens a visually hidden file input (`data-import-file`, accepts `.zip` and `.json`); the chosen
  file's name and size show next to it (else "No file chosen. A .zip backup or a .json chat, up to 256 MB."). A
  `.json` name or type counts as a single chat, anything else as a backup. A file above 256 MB is refused before the
  upload with the inline error "This file is larger than 256 MB." (`data-import-error`, `data-code`
  `payload_too_large`);
- "If a chat already exists": `ToggleGroup` (`data-import-policy`, `data-value`) **Skip it** (`skip`, default) /
  **Import a copy** (`copy`: new ids and " (imported)" appended to the title);
- `Switch` "Restore settings from the backup" (`data-import-restore-settings`, off; disabled for a `.json` file);
- **Import** (`data-import`, `Upload` icon; disabled without a file) → `data.import({ form })` (fields `onConflict`,
  `restoreSettings`, then `file`); "Importing…" with a spinner while it runs; 409 `busy` (7.4) and 413
  `payload_too_large` become toasts, every other error shows inline (`data-import-error`, `data-code`);
- the result panel (`DataImportResultPanel`, `data-import-result`, `data-kind` = `backup` | `chat`): "Imported {n}
  chats · copied {n} · skipped {n} · failed {n}" (zero counts after the first are left out), then "{n} files
  ({reused} reused, {missing} missing)" and "Settings restored" when true; one row per item (`data-import-item`,
  `data-status` = `imported` | `copied` | `skipped` | `failed`, `data-chat-id`) with the title ("Untitled chat" when
  it has none; a link to `/chat/<id>` for imported and copied chats), a status badge and the error of a failed item;
  warnings as a muted list (`data-import-warning`);
- afterwards `chats.fetchPage({ reset: true })`, plus `settings.fetch()` when `settingsRestored`; the summary line
  reloads and the polite region announces the result (14.2).

**Storage cleanup** (Phase 7, ADR-035; `StorageCleanupSection`, `data-cleanup-section`, W7.13): `SettingsSection`
"Storage cleanup" with the description "Remove uploaded and generated files that no chat, share link, plugin or
setting uses anymore. Files from the last 24 hours are kept, and deleting a chat or a version keeps its files until the
next cleanup."

- **Check for unused files** (`data-cleanup-check`, outline) → `data.cleanupPreview()` (`GET /api/data/cleanup`, a
  dry run that reads every message, so it shows a spinner); the summary (`data-cleanup-summary`): "{files} files ·
  {size} can be removed" (plus ", and {n} leftover files on disk" when `blobs + tempFiles` > 0), then "{n} recent files
  are kept for 24 hours." when `recentFiles` > 0, then "Last cleanup {relative time}" from `lastRunAt`; nothing to
  remove → "No unused files."
- **Remove…** (`data-cleanup-run`, destructive outline; enabled only after a check found something) opens a
  `ConfirmDialog` "Remove unused files?" with "This deletes {files} files ({size}). It can't be undone." and **Remove
  files** (`data-cleanup-confirm`, destructive) → `data.cleanup()` (`POST /api/data/cleanup`; not a fresh-auth route) →
  toast "Removed {files} files ({size})"; the section and the summary line reload. The confirm counts come from the
  last check; the server re-checks every file when it deletes.

**Shared links**: `SharesSettingsSection` (W5.6, contract 10.4) renders its own `SettingsSection` "Shared links"
("Read-only links to chat snapshots. Revoking a link stops it at once.") and lists every share link of every chat,
newest first. Row (`shares-row`, `data-share-id`, `data-chat-id`): the chat title (a link to `/chat/<id>`; "Untitled
chat" when null) · "{n} messages · snapshot {relative time}" · "Expires in 5 days" when set and not expired · the
Outdated / Expired badges (`share-outdated`, `share-expired`) · **Copy link** (`share-copy`) · **Manage…**
(`shares-row-manage` → `ui.openShare(chatId)`) · **Revoke…** (`share-revoke` → the `ConfirmDialog` of 7.14,
`share-revoke-confirm`). Empty: "No shared links." (`shares-empty`). A failed load shows "Couldn't load the shared
links" with **Try again** (earlier rows stay). The section refetches after a revoke and when the Share dialog closes
(`ui.shareChatId` back to `null`).

**Encryption key** (Phase 7, ADR-034; `EncryptionKeySection`, `data-key-section`, W7.13): `SettingsSection`
"Encryption key" with the description "API keys and other secrets are encrypted on this server with a master key." On
load it calls `keys.get()` (`GET /api/keys`, `KeyStatus`):

- Rows: "Source" ("Key file in the data directory" for `file`, "HF_MASTER_KEY environment variable" for `env`),
  "Version" (`keyVersion`), "Rotated" (`rotatedAt` as `RelativeTime`, else "Never"), "Secrets" ("{secrets} encrypted",
  plus "· {n} can't be read" when `unreadableSecrets` > 0).
- **Rotate key…** (`data-key-rotate`, outline) opens `RotateKeyDialog`. It is disabled when `canRotate` is false; with
  `source: 'env'` a note follows: "The key comes from HF_MASTER_KEY. Stop the server and run `pnpm key:rotate` with
  HF_NEW_MASTER_KEY set to the new key." (the Docker command is in `docs/guides/using-projects.md`).
- `keyCheck: 'mismatch'` → a destructive `Alert` "The master key doesn't match the stored secrets. Saved API keys can't
  be read. Restore the previous key (HF_MASTER_KEY or data/secret.key), or enter the keys again." and rotation stays
  disabled; `unknown` (no secrets yet) shows nothing extra.
- **Rotate key dialog** (`RotateKeyDialog`, `key-rotate-dialog`): title "Rotate the master key?", text "A new key
  encrypts every saved secret again.", then the effects as a list: "Other browsers and devices are signed out; you stay
  signed in." · "Every share link changes ({shares} links): copy the new links from Shared links." · "Running replies
  stop and pending approvals expire ({pendingApprovals} waiting)." · "Older versions of harness-forge can't read the
  secrets afterwards: back up the data directory first."; `Input` "Type ROTATE to confirm" (`key-rotate-confirm`,
  case-sensitive, autofocus) and **Rotate key** (`key-rotate-submit`, destructive, enabled only when the input is exactly
  `ROTATE`).
- Submit → `keys.rotate({ body: { confirm: 'ROTATE' } })` through `useFreshAuth().run(…, { required: true })` with the
  prompt "Rotating the master key needs your password." (8.4); while the request or the prompt is pending the dialog
  stays open. Success → toast "Master key rotated" with the description "{secrets} secrets encrypted again ·
  {approvalsExpired} approvals expired", `rotated(result)`, the dialog closes, the section and Shared links reload. The
  response carries a new session cookie for this browser; the server then sends `key.rotated` and closes every event
  stream, and this tab reconnects (11). 409 `env-key` / `key-mismatch` → the server message inside the dialog; 409
  `busy` → the busy toast.

**Danger zone** (`SettingsSection` "Danger zone", its content in a `border-destructive/40` box): "Delete every chat,
including archived chats, every message version and every share link. API keys, plugins, projects and settings are
kept." (projects since Phase 7: delete-all keeps them, ADR-031)

- **Delete all data…** (`data-delete`, destructive outline) opens a `Dialog` (`data-delete-dialog`): title "Delete all
  data?", text "This deletes {chats} chats and {messages} messages. It can't be undone; export a backup first if you
  might need them.", `Checkbox` "Also delete uploaded files" (`data-delete-files`, unchecked), `Checkbox` "Also
  delete usage history" (`data-delete-usage`, unchecked; the API defaults of both are false), `Input` "Type DELETE to
  confirm" (`data-delete-confirm-input`, case-sensitive, autofocus) and **Delete everything** (destructive,
  `data-delete-submit`, enabled only when the input is exactly `DELETE`).
- Submit → `data.deleteAll({ body: { confirm: 'DELETE', files, usage } })`, a fresh-auth route:
  `ConfirmPasswordDialog` ("Deleting all data needs your password.") first when a password is set and `auth.fresh`
  is false; a `403` + `action: 'login'` answer prompts and retries once (8.4). While the request or the prompt is
  pending the dialog stays open.
- Success → toast "Deleted {n} chats"; the `hf-composer-draft:*` keys are removed from `sessionStorage` and
  `hf-unread` from `localStorage`; `chats.fetchPage({ reset: true })`; navigate to `/`. The server emits
  `chat.deleted` per chat, so other tabs follow.

### 9.9 Media (`/settings/media`, W6.10, Phase 6)

Images and voice (ADR-028, ADR-029). `MediaSettings` (`media-settings`) in the usual `SettingsPage` frame: the page
(`pages/settings/media.vue`) renders the `PageHeader` "Images and voice" with the description "Models for generated
images, dictation and reading replies aloud.", `MediaSettings` is the body. Wireframe: 2.10. Nav label "Media" (5.5).
Every model here is opt-in: nothing is chosen automatically, and each select lists the models of connected providers
only. On mount `MediaSettings` loads the providers, the whole model catalog (hidden models included) and the settings
(unless already loaded); the sections render right away, and a failed load shows `SettingsLoadError` "Could not load
the media settings" with the server message and **Retry** above them. Settings save on change, optimistically (a
failure shows an error toast with the 7.4 title and rolls back); the Voice field saves on blur or Enter.

**Images** (`ImageSettings`, `image-settings`; `SettingsSection` "Images", description "Generate pictures with your
own providers."):

- "Image model" (`settings-image-model`, `data-value` = the model ref, empty for None): `SettingsModelSelect
  kind="image"` (the **visible** image models of connected providers: an image model is visible only when its provider
  can generate images, and one hidden in Settings → Models is not offered) with `allowNone` "None (the generate_image
  tool is off)" → `settings.update({ imageModelRef })`. Help text: "The generate_image tool uses this model. To
  generate images directly, pick an image model in the composer." Without any image model the popover says "No image
  models from your connected providers."

**Voice** (`VoiceSettings`, `voice-settings`; `SettingsSection` "Voice", description = the privacy notice "Audio and
text go to the provider you choose; harness-forge doesn't store them."):

- "Speech to text" (`settings-transcription-model`, `data-value`): `SettingsModelSelect kind="transcription"` (every
  speech-to-text model of a connected provider, hidden ones included: they are hidden from the chat picker by default),
  `allowNone` "Off" → `transcriptionModelRef`. On an insecure origin a warning line follows (and describes the select):
  "Voice input needs HTTPS or localhost" (the setting still saves; the microphone cannot be used from this address).
- "Language" (`settings-transcription-language`, `data-value` = `auto` or the code): `Select` with "Detect
  automatically" (`auto`, default) and then common languages by English name with their ISO 639-1 code shown in mono
  (Arabic `ar`, Chinese `zh`, Czech `cs`, Danish `da`, Dutch `nl`, English `en`, Finnish `fi`, French `fr`, German
  `de`, Greek `el`, Hindi `hi`, Italian `it`, Japanese `ja`, Korean `ko`, Norwegian `no`, Polish `pl`, Portuguese `pt`,
  Russian `ru`, Spanish `es`, Swedish `sv`, Turkish `tr`, Ukrainian `uk`) → `transcriptionLanguage`; a stored code that
  is not in the list (set through the API) shows as the code. Disabled while Speech to text is Off.
- "Read aloud" (`settings-speech-model`, `data-value`): `SettingsModelSelect kind="speech"` (every text-to-speech model
  of a connected provider, hidden ones included), `allowNone` "Off" → `speechModelRef`; changing it also clears the
  voice (`settings.update({ speechModelRef, speechVoice: null })`).
- "Voice" (`settings-speech-voice`): a text `Input` (placeholder "Provider default", at most 64 characters) with a
  suggestion list from the selected model's `voices`: a `Popover` holding a plain `role="listbox"` "Voices" (not a
  `Command`; the input is a `combobox` only when the model lists voices). Focusing offers every voice, typing filters
  them (case-insensitive, anywhere in the name); focus stays in the input while the list opens and closes: ArrowDown /
  ArrowUp move, Enter takes the highlighted voice (else the typed text), leaves the field and saves, Esc closes the
  list and a second Esc restores the saved value; a click on a suggestion saves it at once; the saved voice has a check
  mark. An empty field = `null` (the provider default);
  validated like `speechVoiceSchema` (inline errors "Use at most 64 characters." and "Voices use letters, digits,
  spaces and "_", ".", ":", "-"."); saves on blur or Enter → `speechVoice` (a failed save restores the saved value).
  Disabled while Read aloud is Off.
- "Speed" (`settings-speech-speed`, `data-value`): `Select` 0.75× · 1× (default) · 1.25× · 1.5× · 1.75× · 2× →
  `speechSpeed` (applied by the browser as `playbackRate`; never sent to the provider; a stored speed outside the list,
  e.g. 0.5 set through the API, keeps its own label). Disabled while Read aloud is Off.
- **Test voice** (`settings-speech-test`, outline, `Volume2` icon, `data-state` `idle` | `loading` | `playing`,
  `aria-pressed` while playing, `aria-busy` while loading): reads "This is how replies sound when they are read aloud."
  with the chosen model, voice and speed through the app-wide player (`useSpeechPlayer().toggle('voice-test', …)`,
  7.18); "Stop" while it plays; disabled while Read aloud is Off; turning Read aloud Off or leaving the page stops it;
  errors → the player's toast "Could not play the test voice" with the server message (the page adds no toast of its
  own).

### 9.10 Projects (`/settings/projects`, W7.9, Phase 7)

Projects (ADR-031). `ProjectsSettings` (`projects-settings`) in the usual `SettingsPage` frame: the page
(`pages/settings/projects.vue`) renders the `PageHeader` "Projects" with the description "Folders on the server that
chats can read and edit." and the header action **Add project** (`project-add`, `FolderPlus`); `ProjectsSettings` is
the body. Wireframe: 2.13. Nav label "Projects" (5.5). `?add=1` opens the Add project dialog (the command palette's
"Add project…", 7.20). A skeleton shows while the projects load; a failure shows `SettingsLoadError` "Could not load
the projects" with **Retry**.

- **Rows** (`project-row`, `data-project-id`), sorted by name: the name, the path in mono muted text (truncated, the
  full path in its `title`), "{n} chats" (`chatCount`), the warning badge "Folder not found" (`project-missing`; its
  tooltip is `issue`) when `available` is false, and a muted "Uses AGENTS.md" / "Uses CLAUDE.md" when
  `instructionsFile` is set.
- **Row `⋯` menu** (`project-row-menu`, `aria-label="Actions for {name}"`): **Rename** (`project-rename` → the name turns
  into `InlineRename`, `project-rename-input`, at most 80 characters; `projects.update(id, { name })`, optimistic) ·
  **Edit instructions…** (`project-instructions` → `ProjectInstructionsDialog`) · **Delete…** (`project-delete` → a
  `ConfirmDialog` "Delete {name}?" with "Its {n} chats stay and move to No project. The folder and its files are not
  touched." and **Delete project**, `project-delete-confirm`, destructive). Delete → `projects.remove(id)` → toast
  "Project deleted"; 409 `run-active` → toast "Wait for the responses in this project to finish before deleting it."
- **Instructions dialog** (`ProjectInstructionsDialog`, `project-instructions-dialog`): title "Instructions for
  {name}", a `Textarea` (`project-instructions-input`, at most 20,000 characters, `LIMITS.instructionsMaxChars`, with
  the counter "{n} / 20,000"), the note "Sent with every chat in this project, after AGENTS.md / CLAUDE.md from the
  folder." (when the folder has one: "This folder has {file}; it is added first."), Cancel and **Save**
  (`project-instructions-save`) → `projects.update(id, { instructions })` (an empty text saves `null`), `saved(project)`.
- **Empty state** (`projects-empty`): "No projects yet. A project is a folder on the server that chats can read and
  edit." and **Add project** (`project-add`).
- **Add project dialog** (`AddProjectDialog`, `add-project-dialog`; a form dialog, full width minus 1rem at 390px,
  `max-h-[90dvh]`, its folder list scrolls; also opened from the switcher, 7.20):
  - **Folder browser** (`FolderBrowser`, `folder-browser`, `data-path`, `data-state` `loading` | `ready` | `empty` |
    `error`): with no folder open it lists the roots from `projects.browse()` (`GET /api/projects/browse`; a root
    whose folder is missing is disabled with "Not found"); then a breadcrumb inside `nav aria-label="Folder path"` (the
    root, then the path segments; `folder-browser-crumb`, `data-path`; the current one `aria-current="page"`),
    **Parent folder** (`folder-browser-up`, `FolderUp`; at a root's top it returns to the list of roots), and the
    subfolders as buttons (`folder-browser-entry`, `data-path`; a click or Enter opens one; the server hides dot
    folders, `node_modules` and the data directory). Folders that already are projects show a "Project" badge and are
    disabled; past 500 folders the list ends with "Showing the first 500 folders." The open folder is the selected
    folder: "Selected: {path}" in mono. Each browse request aborts the previous one; a polite live region announces
    "Opened {folder}, {n} folders" and focus moves to the first entry. Errors inline (`folder-browser-error`,
    `data-code`): 404 → "This folder no longer exists." with Parent folder and back to the roots; 400 → "Choose a folder
    inside the workspace folders."
  - **New folder** (`folder-browser-new`, `FolderPlus`; rendered by the dialog right below the browser, because the
    folder is created only on submit): reveals a "Folder name" input (`folder-browser-new-input`) checked like
    `folderNameSchema`: no `/` or `\`, not `.` or `..`, no leading dot, at most 255 characters (inline errors "Use a
    name without slashes.", "Folder names can't start with a dot.", "Use at most 255 characters."). With a name the
    request becomes `{ name, path: <the open folder>, newFolder }`.
  - **Name** (`add-project-name`, at most 80 characters): the selected folder's basename (or the new folder's name)
    until the user edits it.
  - **Add project** (`add-project-submit`; disabled without a selected folder below a root or without a name) →
    `useFreshAuth().run(() => projects.create(body), { required: true })` with `ConfirmPasswordDialog` ("Adding a
    project needs your password.", 8.4); cancelling the prompt shows nothing. Success → toast "Project added",
    `created(project)`, the dialog closes (the switcher then filters by the new project).
  - **Inline errors** (`add-project-error`, `data-code`): 409 `exists` → "A project for this folder already exists."
    (with a new folder: "A folder with this name already exists."); 400 / 403 → "Choose a folder inside the workspace
    folders." (a 400 with another server message, such as the data-directory refusal or the 200-project cap, shows that
    message); 404 → "This folder no longer exists."
  - **No workspace folders** (every root missing): an `Alert` "No workspace folders. Set HF_WORKSPACE_ROOTS on the
    server." and the submit stays disabled.

---

## 10. Component inventory and contracts

### 10.0 Naming rule

Custom components are referenced by **file name** (`AppSidebar`, not `AppShellAppSidebar`). `nuxt.config.ts`
(S0) therefore registers `~/components` with `pathPrefix: false`, excluding `ui/**` and `ai-elements/**` (those
are registered by `shadcn-nuxt`). Consequence: every custom `.vue` file name is unique across all folders and
never equals a shadcn-vue component name (`Sidebar*`, `Command*`, `Item`, `Field`, `Empty`, …).

### 10.1 shadcn-vue components (S0 installs, `components/ui`, no prefix, frozen)

`button input textarea label dialog alert-dialog sheet drawer dropdown-menu popover command tooltip scroll-area
sidebar tabs toggle-group switch select badge card separator skeleton collapsible sonner avatar kbd empty spinner
input-group field button-group item stepper resizable table alert progress hover-card breadcrumb`

Also needed and part of the same `add` run if the CLI has them: `checkbox` (trust, approval, schema forms),
`toggle` (used by `toggle-group`). Do **not** add the shadcn-vue chat components `Message`, `Bubble`,
`Message Scroller` (name clash with AI Elements).

### 10.2 AI Elements Vue subset (S0 copies, `components/ai-elements`, prefix `Ai`, frozen)

| Block | Components used (verify exact exports in the copied files) | Used by |
|---|---|---|
| conversation | `AiConversation`, `AiConversationContent`, `AiConversationScrollButton` | `ChatTranscript` |
| message | `AiMessage`, `AiMessageContent` | `ChatMessage` (text goes through `Markdown`; the copied `MessageResponse` was removed, ADR-007) |
| prompt-input | `AiPromptInput`, `AiPromptInputTextarea`, toolbar/tools/submit parts | `ChatComposer` |
| reasoning | `AiReasoning`, `AiReasoningTrigger` (the body is `Markdown` in a shadcn `CollapsibleContent`; the copied `ReasoningContent` was removed, ADR-007) | `ReasoningPart` |
| tool | `AiTool`, `AiToolHeader`, `AiToolContent`, `AiToolInput`, `AiToolOutput` | `ToolPart` |
| confirmation | `AiConfirmation` + request/accepted/rejected/actions parts | `ToolApprovalCard` |
| context | `AiContext` + trigger/content parts | `ContextRing` |
| sources | `AiSources`, `AiSourcesTrigger`, `AiSourcesContent`, `AiSource` | `SourcesPart` |
| shimmer | `AiShimmer` | `ReasoningPart`, submitted placeholder |
| loader | `AiLoader` | fallback loading indicator |
| code-block | `AiCodeBlock`, `AiCodeBlockCopyButton` | `Markdown` code fences (when not rendered by markstream) |

Copied files are frozen and never edited by feature agents; any patch is a CCR for the coordinator (applied patches
are listed in `apps/web/AI_ELEMENTS_PATCHES.md`). Phase 5 deleted `message/MessageResponse.vue` and
`reasoning/ReasoningContent.vue` (and their barrel exports): they rendered markdown with vue-stream-markdown and were
never used, so the dependency and its `pnpm-workspace.yaml` override were dropped too (ADR-007); markdown always goes
through `Markdown` (markstream-vue). Do not re-add them when re-syncing with upstream. The copied `MessageBranch*`
components stay unused: they hold every version's content on the client and wrap around at the ends, while versions
here are server-driven and only the active path is loaded, hence the custom `BranchSwitcher` (7.5).

### 10.3 Custom components (inventory)

`×` = cross-owner (contract in 10.4). Paths are under `apps/web/app/components/`.

**`app-shell/`**

| Component | Purpose | Owner |
|---|---|---|
| `AppSidebar` × | sidebar shell: brand, mode tabs, nav slot by mode, footer; remembers last routes | C3 |
| `AppBrand` | ember mark + wordmark + trigger | C3 |
| `ModeTabs` × | `Chat \| Plugins` segmented tabs driven by the route | C3 |
| `SettingsNav` × | "← Back to app" + settings links | C3 |
| `ThemeToggle` × | Moon / Sun / Monitor toggle (dropdown when collapsed) | C3 |
| `ChatNav` × | project switcher (Phase 7), new chat, search, grouped chat list, status dots, row menu (+ Move to project), infinite scroll | W2.4 (stub C3); W7.9 (Phase 7) |
| `PluginsNav` × | new plugin, install, browse filters with counts, installed list | W3.1 (stub C3) |
| `CommandPalette` × | Mod+K palette (Phase 7: a Projects section while searching); also registers global shortcuts (`useGlobalShortcuts`) | W2.4 (stub C3); W7.9 (Phase 7) |
| `ShortcutsDialog` × | Mod+/ list of shortcuts from the registry | W2.4 (stub C3) |

Internal to `ChatNav` / `CommandPalette` (`app-shell/chat-nav/`, W2.4): `ChatNavRow`, `ChatNavDeletedToast` (the
"Chat deleted" toast with Undo), `PaletteSearchInput`.

**`providers/`** (C3)

| Component | Purpose |
|---|---|
| `ProviderIcon` × | provider/plugin icon from server URLs: mono via CSS mask, color via `<img>` on a tile, monogram fallback |
| `ModelCaps` × | capability icons (Eye / Wrench / Brain, optional FileText for PDF, Image for image output since Phase 6) + optional context size |
| `ModelLabel` × | `ProviderIcon` + model display name for a model ref (reads the models store) |
| `ProviderStatusBadge` × | badge for `connected / not_configured / env / error` |

**`common/`**

| Component | Purpose | Owner |
|---|---|---|
| `BrandMark` × | ember ◆ SVG mark | C3 |
| `StatusDot` × | 8px status dot with sr-only label (5.10) | C3 |
| `KbdCombo` × | platform-aware key combo (`⌘⇧O` / `Ctrl Shift O`) built on `Kbd` | C3 |
| `PageHeader` × | h-12 bar with trigger + title/description + actions slot | C3 |
| `CopyButton` × | copy text to clipboard with check feedback | C3 |
| `InlineRename` × | inline title editor (Enter/blur saves, Esc cancels) | C3 |
| `ConfirmDialog` × | `AlertDialog` wrapper for destructive confirmations | C3 |
| `ConfirmPasswordDialog` × | fresh-auth password prompt; the caller runs `auth.login(password)` and retries (8.4) | C3 |
| `HarnessErrorAlert` × | renders a `HarnessError` with action buttons | C3 |
| `FileChip` × | attachment chip/thumbnail (upload states, remove) | C3 |
| `RelativeTime` × | "3h ago" with absolute time in `title` | C3 |
| `Markdown` × | markstream-vue wrapper (escape HTML, Shiki, links in new tab) | W2.2 |

**`chat/`** (W2.2) — `ChatView` ×, `ChatHeader`, `NewChatHeader`, `ChatTranscript`, `ChatMessage`,
`UserMessageBubble`, `MessageEditor`, `MessageActions`, `MessageMeta`, `ChatGreeting`, `NoProviderCallout`,
`ChatNotFound`, `SubmittedPlaceholder`, `TranscriptScrollButton`; Phase 5: `BranchSwitcher` (W5.2). In Phase 5
`ChatHeader` belongs to W5.6 (the "Share…" item) and the rest of `chat/` to W5.2. Phase 6: `ReadAloudButton` × (W6.8;
C12 shipped the stub) and the helper `attachment-toasts.ts` (W6.7, the upload rejection toasts of the message editor,
the same texts as the composer's); `chat-format.ts` gained the gallery block and `isImageMediaType`,
`isImageFilePart`, `imageFileParts` and `formatImageTurn` (the meta line); the other top-level chat files belong to
W6.7.

**`chat/parts/`** (W2.2) — `TextPart`, `ReasoningPart`, `ToolPart`, `ToolValueBlock` (one Input / Output block of a
tool row), `ToolApprovalCard`, `FilePart`, `SourcesPart`, `NoticePart` (`data-notice` line, API.md 6.4),
`ErrorPart`, `CommandBadge`; `parts/markdown/` — `MarkdownCodeBlock`, `MarkdownImage` (renderers used by `Markdown`).
Phase 6 (W6.8; C12 shipped the stubs): `ImageGallery` × (7.16, also used by the share page) and `GeneratingImages` ×,
with the pure helpers in `image-gallery.ts` (`galleryImages`, `downloadableUrl`, `imageDownloadName`,
`aspectRatioCss`, `generatingCaption`) and `tool-row.ts` (`toolRowArgument`: the first argument of a tool row, the
prompt for `generate_image`; also used by `ShareToolRow`).

**`chat/composer/`** (W2.3) — `ChatComposer` ×, `ComposerAttachments`, `ComposerAddMenu`, `ModelPicker` ×
(+ `ModelPickerTrigger`, `ModelPickerList`), `EffortMenu`, `PermissionMenu`, `SlashMenu`, `ContextRing`,
`SendStopButton`, `DropOverlay`. Phase 6 (W6.9; C12 shipped the stubs): `ImageOptionsMenu`, `MicButton`,
`RecordingIndicator`, the pure helpers in `dictation.ts` (`insertDictation`, `pickRecorderMimeType`,
`recordingFileName`, `dictationErrorToast`, `DICTATION_SHORTCUT`) and `image-options.ts` (the aspect ratio choices,
the image counts, the trigger summary and its accessible name).

**`plugins/list/`** (W3.1) — `PluginListView` (content of `/plugins`), `PluginCard`, `PluginGrid`,
`PluginFilterSelect`, `PluginNewMenu`, `PluginIcon`, `PluginSourceBadge`, `PluginStateBadge`, `PluginRunsCodeBadge`.

**`plugins/detail/`** (W3.1) — `PluginDetailView` (content of `/plugins/[id]`), `PluginHeader`,
`PluginStatusBanner`, `PluginOverviewTab`, `PluginDetailSection`, `PluginContributions`, `PluginToolsTable`,
`PluginMcpServerList`, `PluginConfigurationTab`, `PluginLogsTab`.

**`plugins/forms/`** (W3.1) — `SchemaForm` ×, `SchemaField`, `SchemaSecretInput`, `SchemaTagInput`.

**`plugins/install/`** (W3.2) — `InstallDialog` ×, `InspectPreview`, `TrustWarning` ×, `TrustConsent` (the
"I trust {source}" checkbox + password field of both dialogs), `TrustDialog` ×.

**`plugins/wizard/`** (W3.3) — `ProviderWizard`, `WizardBasicsStep`, `WizardApiStep`, `WizardCredentialsStep`,
`WizardModelsStep`, `WizardReviewStep`, `WizardManifestView`, `WizardErrorAlert`, `LobeIconPicker`,
`provider-templates.ts`.

**`plugins/code/`** (W3.4) — `CodePluginForm` ×, `PluginSourceTab` ×, `SourceFileTree`, `SourceEditorTabs`,
`SourceEditor`, `SourceFileDialog` (new file / rename), `SourceConflictDialog` (stale save), `BuildLogPanel`.

**`plugins/mcp/`** (W3.5) — `McpServersPanel` ×, `McpServerDialog`, `McpSecretRows`, `McpTransportBadge`.

**`settings/`** (W2.5) — `SettingsPage` (frame of every settings page), `SettingsSection`, `SettingsLoadError`,
`ProviderList`, `ProviderRow`, `ProviderKeyDialog` ×, `CredentialFieldInput`, `InsecureBanner`, `ModelsSettings`,
`ProviderModelsSection`, `ModelsTable`, `SettingsModelSelect`, `CustomModelDialog`, `GeneralSettings`,
`PasswordSection`, `PasswordDialog`, `AppearanceSettings`, `ThemeCard`, `ThemePreview`, `AboutPanel`, `LoginForm`.

**`settings/data/`** (W5.5, Phase 5) — `DataSettings` × (content of `/settings/data`; C9 shipped the stub) and its
internal pieces `DataExportSection`, `DataImportSection`, `DataImportResultPanel` (the import result), `DataDangerZone`
and `DataDeleteDialog` (the delete-all dialog); pure helpers in `data.ts`.

**`settings/media/`, `settings/images/`, `settings/voice/`** (W6.10, Phase 6; C12 shipped the stubs) — `MediaSettings` ×
(the body of `/settings/media`), `ImageSettings` × (the Images section), `VoiceSettings` × (the Voice section, 9.9)
and the pure helpers in `voice/voice-settings.ts` (the languages, the speeds, `parseVoice`, `filterVoices`, the Test
voice text). Phase 6 also extended `settings/models.ts` (`modelSelectGroups` per kind, `MODEL_SELECT_EMPTY_TEXT`,
`MODEL_KIND_LABELS`) and `settings/custom-model.ts` (`CUSTOM_MODEL_KINDS`, the kind-aware request body).

**`share/`** (W5.6, Phase 5) — `ShareDialog` × (mounted once by `layouts/default.vue`), `SharesSettingsSection` ×
(rendered by `DataSettings`), `SharedChatView` × (content of `/share/[token]`), `ShareToolRow`, and the internal
pieces `ShareLinkCard` (one link of the dialog), `ShareOptionSwitches`, `ShareExpirySelect` and `SharedMessage` (one
message of the share page); pure helpers in `share-links.ts` and `share-view.ts`. C9 shipped stubs of the three
cross-owner components. Phase 6: the dialog's own `fresh-auth.ts` was replaced by `useFreshAuth` (W6.11), and
`SharedMessage` renders generated images with `ImageGallery` (W6.8); `share-view.ts` groups consecutive image files
into a `gallery` block, and the "Files and images" label lives in `share-links.ts`.

**`projects/`** (W7.9, Phase 7; C15 ships the stubs) — `ProjectSwitcher` × (first row of `ChatNav`),
`ProjectMenuItems` × (the radio items of every project menu), `NewChatProjectPicker` × (on `/`), `ChatProjectChip` ×
(in `ChatHeader`), `AddProjectDialog` ×, `FolderBrowser` ×, `ProjectInstructionsDialog` ×, and the helper
`move-chat.ts` (`useMoveChat`, 11.4).

**`settings/projects/`** (W7.9, Phase 7; C15 ships the stub) — `ProjectsSettings` × (the body of
`/settings/projects`, 9.10).

**`chat/parts/tools/`** (W7.11, Phase 7; C15 ships the stubs) — `WorkspaceToolBody` ×, `DiffView` ×,
`TerminalOutput` ×, `FileContent` ×, `FileList` ×, `ToolApprovalPreview` × and the pure registry `workspace-tools.ts`
(7.19, 11.4). `ToolPart`, `ToolApprovalCard` and `ShareToolRow` use them. The pure helpers `utils/line-diff.ts`
(`diffLines`) and `utils/ansi.ts` (`stripAnsi`) belong to W7.11 too.

**`settings/data/`, Phase 7** (W7.13; C15 ships the stubs) — `EncryptionKeySection` ×, `RotateKeyDialog` × and
`StorageCleanupSection` × (9.8), rendered by `DataSettings`.

W4.2 (UX polish) may edit every file above in Phase 4. Phase 7 owners: W7.9 (the projects and chats stores,
`projects/**`, `settings/projects/**`, `ChatNav`, `CommandPalette`), W7.10 (`useChatSession`, `useServerEvents`, the
top-level chat components and pages), W7.11 (`chat/parts/**`, the share rendering files, `line-diff`, `ansi`), W7.12
(`chat/composer/**`, `GeneralSettings`), W7.13 (`settings/data/**`); see `docs/phases/phase-7-v1-3.md`. Phase 6 owners: W6.7 (`useChatSession` and the top-level chat
components), W6.8 (`chat/parts/**`, `ReadAloudButton`, the share rendering files), W6.9 (`chat/composer/**`,
`ModelCaps`), W6.10 (the settings files), W6.11 (`useFreshAuth` and its call sites in `plugins/**`, `settings/data/**`,
`ShareDialog`; `AppBrand`, `ThemeToggle`, `AppSidebar` and the `ui/sidebar` patch); see
`docs/phases/phase-6-v1-2.md`.

### 10.4 Contracts (cross-owner components)

Written as `defineProps` / `defineEmits` / `defineSlots` / `defineExpose` signatures. Types come from
`@harness-forge/shared` (DTOs, enums, `HarnessError`, and the plugin data shapes `SettingsSchema` and `ModelInfo`,
which live in `shared` per ADR-018; `@harness-forge/plugin-sdk` re-exports them and adds `settingsValuesSchema`).
Optional props use the defaults noted. Components without props read their data from stores.

#### Shell (C3 creates; W2.4 / W3.1 fill the stubs)

```ts
// AppSidebar, ModeTabs, SettingsNav, ChatNav, PluginsNav, CommandPalette, ShortcutsDialog: no props, no emits.
// ChatNav / PluginsNav render inside <SidebarContent>; they must not render their own <Sidebar>.
// CommandPalette / ShortcutsDialog read and write ui.paletteOpen / ui.shortcutsOpen.
// CommandPalette's setup calls useGlobalShortcuts() (it is mounted once, in layouts/default.vue).

// ThemeToggle
defineProps<{ collapsed?: boolean }>()          // default false; true = single icon + dropdown
```

#### Providers (C3)

```ts
// ProviderIcon
defineProps<{
  icon?: { color?: string; mono?: string } | null  // DTO icon URLs (/api/icons/lobe/<slug>, /api/plugins/<id>/icon)
  name: string                                      // alt/title text and monogram source
  id?: string                                       // monogram hue seed; default = name
  size?: 'sm' | 'md' | 'lg'                         // sm 16px glyph · md 20px glyph (28px tile) · lg 24px glyph in 36px tile; default 'md'
  variant?: 'auto' | 'color' | 'mono'               // default 'auto'
}>()
// auto  = mono → color → monogram (inline contexts: picker items, composer trigger, message meta)
// color = color on a bg-muted tile → mono → monogram (settings rows, plugin cards, picker group headers)
// mono  = mono → monogram
// mono: <span> with mask-image: url(mono) over bg-current (inherits text color)
// color: <img :src="color" alt="" loading="lazy"> ; never v-html; decorative (aria-hidden) — pair with text
// monogram: first letter(s) of name on oklch(0.45 0.09 h) dark / oklch(0.90 0.05 h) light, h = hash(id) % 360

// ModelCaps
defineProps<{
  capabilities?: ModelInfo['capabilities']   // tools / vision / pdf / reasoning / structuredOutput / imageOutput (Phase 6)
  contextWindow?: number                     // shown as "200K" / "1M" when set
  size?: 'sm' | 'md'                         // icon 12px / 14px; default 'sm'
}>()
// Order: Eye (vision), Wrench (tools), Brain (reasoning), Image (imageOutput: "Image output", W6.9), FileText (pdf:
// "PDF input"). Each icon has a tooltip + sr-only text.

// ModelLabel
defineProps<{ modelRef: string; size?: 'sm' | 'md'; showProvider?: boolean }>()
// Unknown ref → the raw model id in mono with a TriangleAlert icon.

// ProviderStatusBadge
defineProps<{ status: ProviderStatus; httpStatus?: number; message?: string }>()   // message → tooltip
// httpStatus = ProviderSummary.lastError.status (the upstream status), never HarnessError.httpStatus
```

#### Common (C3, except Markdown)

```ts
// BrandMark
defineProps<{ size?: number }>()                  // px, default 16; fill = var(--primary)

// StatusDot
type StatusDotStatus = 'running' | 'approval' | 'unread' | 'ok' | 'off' | 'warning' | 'error'
defineProps<{ status: StatusDotStatus; label?: string }>()   // label overrides the default sr-only text

// KbdCombo
defineProps<{ keys: string }>()                   // 'mod+shift+o', 'alt+m', 'shift+escape' (useShortcuts().format)

// PageHeader
defineProps<{ title: string; description?: string }>()
defineSlots<{ actions?: () => any; default?: () => any }>()   // default slot = extra content under the title row

// CopyButton
defineProps<{ text: string | (() => string); label?: string; size?: 'sm' | 'icon' }>()   // label default 'Copy'
defineEmits<{ copied: [] }>()

// InlineRename
defineProps<{ modelValue: string; editing: boolean; maxLength?: number; placeholder?: string }>()  // maxLength 200
defineEmits<{ 'update:modelValue': [value: string]; 'update:editing': [value: boolean]; cancel: [] }>()
// Emits update:modelValue only when the trimmed value changed and is not empty.

// ConfirmDialog
defineProps<{ open: boolean; title: string; description?: string; confirmLabel?: string
  cancelLabel?: string; destructive?: boolean; pending?: boolean }>()   // 'Delete', 'Cancel', true, false
defineEmits<{ 'update:open': [value: boolean]; confirm: [] }>()
defineSlots<{ default?: () => any }>()              // extra body, e.g. the keepData checkbox

// ConfirmPasswordDialog — fresh-auth prompt (API.md), presentational: password Input + "Confirm". The caller
// handles submit with auth.login(password), passes pending / error ("Wrong password", rate-limit text), closes
// the dialog on success and retries its request once. Phase 6: every caller binds it to useFreshAuth() (open,
// pending, error, submit, setOpen; 8.4, 11.3). The password is cleared whenever the dialog closes.
defineProps<{ open: boolean; description?: string; pending?: boolean; error?: string | null }>()
// description default 'Confirm your password to continue.'
defineEmits<{ 'update:open': [value: boolean]; submit: [password: string] }>()

// HarnessErrorAlert
defineProps<{ error: unknown; providerName?: string; compact?: boolean }>()  // normalized with toHarnessError()
defineEmits<{ action: [action: 'configure-provider' | 'refresh-models' | 'login' | 'retry' | 'view-logs'] }>()

// FileChip
defineProps<{ name: string; size?: number; mime?: string; url?: string
  state?: 'uploading' | 'error' | 'done'; removable?: boolean }>()       // state 'done', removable false
defineEmits<{ remove: []; retry: []; open: [] }>()
// Images (mime image/*) with url render a 64px thumbnail; everything else a chip.

// RelativeTime
defineProps<{ at: string | number | Date }>()

// Markdown (W2.2)
defineProps<{ content: string; final?: boolean }>()   // final default true; false while the part streams
// markstream-vue with HTML escaped (html-policy "escape"), Shiki code blocks + CopyButton, links
// target=_blank rel="noopener noreferrer", images lazy with referrerpolicy="no-referrer". No slots.
```

#### Chat (W2.2) and composer (W2.3)

```ts
// ChatView (W2.2) — transcript + composer for one chat
defineProps<{ chatId: string; isNew?: boolean }>()   // isNew: '/' page, no fetch; first send → router.replace('/chat/<id>')
defineEmits<{ created: [chatId: string] }>()          // after the first send of a new chat
defineSlots<{
  header?: (p: { scrolled: boolean; title: string | null; loading: boolean }) => any  // above the transcript (ChatHeader);
                                                      // scrolled = the transcript left its top; not rendered on 404
  empty?: () => any                                   // above the inline composer of an empty new chat (greeting, callout)
}>()

// ChatMessage (W2.2) — rendered by ChatTranscript
defineProps<{
  message: HarnessUIMessage       // UI message with harness metadata (API.md, @harness-forge/shared)
  isLast: boolean
  streaming: boolean              // this message is being streamed
  showThinking: boolean
  busy?: boolean                  // default false; a request is in flight in this chat: no Edit / Regenerate /
                                  // Delete this version
  error?: unknown                 // live error of the last request (shown on the last assistant message;
                                  // stored errors come from metadata.error)
  commandReply?: boolean          // default false; the previous user message ran a `reply` command: meta reads "Command reply"
  branch?: MessageBranch | null   // + Phase 5 (W5.2): ChatDetail.branches[message.id]; renders BranchSwitcher (7.5)
  switching?: boolean             // + default false; a version switch (Phase 6: or a deletion) is pending (the
                                  // switcher is disabled)
}>()
defineEmits<{
  regenerate: []                  // offered on every finished assistant message (Phase 5)
  edit: [text: string, files: FileUIPart[]]  // Phase 6 (S8): the files left in MessageEditor (the full new set)
  approval: [response: { id: string; approved: boolean; toolName: string; alwaysAllow: boolean }]
  retry: []
  'select-version': [messageId: string]   // + the sibling chosen in BranchSwitcher
  'delete-version': []            // + Phase 6 (S7): "Delete this version" clicked; ChatView asks for confirmation (7.5)
}>()
defineExpose<{ startEdit(): void }>()   // opens MessageEditor on a user message unless busy
                                        // (ChatTranscript calls it for ↑ in an empty composer, via ChatView 'edit-last')
// Phase 6 rendering (W6.7): gallery blocks → ImageGallery; metadata.image while streaming without file parts (and
// without finishedAt, error or aborted) → GeneratingImages; ReadAloudButton after Copy on finished replies with text;
// Copy only with text (canCopy); canDeleteVersion = branch !== null && !busy && !switching; the action row stays
// visible while the reply is read aloud. ChatTranscript re-emits edit as [messageId, text, files] and delete-version
// as [messageId] and exposes focusShownVersion(messageId) / focusDeleteVersion(messageId) (+); ChatView owns the
// delete ConfirmDialog and passes previousImages to ChatComposer.

// ChatComposer (W2.3) — used by ChatView (W2.2): the key cross-owner contract
type ChatStatus = 'ready' | 'submitted' | 'streaming' | 'error'   // useChat status
defineProps<{
  chatId: string
  status: ChatStatus
  modelRef: string | null         // v-model:model-ref
  reasoningEffort: ReasoningEffort // v-model:reasoning-effort
  toolMode: ToolMode              // v-model:tool-mode
  usage?: MessageUsage | null     // last assistant metadata.usage → ContextRing
  chatCostUsd?: number | null
  disabled?: boolean              // e.g. no usable provider
  placeholder?: string            // default 'Reply…'; an image model always shows 'Describe an image…' (Phase 6)
  previousImages?: number         // + Phase 6 (W6.7 passes it, W6.9 uses it), default 0: the images of the last
                                  // assistant message on the path; > 0 shows "Edit the previous image" (ImageOptionsMenu)
}>()
defineEmits<{
  'update:modelRef': [value: string]
  'update:reasoningEffort': [value: ReasoningEffort]
  'update:toolMode': [value: ToolMode]
  submit: [input: { text: string; files: FileRef[] }]   // files already uploaded; client commands never emit
  stop: []
  'edit-last': []                                     // ↑ in an empty composer
}>()
defineExpose<{ focus(): void; setText(text: string): void; openModelPicker(): void }>()

// ModelPicker (W2.3) — used by the composer; settings/models uses its own SettingsModelSelect (W2.5)
defineProps<{
  modelValue: string | null       // v-model (model ref)
  open?: boolean                  // v-model:open (Alt+M, /model)
  variant?: 'composer' | 'field'  // default 'composer'; 'field' = full-width select-like trigger
  allowNone?: boolean             // adds a first item that emits null
  noneLabel?: string              // default 'None'
  disabled?: boolean
  returnFocusTo?: HTMLElement | null   // receives focus on close (the composer textarea); default the trigger
}>()
defineEmits<{ 'update:modelValue': [value: string | null]; 'update:open': [value: boolean] }>()

// EffortMenu (W2.3)
defineProps<{ modelValue: ReasoningEffort; modelRef: string | null; open?: boolean; returnFocusTo?: HTMLElement | null }>()
defineEmits<{ 'update:modelValue': [value: ReasoningEffort]; 'update:open': [value: boolean] }>()

// PermissionMenu (W2.3)
defineProps<{ modelValue: ToolMode; open?: boolean; returnFocusTo?: HTMLElement | null }>()
defineEmits<{ 'update:modelValue': [value: ToolMode]; 'update:open': [value: boolean] }>()

// SlashMenu (W2.3, internal to the composer)
interface SlashItem { name: string; description: string; kind: 'client' | 'server'; source?: string }
defineProps<{ open: boolean; query: string; items: SlashItem[] }>()
defineEmits<{ select: [item: SlashItem]; close: [] }>()
defineExpose<{ handleKeydown(e: KeyboardEvent): boolean; activeId: string | undefined; listId: string }>()
// the textarea keeps focus and forwards its keydowns (true = consumed: ↑/↓/Enter/Tab/Esc while the menu shows);
// activeId / listId feed the textarea's aria-activedescendant / aria-controls
```

#### Plugins (W3.1–W3.5)

```ts
// PluginCard (W3.1) — rendered by PluginGrid, which re-emits with the plugin (viewLogs / review / update:enabled)
defineProps<{ plugin: PluginSummary }>()
defineEmits<{ 'update:enabled': [value: boolean]; 'view-logs': []; review: [] }>()
// view-logs: "View logs" link of an `error` card (the list opens /plugins/<id>?tab=logs);
// review: "Review" button of an `untrusted` card (the list opens TrustDialog)

// InstallDialog (W3.2) — mounted once by pages/plugins.vue (W3.1)
defineProps<{ open: boolean; initialSource?: 'zip' | 'npm' | 'url' | 'folder' }>()  // default 'zip'
defineEmits<{ 'update:open': [value: boolean]; installed: [id: string] }>()

// TrustWarning (W3.2) — also rendered by TrustDialog and plugin detail banners
defineProps<{ inspection?: PluginInspection; plugin?: PluginDetail }>()
// exactly one: the install dialog passes the inspection; installed plugins pass their PluginDetail
// (sha256 = trust.hash, permissions = manifest.permissions, source = sourceRef)

// TrustDialog (W3.2) — opened from PluginCard "Review" and the detail header (W3.1)
defineProps<{ open: boolean; pluginId: string }>()
defineEmits<{ 'update:open': [value: boolean]; trusted: [id: string] }>()

// SchemaForm (W3.1)
defineProps<{
  schema: SettingsSchema
  modelValue: Record<string, unknown>   // v-model values; a new object from the parent = a new starting point
  secretsSet?: string[]                 // default []; keys of secret fields that already have a stored value
  secretHints?: Record<string, string | null>  // default {}; masked hints of stored secrets ("sk-…9fQ2")
  disabled?: boolean
  saving?: boolean                      // default false; the parent is saving: Save shows a spinner, fields lock
}>()
defineEmits<{ 'update:modelValue': [value: Record<string, unknown>]; submit: [value: Record<string, unknown>] }>()
defineExpose<{
  validate(): Promise<boolean>          // runs the validator, shows every message, focuses the first invalid field
  reset(): void                         // back to the starting point (not to the schema defaults), no messages
}>()
// Secret values: omitted = keep the stored secret, a string replaces it, '' clears it (8.9).

// PluginSourceTab (W3.4) — rendered by PluginDetailView (pages/plugins/[id].vue, W3.1) for the Source tab (8.7)
defineProps<{ pluginId: string; readonly?: boolean }>()   // read-only also when PluginDetail.editable is false

// CodePluginForm (W3.4) — rendered by pages/plugins/new.vue (W3.3)
defineEmits<{ created: [id: string]; cancel: [] }>()

// ProviderWizard (W3.3)
defineProps<{ editId?: string }>()     // from ?edit=
defineEmits<{ created: [id: string]; cancel: [] }>()   // also emitted after "Save changes" in edit mode

// McpServersPanel (W3.5) — rendered by pages/plugins/[id].vue (W3.1) when id === 'core-mcp'
defineProps<{ pluginId?: string }>()   // default 'core-mcp'; filters servers contributed by that plugin
```

#### Settings (W2.5)

```ts
// ProviderKeyDialog — opened by the providers page and by ?configure=<providerId>
defineProps<{ open: boolean; providerId: string }>()
defineEmits<{ 'update:open': [value: boolean]; saved: [providerId: string] }>()

// SettingsModelSelect (W2.5; Phase 6: W6.10) — the model select of Settings → Models and Settings → Media
defineProps<{
  modelValue: string | null       // v-model (model ref)
  allowNone?: boolean             // adds a first option that emits null
  noneLabel?: string              // label of that option
  placeholder?: string
  disabled?: boolean
  label?: string                  // accessible name of the trigger (the visible label lives outside)
  kind?: 'chat' | 'image' | 'transcription' | 'speech'
                                  // + Phase 6, default 'chat': 'chat' = the visible chat models of connected providers
                                  // (the default and title selects); 'image' = the visible image models; 'transcription'
                                  // / 'speech' = every model of that kind of a connected provider, hidden ones included
                                  // (they are hidden from the chat picker by default)
}>()
defineEmits<{ 'update:modelValue': [value: string | null] }>()
// Options carry model-select-option with data-model-ref (empty for the none option). Attributes (data-testid) go to
// the trigger, which carries data-value (the ref, '' for none) and data-kind. Without a model of the kind the popover
// has no search field and says "No chat / image / speech-to-text / text-to-speech models from your connected
// providers." ("Loading models…" until the catalog arrived; models.ts MODEL_SELECT_EMPTY_TEXT).
```

#### Branching, sharing and data (Phase 5: W5.2, W5.5, W5.6; C9 ships the stubs)

```ts
// BranchSwitcher (W5.2) — first item of a message's action row (7.5), only for messages listed in `branches`
defineProps<{
  siblings: readonly string[]   // MessageBranch.siblings: every version of this message (>= 2), seq order
  index: number                 // MessageBranch.index: position of the shown version (0-based)
  disabled?: boolean            // default false; busy or switching: both buttons aria-disabled
}>()
defineEmits<{ select: [messageId: string] }>()   // the sibling to show (never the current one)
// Root: role="group" aria-label="Message versions", data-testid message-branch with data-message-id
// (= siblings[index]), data-index (= index) and data-count (= siblings.length). Buttons "Previous version" /
// "Next version" (ChevronLeft / ChevronRight, ghost icon-xs, 40px on coarse pointers; aria-disabled at the ends,
// never the native disabled attribute); counter "2/3" (aria-hidden, tabular-nums, message-branch-counter) followed
// by the sr-only text "Version 2 of 3". ArrowLeft / ArrowRight inside the group select the enabled neighbor.

// ShareDialog (W5.6) — mounted once by layouts/default.vue (C9)
// No props, no emits: open while ui.shareChatId !== null; closing calls ui.closeShare() (7.14).

// SharedChatView (W5.6) — content of pages/share/[token].vue (share layout)
defineProps<{ token: string }>()   // the route param; the component calls only shares.view (7.15)

// ShareToolRow (W5.6, internal to share/)
defineProps<{ part: Extract<SharePart, { type: 'tool' }> }>()   // toolName, status, input?, output?, errorText?
// Expandable only when the part carries input, output or errorText (sent only with the toolDetails option, 7.15).

// SharesSettingsSection (W5.6) — rendered by DataSettings (W5.5)
// No props, no emits: renders its own SettingsSection "Shared links" (root data-testid shares-section), lists every
// share (shares.list()), refetches after a revoke and when the Share dialog closes (9.8).

// DataSettings (W5.5) — content of pages/settings/data.vue
// No props, no emits (9.8): the summary line, then DataExportSection, DataImportSection, SharesSettingsSection and
// DataDangerZone.
```

#### Multimodal and versions (Phase 6: W6.7 – W6.10; C12 shipped the stubs)

The nine components marked "stub" were created by C12 in P6-0b with exactly these props, emits and root test ids and
are frozen since Gate P6-0b (a change is a CCR); P6-A implemented them behind those contracts. Additive details that
P6-A added without changing a prop or an emit: `MicButton` exposes `activate()`, and the `RecordingIndicator` root
carries `data-state`, `role="group"` and an `aria-label`. Types: `FileUIPart` from `ai`; `ImageAspectRatio`,
`ImageOptions`, `AudioTranscription` from `@harness-forge/shared`; `VoiceInputState` from `useVoiceInput` (11). The
components are imported by path (`import ImageGallery from './parts/ImageGallery.vue'`).

```ts
// ImageGallery (W6.8; stub) — one gallery block of an assistant message (7.16); also rendered by SharedMessage
defineProps<{
  images: readonly FileUIPart[]   // consecutive image/* file parts in part order (chat-format.ts block 'gallery');
                                  // url /api/files/<id> (share page: /api/share/<token>/files/<id>); filename optional
  messageId: string               // the message holding them (share page: its generated key)
}>()
// No emits, no store (the share page renders it too). Root image-gallery (data-message-id, data-count = the tiles
// shown: an image whose URL fails safeAssetUrl is left out); tiles image-tile (data-index, 0-based) open the lightbox
// image-lightbox (data-index) with Previous image / Next image (data-action previous / next, aria-disabled at the
// ends) and the Download link image-download (data-action="download"; only for a same-origin, blob: or image data:
// URL).

// GeneratingImages (W6.8; stub) — placeholders of an image turn in flight (7.16)
defineProps<{
  n: number                       // metadata.image.n: placeholder tiles, 1–4 (clamped)
  aspectRatio?: ImageAspectRatio  // metadata.image.aspectRatio; omitted (Auto) = square tiles
  startedAt: number               // metadata.startedAt (epoch ms): the "Generating image… 12s" counter
}>()
// No emits, no store. Root image-generating (data-count); aria-busy="true", sr-only "Generating images"; the caption
// is aria-live="off" and updates every second.

// ImageOptionsMenu (W6.9; stub) — composer menu of image-capable models (7.7), after EffortMenu
defineProps<{
  modelValue: ImageOptions        // v-model: useImageOptions().options ({ n?, aspectRatio?, editPrevious? })
  modelRef: string | null         // the composer's model: an image model shows aspect ratio, Images 1–4 and "Edit the
                                  // previous image"; a chat model with imageOutput shows the aspect ratio only; any
                                  // other model renders nothing
  previousImages?: number         // default 0; "Edit the previous image" shows only when > 0
  open?: boolean                  // v-model:open
  returnFocusTo?: HTMLElement | null   // receives focus on close (the composer textarea); default the trigger
}>()
defineEmits<{ 'update:modelValue': [value: ImageOptions]; 'update:open': [value: boolean] }>()
// update:modelValue carries the whole new value, with undefined for an option back at its default (1 image, Auto,
// "Edit the previous image" on); ChatComposer stores it through useImageOptions().set, so the defaults are absent
// keys. Trigger image-options-trigger (tooltip "Image options", aria-label "Image options: 16:9, 2 images"); items
// image-aspect-option / image-count-option (data-value); checkbox image-edit-previous (data-state checked /
// unchecked). A model change that hides the menu also closes it.

// MicButton (W6.9; stub) — the dictation toggle right before SendStopButton (7.17)
defineProps<{
  state: VoiceInputState          // useVoiceInput().state: 'idle' | 'requesting' | 'recording' | 'transcribing'
  configured: boolean             // settings.transcriptionModelRef is set; false = a click opens the setup popover
  secure: boolean                 // useVoiceInput().secure; false = aria-disabled + "Voice input needs HTTPS or localhost"
  level?: number                  // default 0; the 0–1 input level drawn as a ring while recording
  disabled?: boolean              // default false (e.g. the composer is disabled)
}>()
defineEmits<{ toggle: [] }>()     // idle → start, recording → stop, transcribing → cancel; not emitted while
                                  // requesting, in the setup state, when insecure or when disabled
defineExpose<{ activate(): void }>()   // + P6-A: what a click does (toggle, or the setup popover); Alt+V calls it
// Root composer-mic with data-state = setup | insecure | the state (insecure wins over setup, setup over the state),
// aria-pressed always 'true' (recording) / 'false', aria-keyshortcuts="Alt+V", aria-disabled when insecure or
// disabled; the popover composer-mic-setup with the link composer-mic-setup-link (/settings/media). The composer
// renders MicButton only when useVoiceInput().supported is true.

// RecordingIndicator (W6.9; stub) — replaces the composer's left tools while recording or transcribing (7.17)
defineProps<{
  elapsedMs: number               // useVoiceInput().elapsedMs: the timer "0:07" (m:ss)
  transcribing?: boolean          // default false; true stops the timer (the mic shows "Transcribing…")
}>()
defineEmits<{ cancel: [] }>()     // Cancel: drops the recording or aborts the transcription
// Root composer-recording with data-state = recording | transcribing, role="group" and aria-label "Recording" /
// "Transcribing" (+ P6-A); timer composer-recording-time (not in a live region); the Cancel button
// composer-mic-cancel.

// ReadAloudButton (W6.8; stub) — after Copy on a finished assistant reply with text (7.18)
defineProps<{
  messageId: string               // the reply; compared with useSpeechPlayer().activeId
  markdown: string                // the reply's text parts as markdown (speech-text.ts decides what is read)
}>()
// No emits. Renders nothing while settings.speechModelRef is null. Root message-read-aloud (attributes go to the
// button) with data-state = idle | loading | playing (for this message); while this reply is read (loading or
// playing) aria-pressed="true" and the label "Stop reading", else "Read aloud"; aria-busy="true" while loading.

// MediaSettings (W6.10; stub) — the body of pages/settings/media.vue (9.9): the page's SettingsPage renders the
// PageHeader "Images and voice"; MediaSettings loads the providers, the catalog and the settings, shows the load error
// with Retry, then ImageSettings and VoiceSettings. No props, no emits. Root media-settings.
// ImageSettings (W6.10; stub) — the Images section (9.9). No props, no emits. Root image-settings.
// VoiceSettings (W6.10; stub) — the Voice section (9.9). No props, no emits. Root voice-settings.

// MessageActions (W6.7; internal to chat/, listed for its Phase 6 members) — the action row of a message (7.5)
withDefaults(defineProps<{
  copyText: () => string          // text copied by "Copy" (resolved on click)
  canCopy?: boolean               // + default true; false hides Copy (a reply without text, e.g. images only)
  canRegenerate?: boolean         // default false
  canEdit?: boolean               // default false
  canDeleteVersion?: boolean      // + default false: "Delete this version" (the message has versions, nothing runs)
  align?: 'start' | 'end'         // default 'start'
}>(), { canCopy: true, canRegenerate: false, canEdit: false, canDeleteVersion: false, align: 'start' })
defineEmits<{ regenerate: []; edit: []; 'delete-version': [] }>()
defineSlots<{ 'after-copy'?: () => any; default?: () => any }>()
// after-copy (+): ReadAloudButton, right after Copy; default: the meta (MessageMeta). The delete button carries
// message-delete-version (Trash2, 40px on coarse pointers).

// MessageEditor (W6.7; internal to chat/) — edits a user message with its attachments (7.5, S8)
defineProps<{
  text: string                    // the message text
  files: readonly FileUIPart[]    // + Phase 6: the message's file parts (removable chips message-edit-attachment)
}>()
defineEmits<{
  save: [text: string, files: FileUIPart[]]   // + files: the chips left + the new uploads (the full new set)
  cancel: []                      // aborts the editor's uploads
}>()
// Paperclip button message-edit-attach (its hidden file input has only data-slot="message-edit-file-input");
// input message-edit-input; Save message-edit-save ("Send"; disabled while an upload runs or failed; allowed with
// files and no text); Cancel message-edit-cancel. The send key follows settings.sendKey; Esc cancels.
```

#### Projects, workspace tools and data maintenance (Phase 7: W7.9 – W7.13; C15 ships the stubs)

The seventeen components marked "stub" are created by C15 in P7-0b with exactly these props, emits and root test ids
and are frozen from Gate P7-0b (a change is a CCR); P7-A implements them behind those contracts. Types:
`ProjectSummary`, `ProjectCreate`, `ProjectUpdate`, `ProjectBrowse`, `KeyStatus`, `KeyRotationResult`, `ToolMode`,
`WorkspaceAccess`, `DiffHunk`, `ShellOutput` and the workspace tool output types from `@harness-forge/shared`;
`WorkspaceToolView` and `FileListItem` from `workspace-tools.ts` (11.4). The components are imported by path
(`import DiffView from './tools/DiffView.vue'`).

```ts
// ProjectSwitcher (W7.9; stub) — the first row of ChatNav (5.3, 7.20)
// No props, no emits: reads the projects and chats stores; its menu calls chats.setProjectFilter(); "Add project…"
// mounts its own AddProjectDialog (the filter then switches to the new project); "Manage projects" → /settings/projects.
// Root project-switcher (data-value = all | none | <project id>); items project-switcher-option (data-value),
// project-add, project-manage.

// ProjectMenuItems (W7.9; stub) — radio items inside the caller's DropdownMenu content: the new-chat picker, the
// header chip and both "Move to project" submenus
defineProps<{
  modelValue: string | null       // the selected project id; null = No project
  includeNone?: boolean           // default true: a first "No project" item
}>()
defineEmits<{ select: [projectId: string | null] }>()
// Items project-option (data-value = none | <project id>): projects sorted by name with the path (mono, muted) on a
// second line; a project whose folder is missing shows FolderX in text-warning.

// NewChatProjectPicker (W7.9; stub; mounted by pages/index.vue, W7.10) — the pill under ChatGreeting (7.20)
defineProps<{ modelValue: string | null; disabled?: boolean }>()   // v-model: the new chat's project (null = none)
defineEmits<{ 'update:modelValue': [projectId: string | null] }>()
// Root new-chat-project (data-value = none | <project id>); renders nothing while no project exists. A pick also sets
// the chats store filter when the filter is not 'all'.

// ChatProjectChip (W7.9; stub; mounted by ChatHeader, W7.10) — the project of a saved chat (7.20)
defineProps<{ chatId: string; projectId: string | null }>()
// Renders nothing for a null or unknown project. Root chat-project-chip (data-value = the id, data-state = ok |
// missing); its menu: ProjectMenuItems (moves through useMoveChat) and "Project settings".

// AddProjectDialog (W7.9; stub) — 9.10
defineProps<{ open: boolean; initialPath?: string | null }>()   // initialPath: the folder to open first (default: the roots)
defineEmits<{ 'update:open': [value: boolean]; created: [project: ProjectSummary] }>()
// Root add-project-dialog; renders FolderBrowser, the New folder button folder-browser-new + input
// folder-browser-new-input, the name input add-project-name, submit add-project-submit and the inline error
// add-project-error (data-code). Submits through useFreshAuth().run(() => projects.create(body), { required: true }).

// FolderBrowser (W7.9; stub) — 9.10
defineProps<{ modelValue: string | null; disabled?: boolean }>()   // v-model: the open (= selected) folder; null = the roots
defineEmits<{ 'update:modelValue': [path: string | null] }>()
// Root folder-browser (data-path = the open folder, '' for the roots; data-state = loading | ready | empty | error);
// entries folder-browser-entry (data-path), folder-browser-up, breadcrumb folder-browser-crumb (data-path),
// folder-browser-error (data-code). Calls projects.browse(path, { signal }) and aborts the previous request.

// ProjectInstructionsDialog (W7.9; stub) — 9.10
defineProps<{ open: boolean; project: ProjectSummary | null }>()
defineEmits<{ 'update:open': [value: boolean]; saved: [project: ProjectSummary] }>()
// Root project-instructions-dialog; textarea project-instructions-input; Save project-instructions-save.

// ProjectsSettings (W7.9; stub) — the body of pages/settings/projects.vue (9.10): the page's SettingsPage renders the
// PageHeader "Projects" with the Add project action. No props, no emits. Root projects-settings.

// WorkspaceToolBody (W7.11; stub) — the expanded body of a workspace tool row (7.19)
defineProps<{ view: WorkspaceToolView; running?: boolean }>()   // running default false
// Renders DiffView / TerminalOutput / FileContent / FileList by view.kind, then the toggle tool-raw-toggle
// ("Raw input and output", which shows the generic ToolValueBlocks).

// DiffView (W7.11; stub)
defineProps<{
  hunks: readonly DiffHunk[]      // the server's hunks (workspaceDiffSchema) or utils/line-diff.ts output
  path?: string | null            // project-relative path shown in the header
  created?: boolean               // default false: a new file ("New file" badge)
  truncated?: boolean             // default false: "Diff truncated by server"
  maxLines?: number               // default 200: then "Show {n} more lines"
}>()
// Root diff-view (data-path, data-state = created | modified; role="region" aria-label "Changes to {path}"); lines
// diff-line (data-kind = add | del | context); diff-expand (data-action = unfold | show-all).

// TerminalOutput (W7.11; stub)
defineProps<{ command: string; output: ShellOutput | null; running?: boolean }>()   // output null while running
// Root terminal-output (data-status = running | ok | error | timeout | killed; aria-label "Output of {command}");
// terminal-command, terminal-stdout, terminal-stderr, terminal-exit (data-value = the exit code).

// FileContent (W7.11; stub)
defineProps<{ path: string; content: string; startLine?: number; totalLines?: number | null; truncated?: boolean }>()
// startLine default 1; 20 lines, then "Show all". Root file-content (data-path).

// FileList (W7.11; stub)
defineProps<{ items: readonly FileListItem[]; truncated?: boolean; maxItems?: number }>()   // maxItems default 50
// Root file-list; items file-list-item (data-path); search matches grouped by path with "line:" prefixes.

// ToolApprovalPreview (W7.11; stub) — replaces the JSON block of ToolApprovalCard for workspace tools (7.3)
defineProps<{ toolName: string; input: unknown }>()
// Root tool-approval-preview (data-kind = diff | content | command); renders nothing when
// workspaceApprovalView(toolName, input) is null (the card then keeps its JSON block).

// ToolApprovalCard (W7.11; internal to chat/parts, listed for its Phase 7 members)
defineProps<{
  part: ToolPartLike
  toolName: string
  source?: string | null
  workspace?: WorkspaceAccess | null   // + C15: ToolSummary.workspace; 'execute' hides "Always allow", 'write' offers
                                       // "Accept all edits in this chat" (tool-approval-accept-edits)
}>()
defineEmits<{ decide: [decision: { approved: boolean; alwaysAllow: boolean; acceptEdits?: boolean /* + */ }] }>()
// ToolPart and ChatMessage add acceptEdits? to their approval emit payload (C15, type only); the session switches the
// mode (11.1).

// EncryptionKeySection (W7.13; stub) — Settings → Data (9.8). No props, no emits: loads keys.get() itself and owns the
// RotateKeyDialog. Root data-key-section; the button data-key-rotate.

// RotateKeyDialog (W7.13; stub) — 9.8
defineProps<{ open: boolean; status: KeyStatus | null }>()   // the counts of the effects list come from status
defineEmits<{ 'update:open': [value: boolean]; rotated: [result: KeyRotationResult] }>()
// Root key-rotate-dialog; the "Type ROTATE to confirm" input key-rotate-confirm; submit key-rotate-submit. Submits
// through useFreshAuth().run(…, { required: true }).

// StorageCleanupSection (W7.13; stub) — Settings → Data (9.8). No props, no emits. Root data-cleanup-section;
// data-cleanup-check, data-cleanup-summary, data-cleanup-run, and data-cleanup-confirm on the ConfirmDialog's button.

// Prop-only additions (C15 declares them in P7-0b; the owners use them in P7-A)
// ChatHeader (W7.10):     projectId?: string | null         // the chat's project: ChatProjectChip + "Move to project"
// ChatComposer (W7.12):   projectId?: string | null         // a project chat: PermissionMenu offers Accept edits
// PermissionMenu (W7.12): modes?: readonly ToolMode[]       // default every mode; ChatComposer passes ask, auto, off,
//                                                           // plus edits in a project chat or while edits is selected
```

---

## 11. Pinia stores and composables

C5 implements every store over the typed client (`useApi()` → `useNuxtApp().$api`, created with
`createApiClient()` from `@harness-forge/shared`). Store signatures (state keys, getter and action names) are
frozen after Phase 0; `+` marks additive members added since. Actions throw `HarnessError`; callers show toasts.
Setup-style stores, `use<Name>Store`.
DTO names are exactly those of `docs/API.md` section 4 (`AuthStatus`, `Settings`, `ProviderSummary`,
`CatalogModel`, `ChatSummary`, `ChatDetail`, `HarnessUIMessage`, `MessageUsage`, `PluginSummary`,
`PluginDetail`, `PluginLogEntry`, `ToolSummary`, `McpServer`, `CommandSummary`, `ServerEvent`, ...).

```ts
// stores/auth.ts — useAuthStore
state:   { status: AuthStatus | null; loaded: boolean }
getters: requiresLogin, authenticated, passwordFromEnv,
         fresh (no password, or AuthStatus.freshUntil in the future: fresh-auth routes pass without a prompt)
actions: fetchStatus(), login(password) /* also refreshes freshUntil */, logout(), changePassword({ current, next }),
         markUnauthenticated() /* + : the $api plugin calls it on a 401 before redirecting to /login */

// stores/settings.ts — useSettingsStore
state:   { settings: Settings | null; loaded: boolean; saving: boolean }
getters: resolved (Settings with defaults applied)
actions: fetch(), update(patch: Partial<Settings>)   // optimistic, rolls back on error; appearance keys → ui.applyAppearance

// stores/providers.ts — useProvidersStore
state:   { items: ProviderSummary[]; loaded: boolean; testing: Record<string, boolean> }
getters: byId(id), connected, hasUsableProvider
actions: fetchAll(), setEnabled(id, enabled), update(id, patch), saveCredentials(id, values),
         clearCredentials(id), test(id, draft?), applyEvent(event)

// stores/models.ts — useModelsStore
state:   { items: CatalogModel[]; loaded: boolean; refreshing: Record<string, boolean>; recentRefs: string[] }
getters: byRef(ref), visible, favorites, recent, groupedByProvider, defaultRef
actions: fetchAll(), refresh(providerId), setPref(ref, { favorite?, hidden?, alias? }), addCustom(input),
         removeCustom(providerId, modelId), touchRecent(ref), applyEvent(event)
// recentRefs persist in localStorage['hf-recent-models'] (max 5)
// Phase 6 (W6.9, implementation only): groupedByProvider lists chat models only (the picker adds the "Image models"
// group from visible models of kind 'image'; SettingsModelSelect builds its own lists per kind); defaultRef returns
// the defaultModelRef setting unless it names a known model that is not a chat model, else the most recent visible
// chat model, else the first visible chat model (never an image model). favorites and recent keep every kind; the
// picker shows only their chat and image models.

// stores/chats.ts — useChatsStore
state:   { items: ChatSummary[]; cursor: string | null; hasMore: boolean; loading: boolean
           loaded: boolean /* + : the first page arrived */
           runState: Record<string, 'running' | 'approval'>; unread: Record<string, true> }
getters: byId(id), groups (Array<{ label: string; chats: ChatSummary[] }>), statusOf(id): 'running' | 'approval' | 'unread' | null
actions: fetchPage({ reset? }) /* pages of 50 */, search(q, { limit?, signal? }) /* returns results, list untouched */,
         get(id) /* ChatDetail */, create(input), rename(id, title), update(id, patch),
         remove(id, { undoMs = 5000 }) /* → { undo(), done } */,
         exportChat(id, format: 'md' | 'json'), setRunState(id, state | null), markRead(id), applyEvent(event)
// remove(): hides the row now, calls DELETE when the undo window ends; `done` (+) settles with
// { status: 'deleted' | 'undone' | 'failed', error? } and never rejects (a failed delete restores the row).
// Pending deletes are flushed on pagehide (fetch keepalive). unread persists in localStorage['hf-unread'].
// + Phase 7 (C15 signature, W7.9 implementation, 7.20):
type ChatProjectFilter = 'all' | 'none' | (string & {})   // 'all' = every chat, 'none' = chats without a project, else a project id
state:   + projectFilter: ChatProjectFilter               // localStorage['hf-project-filter']; default 'all'
actions: + setProjectFilter(filter: ChatProjectFilter): Promise<void>  // stores it, resets the list, fetchPage({ reset: true })
// fetchPage sends projectId (an id or 'none'); upsertSummary inserts rows that match the filter and removes rows that
// no longer do; summaryOf copies projectId; update(id, { projectId }) patches the row optimistically (a move);
// applyEvent(project.changed with project null) sets projectId to null on loaded rows and resets a filter on that
// project to 'all' (toast); search ignores the filter; an id unknown once the projects loaded falls back to 'all'.

// stores/projects.ts — useProjectsStore (+ Phase 7, ADR-031; C15 signature, W7.9 implementation)
state:   { items: ProjectSummary[]; loaded: boolean; loading: boolean }
getters: byId(id: string): ProjectSummary | undefined, sorted (ProjectSummary[] by name)
actions: fetchAll(): Promise<void>
         create(input: ProjectCreate): Promise<ProjectSummary>     // POST /projects; the caller wraps it in useFreshAuth().run
         update(id: string, patch: ProjectUpdate): Promise<ProjectSummary>  // optimistic, rolls back on error
         remove(id: string): Promise<void>                         // 409 run-active is thrown (the caller shows the toast)
         browse(path?: string | null, opts?: { signal?: AbortSignal }): Promise<ProjectBrowse>
         applyEvent(event: ServerEvent): void                      // project.changed: upsert, or remove for project null

// stores/plugins.ts — usePluginsStore
state:   { items: PluginSummary[]; details: Record<string, PluginDetail>; logs: Record<string, PluginLogEntry[]>
           tools: ToolSummary[]; mcp: McpServer[]; commands: CommandSummary[]; loaded: boolean
           toolsLoaded: boolean; mcpLoaded: boolean; commandsLoaded: boolean /* + : that list was fetched */ }
getters: byId(id), counts ({ all, providers, tools, mcp, commands, disabled }), filtered(filter, q), hasTools
// filter = the /plugins?filter= value: 'all' | 'providers' | 'tools' | 'mcp' | 'commands' | 'disabled'
actions: fetchAll(), fetchOne(id), enable(id), disable(id), reload(id), uninstall(id, { keepData }),
         trust(id, sha256?) /* default: the detail's trust.hash */, fetchSettings(id), saveSettings(id, values),
         fetchLogs(id), fetchTools(), setToolPref(name, patch), fetchMcp(),
         saveMcp(input: McpServerInput | { id, patch }) /* create or update */, removeMcp(id), reconnectMcp(id),
         fetchCommands(), applyEvent(event),
         refreshLoaded() /* + : refetches every loaded list, detail and log after an event-stream reconnect */
// One-shot calls stay in components via useApi(): inspect/install, drafts test/create/manifest, scaffold,
// files read/write, build, export.

// stores/ui.ts — useUiStore
state:   { paletteOpen: boolean; shortcutsOpen: boolean; installDialogOpen: boolean
           installSource: 'zip' | 'npm' | 'url' | 'folder'; showThinkingOverride: boolean | null
           composerFocusRequest: number; activeChatId: string | null
           shareChatId: string | null /* + Phase 5 (C9): the chat whose Share dialog is open, 7.14 */ }
getters: showThinking (showThinkingOverride ?? settings.resolved.showThinking)
actions: openPalette(), closePalette(), togglePalette(), openShortcuts(), openInstall(source?),
         toggleShowThinking(), requestComposerFocus(), setActiveChat(id | null),
         applyAppearance({ density, textSize, readingFont }),
         openShare(chatId) /* + sets shareChatId */, closeShare() /* + sets it back to null */
```

Phase 7 adds the projects store and the two chats store members above (frozen from Gate P7-0b); the settings store
carries `projectMaxSteps` through `Settings`. The chats store keeps its signature in Phase 5 (W5.2 changes only the
implementation); the Data page uses
`chats.fetchPage({ reset: true })` and `settings.fetch()` after an import or a delete-all (9.8). Phase 6 changes no
store signature: the settings store carries the six new keys through `Settings` (`imageModelRef`,
`transcriptionModelRef`, `transcriptionLanguage`, `speechModelRef`, `speechVoice`, `speechSpeed`), and the chats store
(W6.7, implementation only) drops `activeLeafId` from `chat.updated` data before it patches a summary row.

Server events (`plugins/events.client.ts` + `composables/useServerEvents.ts`, C5): one
`EventSource('/api/events')` while the user has access (auth loaded, no login required), with backoff reconnect;
`chat.*` and `run.*` → `chats.applyEvent`; `provider.changed` → `providers.applyEvent` + `models.applyEvent`;
`catalog.changed` → `models.applyEvent`; `plugin.changed` → `plugins.applyEvent` + `providers.applyEvent` +
`models.applyEvent`; `plugin.log` → `plugins.applyEvent`. The stores patch rows from event payloads and refetch
only lists they already loaded (bursts coalesced into one request, `utils/coalesce.ts`): models on
`catalog.changed` / `provider.changed` / `plugin.changed`; providers, tools, MCP servers, commands and that
plugin's opened detail on `plugin.changed`. `chat.deleted` of the open chat navigates to `/`. On reconnect
(missed events are not replayed) `refetchLoadedStores()` refetches the auth status, settings,
`plugins.refreshLoaded()` and the loaded providers / models / first chat page. `run.finished` for a chat that is
not `ui.activeChatId` marks it unread; `awaitingApproval: true` sets its run state to `approval`. Components
subscribe to single events with `useServerEvents().on(type | '*', handler)` (runs after the stores applied the
event; unsubscribes with the scope). Phase 7 (W7.10): `project.changed` → `projects.applyEvent` + `chats.applyEvent`;
`key.rotated` → the chats store reloads its first page, an open session whose chat is in `chatIds` refreshes (its
pending approvals were denied), and the toast "The encryption key was rotated." shows; the server closes every event
stream right after `key.rotated`, so the client reconnects with backoff (the rotating tab holds a new cookie; other
browsers are signed out and land on `/login`); `refetchLoadedStores()` also calls `projects.fetchAll()` when the
projects store is loaded.

### 11.1 `useChatSession(id)` (W2.2)

```ts
interface ChatSession {
  id: string
  chat: UseChatHelpers<HarnessUIMessage>  // messages, status, error, sendMessage, regenerate, stop,
                                          // addToolApprovalResponse, resumeStream — verify in @ai-sdk/vue types
  modelRef: WritableComputedRef<string | null>        // composer state sent with every request; writing records
  reasoningEffort: WritableComputedRef<ReasoningEffort> // the choice (and saves it on the chat)
  toolMode: WritableComputedRef<ToolMode>
  loaded: Ref<boolean>                    // history arrived (always true for a new chat)
  notFound: Ref<boolean>                  // GET /api/chats/:id answered 404
  loadError: Ref<HarnessError | null>     // + any other load failure
  summary: Ref<ChatSummary | null>        // + the chat as the server last described it; null for a new chat
  persisted: Ref<boolean>                 // + the server knows the chat (loaded, or a request reached the model)
  runState: ComputedRef<'idle' | 'submitted' | 'streaming' | 'approval' | 'error'>
  busy: ComputedRef<boolean>              // + a request is in flight (submitted or streaming)
  branches: Ref<Record<string, MessageBranch>>  // + Phase 5: ChatDetail.branches of the shown path (7.5)
  switching: Ref<boolean>                 // + Phase 5: a switchBranch() request is in flight (Phase 6: or a
                                          // deleteVersion())
  send(input: { text: string; files: FileRef[] }): Promise<void>  // a new user message; parentId = the visible path
  edit(messageId: string, text: string, files?: readonly FileUIPart[]): Promise<void>
                                          // Phase 5: a new version of that user message; Phase 6 (S8): files omitted =
                                          // keep the edited message's files (the ↑ flow), [] = remove them all
  deleteVersion(messageId: string): Promise<void>  // + Phase 6 (S7): DELETE /api/chats/:id/messages/:messageId, then
                                          // the returned path (like switchBranch)
  followActiveLeaf(): Promise<void>       // + Phase 6 (S5): GET /api/chats/:id + applyDetail({ keepPrefix: true }) after
                                          // another tab moved the leaf (coalesced)
  regenerate(messageId?: string): Promise<void>   // a new version of that reply (default: the last message), or a
                                          // first reply to a user message; re-sends an unstored failed message
  approve(r: ToolApprovalDecision): Promise<void>   // below; Phase 7 adds acceptEdits
  stop(): Promise<void>                   // POST /api/chat/:id/stop, then the client abort (an abort alone only disconnects)
  load(): Promise<void>                   // + GET /api/chats/:id, then resumeIfRunning()
  refresh(): Promise<void>                // + reloads the history unless a request is in flight
  resumeIfRunning(): Promise<void>        // + chat.resumeStream() when the server or the chats store reports a run
  switchBranch(messageId: string): Promise<void>  // + Phase 5: POST /api/chats/:id/branch, then the returned path
  refreshBranches(): Promise<void>        // + Phase 5: GET /api/chats/:id after the session's own edit / regenerate
  takeBackUnstored(): HarnessUIMessage | null  // + Phase 5: removes the unstored failed user message (and anything
                                          // after it) from the transcript and returns it; null when there is none
  projectId: ComputedRef<string | null>   // + Phase 7: a new chat: the picker's choice, else the filter's project
                                          // (when it names a known project); a saved chat: chats.byId(id)?.projectId
                                          // ?? summary.projectId
  setProject(projectId: string | null): Promise<void>  // + Phase 7: a new chat: local only (sent with the first
                                          // request); a persisted chat: PATCH /api/chats/:id { projectId } (throws
                                          // HarnessError on 409 run-active / 404; useMoveChat shows the toasts)
}
interface ToolApprovalDecision {          // the argument of approve()
  id: string; approved: boolean; toolName: string; alwaysAllow: boolean
  acceptEdits?: boolean                   // + Phase 7: "Accept all edits in this chat": toolMode = 'edits' is set
                                          // (and saved on the chat) before the approval is sent
}
function useChatSession(id: string, opts?: { isNew?: boolean }): ChatSession
function useChatSessionRegistry(): { get(id: string): ChatSession | undefined; ids: Readonly<Ref<readonly string[]>> }
// + Phase 6 (S5), pure and exported: true when the last stored message shown is not `leaf` (a trailing unstored
//   message, `unstoredId`, is ignored)
function leafMovedElsewhere(messages: readonly HarnessUIMessage[], leaf: string | null, unstoredId: string | null): boolean
// + forgetChatSession(id) (a deleted chat: stops its stream, drops the session),
//   useDraftChatId() / releaseDraftChatId(id) (the `/` page's chat id, kept until the first send)
```

`+` = added after the Phase 0 freeze (additive).

- Sessions live in a registry inside a detached `effectScope(true)`, so route changes never stop a stream.
  `useChatSession()` loads the history unless `isNew` (otherwise it calls `resumeIfRunning()`); called from a
  component setup, it holds the session until that component unmounts.
- `useChat({ id, messages, generateId: createMessageId, transport: new DefaultChatTransport({ api: '/api/chat',
  prepareSendMessagesRequest }), sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses })`
  (API.md 6.1); the body sends only the last message plus `{ chatId, trigger, parentId?, messageId?, modelRef,
  reasoningEffort, toolMode, imageOptions?, projectId? }` (Phase 6: `imageOptions = useImageOptions().forModel(model)`,
  sent only for image models and chat models with image output; Phase 7: `projectId` = the session's `projectId`, sent
  only while the chat is not persisted and the request is a new user message: the server honors it only when the
  request creates the chat). User message ids are generated here (`createMessageId`,
  ADR-019); assistant ids always come from the server.
- `@ai-sdk/vue` 4 has no `resume` option: on mount, when the chat has an active run (`ChatSummary.running`, or the
  chats store saw `run.started`), the session calls `chat.resumeStream()` (`GET /api/chat/:id/stream`, 204 when
  idle).
- Keeps the 8 most recently used sessions; never evicts one that is `submitted`, `streaming` or `approval`, or
  held by a mounted component. `useChat` also gets `messageMetadataSchema` and `dataPartSchemas:
  harnessDataSchemas` from `@harness-forge/shared`.
- Pushes run state into `chats.setRunState()` so sidebar dots read one source.

Branching (Phase 5, W5.2, ADR-023):

- **Request body.** A user submit sends `parentId: messages.at(-2)?.id ?? null` (the message before it on the visible
  path; `null` for a first message); `regenerate-message` sends `messageId` (the reply to regenerate, or a user
  message to answer); an approval continuation sends neither. A user submit never carries `messageId` (the server
  answers 400: in-place edits were removed).
- **`edit(messageId, text, files?)`** sets `chat.messages.value` to the messages before the edited one, then calls
  `chat.sendMessage({ text, files })` with `files` when given (Phase 6: the editor's full new set; `[]` removes every
  attachment) or else the edited message's files: the SDK generates the new id, and the request's `parentId` is the
  edited message's parent. The old version stays on the server.
- **Failed unstored messages.** A user message whose request failed with an HTTP error before the stream started
  (`APICallError` with a `statusCode`; except 409 `exists`, whose message id is already stored) was never stored.
  The session remembers it: the next `send()` first removes it from `chat.messages`, so `parentId` never names an
  unstored message, and `regenerate()` (the Retry of 7.4) re-sends exactly that message as a new submit instead of
  calling `chat.regenerate({ messageId })`. `takeBackUnstored()` removes it (and anything after it) and returns it:
  `ChatView` calls it on a 409 `run-active` or a 404 answer and puts its text back into the composer (7.4). A
  `404 not_found` answer to any request of the session (an unknown `parentId` or `messageId`: the local path is
  stale) makes the session call `refresh()` once the request ended, then clear the error; `ChatView` shows the toast
  "This chat changed elsewhere and was reloaded."
- **`switchBranch(messageId)`** does nothing while `busy`, `switching` or resuming, or before the chat is persisted;
  otherwise it calls `api.chats.switchBranch({ params: { id }, body: { messageId } })` directly (the chats store is
  not involved), then replaces `chat.messages` with the returned path, **keeping the existing message objects of the
  shared id prefix** (so `v-memo` skips them), and replaces `branches`. 409 `run-active` → it marks the chat running,
  reloads the path with `refresh()` and calls `resumeIfRunning()` (the run may belong to another version); 404 →
  `refresh()`. Either way it rethrows, and `ChatView` shows the 7.4 toast. `send()`, `edit()` and `regenerate()` wait
  for a pending switch first, so a request starts from the path the switch shows.
- **`refreshBranches()`**: the session still skips the reload after its own runs, except after an edit or a
  regenerate (`run.finished`): then it fetches `GET /api/chats/:id`; unchanged path ids replace only `branches`,
  otherwise the whole path is applied (keeping the shared-prefix objects). `load()` and `refresh()` set `branches`
  from `ChatDetail.branches`.
- **`v-memo`** of a transcript row adds `branches[message.id]` and `branches[message.id] !== undefined && (busy ||
  switching)`, so only messages with versions re-render when a request starts or ends.
- **`deleteVersion(messageId)`** (Phase 6, S7) behaves like `switchBranch`: nothing while busy, switching or resuming;
  it sets `switching`, calls `api.chats.deleteMessage({ params: { id, messageId } })` and applies the returned detail
  with `keepPrefix`; 409 `run-active` → the chat is marked running, the path reloads and the run is followed; 404 →
  `refresh()`; it rethrows, and `ChatView` shows the toast (7.5).
- **Other tabs** (Phase 6, S5). `chat.updated` carries `activeLeafId` (ADR-030). The session strips it before it sets
  `summary`, and when it is idle (loaded, persisted, not busy, no switch pending or in flight, not resuming) and
  `leafMovedElsewhere(messages, leaf, unstoredId)` is true, it calls `followActiveLeaf()` (coalesced: one GET for a
  burst of events, plus one more reload when another leaf is announced while it runs; a reload whose result is older
  than a local change is dropped, and a failed GET keeps the transcript). Its own switches, edits and regenerations
  never trigger it. The stored leaf can be null or name a deleted message while the server shows its newest path: after
  one reload that cannot reach the announced leaf, events that repeat it (a rename, a pin) are ignored until a
  different leaf is announced, so there is no reload loop. Known limit: deleting an off-path version does not move the
  leaf (7.5).

### 11.2 `useShortcuts()` (C5)

```ts
interface ShortcutDef {
  id: string                    // 'new-chat'
  keys: string                  // 'mod+shift+o'; tokens mod ctrl alt shift meta + key; 'code:KeyM' matches event.code
  description: string           // shown in ShortcutsDialog
  group: 'General' | 'Chat' | 'Composer' | 'Editor'
  handler?: (e: KeyboardEvent) => void   // omitted = display-only (Mod+B is handled by SidebarProvider)
  when?: () => boolean          // evaluated per key press
  allowInInputs?: boolean       // default false; mod-combos usually true
  allowInEditor?: boolean       // + default false; also fire inside CodeMirror (only Mod+K and Mod+S use it)
  alt?: boolean                 // Alt shortcut (default: the keys contain alt): inactive when altShortcuts === false
}
function useShortcuts(): {      // one app-wide registry (createShortcutRegistry)
  register(defs: ShortcutDef | ShortcutDef[]): () => void   // unregisters automatically on scope dispose
  list(): ShortcutDef[]                                     // one per id (the latest), grouped General, Chat, Composer, Editor
  format(keys: string): string[]                            // ['⌘', '⇧', 'O'] or ['Ctrl', 'Shift', 'O']
  isMac: boolean
  handleKeydown(e: KeyboardEvent): void                     // + the window listener (plugins/shortcuts.client.ts)
  setAltEnabled(fn: () => boolean): void                    // + connects the altShortcuts setting
}
```

One `keydown` listener on `window` (installed by `plugins/shortcuts.client.ts`, C5). `mod` = Meta on macOS,
Ctrl elsewhere. Later registrations win for the same keys. A matching shortcut calls `preventDefault()` (also on
auto-repeat, where the handler does not run again). Ignored while an IME composition is active.
Other composables: `useApi()` / `useApiFetch()` (C5), `useServerEvents()` (C5, 11), `useChatSession()` (W2.2,
11.1), `useGlobalShortcuts()` (W2.4), `useComposerAttachments()`, `useComposerDraft(chatId)`,
`useComposerModel(modelRef)`, `useComposerShortcuts()` and `useComposerDropZone()` (W2.3); Phase 6: `useImageOptions()`,
`useVoiceInput()`, `useSpeechPlayer()` and `useFreshAuth()` (11.3); Phase 7: `useMoveChat()` and the pure workspace
modules (11.4).

### 11.3 Phase 6 composables

`useImageOptions`, `useVoiceInput` and `useSpeechPlayer` were created by C12 in P6-0b as stubs with exactly these
signatures (frozen since Gate P6-0b) and implemented behind them in P6-A; `useFreshAuth` is W6.11's.

```ts
// composables/useImageOptions.ts (W6.9) — the image options of the composer, remembered per browser; one shared state
// for the whole app (created on first use)
function useImageOptions(): {
  options: Readonly<Ref<ImageOptions>>    // localStorage['hf-image-options'] (every chat); default {} (= 1 image, Auto,
                                          // edit the previous image); a missing, unreadable or invalid stored value
                                          // gives {} (and is removed); blocked storage keeps the options in memory
  set(patch: Partial<ImageOptions>): void // merged (an undefined value clears that option), validated with
                                          // imageOptionsSchema, persisted; an invalid result changes nothing. The
                                          // composer passes undefined for the defaults (1 image, Auto, edit on), so
                                          // they are stored as absent keys
  forModel(model: CatalogModel | null | undefined): ImageOptions | undefined
                                          // what the next chat request sends: an image model → { n?, aspectRatio?,
                                          // editPrevious? }; a chat model with capabilities.imageOutput → { aspectRatio }
                                          // when one is chosen, else undefined; any other model → undefined
}
// Also exported: imageOptionsScope(model) ('image' | 'image-output' | null: which options a model takes),
// imageOptionsForModel(options, model) (the pure forModel rule), readStoredImageOptions(), IMAGE_OPTIONS_KEY.

// composables/useVoiceInput.ts (W6.9) — dictation state machine (7.17)
type VoiceInputState = 'idle' | 'requesting' | 'recording' | 'transcribing'
interface VoiceInputEnv {                 // injected by tests (utils/testing/fake-media.ts); default: the browser
  isSecureContext: boolean
  mediaDevices?: Pick<MediaDevices, 'getUserMedia'>
  MediaRecorder?: typeof MediaRecorder
  transcribe(audio: Blob, signal: AbortSignal): Promise<AudioTranscription>   // default: POST /api/audio/transcriptions
}
function useVoiceInput(opts: {
  onTranscript: (text: string) => void    // the transcript, trimmed; '' = no speech detected (the composer shows the
                                          // toast)
  onError?: (error: unknown) => void      // permission denied, no microphone, busy microphone, 413, provider errors, a
                                          // recorder error; a start in an insecure or unsupported browser reports a
                                          // DOMException (SecurityError / NotSupportedError)
  maxDurationMs?: number                  // default LIMITS.transcriptionMaxSeconds × 1000 (10 min): auto-stop
  env?: Partial<VoiceInputEnv>            // a key given as undefined means "not available"
}): {
  state: Readonly<Ref<VoiceInputState>>
  supported: boolean                      // the browser can record: MediaRecorder exists, and in a secure context
                                          // getUserMedia too (browsers leave navigator.mediaDevices out of insecure
                                          // contexts, so there MediaRecorder alone counts and the mic shows the
                                          // insecure state instead of disappearing); false: no mic button
  secure: boolean                         // a secure context (false: the mic is disabled)
  elapsedMs: Readonly<Ref<number>>        // recording time (stops while transcribing)
  level: Readonly<Ref<number>>            // 0–1 input level while recording (Web Audio analyser; 0 without Web Audio)
  start(): Promise<void>
  stop(): Promise<void>                   // ends the recording and transcribes it (< 0.5 s is discarded); while
                                          // requesting it cancels
  cancel(): void                          // drops the recording or aborts the transcription (a late transcript is
                                          // ignored)
  toggle(): Promise<void>                 // idle → start, recording → stop, transcribing → cancel; nothing while
                                          // requesting
}
// The microphone tracks are always stopped in a finally; a scope dispose cancels. The default transcribe is
// `$api.audio.transcribe({ form, signal })` with the clip as a File named dictation.<ext> in the part `file` and no
// model or language field (the server uses Settings → Media). useVoiceInput calls useApi() when it is created
// (unless env.transcribe is given), so unit tests that import it mock `~/composables/useApi`. Also exported:
// browserVoiceInputEnv(), isVoiceInputSupported(env), sampleLevel(samples).

// composables/useSpeechPlayer.ts (W6.8) — one app-wide read-aloud player (module singleton, 7.18)
type SpeechPlayerState = 'idle' | 'loading' | 'playing'
function useSpeechPlayer(): {
  state: Readonly<Ref<SpeechPlayerState>>
  activeId: Readonly<Ref<string | null>>  // the message being read ('voice-test' for Settings → Media)
  play(id: string, markdown: string, opts?: { modelRef?: string; voice?: string }): Promise<void>
                                          // stops whatever plays, then reads `markdown` in chunks (speech-text.ts);
                                          // call it inside the click (the audio element is unlocked synchronously);
                                          // resolves when this reading ends and never rejects (failures are toasts)
  stop(): void
  toggle(id: string, markdown: string, opts?: { modelRef?: string; voice?: string }): Promise<void>
                                          // stop when `id` is active, else play
}
// Also exported: VOICE_TEST_ID ('voice-test'; failures read "Could not play the test voice"),
// READ_ALOUD_STOP_SHORTCUT ('read-aloud-stop', 12) and the test helper resetSpeechPlayer().

// composables/useFreshAuth.ts (W6.11) — every fresh-auth prompt (8.4)
export class FreshAuthCancelledError extends Error {}
export function isFreshAuthCancelled(e: unknown): e is FreshAuthCancelledError
export function isFreshAuthRequired(e: unknown): boolean          // 403 forbidden + action 'login'
export function loginErrorText(e: unknown, now?: number): string  // 401 'Wrong password', 429 a countdown, else the
                                                                  // server message
export interface FreshAuth {
  open: Readonly<Ref<boolean>>            // bind to ConfirmPasswordDialog
  pending: Readonly<Ref<boolean>>
  error: Readonly<Ref<string | null>>     // a rate limit counts down and clears itself when the wait is over
  needed: ComputedRef<boolean>            // a password is set (auth.status.enabled) && !auth.fresh
  submit: (password: string) => Promise<void>   // ConfirmPasswordDialog @submit
  setOpen: (value: boolean) => void       // ConfirmPasswordDialog @update:open (closing cancels; ignored while the
                                          // login runs)
  run: <T>(task: () => Promise<T>, opts?: { required?: boolean }) => Promise<T>
  login: (password: string) => Promise<string | null>   // inline password fields; null = ok, else the error text
  confirm: () => Promise<void>            // opens the prompt now or joins the open one (the "Log in" action of an
                                          // error alert); rejects with FreshAuthCancelledError when it is closed
  cancel: () => void                      // rejects every waiting task with FreshAuthCancelledError
}
export function useFreshAuth(): FreshAuth
```

### 11.4 Phase 7 modules

C15 creates these modules in P7-0b with exactly these exports and inert bodies (`workspaceToolView` returns `null`, so
`ToolPart` keeps its generic blocks until W7.11 lands); W7.9 owns `move-chat.ts`, W7.11 the other three.

```ts
// components/projects/move-chat.ts (W7.9) — the one move action behind every "Move to project" menu (7.20)
function useMoveChat(): (chatId: string, projectId: string | null) => Promise<void>
// chats.update(chatId, { projectId }) (optimistic; the row leaves a list it no longer matches), then the toast
// "Moved to {name}" / "Moved out of {name}" with Undo (moves back); 409 run-active → rolled back + "Wait for the
// response to finish before moving this chat."; 404 → rolled back + "This project no longer exists."; never rejects.

// components/chat/parts/tools/workspace-tools.ts (W7.11) — pure and store-free (the share page uses it too), 7.19
// DiffHunk ({ oldStart, oldLines, newStart, newLines, lines }, lines prefixed ' ' / '+' / '-') and ShellOutput (the
// stored shell output) come from @harness-forge/shared (the workspace tool schemas).
type FileListItem = { path: string; type?: WorkspaceEntryType; line?: number; text?: string }
                                        // type: list_directory entries (file | dir | symlink | other);
                                        // line + text: a search_files match
type WorkspaceToolView =
  | { kind: 'diff', path: string, created: boolean, additions: number, deletions: number, hunks: DiffHunk[], truncated: boolean }
  | { kind: 'terminal', command: string, output: ShellOutput | null }
  | { kind: 'file', path: string, content: string, startLine: number, endLine: number, totalLines: number | null, truncated: boolean }
  | { kind: 'list', items: FileListItem[], noun: 'entries' | 'files' | 'matches', truncated: boolean }
function workspaceToolView(toolName: string, input: unknown, output: unknown): WorkspaceToolView | null
function workspaceApprovalView(toolName: string, input: unknown): WorkspaceToolView | null   // previews (7.3)
function workspaceRowArgument(toolName: string, input: unknown): string | null
function workspaceRowSummary(toolName: string, output: unknown):
  { text: string; tone: 'muted' | 'success' | 'destructive' | 'warning' } | null
function workspaceToolIcon(toolName: string): Component | null
// Every function returns null for a name outside WORKSPACE_TOOL_NAMES or a value that fails the shared schema.

// utils/line-diff.ts (W7.11) — client diffs for approval previews only (no dependency)
function diffLines(a: string, b: string, opts?: { context?: number; maxCells?: number }): DiffHunk[]
// context default 3, maxCells default 4e6 (the LCS table); past the cap one hunk: every old line removed, then every
// new line added; CRLF is compared as LF; a missing trailing newline is not a change of its own.

// utils/ansi.ts (W7.11)
function stripAnsi(text: string): string   // removes CSI / OSC escape sequences (the server strips them too)
```

---

## 12. Keyboard shortcuts

`Mod` = ⌘ on macOS, Ctrl elsewhere. Registered through `useShortcuts()`; listed in `ShortcutsDialog` (Mod+/).

| Keys | Action | Scope | Registered by |
|---|---|---|---|
| Mod+K | toggle the command palette (search chats and commands) | global, also in inputs and CodeMirror | W2.4 `useGlobalShortcuts` |
| Mod+Shift+O | new chat (go to `/`, focus composer) | global, also in inputs | W2.4 |
| Mod+B | toggle sidebar (the key matches case-insensitively, so Caps Lock works, and non-Latin layouts use the physical B key; Mod+Shift+B stays the browser's bookmarks-bar shortcut; Alt combos, IME composition and events another handler already took are ignored) | global | handled by shadcn `SidebarProvider` (local patch, `apps/web/AI_ELEMENTS_PATCHES.md`); W2.4 registers a display-only entry |
| Mod+/ | toggle the keyboard shortcuts dialog | global, also in inputs | W2.4 |
| Shift+Esc | focus the composer | chat pages, no overlay open | W2.4 (→ `ui.requestComposerFocus()`) |
| Alt+M | open model picker | chat pages, also in inputs | W2.3 (`alt+code:KeyM`, `alt: true`) |
| Alt+R | open effort menu (reasoning models) | chat pages, also in inputs | W2.3 (`alt+code:KeyR`, `alt: true`) |
| Alt+P | open permission menu (when tools exist; Phase 7: with Accept edits in project chats) | chat pages, also in inputs | W2.3 (`alt+code:KeyP`, `alt: true`) |
| Alt+V | what a click on the mic does (7.17): start dictation; while recording: stop and transcribe; while transcribing: cancel; without a speech-to-text model: the setup popover | chat pages with the composer, also in inputs; not while focus is in a dialog, menu or listbox; only where the browser can record in a secure context; with a disabled composer only while dictation runs | W6.9 (id `composer-dictate`, `alt+code:KeyV`, `alt: true`; calls `MicButton.activate()`; Phase 6) |
| Enter | send (`sendKey = enter`) | composer | W2.3 |
| Mod+Enter | send (`sendKey = mod-enter`) | composer | W2.3 |
| Shift+Enter | new line | composer | W2.3 |
| Esc | close the open menu/dialog; else cancel a recording or transcription (Phase 6); else stop the running response | composer / chat | W2.3; W6.9 (dictation: the textarea's keydown handles Esc inside the composer; outside inputs the registry entry `composer-dictation-cancel`, registered after `composer-stop` so it wins while dictation runs) |
| Esc (outside inputs and overlays) | stop reading aloud (Phase 6, 7.18), before stopping a running response | chat pages | W6.8 (registry entry `read-aloud-stop`, group Chat; registered only while something is read and removed when the reading ends) |
| ↑ (empty composer) | edit the last user message | composer | W2.3 |
| ← / → | previous / next version of a message | focus inside a `BranchSwitcher` | W5.2 (component keydown, not the registry) |
| Mod+S | save the active file | code editor | W3.4 |
| ↑ / ↓ / Enter / Tab | navigate and pick in palette, slash menu, model picker | overlays | components |

Rules:
- **Browser-reserved combos are never used**: Mod+N, Mod+Shift+N, Mod+T, Mod+Shift+T, Mod+W, Mod+Shift+W,
  Mod+Tab, Mod+L, Mod+R, Mod+D, Mod+P, Mod+Q. New chat is therefore Mod+Shift+O (as on claude.ai); the page calls
  `preventDefault()` so Chrome's Ctrl+Shift+O (bookmarks manager) and Firefox's Ctrl+K / Ctrl+B do not fire.
- Alt shortcuts match `event.code` (Option+M types `µ` on macOS), are ignored when Ctrl or Meta is also pressed,
  and can be turned off in Settings → General (`altShortcuts`, which covers Alt+V too). Alt+V calls
  `preventDefault()` like every matched shortcut, which should keep Firefox on Windows from opening its View menu
  (unverified). Phase 6 kept Alt+V; the Alt+J fallback of the plan was not needed.
- Esc priority: close an open overlay → cancel a recording or transcription (composer) → cancel an inline edit → stop
  reading aloud (outside inputs) → stop streaming. The registry tries the latest registration first and skips an entry
  whose `when` is false: `composer-dictation-cancel` only takes Esc while dictation runs, and `read-aloud-stop` exists
  only while something is read.
- Shortcuts never fire while an IME composition is active or inside CodeMirror (except Mod+S and Mod+K).
- Phase 7 adds no shortcut (every free combo clashes with a browser shortcut): projects are reached through the
  switcher (Tab and Enter), the command palette's Projects section (7.20) and Alt+P for the permission mode.
- `KbdCombo` renders hints: `⌘⇧O` / `⌘K` on macOS, `Ctrl Shift O` / `Ctrl K` elsewhere. Hints are hidden below `lg`
  and on touch devices.

---

## 13. `data-testid` contract

Constants live in `apps/web/app/utils/testids.ts` (C5), auto-imported:

```ts
export const testIds = {
  sidebar: 'sidebar',
  modeTabChat: 'mode-tab-chat',
  // … one entry per id below; key = camelCase of the id
} as const
export type TestIdKey = keyof typeof testIds
export type TestId = (typeof testIds)[TestIdKey]
```

Usage: `<Button :data-testid="testIds.newChat">`. Ids are kebab-case and static; the identity of repeated
elements goes into data attributes (`data-chat-id`, `data-message-id`, `data-model-ref`, `data-provider-id`,
`data-plugin-id`, `data-tool-name`, `data-server-id`, `data-state`, `data-status`, `data-value`, `data-step`,
`data-step-item`, `data-path`, `data-kind`, `data-action`, `data-code`, `data-level`, `data-dirty`, `data-hidden`;
Phase 5 adds `data-index`, `data-count`, `data-share-id`, `data-role`, `data-outdated`, `data-expired`; Phase 6 reuses
them for galleries and adds no new attribute name; Phase 7 adds `data-project-id` and `data-tone`). Playwright uses
`getByTestId()` plus attribute filters. Ids are never reused for a different element; removing one is a CCR. The Phase
5 ids are collected in 13.6, except the two Settings → Models ids added in P5-B (`model-select-option`,
`model-row-menu`, 13.4); the Phase 6 ids in 13.7; the Phase 7 ids in 13.8.

### 13.1 Shell and navigation

| Id | Element | Data attributes |
|---|---|---|
| `sidebar` | `AppSidebar` root | `data-state` (expanded / collapsed) |
| `sidebar-trigger` | every `SidebarTrigger` | |
| `mode-tab-chat` · `mode-tab-plugins` | mode tabs | `data-state` (active / inactive) |
| `new-chat` | New chat row | |
| `search-chats` | Search row | |
| `chat-list` | chat list container | |
| `chat-group` | date group | `data-value` (group label) |
| `chat-row` | chat row link | `data-chat-id`, `data-active` |
| `chat-status-dot` | status dot in a row | `data-status` (running / approval / unread) |
| `chat-row-menu` | row `⋯` trigger | |
| `chat-row-rename` · `chat-row-export-md` · `chat-row-export-json` · `chat-row-delete` | row menu items | |
| `chat-row-rename-input` | inline rename input | |
| `toast-undo` | Undo button in the delete toast | |
| `settings-link` | footer Settings | |
| `back-to-app` | settings "← Back to app" | |
| `theme-toggle` | theme group / collapsed button | |
| `theme-dark` · `theme-light` · `theme-system` | theme items (group or dropdown) | `data-state` (on / off) |
| `command-palette` · `command-palette-input` · `command-palette-item` | palette dialog, input, items | item: `data-value` |
| `shortcuts-dialog` | shortcuts dialog | |
| `page-header` | `PageHeader` root | |
| `error-page` · `error-back` | error page (`app/error.vue`) root and its "Back to chats" button | page: `data-status` (HTTP status, e.g. 404) |
| `error-retry` | "Try again" on the access-blocked error page (403 from a password-less server reached through a non-local host) | |

### 13.2 Chat

| Id | Element | Data attributes |
|---|---|---|
| `empty-greeting` | greeting heading on `/` | |
| `no-provider-callout` · `no-provider-connect` | callout and its button | |
| `chat-header` · `chat-title` · `chat-title-input` | header, title, inline rename input | |
| `chat-menu-trigger` | header `⋯` | |
| `chat-menu-rename` · `chat-menu-thinking` · `chat-menu-export-md` · `chat-menu-export-json` · `chat-menu-delete` | header menu items | thinking: `data-state` |
| `chat-not-found` | not-found empty state | |
| `transcript` | scroll container | |
| `transcript-skeleton` | loading skeleton of the transcript while the history loads | |
| `message-user` · `message-assistant` | message containers by role | `data-message-id`, `data-status` (streaming / done / aborted / error) |
| `submitted-placeholder` | "Thinking…" placeholder | |
| `message-copy` · `message-regenerate` · `message-edit` | message actions | |
| `message-edit-input` · `message-edit-save` · `message-edit-cancel` | message editor | |
| `message-meta` | model · duration meta | |
| `reasoning-row` | reasoning trigger row | `data-state` (streaming / done), `data-expanded` |
| `tool-row` | tool row | `data-tool-name`, `data-state` (part state) |
| `tool-row-output` | expanded tool body | |
| `tool-approval` | approval card | `data-tool-name` |
| `tool-approval-allow` · `tool-approval-deny` · `tool-approval-always` | approval buttons, "Always allow" checkbox | |
| `file-chip` | file chip / thumbnail | `data-state` |
| `sources-row` | sources row | |
| `chat-error` | error alert | `data-code` |
| `chat-error-action` | error action button | `data-action` |
| `scroll-to-bottom` | scroll pill | |

### 13.3 Composer

| Id | Element | Data attributes |
|---|---|---|
| `composer` | composer root | `data-status` |
| `composer-input` | textarea | |
| `composer-send` · `composer-stop` | send / stop button (same slot) | |
| `composer-add` · `composer-attach` · `composer-file-input` | `+` menu, "Attach files" item, hidden file input | |
| `composer-attachment` | attachment chip in the composer | `data-state` |
| `composer-drop-overlay` | drag-and-drop overlay | |
| `slash-menu` · `slash-menu-item` | slash menu, items | item: `data-value` (name), `data-kind` |
| `model-picker-trigger` · `model-picker` · `model-picker-search` | trigger, content, search input | trigger: `data-model-ref` |
| `model-picker-group` | group | `data-value` (favorites / recent / provider id / `images`, Phase 6) |
| `model-picker-item` · `model-picker-favorite` | item, star button | `data-model-ref` |
| `model-picker-manage` · `model-picker-connect` | footer links | |
| `effort-menu-trigger` · `effort-option` | effort trigger, options | `data-value` |
| `permission-menu-trigger` · `permission-option` | permission trigger, options | `data-value` |
| `context-ring` | context ring trigger | `data-value` (percent) |

### 13.4 Settings and login

| Id | Element | Data attributes |
|---|---|---|
| `settings-nav-providers` · `settings-nav-models` · `settings-nav-general` · `settings-nav-appearance` · `settings-nav-about` | settings nav items | `data-state` (active) |
| `insecure-banner` | HTTP warning banner | |
| `provider-row` | provider row | `data-provider-id` |
| `provider-status` | status badge | `data-status` |
| `provider-configure` · `provider-enabled` | Configure/Add key button, enabled switch | |
| `key-dialog` | provider key dialog | `data-provider-id` |
| `key-input` · `key-reveal` · `key-get-link` | credential input (`data-value` = field key), reveal toggle, "Get a key" link | |
| `key-env-badge` | "From env" badge | |
| `key-advanced` · `key-base-url` | Advanced toggle, base URL input | |
| `key-test` · `key-test-result` · `key-save` · `key-save-anyway` · `key-remove` | dialog actions and result | result: `data-status` (ok / error) |
| `models-default-picker` · `models-title-picker` | default / title model pickers (field triggers) | `data-value` (the model ref; empty for "Automatic"), `data-kind` (`chat`) |
| `model-select-option` | one option in the popover of those pickers (`SettingsModelSelect`; Phase 5, W5.13) | `data-model-ref` (empty for the "Automatic" choice) |
| `models-filter` | filter input | |
| `models-section` · `models-refresh` · `custom-model-add` | provider section, refresh, add custom | `data-provider-id` |
| `model-row` · `model-favorite` · `model-visible` · `model-remove` | table row and its controls (`model-remove` = the Remove item of the row menu, custom models only; Phase 6: `model-favorite` and `model-visible` exist only in rows of chat and image models, 9.3) | row: `data-model-ref`, `data-hidden` (`true` / `false`); favorite: `data-state` (on / off) |
| `model-row-menu` | `⋯` actions trigger of a model row (Rename, Reset name, Remove; Phase 5, W5.13) | |
| `custom-model-dialog` · `custom-model-id` · `custom-model-save` | custom model dialog (Phase 6: the Kind select has no id; its trigger carries `data-value`) | |
| `settings-display-name` · `settings-send-key` · `settings-default-mode` · `settings-default-effort` · `settings-max-steps` · `settings-alt-shortcuts` · `settings-instructions` | general fields | |
| `password-set` · `password-remove` · `password-dialog` · `password-current` · `password-new` · `password-confirm` · `password-save` · `logout` | password section (`password-set` = Set password / Change password; `password-remove` = Remove password) | remove: `data-action="remove-password"` |
| `appearance-theme-card` | theme card | `data-value` (dark / light / system) |
| `appearance-reading-font` · `appearance-text-size` · `appearance-density` · `appearance-show-thinking` | appearance controls | |
| `about-copy-diagnostics` | copy diagnostics button | |
| `login-form` · `login-password` · `login-submit` · `login-error` | login page | |

### 13.5 Plugins

| Id | Element | Data attributes |
|---|---|---|
| `plugins-new` · `plugins-new-provider` · `plugins-new-code` | "New plugin" trigger and items (sidebar and page) | |
| `plugins-install` | "Install…" (sidebar and page) | |
| `plugins-filter` | browse filter row / select | `data-value` (all / providers / tools / mcp / commands / disabled) |
| `plugins-search` | search input | |
| `plugin-nav-row` | installed row in the sidebar | `data-plugin-id` |
| `plugin-card` | plugin card | `data-plugin-id`, `data-state` |
| `plugin-card-switch` · `plugin-card-logs` · `plugin-card-review` | card controls | |
| `install-dialog` | install dialog | |
| `install-tab-zip` · `install-tab-npm` · `install-tab-url` · `install-tab-folder` | source tabs | |
| `install-zip-input` · `install-npm-input` · `install-url-input` · `install-integrity-input` · `install-folder-input` · `install-folder-mode` | source inputs | folder mode: `data-value` (link / copy) |
| `install-inspect` · `install-preview` · `install-back` | inspect button, preview panel, back | |
| `trust-warning` · `trust-checkbox` · `trust-password` | trust block | |
| `install-submit` · `install-error` | install button, inline error | |
| `install-stale` | "This plugin changed since you reviewed it" alert (install answered 409 `stale`) | |
| `trust-dialog` · `trust-confirm` | trust dialog for installed plugins | |
| `confirm-password-dialog` · `confirm-password-input` · `confirm-password-submit` | `ConfirmPasswordDialog` (fresh auth) | |
| `plugin-detail` · `plugin-state` | detail root, state badge | `data-plugin-id`, `data-state` |
| `plugin-tab-overview` · `plugin-tab-configuration` · `plugin-tab-source` · `plugin-tab-logs` | detail tabs | |
| `plugin-enabled` · `plugin-reload` · `plugin-menu` · `plugin-export` · `plugin-edit` · `plugin-uninstall` | header controls | |
| `plugin-uninstall-confirm` · `plugin-uninstall-keep-data` | uninstall dialog | |
| `plugin-tool-row` · `plugin-tool-approval` · `plugin-tool-enabled` | tools table | `data-tool-name` |
| `schema-form` · `schema-field` · `schema-form-save` · `schema-form-reset` | configuration form | field: `data-value` (key) |
| `plugin-logs` · `plugin-log-entry` · `plugin-logs-level` | logs tab | entry: `data-level` |
| `mcp-panel` · `mcp-add` | MCP panel, add button | |
| `mcp-server-row` · `mcp-status` · `mcp-enabled` · `mcp-restart` · `mcp-edit` · `mcp-delete` | server row controls | `data-server-id`, status: `data-status` |
| `mcp-dialog` · `mcp-transport-tab` · `mcp-save` | add/edit dialog | tab: `data-value` |
| `wizard` | provider wizard root | `data-step` |
| `wizard-step-basics` · `wizard-step-api` · `wizard-step-credentials` · `wizard-step-models` · `wizard-step-review` | the body of the current step panel only (stepper items have no test id) | stepper items: `data-step-item` (basics / api / credentials / models / review) |
| `wizard-name` · `wizard-id` · `wizard-icon-tab` · `wizard-icon-search` · `wizard-icon-option` | basics fields | icon: `data-value` (slug) |
| `wizard-template` · `wizard-api-format` · `wizard-base-url` | API step | `data-value` |
| `wizard-credential-row` · `wizard-auth-style` · `wizard-header-row` · `wizard-credential-value` | credentials step | |
| `wizard-fetch-models` · `wizard-add-model` · `wizard-model-row` | models step | `data-value` (model id) |
| `wizard-manifest` · `wizard-test` · `wizard-test-result` | review step | result: `data-status` |
| `wizard-back` · `wizard-next` · `wizard-create` · `wizard-discard` | footer | |
| `code-plugin-form` · `code-plugin-name` · `code-plugin-id` · `code-plugin-template` · `code-plugin-create` | code plugin creation | template: `data-value` (tool / provider / mcp-bridge / command-pack) |
| `code-plugin-language` | JavaScript / TypeScript toggle of the code plugin form | `data-value` |
| `code-file-tree` · `code-file` · `code-new-file` · `code-file-rename` · `code-file-delete` | file tree and file actions | file: `data-path` |
| `code-editor` · `code-editor-tab` · `code-editor-save` · `code-build-reload` | editor | tab: `data-path`, `data-dirty` |
| `code-build-log` · `code-readonly-banner` | build/log panel, read-only banner | |

### 13.6 Branching, sharing and data (Phase 5)

The new ids of the Phase 5 features. C9 copied this table verbatim into `utils/testids.ts` in P5-0b (the key column
is the `testIds` key, the camelCase of the id), under a `// Branching, sharing and data (Phase 5)` comment; the file
was frozen during P5-A. W5.13 added `model-select-option` and `model-row-menu` in P5-B, next to the other Settings →
Models ids (13.4). The new components also reuse existing ids: the share page renders
`reasoning-row`, `file-chip` and `sources-row` through the reused part components, the `share` layout renders
`theme-toggle`, fresh-auth prompts use `confirm-password-dialog`, and pages use `page-header`. The mobile specs need no
new id (14.6).

| Id | Key (`testIds.*`) | Element | Data attributes |
|---|---|---|---|
| `message-branch` | `messageBranch` | `BranchSwitcher` root (`role="group"`) | `data-message-id` (the shown version), `data-index` (0-based), `data-count` |
| `message-branch-previous` | `messageBranchPrevious` | "Previous version" button | `aria-disabled` at the first version |
| `message-branch-next` | `messageBranchNext` | "Next version" button | `aria-disabled` at the last version |
| `message-branch-counter` | `messageBranchCounter` | the "2/3" counter | |
| `chat-menu-share` | `chatMenuShare` | "Share…" in the chat header menu | |
| `chat-row-share` | `chatRowShare` | "Share…" in the sidebar row menu | |
| `share-dialog` | `shareDialog` | `ShareDialog` content | `data-chat-id` |
| `share-passwordless-warning` | `sharePasswordlessWarning` | "No password set" warning in the dialog | |
| `share-dialog-error` | `shareDialogError` | inline error alert of the dialog | `data-code` |
| `share-link` | `shareLink` | one link card in the dialog | `data-share-id`, `data-outdated`, `data-expired` (`true` / `false`) |
| `share-url` | `shareUrl` | read-only URL input of a card | |
| `share-copy` | `shareCopy` | "Copy link" (dialog cards and settings rows) | |
| `share-outdated` | `shareOutdated` | Outdated badge (dialog and settings) | |
| `share-expired` | `shareExpired` | Expired badge (dialog and settings) | |
| `share-option` | `shareOption` | include switch (cards and the new-link form) | `data-value` (`attachments` / `reasoning` / `tool-details`) |
| `share-expiry` | `shareExpiry` | expiry select trigger (cards and the new-link form) | |
| `share-expiry-option` | `shareExpiryOption` | expiry select item | `data-value` (`never` / `1d` / `7d` / `30d` / `90d`) |
| `share-update` | `shareUpdate` | "Update snapshot" | |
| `share-revoke` | `shareRevoke` | "Revoke…" (dialog cards and settings rows) | |
| `share-revoke-confirm` | `shareRevokeConfirm` | confirm button of the revoke `ConfirmDialog` | |
| `share-create-form` | `shareCreateForm` | the new-link form | |
| `share-create` | `shareCreate` | "Create link" | |
| `shares-section` | `sharesSection` | `SharesSettingsSection` root | |
| `shares-row` | `sharesRow` | one share in the settings list | `data-share-id`, `data-chat-id` |
| `shares-row-manage` | `sharesRowManage` | "Manage…" (opens the Share dialog) | |
| `shares-empty` | `sharesEmpty` | "No shared links." | |
| `share-page` | `sharePage` | `SharedChatView` root | `data-state` (`loading` / `ready` / `unavailable` / `error`) |
| `share-title` | `shareTitle` | share page title (`h1`) | |
| `share-meta` | `shareMeta` | "Read-only snapshot · {date}" line | |
| `share-transcript` | `shareTranscript` | message list of the share page | |
| `share-message` | `shareMessage` | one message of the share page | `data-role` (`user` / `assistant`), `data-status` (`done` / `stopped` / `failed`) |
| `share-tool-row` | `shareToolRow` | `ShareToolRow` row | `data-tool-name`, `data-status` (`done` / `error` / `denied` / `stopped`) |
| `share-tool-row-output` | `shareToolRowOutput` | expanded body of a `ShareToolRow` | |
| `share-unavailable` | `shareUnavailable` | "This link is unavailable" state | |
| `share-page-error` | `sharePageError` | error state of the share page | `data-code` |
| `share-page-retry` | `sharePageRetry` | "Try again" of the error state | |
| `settings-nav-data` | `settingsNavData` | "Data" settings nav item | `data-state` (active) |
| `data-settings` | `dataSettings` | `DataSettings` root | |
| `data-summary` | `dataSummary` | summary line | |
| `data-export-files` | `dataExportFiles` | "Include attachments" switch | |
| `data-export-settings` | `dataExportSettings` | "Include settings" switch | |
| `data-export-warning` | `dataExportWarning` | import-limit warning of the export | |
| `data-export` | `dataExport` | "Export backup" | |
| `data-import-file` | `dataImportFile` | import file input | |
| `data-import-policy` | `dataImportPolicy` | "If a chat already exists" toggle group | `data-value` (`skip` / `copy`) |
| `data-import-restore-settings` | `dataImportRestoreSettings` | "Restore settings from the backup" switch | |
| `data-import` | `dataImport` | "Import" | |
| `data-import-error` | `dataImportError` | inline import error | `data-code` |
| `data-import-result` | `dataImportResult` | import result panel | `data-kind` (`backup` / `chat`) |
| `data-import-item` | `dataImportItem` | one row of the result | `data-status` (`imported` / `copied` / `skipped` / `failed`), `data-chat-id` |
| `data-import-warning` | `dataImportWarning` | one warning line of the result | |
| `data-delete` | `dataDelete` | "Delete all data…" | |
| `data-delete-dialog` | `dataDeleteDialog` | delete-all dialog | |
| `data-delete-files` | `dataDeleteFiles` | "Also delete uploaded files" checkbox | |
| `data-delete-usage` | `dataDeleteUsage` | "Also delete usage history" checkbox | |
| `data-delete-confirm-input` | `dataDeleteConfirmInput` | "Type DELETE to confirm" input | |
| `data-delete-submit` | `dataDeleteSubmit` | "Delete everything" | |

### 13.7 Multimodal, versions and stabilization (Phase 6)

The 31 new ids of Phase 6. C12 copied this table verbatim into `utils/testids.ts` in P6-0b (the key column is the
`testIds` key, the camelCase of the id) under a `// Multimodal, versions and stabilization (Phase 6)` comment; the file
stayed frozen through P6-A, and the table matches it id for id. The new components also reuse existing ids: the
"Image models" group of the model picker is a `model-picker-group` with `data-value="images"` and its items are
`model-picker-item`s; the `generate_image` row is a `tool-row` with `data-tool-name="generate_image"`; the
delete-version dialog is a `ConfirmDialog` (its confirm button carries `message-delete-version-confirm`); Settings →
Media renders `page-header` and its selects' options carry `model-select-option`; fresh-auth prompts keep
`confirm-password-dialog`. The tablet spec needs no new id (14.7). Two Phase 6 elements have no id on purpose: the
message editor's hidden file input (`data-slot="message-edit-file-input"`; e2e tests use Playwright's file-chooser
event on `message-edit-attach`) and the custom model dialog's Kind select (tests use its trigger's `data-value`).

| Id | Key (`testIds.*`) | Element | Data attributes |
|---|---|---|---|
| `image-gallery` | `imageGallery` | `ImageGallery` root (one gallery block) | `data-message-id`, `data-count` (the tiles shown) |
| `image-tile` | `imageTile` | one image button of a gallery | `data-index` (0-based) |
| `image-lightbox` | `imageLightbox` | the gallery's lightbox dialog content | `data-index` (the image shown) |
| `image-download` | `imageDownload` | "Download" link of the lightbox (`<a download>`; only for a same-origin, `blob:` or image `data:` URL) | `data-action="download"` |
| `image-generating` | `imageGenerating` | `GeneratingImages` root (placeholder tiles) | `data-count` (1–4) |
| `image-options-trigger` | `imageOptionsTrigger` | `ImageOptionsMenu` trigger in the composer | |
| `image-aspect-option` | `imageAspectOption` | an "Aspect ratio" item | `data-value` (`auto`, `1:1`, `3:2`, `2:3`, `4:3`, `3:4`, `16:9`, `9:16`) |
| `image-count-option` | `imageCountOption` | an "Images" item | `data-value` (`1` … `4`) |
| `image-edit-previous` | `imageEditPrevious` | "Edit the previous image" checkbox | `data-state` (reka: `checked` / `unchecked`) |
| `settings-image-model` | `settingsImageModel` | "Image model" select trigger (Settings → Media) | `data-value` (model ref; empty for None) |
| `composer-mic` | `composerMic` | `MicButton` | `data-state` (`idle` / `requesting` / `recording` / `transcribing` / `setup` / `insecure`) |
| `composer-mic-cancel` | `composerMicCancel` | "Cancel" of the recording indicator | |
| `composer-recording` | `composerRecording` | `RecordingIndicator` root (`role="group"`, "Recording" / "Transcribing") | `data-state` (`recording` / `transcribing`) |
| `composer-recording-time` | `composerRecordingTime` | the recording timer ("0:07") | |
| `composer-mic-setup` | `composerMicSetup` | the "Choose a speech-to-text model" popover | |
| `composer-mic-setup-link` | `composerMicSetupLink` | its "Open settings" link (a button-styled `NuxtLink` to `/settings/media`) | |
| `message-read-aloud` | `messageReadAloud` | `ReadAloudButton` | `data-state` (`idle` / `loading` / `playing`) |
| `message-delete-version` | `messageDeleteVersion` | "Delete this version" in a message's action row | |
| `message-delete-version-confirm` | `messageDeleteVersionConfirm` | confirm button of the delete-version `ConfirmDialog` | |
| `message-edit-attach` | `messageEditAttach` | paperclip "Attach files" button of `MessageEditor` | |
| `message-edit-attachment` | `messageEditAttachment` | one attachment chip in `MessageEditor` (kept attachments first, then new uploads) | `data-state` (`uploading` / `error` / `done`; kept attachments are `done`) |
| `settings-nav-media` | `settingsNavMedia` | "Media" settings nav item | `data-state` (active) |
| `media-settings` | `mediaSettings` | `MediaSettings` root | |
| `image-settings` | `imageSettings` | `ImageSettings` root (the Images section) | |
| `voice-settings` | `voiceSettings` | `VoiceSettings` root (the Voice section) | |
| `settings-transcription-model` | `settingsTranscriptionModel` | "Speech to text" select trigger | `data-value` (model ref; empty for Off) |
| `settings-transcription-language` | `settingsTranscriptionLanguage` | "Language" select trigger | `data-value` (`auto` or the ISO 639 code) |
| `settings-speech-model` | `settingsSpeechModel` | "Read aloud" select trigger | `data-value` (model ref; empty for Off) |
| `settings-speech-voice` | `settingsSpeechVoice` | "Voice" input | |
| `settings-speech-speed` | `settingsSpeechSpeed` | "Speed" select trigger | `data-value` (`0.75` … `2`) |
| `settings-speech-test` | `settingsSpeechTest` | "Test voice" button | `data-state` (`idle` / `loading` / `playing`) |

### 13.8 Projects, workspace tools and data maintenance (Phase 7)

The 60 new ids of Phase 7. C15 copies this table verbatim into `utils/testids.ts` in P7-0b (the key column is the
`testIds` key, the camelCase of the id) under a `// Projects, workspace tools and data maintenance (Phase 7)` comment;
the file stays frozen through P7-A. The new components also reuse existing ids: the permission option "Accept edits" is
a `permission-option` with `data-value="edits"`; workspace tool rows are `tool-row`s (`data-tool-name` = the tool),
their approval cards `tool-approval` with `tool-approval-allow` / `tool-approval-deny` (the shell card has no
`tool-approval-always`); the Add project and Rotate key prompts use `confirm-password-dialog`; the delete and cleanup
confirmations are `ConfirmDialog`s whose confirm buttons carry `project-delete-confirm` / `data-cleanup-confirm`; the
share page keeps `share-tool-row`; Settings → Projects renders `page-header`; the palette's Projects entries are
`command-palette-item`s. `project-add` marks every "Add project" control (the switcher item, the Settings → Projects
header button and its empty state), as `share-copy` marks every "Copy link".

| Id | Key (`testIds.*`) | Element | Data attributes |
|---|---|---|---|
| `project-switcher` | `projectSwitcher` | `ProjectSwitcher` trigger (first row of `ChatNav`) | `data-value` (`all` / `none` / project id) |
| `project-switcher-option` | `projectSwitcherOption` | a filter item of the switcher menu | `data-value` (`all` / `none` / project id) |
| `project-add` | `projectAdd` | "Add project…" / "Add project" (switcher menu, Settings → Projects header and empty state) | |
| `project-manage` | `projectManage` | "Manage projects" in the switcher menu | |
| `new-chat-project` | `newChatProject` | `NewChatProjectPicker` pill on `/` | `data-value` (`none` / project id) |
| `project-option` | `projectOption` | a project item of `ProjectMenuItems` (picker, chip and move menus) | `data-value` (`none` / project id), `data-state` (reka: `checked` / `unchecked`) |
| `chat-project-chip` | `chatProjectChip` | `ChatProjectChip` in the chat header | `data-value` (project id), `data-state` (`ok` / `missing`) |
| `chat-menu-move` | `chatMenuMove` | "Move to project" submenu trigger in the header `⋯` menu | |
| `chat-row-move` | `chatRowMove` | "Move to project" submenu trigger in the sidebar row menu | |
| `add-project-dialog` | `addProjectDialog` | `AddProjectDialog` content | |
| `add-project-name` | `addProjectName` | "Name" input | |
| `add-project-submit` | `addProjectSubmit` | "Add project" submit | |
| `add-project-error` | `addProjectError` | inline error of the dialog | `data-code` |
| `folder-browser` | `folderBrowser` | `FolderBrowser` root | `data-path` (the open folder; empty for the roots), `data-state` (`loading` / `ready` / `empty` / `error`) |
| `folder-browser-entry` | `folderBrowserEntry` | a root or subfolder button | `data-path` |
| `folder-browser-up` | `folderBrowserUp` | "Parent folder" | |
| `folder-browser-crumb` | `folderBrowserCrumb` | a breadcrumb segment | `data-path` |
| `folder-browser-new` | `folderBrowserNew` | "New folder" | |
| `folder-browser-new-input` | `folderBrowserNewInput` | "Folder name" input | |
| `folder-browser-error` | `folderBrowserError` | inline browse error | `data-code` |
| `settings-nav-projects` | `settingsNavProjects` | "Projects" settings nav item | `data-state` (active) |
| `projects-settings` | `projectsSettings` | `ProjectsSettings` root | |
| `projects-empty` | `projectsEmpty` | "No projects yet." state | |
| `project-row` | `projectRow` | one project in Settings → Projects | `data-project-id` |
| `project-row-menu` | `projectRowMenu` | `⋯` actions trigger of a project row | |
| `project-rename` | `projectRename` | "Rename" item | |
| `project-rename-input` | `projectRenameInput` | inline rename input of a project | |
| `project-instructions` | `projectInstructions` | "Edit instructions…" item | |
| `project-instructions-dialog` | `projectInstructionsDialog` | `ProjectInstructionsDialog` content | |
| `project-instructions-input` | `projectInstructionsInput` | instructions textarea | |
| `project-instructions-save` | `projectInstructionsSave` | "Save" of the instructions dialog | |
| `project-delete` | `projectDelete` | "Delete…" item | |
| `project-delete-confirm` | `projectDeleteConfirm` | confirm button of the delete `ConfirmDialog` | |
| `project-missing` | `projectMissing` | "Folder not found" badge of a project row | |
| `settings-project-max-steps` | `settingsProjectMaxSteps` | "Max steps in project chats" input (Settings → General) | |
| `tool-row-summary` | `toolRowSummary` | summary of a workspace tool row (`+12 −3`, `exit 1`, …) | `data-tone` (`muted` / `success` / `destructive` / `warning`) |
| `tool-raw-toggle` | `toolRawToggle` | "Raw input and output" toggle of a workspace tool body | `data-state` (`open` / `closed`) |
| `diff-view` | `diffView` | `DiffView` root | `data-path`, `data-state` (`created` / `modified`) |
| `diff-line` | `diffLine` | one diff line | `data-kind` (`add` / `del` / `context`) |
| `diff-expand` | `diffExpand` | "⋯ N unchanged lines" / "Show N more lines" | `data-action` (`unfold` / `show-all`) |
| `terminal-output` | `terminalOutput` | `TerminalOutput` root | `data-status` (`running` / `ok` / `error` / `timeout` / `killed`) |
| `terminal-command` | `terminalCommand` | the `$ command` line | |
| `terminal-exit` | `terminalExit` | "Exit code N" badge | `data-value` (the exit code) |
| `terminal-stdout` | `terminalStdout` | stdout block | |
| `terminal-stderr` | `terminalStderr` | stderr block | |
| `file-content` | `fileContent` | `FileContent` root | `data-path` |
| `file-list` | `fileList` | `FileList` root | |
| `file-list-item` | `fileListItem` | one item of a file list | `data-path` |
| `tool-approval-preview` | `toolApprovalPreview` | `ToolApprovalPreview` root inside an approval card | `data-kind` (`diff` / `content` / `command`) |
| `tool-approval-accept-edits` | `toolApprovalAcceptEdits` | "Accept all edits in this chat" checkbox | `data-state` (reka: `checked` / `unchecked`) |
| `data-key-section` | `dataKeySection` | `EncryptionKeySection` root | |
| `data-key-rotate` | `dataKeyRotate` | "Rotate key…" | |
| `key-rotate-dialog` | `keyRotateDialog` | `RotateKeyDialog` content | |
| `key-rotate-confirm` | `keyRotateConfirm` | "Type ROTATE to confirm" input | |
| `key-rotate-submit` | `keyRotateSubmit` | "Rotate key" submit | |
| `data-cleanup-section` | `dataCleanupSection` | `StorageCleanupSection` root | |
| `data-cleanup-check` | `dataCleanupCheck` | "Check for unused files" | |
| `data-cleanup-summary` | `dataCleanupSummary` | the preview summary line | |
| `data-cleanup-run` | `dataCleanupRun` | "Remove…" | |
| `data-cleanup-confirm` | `dataCleanupConfirm` | confirm button of the cleanup `ConfirmDialog` | |

---

## 14. Accessibility and responsiveness

### 14.1 Focus management

- Dialogs, sheets and popovers trap focus (reka-ui) and return it to their trigger on close.
- Opening a chat or pressing New chat focuses the composer (desktop only; never on touch, to avoid the keyboard
  popping up). After send, focus stays in the composer.
- Command palette focuses its input; closing returns focus to where it was.
- Inline rename focuses the input with the text selected; Enter/Esc returns focus to the row or title.
- Deleting a chat row moves focus to the next row (or the previous one, or New chat).
- The wizard moves focus to the first field of each step; validation errors focus the first invalid field.
- Route changes announce the page title through a polite live region (`useRouteAnnouncer`).
- Switching a message version keeps focus on the same control (previous / next) of the new version's switcher; the
  buttons use `aria-disabled`, so focus survives reaching the first or last version (7.5).
- The Share dialog focuses "Create link" when the chat has no link, else the first card's "Copy link"; a new link's
  URL input receives focus with the text selected; after a revoke, focus moves to the next card's "Copy link" (else
  the previous card's, else "Create link"). Closing returns focus to the element that had it when the dialog opened:
  the dialog has no trigger of its own, so the chat menus run "Share…" after they closed and put focus back on their
  `⋯` trigger first; from Settings → Data it is the row's "Manage…".
- The delete-all dialog focuses the "Type DELETE to confirm" input; closing returns focus to "Delete all data…". When
  the password prompt on top of it closes, focus returns to "Delete everything".
- Phase 6: after a version is deleted, focus moves to the switcher of the version now shown, or to its Copy button
  when only one version is left (7.5); a canceled or failed delete returns focus to "Delete this version". The image
  lightbox traps focus, opens on Next image (else Download) and returns focus to the tile it was opened from. After
  dictation the transcript's end holds the caret and the textarea is focused on desktop only (never on touch); the
  recording indicator's Cancel gives focus back to the textarea (desktop), and the mic's setup popover returns it to
  the mic unless the user clicked elsewhere. The image options menu opens on the current aspect ratio and returns focus
  to the textarea (desktop). The voice field keeps focus while its suggestions open and close. The Media page's Test
  voice keeps focus on its button while it plays.
- Phase 7: the switcher, the new-chat picker and the chip are menus that return focus to their trigger; a "Move to
  project" submenu returns focus to its `⋯` trigger (the row or the header). Opening a folder in the `FolderBrowser`
  moves focus to its first entry (else Parent folder) and the polite region announces "Opened {folder}, {n} folders";
  the Add project dialog opens on the browser's first entry. The Rotate key dialog focuses "Type ROTATE to confirm";
  closing it (or its password prompt) returns focus to "Rotate key…". "Show {n} more lines" and "Show all" keep focus on
  the same place of the expanded block. Checking "Accept all edits in this chat" does not move focus; Allow then
  collapses the card like any decision.

### 14.2 Semantics and labels

- Landmarks: sidebar `<nav aria-label="Chats">` / "Plugins" / "Settings"; main content `<main>`; composer
  `<form aria-label="Message composer">`.
- Every icon-only button has `aria-label` and a tooltip with the same text (plus the shortcut).
- Transcript: `role="log"` with `aria-live="off"` while streaming (tokens are not read one by one); a separate
  visually hidden polite region announces "Response finished", "Response stopped", "Approval needed: {tool}" and
  errors.
- Collapsible rows are buttons with `aria-expanded` and `aria-controls`. Status dots and capability icons carry
  sr-only text. Switches have visible labels or `aria-label`. Tabs use the reka `Tabs` roles.
- Model picker items read "{model}, {provider}, vision, tools, reasoning, image output, 200K context" ("image output"
  since Phase 6).
- `BranchSwitcher`: `role="group"` named "Message versions", buttons "Previous version" / "Next version", the counter
  read as "Version 2 of 3"; after a switch the transcript's polite live region announces the new position.
- Share page: the `share` layout's `<main>` landmark, one `h1` (the title), messages as `<article>` elements in a
  plain list (no live region: nothing streams); tool rows are buttons with `aria-expanded` only when they expand.
- Data page: each section has a heading; "Delete all data…" and "Delete everything" name the destructive action in
  their text; the result panel is announced once through the polite region ("Import finished: 10 imported, 1
  failed").
- Phase 6 toggles: the mic (`aria-pressed` `true` while recording, else `false`; `aria-keyshortcuts="Alt+V"`, labels
  "Dictate" / "Stop and transcribe" / "Cancel transcription"; `aria-disabled` with the tooltip "Voice input needs HTTPS
  or localhost" on an insecure origin; `aria-haspopup="dialog"` + `aria-expanded` in the setup state) and read-aloud
  buttons (`aria-pressed` while the reply loads or plays, `aria-busy` while it loads, labels "Read aloud" / "Stop
  reading"). The recording indicator is a `role="group"` named "Recording" / "Transcribing". The composer has its own
  polite live region (`aria-live="polite"`, `aria-atomic`, without `role="status"`, so the `role="status"` region of
  `ChatView` stays unique) announcing "Recording started", "Transcribing…", "Transcript added" and "Recording
  canceled"; the `ChatView` region announces "Version deleted". The recording timer and the "Generating image…
  12s" counter are never announced. Gallery tiles are buttons "Open image {n} of {m}"; images have the alt text
  "Generated image {n} of {m}"; the lightbox counter is read as "Image {n} of {m}" (polite), its dialog title is the
  image's alt text and its description "Use the arrow keys to see the other images." ("A generated image." for one);
  `GeneratingImages` is `aria-busy` with the sr-only text "Generating images".
- Phase 7: the switcher trigger is named "Project filter: {name}" ("All chats", "No project") with
  `aria-haspopup="menu"`; its items and the move items are menu radio items; the chip is named "Project: {name}" (plus
  ", folder not found" when missing). The folder browser's breadcrumb is a `nav` "Folder path" with `aria-current` on
  the open folder; disabled entries say "{name}, already a project". A diff is a `role="region"` named "Changes to
  {path}" whose changed lines carry the sr-only words "Added" / "Removed"; a terminal block is named "Output of
  {command}" and its exit badge reads "Exit code {n}"; row summaries carry sr-only text ("12 lines added, 3 removed",
  "exit code 1"). The shell approval is announced as "Approval needed: run {command}"; its warning is part of the card's
  description. The Encryption key and Storage cleanup sections have headings; "Rotate key…" and "Remove…" name their
  action.

### 14.3 Contrast targets

- Body text and UI labels ≥ 4.5:1 against their surface in both modes (`foreground`, `muted-foreground` on
  `background`, `sidebar`, `card`, `muted`). Large text (≥ 18px or 14px 600) ≥ 3:1.
- `primary-foreground` on `primary` ≥ 4.5:1 (send button, primary buttons).
- Focus rings, input borders and status dots ≥ 3:1 against the adjacent color.
- `success` / `warning` / `info` are not used for small text in light mode; tinted alerts keep `text-foreground`.
- Links in markdown: `text-foreground underline decoration-primary/60 underline-offset-2`, hover
  `decoration-primary` (does not rely on color alone).
- W4.2 checks every screen in dark and light with an automated contrast audit (axe in Playwright).

### 14.4 Reduced motion

`prefers-reduced-motion: reduce` → durations 0ms, no pulse (static ring), no shimmer (static muted text),
instant scroll instead of smooth, no sheet slide (fade only).

### 14.5 Breakpoints and layout

| Width | Layout |
|---|---|
| < 640 (`sm`) | greeting 24px; effort/permission triggers show icons only; dialogs stay centered, never full-screen: form dialogs span the width minus 1rem on each side (`max-w-[calc(100%-2rem)]`), are capped at the viewport height minus 2rem and scroll inside; confirmations (`AlertDialog`) are 20rem wide |
| < 768 (`md`) | sidebar becomes a `Sheet` (18rem, from the left; its own query is `max-width: 768px`, so it is still a sheet at exactly 768px) opened by the header trigger; closes on navigation; composer full width with 12px gutters; textarea 16px; model picker as a bottom `Drawer`; plugin filters as a `Select`; settings content full width |
| 768–1023 | sidebar collapsible to icons; transcript `max-w-3xl` with 16px gutters; kbd hints hidden |
| ≥ 1024 (`lg`) | full layout, kbd hints visible |
| ≥ 1280 (`xl`) | plugin grid 3 columns |

- Use `min-h-dvh` / `h-dvh` (not `vh`) for full-height areas; the composer dock pads with
  `env(safe-area-inset-bottom)`.
- Source tab below `lg`: file tree collapses into a `Select` above the editor; the build panel starts collapsed.
- Touch (`pointer: coarse`): interactive targets ≥ 40×40px (rows 40px tall, icon buttons 40px, hit-area padding
  on the 32px send button); hover-only actions (row `⋯`, message actions) are always visible. The `BranchSwitcher`
  buttons, the Chat | Plugins mode tabs and the chat-row `⋯` follow the same 40px rule (`pointer-coarse:` classes), and
  so do the Phase 6 controls: the mic, the recording indicator's Cancel, the image options trigger, Read aloud, Delete
  this version, the message editor's paperclip and buttons, the lightbox buttons and Download, and Test voice.
- Touch tablets (Phase 6, S9, W6.11; ≥ 769px, where the sidebar is not a sheet): the collapsed icon rail is 3.5rem
  (56px) wide instead of 3rem and its buttons are 40px (`pointer-coarse:group-data-[collapsible=icon]:size-10!` and
  `p-3!` on the sidebar menu buttons, the `lg` size keeping its zero icon-mode padding; the wrapper's
  `--sidebar-width-icon` moved from the inline style to the classes `[--sidebar-width-icon:3rem]
  pointer-coarse:[--sidebar-width-icon:3.5rem]` on `SidebarProvider`, since an inline custom property outranks every
  class; `pointer-coarse:size-10` on `AppBrand` and `ThemeToggle`); both `ui/sidebar` patches are recorded in
  `apps/web/AI_ELEMENTS_PATCHES.md`.
- Phase 7 screens: at 390px the switcher is a full-width row in the sheet, the chip is icon-only, diffs scroll sideways
  inside their own block (the page never scrolls horizontally; e2e asserts it), terminal output wraps, and the Add
  project dialog follows the form-dialog rule (full width minus 1rem, `max-h-[90dvh]`, the folder list scrolls inside).
  On touch screens every new control is at least 40px (`pointer-coarse:h-10`): the switcher, the new-chat pill, the
  chip, the move items, the folder entries and Parent folder, Raw input and output, Show more, and the approval
  checkbox.
- Phase 6 screens: galleries keep their two columns at 390px (tiles never overflow the column); the recording composer
  keeps the 390px layout without horizontal scroll (the indicator shows the dot, the timer and Cancel); the Media page
  stacks labels above controls below `sm`.
- Phase 5 screens: the share page keeps the `max-w-3xl` column with 16px gutters below `md` (the header shows the
  brand and the theme menu only); the Share dialog and the delete-all dialog follow the form-dialog rule above
  (centered, height-capped, scrolling inside); on the Data page the switches stack and the section buttons span the
  full width below `sm`.

### 14.6 Mobile e2e (Phase 5)

`playwright.config.ts` has a `mobile` project: `devices['Pixel 7']` (Chromium, touch, `isMobile`) with the viewport
set to 390×844. It runs only `e2e/specs/mobile/*.spec.ts`; the `chromium` project ignores that folder, so CI needs no
extra browser. The mobile specs (W5.8) assert:

- the sidebar opens as a `Sheet` from the header's `sidebar-trigger` and closes after a navigation;
- no horizontal scroll at 390 px (`document.documentElement.scrollWidth <= 390`) on `/`, a chat, `/plugins` and the
  settings pages;
- the composer is fully inside the viewport (its bounding box ends above 844 px, with the safe-area padding);
- the model picker opens as a bottom `Drawer` (its content carries `model-picker`);
- touch targets are at least 40×40 px (composer toolbar buttons, message actions, sidebar rows);
- a `mock:echo` reply streams and finishes.

They reuse the existing test ids; Phase 5 adds none for mobile. Phase 6 adds to the mobile specs (W6.12): the mic is
at least 40×40px, a gallery fits 390px, and there is no horizontal scroll while recording. Phase 7 adds
`mobile/projects.spec.ts` (W7.14): the switcher works inside the sheet, the chip is icon-only, and an expanded diff
causes no horizontal page scroll.

### 14.7 Tablet e2e and media permissions (Phase 6)

`playwright.config.ts` (K4) adds a `tablet` project: `devices['Galaxy Tab S9 landscape']` (1024×640, Chromium, touch,
so `pointer: coarse` matches and the sidebar is not a sheet). It runs only `e2e/specs/tablet/*.spec.ts`; the `chromium`
project ignores `specs/(mobile|tablet)/`. `tablet/touch-targets.spec.ts` (W6.12) collapses the sidebar and asserts that
the icon rail is 56px wide and every icon button is at least 40×40px. Phase 7 (W7.14) extends it to the project
switcher, the chip and the approval controls.

Every project runs with `use.permissions: ['microphone']` and the Chromium flags `--use-fake-ui-for-media-stream`,
`--use-fake-device-for-media-stream` and `--autoplay-policy=no-user-gesture-required`, so the voice spec records from a
fake device and read-aloud plays without a gesture. If the flags fail in headless CI, the voice spec mocks
`getUserMedia` / `MediaRecorder` with `page.addInitScript`.

---

## 15. Copy guidelines

- **English only; sentence case** for everything: buttons, menu items, titles, tabs ("New chat", "Install
  plugin", "Show thinking"). Proper nouns keep their case (Anthropic, OpenAI, MCP, npm, URL, JSON).
- **Short labels**: verbs for actions ("Save", "Test", "Install", "Retry"), nouns for navigation ("Providers").
  One to three words for buttons.
- **Ellipsis `…`** (single character) when the item opens a dialog that needs more input ("Install…",
  "Uninstall…") and for progress ("Thinking…", "Connecting…"). Not on "Rename" (inline).
- **Tone**: plain, calm, second person, no exclamation marks, no emojis, no blame ("Wrong password", not
  "You entered an invalid password!").
- **Errors** say what happened, then what to do: "Anthropic rejected the API key. Check it in Settings." Never show
  raw stack traces; technical details go into a collapsible "Details".
- **Numbers and units**: "14s", "Thought for 12s", "200K", "$0.004", "23 models", "3 sources", times in the
  user's locale.
- **Placeholders** end with `…` ("Reply…", "Search models…").

Key strings:

| Where | String |
|---|---|
| Empty greeting | "What's next, {displayName}?" / "What's next?" |
| No provider | "Connect a provider to start" · "Add an API key for Anthropic, OpenAI, DeepSeek and more, or run models locally with Ollama." · "Connect a provider" |
| Empty chat list | "No chats yet" |
| Chat not found | "Chat not found" · "It may have been deleted." · "New chat" |
| Delete toast | "Chat deleted" · "Undo" |
| Reasoning | "Thinking…" · "Thought for {n}s" · "Thought" |
| Tool states | "Needs approval" · "Denied" · "Skipped because you sent a new message" |
| Approval | "Allow {tool}?" · "Always allow {tool}" · "Deny" · "Allow" |
| Stopped | "Stopped" |
| Conflict | "A response is already running in this chat." |
| Stale path (404 to a chat request or a switch) | "This chat changed elsewhere and was reloaded." |
| Trust warning | "Runs code on your server with harness-forge's permissions. It can read API keys and conversations and make network requests. Only install plugins from sources you trust." (PLUGINS.md) · "I trust {source}" · "Confirm your password" |
| HTTP banner | "You're using plain HTTP. Keys you enter can be read on the network. Use HTTPS or localhost." |
| Key dialog | "Get a key" · "Using {ENV_VAR} from the server environment. A key saved here takes priority." · "Connected · {n} models · {ms} ms" |
| Plugins empty | "No plugins match" · "Clear filters" |
| Read-only source | "Installed from {source}. Editing is disabled." |
| Login | "Enter your password" · "Wrong password" · "Too many attempts. Try again in {n}s." |
| Not found page | "Page not found" · "Back to chats" |
| Message versions | "Message versions" · "Previous version" · "Next version" · "Version {n} of {m}" · "Could not switch versions" |
| Share dialog | "Share chat" · "Anyone with a link can read a snapshot of this chat. Messages you add later are not shared until you update the snapshot." · "This chat has no links yet." · "New link" · "Create link" · "Copy link" · "Update snapshot" · "Revoke…" · "Revoke this link?" · "People with the link can no longer open it. This can't be undone." · "Outdated" · "Expired" · "No password set" · "Changes apply to the link at once." · "A chat can have up to 20 links." · "Confirm your password to create or change a share link." |
| Share page | "Read-only snapshot · {date}" · "This link is unavailable" · "It may have expired or been revoked, or the chat was deleted." · "Couldn't load this chat" · "Too many requests. Try again in {n}s." · "This reply failed." |
| Data page | "Export backup" · "Choose file…" · "Import" · "Importing…" · "This file is larger than 256 MB." · "Skip it" · "Import a copy" · "Restore settings from the backup" · "Shared links" · "No shared links." · "Delete all data…" · "Delete all data?" · "Type DELETE to confirm" · "Delete everything" · "Deleting all data needs your password." · "Deleted {n} chats" |
| Busy (409 `busy`, v1.1 – v1.2) | "Another import or delete is running. Try again when it finishes." (replaced in Phase 7, below) |
| Composer (image model) | "Describe an image…" · "Image options" (tooltip) · "Image options: {ratio}, {n} images" / "Image options: {ratio}" (accessible name) · "Aspect ratio" · "Auto" · "Images" · "Edit the previous image" · "The prompt can be up to 32,000 characters" (Send tooltip) · "Finish dictation first" (Send tooltip while voice input runs) |
| Attachment warnings | "{model} can't see images. Remove them or choose another model." · "{model} can't read PDFs. Remove them or choose another model." · "{name} is too large" · "Files can be up to 20 MB." · "{name} can't be attached" · "Attach images, PDFs or text files." |
| Model picker | "Image models" · "Image output" |
| Generated images | "Generating image… {s}s" · "Generating {n} images… {s}s" · "Generating images" · "Generated image {n} of {m}" · "Open image {n} of {m}" · "Previous image" · "Next image" · "Image {n} of {m}" · "Use the arrow keys to see the other images." · "A generated image." · "Download" · "Close" · "{n} images · {ratio} · edited {k} image(s)" · "Estimated cost" |
| `generate_image` | "Choose an image model in Settings → Media." |
| Dictation | "Dictate" · "Stop and transcribe" · "Transcribing…" · "Cancel transcription" · "Recording" · "Transcribing" · "Cancel" · "Choose a speech-to-text model to dictate messages." · "Open settings" · "Voice input needs HTTPS or localhost" · "No speech detected" · "Microphone access is blocked. Allow it in the browser's site settings." · "No microphone was found." · "The microphone is in use by another app." · "The recording is too long." · "This browser can't record audio." |
| Live region (Phase 6) | "Recording started" · "Transcribing…" · "Transcript added" · "Recording canceled" · "Version deleted" |
| Read aloud | "Read aloud" · "Stop reading" · "Could not read this reply aloud" · "The browser blocked audio playback." · "The browser could not play the audio." |
| Versions (Phase 6) | "Delete this version" · "Delete this version?" · "This version and every message after it are deleted. Other versions stay." · "Delete version" · "Could not delete the version" |
| Edit attachments | "Attach files" · "Remove {name}" · "Send" · "Cancel" |
| Settings → Media | "Media" · "Images and voice" · "Models for generated images, dictation and reading replies aloud." · "Could not load the media settings" · "Retry" · "Images" · "Generate pictures with your own providers." · "Image model" · "None (the generate_image tool is off)" · "The generate_image tool uses this model. To generate images directly, pick an image model in the composer." · "Loading models…" · "No image models from your connected providers." · "No speech-to-text models from your connected providers." · "No text-to-speech models from your connected providers." · "Voice" · "Audio and text go to the provider you choose; harness-forge doesn't store them." · "Speech to text" · "Off" · "Language" · "Detect automatically" · "Read aloud" · "Voice" · "Provider default" · "Voices" · "Use at most 64 characters." · "Voices use letters, digits, spaces and "_", ".", ":", "-"." · "Speed" · "Test voice" · "Stop" · "This is how replies sound when they are read aloud." · "Could not play the test voice" |
| Settings → Models (Phase 6) | "No chat models from your connected providers." · "Chosen in Settings → Media" (the dash of Favorite and Visible) · kind badges "Image" · "Speech to text" · "Text to speech" · "Embedding" · "Audio" · "Other" |
| Custom model kind (Settings → Models) | "Kind" · "Chat" · "Image" · "Speech to text" · "Text to speech" · "Image output" · "For a model {provider} serves but does not list." · "It appears in the model picker right away." · "Image models appear in the model picker when the provider can generate images." · "Choose it in Settings → Media." |
| General (Phase 6) | "Use Alt+M, Alt+R and Alt+P for composer menus, and Alt+V to dictate." |
| Fresh-auth prompts | "Creating a plugin that runs code needs your password." · "Changing the code of a plugin needs your password." · "Reloading runs the plugin's code again. Confirm your password to continue." · "Saving a server that runs a local command needs your password." · "This provider starts a program on the server. Confirm your password to continue." · "Confirm your password to install a plugin that runs code on this server." · "Confirm your password to trust a plugin that runs code on this server." (8.4) |
| Share option (Phase 6) | "Files and images" (was "Attachments") |
| Project switcher (Phase 7) | "All chats" · "No project" · "Add project…" · "Manage projects" · "Project: {name}" · "Project filter: {name}" · "No chats in {name} yet" · "No chats without a project" · "The project was deleted. Showing all chats." |
| Project of a chat (Phase 7) | "No project" · "Move to project" · "Project settings" · "Moved to {name}" · "Moved out of {name}" · "Undo" · "Wait for the response to finish before moving this chat." · "This project no longer exists." · palette: "Show all chats" · "Show chats without a project" · "Show {name}" · "Move chat to {name}" · "Move chat out of project" |
| Settings → Projects (Phase 7) | "Projects" · "Folders on the server that chats can read and edit." · "Add project" · "{n} chats" · "Folder not found" · "Uses AGENTS.md" · "Uses CLAUDE.md" · "Rename" · "Edit instructions…" · "Delete…" · "Delete {name}?" · "Its {n} chats stay and move to No project. The folder and its files are not touched." · "Delete project" · "Project deleted" · "Wait for the responses in this project to finish before deleting it." · "Instructions for {name}" · "Sent with every chat in this project, after AGENTS.md / CLAUDE.md from the folder." · "This folder has {file}; it is added first." · "No projects yet. A project is a folder on the server that chats can read and edit." · "Could not load the projects" |
| Add project (Phase 7) | "Add project" · "Folder path" · "Parent folder" · "Not found" · "Project" (badge) · "Showing the first 500 folders." · "Selected: {path}" · "New folder" · "Folder name" · "Use a name without slashes." · "Folder names can't start with a dot." · "Use at most 255 characters." · "Name" · "Opened {folder}, {n} folders" · "Project added" · "A project for this folder already exists." · "A folder with this name already exists." · "Choose a folder inside the workspace folders." · "This folder no longer exists." · "No workspace folders. Set HF_WORKSPACE_ROOTS on the server." · "Adding a project needs your password." |
| Workspace tools (Phase 7) | "New · {n} lines" · "exit {n}" · "timed out" · "killed {signal}" · "lines {a}–{b} of {n}" · "{n} entries" · "{n} files" · "{n} matches" · "Raw input and output" · "New file" · "⋯ {n} unchanged lines" · "Show {n} more lines" · "Diff truncated by server" · "The diff is too large to show." · "Added" · "Removed" · "Changes to {path}" · "stderr" · "Show all {n} lines" · "Exit code {n}" · "Timed out" · "Running…" · "Output truncated by server" · "Output of {command}" · "Show all" · "Show {n} more" · "More results were cut by the server" |
| Workspace approvals (Phase 7) | "Run this command?" · "In {project}" · "Runs on the server with the server user's permissions." · "Run" · "Create or overwrite {path} · {n} lines" · "All occurrences" · "Accept all edits in this chat" · "Approval needed: run {command}" |
| Permission mode (Phase 7) | "Accept edits" · "Edit project files without asking; ask before shell commands" · "Accept edits works in project chats." · notice icon `FolderX` for `workspace-unavailable` (the text comes from the server) |
| General (Phase 7) | "Max steps in project chats" · "Agent runs in project chats can take more steps." · "Chats without a project" · "Enter a whole number from 1 to 200." |
| Settings → Data (Phase 7) | "Storage cleanup" · "Remove uploaded and generated files that no chat, share link, plugin or setting uses anymore. Files from the last 24 hours are kept, and deleting a chat or a version keeps its files until the next cleanup." · "Check for unused files" · "{files} files · {size} can be removed" · "and {n} leftover files on disk" · "{n} recent files are kept for 24 hours." · "Last cleanup {time}" · "No unused files." · "Remove…" · "Remove unused files?" · "This deletes {files} files ({size}). It can't be undone." · "Remove files" · "Removed {files} files ({size})" · "Encryption key" · "API keys and other secrets are encrypted on this server with a master key." · "Source" · "Key file in the data directory" · "HF_MASTER_KEY environment variable" · "Version" · "Rotated" · "Never" · "Secrets" · "{n} encrypted" · "{n} can't be read" · "Rotate key…" · "The key comes from HF_MASTER_KEY. Stop the server and run `pnpm key:rotate` with HF_NEW_MASTER_KEY set to the new key." · "The master key doesn't match the stored secrets. Saved API keys can't be read. Restore the previous key (HF_MASTER_KEY or data/secret.key), or enter the keys again." · "Rotate the master key?" · "A new key encrypts every saved secret again." · "Other browsers and devices are signed out; you stay signed in." · "Every share link changes ({n} links): copy the new links from Shared links." · "Running replies stop and pending approvals expire ({n} waiting)." · "Older versions of harness-forge can't read the secrets afterwards: back up the data directory first." · "Type ROTATE to confirm" · "Rotate key" · "Rotating the master key needs your password." · "Master key rotated" · "{n} secrets encrypted again · {m} approvals expired" · "The encryption key was rotated." |
| Busy (Phase 7) | "Another data task is running. Try again when it finishes." (Data page; was "Another import or delete is running. Try again when it finishes.") · "The server is rotating its encryption key. Try again in a moment." (chat requests) |
