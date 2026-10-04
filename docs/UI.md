# UI — harness-forge web app

The complete UI/UX specification for `apps/web` (Nuxt 4 SPA, shadcn-vue, Tailwind 4, AI Elements Vue).
Agents build the UI from this document. Names, props, emits, routes, store actions, shortcuts and `data-testid`
values defined here are **contracts**: several agents build components in parallel against them.

- Source of truth for shared names: `docs/DECISIONS.md` (wins on conflict). DTO names come from `docs/API.md`.
- Owners (C3, C5, W2.x, W3.x, W4.x; Phase 5: C9, W5.x; Phase 6: C12, W6.x; Phase 7: C15, W7.x; Phase 8: C20, W8.x;
  Phase 9: C25, W9.x; Phase 10: C33, W10.x) follow the phase tables in `docs/phases/`. A component contract marked **cross-owner** must not change without a CCR.
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
   - Customize as an app mode (amended in Phase 10, ADR-044: the user asked for **agent customization**, so
     Settings → Customize lists the sub-agents, slash commands and skills of the user, the projects and the plugins,
     9.12; it is a settings page, not a third sidebar mode, and project definition files stay read-only in the UI);
   - session filters (status/branch/environment filters above the session list; Phase 7: the project switcher is the
     only filter);
   - diff, terminal and browser panes (no split panes next to the transcript; Phase 7 keeps this: diffs and shell
     output render **inside tool rows**, 7.19; amended in Phase 8, ADR-037: the user asked for **one changes panel**.
     It is a right-hand pane on desktop (≥ 1024px) and a sheet below that, exists only in **project chats**, opens only
     when the user toggles it, and lists the files the agent changed in the chat and the project's Git status, each
     with a diff and "Revert file" (2.15, 7.21). There is still no terminal pane, browser pane, editor, staging or
     committing; tool rows keep their own inline diffs and shell output, 7.19);
   - usage-limit UI (plan limits, quota meters, upgrade prompts).
   What stays: sidebar with `Chat | Plugins`, New chat, Search, date-grouped chats, Settings, theme toggle,
   transcript, composer (`+`, model, effort, permission, context ring, send/stop; Phase 6: image options and the mic);
   Phase 7: the project switcher above New chat. Phase 8: the changes toggle in the header of project chats (5.6).
   Phase 9: the todo strip and the queued messages stack above the composer in its dock (2.16, 7.25, 7.26); there is
   still no side pane for plans, tasks or sub-agents (they render inside the transcript). Phase 10: the background
   agents list joins the dock between the todo strip and the queue (2.17, 7.29); still no side pane.
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

Diffs and shell output render inside the expanded tool row (7.19). Rows render their own diff and output; the changes
panel (Phase 8, 7.21) shows the chat's net changes.

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

### 2.15 Changes panel, rewind and shell rules (Phase 8)

Legend additions: `◨` the changes toggle (`PanelRight`, count pill) · `↶` "Revert file" (`Undo2`) · `⚠` changed
outside this chat (`TriangleAlert`) · `⟲` "Rewind files to here" (`History`) · `⛉` allowed by a shell rule
(`ShieldCheck`) · `⊖` "Remove" (`Trash2`).

Desktop (≥ 1024px): the changes pane sits right of the chat panel (7.21); the transcript keeps its `max-w-3xl` column
centred in the remaining width.

```
┌─sidebar 16.5rem─┬────────── chat panel (flex, ≥ 40%) ──────────┬┬────── changes pane 440px ──────┐
│ ◆ harness-forge │ Fix the parser  [▢ harness-forge]  [◨ 3]  ⋯  ││ Changes [This chat | Git]  ⟳  ✕ │ both h-12
│ ▢ harness-forge │──────────────────────────────────────────────││ 3 files changed · +24 −7        │ changes-summary
│ ＋ New chat     │   transcript: max-w-3xl, centred in the      ││ ▸ M src/parser.ts   +12 −3   ↶  │ changes-file
│ ⌕  Search       │   remaining width (px-4 gutters)             ││ ▾ A src/lexer.ts    +10      ↶  │
│ Today           │   ▸ ✎ edit_file "src/parser.ts"  +12 −3   ✓  ││   ┌ src/lexer.ts  New file +10 ┐│ DiffView, lazy
│  Fix the parser │   ▸ ❯ shell "pnpm test"  ⛉       exit 0   ✓  ││   │ 1  + export function lex() ││
│                 │                                              ││   └────────────────────────────┘│
│                 │   ┌ composer (same max-w-3xl) ─────────────┐ ││ ▸ D old/util.ts        −4  ⚠ ↶  │ changed outside
│ ⚙ Settings ☾☀▭ │   └────────────────────────────────────────┘ ││ 2 shell commands may have …     │ untracked note
└─────────────────┴──────────────────────────────────────────────┴┴─────────────────────────────────┘
                                                                 ↑ changes-resize: drag or arrow keys, 320–720px
```

The Git view of the same pane (a project inside a git work tree):

```
│ Changes [This chat | Git]  ⟳  ✕ │
│ On main · 4 files changed       │   "On {branch}"; "No changes since the last commit." when clean
│ ▸ M src/parser.ts            ↶  │
│ ▸ R src/lex.ts → src/lexer.ts ↶ │   rename: origPath → path
│ ▸ U notes.txt                ↶  │   untracked
│ ▸ ! src/merge.ts                │   conflicted: no Revert
```

Phone and tablet (< 1024px): the same panel in a right `Sheet` (full width below `sm`, `sm:max-w-lg` above).

```
┌ 390 ──────────────────────────┐      ┌ 390 ──────────────────────────┐
│ ≡  Fix the parser   ▢  ◨3  ⋯ │  →   │ Changes [This chat|Git] ⟳  ✕ │ Sheet from the right,
│───────────────────────────────│      │ 3 files changed · +24 −7      │ own 40px close button
│ transcript…                   │      │ ▸ M src/parser.ts  +12 −3  ↶  │
│                               │      │ ▸ A src/lexer.ts   +10     ↶  │
└───────────────────────────────┘      └───────────────────────────────┘
```

Revert confirmation and its toast (7.21):

```
┌ Revert parser.ts? ───────────────────────────────────────────┐
│ src/parser.ts goes back to how it was before this chat        │
│ changed it.                                                   │
│ It also changed outside this chat after the agent's last      │   only when changedOutside
│ edit. Those changes are reverted too.                         │
│ The current version is saved first, so you can undo this.     │
│                                       [Cancel] [Revert file]  │   destructive
└───────────────────────────────────────────────────────────────┘
  toast: Reverted src/parser.ts                        [Undo]
```

Rewind (7.22): the action row of a user message in a project chat, then the dialog.

```
                                  ┌───────────────────────────────┐
                                  │ Fix the empty-input crash      │
                                  └───────────────────────────────┘
                                                    ⧉  ✎  ⟲          ⟲ after Edit, only when edits follow

┌ Rewind files to here? ──────────────────────────────────────────── × ┐
│ Files the agent changed after this message go back to how they were  │
│ before it. The conversation stays as it is.                          │
│ ┌──────────────────────────────────────────────────────────────────┐ │
│ │ src/parser.ts                                         [Restore]  │ │ rewind-file
│ │ src/lexer.ts                                          [Delete]   │ │ created after it
│ │ README.md                                       ⚠     [Restore]  │ │ changed outside this chat
│ └──────────────────────────────────────────────────────────────────┘ │
│ ☐ Also restore files changed outside this chat                       │ rewind-force (with conflicts)
│ Shell changes aren't tracked.                                        │
│ ┌ ⚠ These commands ran after this message; their effects on files ─┐ │
│ │ stay:                                                            │ │
│ │ mkdir -p mock-dir && cd mock-dir                                 │ │ rewind-shell-command
│ │ pnpm test                                                        │ │
│ └──────────────────────────────────────────────────────────────────┘ │
│           [Cancel]  [Restore files and edit]  [Restore files]        │
└──────────────────────────────────────────────────────────────────────┘
```

The shell approval card with the allow-rule option (7.3, 7.23) and a shell row in a sticky folder (7.19):

```
┌───────────────────────────────────────────────────────────────┐
│ Run this command?                         from core-workspace │
│ ┌───────────────────────────────────────────────────────────┐ │
│ │ pnpm test --filter parser                                 │ │
│ └───────────────────────────────────────────────────────────┘ │
│ In harness-forge/packages/web · timeout 120s                  │   the sticky folder
│ ⚠ Runs on the server with the server user's permissions.      │
│ ☑ Always allow commands starting with                         │   tool-approval-allow-rule
│   [ pnpm test          ]  ( This project | All projects )     │   prefix + scope, once checked
│   Combined commands run only when every part matches a rule.  │
│                                                [Deny]  [Run]  │
└───────────────────────────────────────────────────────────────┘
  a command with always-ask syntax shows, instead of the checkbox:
│ Commands with redirections, substitutions or other shell      │
│ syntax always ask.                                            │

   ▾ ❯ shell  "cd web && pnpm build"  ⛉                        exit 0   ✓
     ┌──────────────────────────────────────────────────────────────┐   TerminalOutput
     │ packages $ cd web && pnpm build                              │   terminal-cwd (muted)
     │ built in 2.1s                                                │
     │ [Exit code 0] [3.2s] [Now in packages/web]                   │   terminal-cwd-change
     │ Allowed by rule: pnpm build                                  │
     └──────────────────────────────────────────────────────────────┘
```

Settings → Projects with the rules (9.10, 7.23):

```
│ Projects                                        [Add project]   │
│ harness-forge            12 chats · 3 allowed commands      ⋯   │ ⋯: Rename · Edit instructions… ·
│ /home/me/workspaces/harness-forge                               │    Allowed commands… · Delete…
│ notes                    3 chats                            ⋯   │
│                                                                 │
│ Allowed in every project                                        │ GlobalAllowlistSection
│ Shell commands that start with one of these run without asking  │
│ in every project. …                                             │
│ ls                                                          ⊖   │ allowlist-rule
│ git status                                                  ⊖   │
│ [ pnpm test                                      ]  [Add]       │ allowlist-input, allowlist-add

┌ Allowed commands in harness-forge ─────────────────────────── × ┐
│ Shell commands that start with one of these run without asking │
│ in this project. Combined commands run only when every part    │
│ matches; redirections and substitutions always ask.            │
│ A rule for a script runner such as pnpm test or make also lets │ risk note (AllowlistEditor)
│ the agent run any code it writes into the project.             │
│ pnpm test                                                  ⊖   │
│ pnpm -F @harness-forge/web typecheck:fast                  ⊖   │
│ [ make                                          ]  [Add]       │
│ ⚠ This allows every make command.                              │ one-word warning (not blocking)
└─────────────────────────────────────────────────────────────────┘
```

Settings → Data, automatic cleanup inside Storage cleanup (9.8):

```
│ Storage cleanup                                                 │
│ Remove uploaded and generated files that no chat, …             │
│ [Check for unused files]  [Remove…]                             │
│ ◉ Automatic cleanup                      [ Every day        ▾ ] │ data-cleanup-auto, data-cleanup-interval
│   Remove unused files on a schedule. They're deleted without    │
│   asking and can't be restored. Files from the last 24 hours    │
│   are always kept.                                              │
│   Last automatic cleanup 3 days ago: removed 4 files (2 MB).    │ data-cleanup-auto-status
│   Next automatic cleanup in 21 hours.                           │
```

### 2.16 Agent 2.0: compaction, plan mode, todos, sub-agents, mentions and the queue (Phase 9)

Legend additions: `⇵` compaction (`FoldVertical`) · `▤` plan (`ClipboardList`) · `☰` tasks (`ListTodo`) · `◉` / `○` /
`✓` a task in progress / to do / done (`CircleDot` / `Circle` / `CircleCheck`) · `⌕` explore sub-agent (`Telescope`) ·
`⑂` general sub-agent (`Bot`) · `@` mention (`AtSign`) · `◷` queued (`Clock`) · `✎` edit · `×` cancel · `⟳` running.

A compaction divider (7.24): the rows above it are dimmed (`data-compacted`), the summary opens below the rule.

```
                                   ┌──────────────────────────────┐
                                   │ Fix the parser…              │   dimmed (opacity-70), data-compacted
                                   └──────────────────────────────┘
   ──────── ⇵ Conversation compacted · 42 messages summarized · 182K → 9K tokens · Show summary ▸ ────────
   ┌ Summary ──────────────────────────────────────────────────────────── ⧉ ┐   compaction-summary (open)
   │ Focus: tests                                                             │
   │ The user is moving auth to server sessions. Done: …                      │   Markdown, max-h-[50dvh]
   └ The model sees this summary instead of the messages above. ─────────────┘
   ▸ ✎ edit_file "src/auth.ts"                                  +4 −1   ✓     later rows: full opacity

   in-run variant, inside a long reply (the blocks above it in that reply are dimmed too):
   ──────── ⇵ Context compacted during this response · Show summary ▸ ────────
```

The plan approval card (7.25) under the `exit_plan_mode` row; the feedback goes out with whichever button is pressed.

```
   ▸ ▤ exit_plan_mode  "Move auth to server sessions"      Plan ready for review
┌ ▤ Plan ready for review ───────────────────────────────── from core-agent ┐   plan-approval, border-info/50
│ ┌───────────────────────────────────────────────────────────────────────┐ │   plan-approval-plan
│ │ ## Move auth to server sessions                                       │ │   region "Plan", tabindex 0,
│ │ 1. Add createSession() in src/auth/session.ts …                       │ │   max-h-[45dvh], scrolls
│ └───────────────────────────────────────────────────────────────────────┘ │
│ [ Feedback for the agent (optional)                                     ] │   plan-feedback (1 → 4 rows)
│ [Keep planning]        [Approve, ask before edits] [Approve, accept edits]│   plan-keep-planning,
└───────────────────────────────────────────────────────────────────────────┘   plan-approve-ask, plan-approve-edits
   after a decision the card collapses into the row: "Approved · Accept edits" / "Approved · Ask" / "Kept planning"
```

The todo strip (7.25) in the composer dock, collapsed and expanded, and the `todo_write` row:

```
   ▸ ☰ todo_write  "Running the parser tests"                          3/7   ✓     tool-row
 ┌────────────────────────────────────────────────────────────────────────┐       todo-strip (open): the list above the toggle
 │ ✓ Read the parser                                                      │       todo-item[data-status=completed]
 │ ✓ Find the crash                                                       │
 │ ✓ Write a test                                                         │
 │ ◉ Running the parser tests                                             │       in_progress: activeForm, 500
 │ ○ Fix the empty-input branch                                           │
 │ ○ Run the suite                                                        │
 ├────────────────────────────────────────────────────────────────────────┤
 │ ☰ Tasks 3/7                                                          ⌄ │       todo-strip-toggle: "Tasks 3/7" while open
 └────────────────────────────────────────────────────────────────────────┘
 ┌ ☰ 3/7 · Running the parser tests              ▰▰▰▱▱▱▱               ⌃ ┐       todo-strip (closed), h-9
 ┌ Queued · 1 · sent at the next step ────────────────────────────────────┐       queued-messages
 │ ◷ Also update the README                                       ✎   ×   │
 ┌ Queue a message…                                                       ┐       composer
 │ ＋ ✱ Sonnet ▾                                  ▤ Plan ▾  ◔  [Queue] (■) │       composer-queue left of Stop
```

Sub-agent blocks (7.27): two run in parallel, one finished and expanded.

```
 ▸ ⌕ Explore  Find the session code                                     ⟳     task-block[data-state=running]
     └ read_file "src/auth/session.ts"                                          data-slot="task-live"
 ▸ ⌕ Explore  Find the cookie settings                                  ⟳
     └ search_files "cookie"
 ▾ ⑂ Agent    Draft the migration              8 tool calls · 1m 2s      ✓     task-block-trigger
     Sessions are created in src/auth/session.ts.                               line 2: the report's first sentence
     ┌──────────────────────────────────────────────────────────────────┐       TaskBody (bg-muted/50)
     │ PROMPT                                                           │
     │ Draft a migration from cookie sessions to server sessions …      │
     │ STEPS                                                            │
     │ ▢ find_files "**/session*.ts"                         3 files  ✓ │       task-step: tool icon left,
     │ ✎ edit_file "src/auth/session.ts"                       +4 −1  ✓ │       preview + status right
     │ ❯ shell "pnpm test"                                    ⊘ Skipped │       denied: tooltip
     │ REPORT                                                         ⧉ │       task-report
     │ Sessions are created in `src/auth/session.ts` …                  │
     │ claude-haiku-5 · 18K tokens · $0.004 · 1m 2s                     │       data-slot="task-meta"
     └──────────────────────────────────────────────────────────────────┘
```

A steer note inside a running reply, and the `@` mention menu of a project chat (7.26):

```
    ▸ ❯ shell "pnpm test"                                       exit 1  ✗
                         ┌──────────────────────────────────────────┐     steer-note, bg-muted/70
                         │ Use the vitest filter instead            │
                         └──────────────────────────────────────────┘
                                           ↳ You · while it worked
    I'll switch to the vitest filter…

 ┌ Files in harness-forge ───────────────────────────────────────────┐   mention-menu (above the composer)
 │ ▤ parser.ts                src/                                   │   mention-menu-item (highlighted)
 │ ▤ parser.test.ts           src/                                   │
 │ ▢ parsers/                 src/                                   │   data-kind="dir": opens the folder
 │ Showing the first 50 matches. Type more to narrow it down.        │
 └───────────────────────────────────────────────────────────────────┘
 ┌ [▤ parser.ts ×]                                                   ┐   composer-attachment[data-kind=project]
 │ Fix the crash in @src/parser.ts|                                  │
 │ ＋ ✱ Sonnet ▾                                 Ask ▾  ◔  (↑)        │
```

Phone (390px): the dock stacks the strip (collapsed), the queue (at most 2 rows, then "Show {n} more") and the
composer; the plan buttons stack full width; the mention menu spans the composer.

```
┌ 390 ──────────────────────────┐      ┌ 390 ──────────────────────────┐
│ ▤ Plan ready for review       │      │ transcript…                   │
│ ┌ ## Move auth to … ────────┐ │      │ ┌ ☰ 3/7 · Running tests   ⌃ ┐ │  todo-strip (h-10 on touch)
│ │ 1. Add createSession() …  │ │      │ ┌ Queued · 3 ──────────────┐ │
│ └───────────────────────────┘ │      │ │ ◷ Also update …    ✎  ×  │ │  40px actions
│ [ Feedback (optional)       ] │      │ │ ◷ Check the lexer  ✎  ×  │ │
│ [ Approve, accept edits     ] │      │ │ Show 1 more              │ │
│ [ Approve, ask before edits ] │      │ └──────────────────────────┘ │
│ [ Keep planning             ] │      │ ┌ Queue a message…          ┐ │
└───────────────────────────────┘      │ │ ＋ ✱ ▾       ▤ ◔ [Q] (■)  │ │
  flex-col-reverse, 40px each          └───────────────────────────────┘
```

Settings → General, the Agent section (9.11):

```
│ Agent                                                           │
│ Long chats and sub-agents.                                      │
│ Automatic compaction                                        ◉   │ settings-auto-compact (switch right)
│   Summarize older messages when a chat nears the model's        │
│   context window. When off, older messages are left out instead.│
│ Compaction model   [ Same model as the chat                 ▾ ] │ settings-compaction-model
│   Writes the summary when a chat is compacted.                  │
│ Sub-agent model    [ ✱ Claude Haiku 5                       ▾ ] │ settings-subagent-model
│   Runs the tasks the agent hands to sub-agents.                 │
│   ⚠ {model} can't call tools, so sub-agents can't use it.       │ only for a model without tools
│ Sub-agent max steps [ 30 ]                                      │ settings-subagent-max-steps
│   How many tool calls one sub-agent may chain (1–200).          │
```

### 2.17 Agent customization: Customize page, commands, skills, background agents, Remember (Phase 10)

Legend additions: `✦` Customize (`WandSparkles`) · `⊡` custom agent (`BotMessageSquare`) · `/` command
(`SquareSlash`) · `◫` skill (`BookOpen`) · `⊘` shadowed (`EyeOff`) · `✕` invalid (`CircleAlert`) · `⋯` row menu ·
`■` stop · `▤` plan file (`FileText`) · `⧉` copy.

Settings → Customize (9.12), desktop, the Agents tab with a project selected:

```
┌ Settings ───────┬────────────────────────────────────────────────────────────────────┐
│ ← Back to app   │ Customize                                [Import…]  [+ New agent]  │ customize-import, customize-new
│ Providers       │ Sub-agents, slash commands and skills: yours, your projects' and … │
│ Models          │ [Agents 6][Commands 3][Skills 2]       Project [ harness-forge   ▾]│ customize-tab, customize-project-select
│ Media           │ Personal · 2                                      customize-section│ data-source=user
│ Projects        │ ┌────────────────────────────────────────────────────────────────┐ │
│ ✦ Customize ◀   │ │ ⊡ code-reviewer  Reviews diffs for bugs and risky changes.   ⋯ │ │ customization-row
│ General         │ │   Personal · claude-sonnet-5 · 4 tools                         │ │
│ Appearance      │ │ ⊡ test-writer    Writes vitest tests for a module.           ⋯ │ │ data-state=shadowed
│ Data            │ │   Personal · All tools · ⊘ Shadowed                            │ │
│ About           │ └────────────────────────────────────────────────────────────────┘ │
│                 │ In harness-forge · 2      .harness/agents · .claude/agents         │ data-source=project
│                 │ │ ⊡ test-writer    Project test writer.  .harness/agents/test-…⋯ │ │
│                 │ │ ✕ broken         Invalid                                     ⋯ │ │
│                 │ │   Line 2: Add a description.          customization-diagnostics│ │
│                 │ From plugins · 1  │ ⊡ sql-expert  Plans SQL migrations.  db-tools ⋯│ data-source=plugin
│                 │ Built-in · 2      │ ⌕ explore  Read-only research   ⑂ general  …  │ data-source=builtin
└─────────────────┴────────────────────────────────────────────────────────────────────┘
```

The editor sheet (right side, `sm:max-w-2xl`; full width at 390px) and the page at 390px:

```
┌ 390 ──────────────────────────┐   ┌ 390 ──────────────────────────┐
│ ☰ Customize                   │   │ New agent                   × │ customization-editor (sheet)
│ [Import…] [+ New agent]       │   │ Name [ code-reviewer        ] │ customization-name
│ [Agents 6][Commands 3][Ski… → │   │ Description                   │ customization-description
│ Project [ harness-forge     ▾]│   │ [ Reviews diffs for bugs …  ] │
│ Personal · 2                  │   │ Tools (•) All tools the chat  │ customization-tools-mode
│ │ code-reviewer            ⋯ ││   │       allows ( ) Only these   │
│ │ Reviews diffs for bugs …   ││   │ Model [ Default sub-agent… ▾ ]│ customization-model
│ │ Personal · sonnet-5        ││   │ [ ] Same as the chat          │ checkbox (agents: inherit)
│ │                            ││   │ Instructions    1.2 KB / 64 KB│
│ In harness-forge · 2          │   │ ┌───────────────────────────┐ │ customization-body (≤ 50dvh)
│ │ test-writer              ⋯ ││   │ │ You review diffs. …       │ │
│ │ .harness/agents/test-wri…  ││   │ └───────────────────────────┘ │
└───────────────────────────────┘   │ [Cancel]        [Save agent]  │ sticky footer, 40px
                                    └───────────────────────────────┘
```

The slash menu with groups and the argument hint (7.8, 7.28):

```
 ┌ App ─────────────────────────────────────────────────────────────┐  slash-menu
 │ /remember   Save a note to your instructions                     │  slash-menu-item[data-group=app]
 │ /compact    [focus]  Summarize the conversation                  │
 │ Project ─────────────────────────────────────────────────────────│
 │ /review     <file> [focus]   Review a file for bugs     frontend │  data-group=project (namespace right)
 │ Personal ────────────────────────────────────────────────────────│
 │ /standup    Draft my standup notes                               │  data-group=personal
 │ Plugins ─────────────────────────────────────────────────────────│
 │ /tldr       Summarize the text                         Summaries │  data-group=plugin (plugin name right)
 └──────────────────────────────────────────────────────────────────┘
 ┌ /review <file> [focus]                                           ┐  slash-argument-hint (ghost after "/review ")
 │ ＋ ✱ Sonnet ▾                                  Ask ▾  ◔  (↑)      │
```

The transcript: a custom agent, a background call, a skill row, a saved plan and a delivered result (7.25, 7.27, 7.28,
7.29):

```
 ▸ ⊡ code-reviewer  Review the auth diff        8 tool calls · 1m 2s  ✓   task-block[data-kind=custom]
     No blocking issues found.
 ▸ ⑂ Agent  Find flaky tests  Background · 3 tool calls · 41s ⟳ In background task-block[data-background]
     └ shell "pnpm vitest --run"
 ▸ ◫ Loaded skill  release-notes                            Project  ✓    tool-row[data-tool-name=skill]
 ▸ ▤ exit_plan_mode "Move auth…"                 Approved · Accept edits
     Saved to [▤ .harness/plans/2026-10-04-move-auth.md] ⧉  Show changes  plan-file
 ┌ ⑂ Background agent finished · Agent · Find flaky tests  12 tool calls · 3m 2s ┐ task-result (dashed)
 │ Two tests depend on wall-clock time.                          Show report ▸  │ task-result-toggle
 └──────────────────────────────────────────────────────────────────────────────┘
   Sent to the agent                                                    (variant turn: the carrier message)
```

The background agents list in the dock (7.29), open, between the todo strip and the queue:

```
 ┌ ☰ 3/7 · Running the parser tests                     ▰▰▰▱▱▱▱       ⌃ ┐ todo-strip
 ┌ Background agents · 2 running                         [Stop all]      ┐ background-agents (open)
 │ ▸ ⑂ Agent  Find flaky tests        12 tool calls · 1m 12s  ⟳   [■]   │ background-agent
 │     └ shell "pnpm vitest --run"                                      │
 │ ▸ ⊡ code-reviewer  Review the diff  3 tool calls · 20s     ⟳   [■]   │ background-agent-stop
 │ They keep running after the reply. Stop in the composer doesn't …    │
 ├──────────────────────────────────────────────────────────────────────┤
 │ ⟳ Hide background agents                                           ⌄ │ background-agents-toggle
 ┌ ⟳ 2 background agents · Find flaky tests · 1m 12s                  ⌃ ┐ (closed: one h-9 line)
 ┌ Queued · 1 · sent at the next step …                                  ┐ queued-messages
 ┌ Reply…                                                                ┐ composer
```

The Remember dialog (7.30), opened by `/remember` in a project chat:

```
┌ Remember ─────────────────────────────────────────────── × ┐   remember-dialog
│ ┌──────────────────────────────────────────────────────────┐ │   remember-text
│ │ Run pnpm check before every commit.                      │ │
│ └──────────────────────────────────────────── 36 / 2,000 ──┘ │
│ Save to                                                      │
│ (•) AGENTS.md in harness-forge                               │   remember-target[data-value=project-file]
│     Added as a line at the end of the file.                  │
│ ( ) Instructions of harness-forge                            │   data-value=project-instructions
│     Kept by harness-forge and sent with this project's chats.│
│ ( ) Custom instructions                                      │   data-value=global
│     Sent with every chat.                                    │
│                                         [Cancel]  [Save]     │   remember-save
└──────────────────────────────────────────────────────────────┘
```

Settings → General, the Agent section with the plan-file fields (9.11):

```
│ Sub-agent max steps [ 30 ]                                      │ settings-subagent-max-steps
│ Save approved plans                                         ○   │ settings-plan-files
│   When you approve a plan in a project chat, it's saved as a    │
│   Markdown file in the project.                                 │
│ Plan folder        [ .harness/plans                         ]   │ settings-plan-directory (disabled while off)
│   A folder inside the project. Files are named by date and plan │
│   title.                                                        │
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
   `Folders` + "All chats", `Folder` + "No project" or a project name, or `FolderX` in `text-warning` when that
   project's folder is missing, then `ChevronsUpDown`. Its menu filters the list below (All chats · No project · a
   project; `chats.setProjectFilter`) and its project is the default project of new chats.
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
   `chat-row-move`, only once a project exists, 7.20), Share… (`Share2` icon), Export as Markdown, Export as JSON,
   separator, Delete
   (destructive). Share… opens the Share dialog through `ui.openShare(chatId)` (7.14; W5.6 owns the item and
   `chat-actions.ts`).
7. Rename: the row turns into `InlineRename` (Enter saves, Esc cancels, blur saves; empty = cancel).
8. Delete: the row disappears at once; toast "Chat deleted" with **Undo** (5s). The API call runs when the toast
   expires (see `chats.remove` in 11). Deleting the open chat navigates to `/`.
9. Infinite scroll: `useIntersectionObserver` on a sentinel → `chats.fetchPage()` (with `projectId` while a project
   filter is set, Phase 7); skeleton rows while loading. A first page that fails (Phase 7: also the reload after a
   filter change) shows **Retry** under the list.
10. Empty list: caption "No chats yet"; with a filter (Phase 7) "No chats in {name} yet" (or "No chats yet" while the
    project's name is unknown) or "No chats without a project".

### 5.4 Plugins mode contents (`PluginsNav`, W3.1)

1. "New plugin" row with `ChevronDown` → dropdown: "Provider" (`/plugins/new?type=provider`), "Code plugin"
   (`/plugins/new?type=code`).
2. "Install…" row (`Download` icon) → `ui.openInstall()` (dialog mounted by `pages/plugins.vue`, see 6).
3. "Browse" group: All, Providers, Tools, MCP servers, Commands, Agents and skills (Phase 10, `Bot` icon: plugins that
   contribute agents or skills), Disabled — each with a count badge from `plugins.counts`; links to
   `/plugins?filter=all|providers|tools|mcp|commands|agents|disabled` (no param = `all`; DECISIONS "UI query
   parameters"). Active filter row is highlighted.
4. "Installed" group: every plugin sorted by name (builtins first): `ProviderIcon` (sm) + name + `StatusDot`
   (`active` → ok, `disabled` → off, `loading` → running, `untrusted`/`incompatible` → warning, `error` → error).
   Links to `/plugins/<id>`.

### 5.5 Settings mode contents (`SettingsNav`, C3)

"← Back to app" row, then Providers (`KeyRound`), Models (`Boxes`), Media (`ImagePlay`, Phase 6: right after
Models, `/settings/media`, 9.9), Projects (`Folders`, Phase 7: right after Media, `/settings/projects`, 9.10),
Customize (`WandSparkles`, Phase 10: right after Projects, `/settings/customize`, 9.12), General
(`SlidersHorizontal`), Appearance (`Palette`), Data (`Database`, Phase 5: between Appearance and About,
`/settings/data`, 9.8), About (`Info`). The order is therefore Providers, Models, Media, Projects, Customize, General,
Appearance, Data, About. Active item from the route (`/settings/customize?tab=…&project=…` keeps Customize active).
Footer shows only `ThemeToggle`. The links live in `SETTINGS_LINKS` (`components/app-shell/navigation.ts`; the Media
entry has the key `media` and the test id `settings-nav-media`, the Projects entry the key `projects` and the test id
`settings-nav-projects`, the Customize entry the key `customize` and the test id `settings-nav-customize`); the command
palette lists them too (`go-settings-projects`; Phase 10: `go-settings-customize`, "Customize", added automatically
because the palette reads `SETTINGS_LINKS`). The wireframes 2.5, 2.7 and 2.10 predate the Projects entry (2.13 shows
it); 2.17 shows Customize.

### 5.6 Main header

- **Chat pages** (`ChatHeader`, W2.2; W5.6 in Phase 5): h-12 (`--header-height`), `z-10 bg-background`, above the
  transcript in the chat view's `h-dvh` column (only the transcript scrolls); bottom border appears only after the
  transcript scrolls (`border-b border-border` when `scrollTop > 0`, fixed 1px reserved so nothing moves). Left:
  `SidebarTrigger` (only when the sidebar is collapsed or on mobile), then the title (`text-base font-medium`,
  truncate). Clicking the title starts `InlineRename`. Phase 7: `ChatProjectChip` follows the title when the chat
  belongs to a project (7.20, wireframe 2.12). Right: `⋯` menu
  (`aria-label="Chat options"`): Rename · Move to project ▸ (Phase 7, `chat-menu-move`, shown while a project exists
  or the chat has one, 7.20) · Show thinking
  (checkbox) · Share… · Export as Markdown · Export as JSON · separator · Delete. Share… calls `ui.openShare(chatId)`
  (7.14). The empty state `/` shows no title and no menu (its project is picked under the greeting, 7.20). Phase 7:
  `ChatView` passes the session's `projectId` to its `header` slot, and `pages/chat/[id].vue` hands it to
  `ChatHeader` (10.4). Phase 8 (ADR-037): `ChangesToggle` (7.21) sits between `ChatProjectChip` and `⋯` in project
  chats only (`PanelRight` + a count pill of the files this chat changed, capped at "9+"; it opens and closes the
  changes panel; Alt+C, 12); `ChatHeader` mounts it with its `chatId` and `projectId` and it renders nothing without a
  project.
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
in 7.7. Phase 9: the dock stacks the todo strip (7.25) and the queued messages (7.26) above the composer, in that order
and in the same column; each renders nothing when it has nothing to show (14.1, "Dock stacking"). Phase 10: the
background agents list (`BackgroundAgents`, 7.29) sits between the todo strip and the queued messages, so the order is
todo strip → background agents → queued messages → composer.

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
| `/` | `pages/index.vue` | empty state: `ChatView` with `isNew` for the draft chat id (`useDraftChatId()`: a uuidv7 kept until the first send, so an unsent draft survives leaving `/`); `ChatGreeting` + `NoProviderCallout` fill its `empty` slot (Phase 7: the slot props `{ projectId, setProject }` feed `NewChatProjectPicker`, placed in `ChatGreeting`'s default slot right under the greeting, 7.20); the first send replaces the route with `/chat/<id>` | W2.2; W7.10 (Phase 7) |
| `/chat/[id]` | `pages/chat/[id].vue` | `ChatView` for an existing chat with `ChatHeader` in its `header` slot (Phase 7: with the slot's `projectId`); `ChatNotFound` ("Chat not found" + "New chat") for malformed ids and on 404; Phase 8: `ChatView` is wrapped in `ChatWorkspace` (`chatId`, `projectId` = the session's project from the registry), which adds the changes pane or sheet (7.21) without remounting `ChatView` | W2.2; C20 (Phase 8 mount) |
| (parent) | `pages/plugins.vue` | plugins shell: `<NuxtPage />` + the single `InstallDialog` instance bound to `ui.installDialogOpen` (`@installed` → `/plugins/<id>`) | W3.1 |
| `/plugins` | `pages/plugins/index.vue` | `PageHeader` "Plugins" (search, Install…, New plugin ▾), filter from `?filter=` and `?q=`, `PluginCard` grid | W3.1 |
| `/plugins/new?type=provider` | `pages/plugins/new.vue` | `ProviderWizard` (`?edit=<id>` edits an existing declarative plugin); without `type` the page shows a Provider / Code plugin chooser | W3.3 |
| `/plugins/new?type=code` | `pages/plugins/new.vue` | `CodePluginForm` (W3.4 component) | W3.3 (page), W3.4 (form) |
| `/plugins/[id]` | `pages/plugins/[id].vue` → `PluginDetailView` | `PluginHeader` + tabs from `?tab=`: Overview · Configuration (only with a settings schema) · Source (`PluginSourceTab`: code plugins, and declarative plugins whose files are editable, 8.7) · Logs; `McpServersPanel` inside Overview for `core-mcp` | W3.1 (page), W3.4, W3.5 |
| `/settings` | `pages/settings/index.vue` | redirects to `/settings/providers` | W2.5 |
| `/settings/providers` | `pages/settings/providers.vue` | provider list, key dialog (`?configure=<providerId>` opens it) | W2.5 |
| `/settings/models` | `pages/settings/models.vue` | default + title model (chat models only), per-provider model tables | W2.5; W6.10 (Phase 6) |
| `/settings/media` | `pages/settings/media.vue` → `MediaSettings` | "Images and voice": the Images section (image model of the `generate_image` tool) and the Voice section (speech to text, language, read aloud, voice, speed, test voice), 9.9 | C12 (stub), W6.10 |
| `/settings/projects` | `pages/settings/projects.vue` → `ProjectsSettings` | Projects (Phase 7): the project list with rename, instructions and delete, and the Add project dialog with the folder browser (`?add=1` opens it), 9.10; Phase 8: "Allowed commands…" per project and the global rules section `GlobalAllowlistSection` below the list; Phase 10: "Agents, commands and skills…" per project (links to `/settings/customize?project=<id>`) | C15 (stub), W7.9; W8.11 (Phase 8); W10.12 (Phase 10 menu item) |
| `/settings/customize` | `pages/settings/customize.vue` → `CustomizeSettings` | Customize (Phase 10, ADR-044 / ADR-045): the sub-agents, slash commands and skills of the user (editable), of a project (read-only, from `.harness/` and `.claude/`), of the plugins and the built-ins, by source, with the editor, the viewer, import and export (9.12); `?tab=agents\|commands\|skills` (default `agents`), `?project=<id>` (default none) | C33 (stub), W10.8 |
| `/settings/general` | `pages/settings/general.vue` | display name, send key, defaults, max steps (Phase 7: also in project chats), Alt shortcuts, instructions, password; Phase 9: the Shift+Tab switch and the Agent section (9.11) | W2.5; W7.12 (Phase 7); W9.12 (Phase 9) |
| `/settings/appearance` | `pages/settings/appearance.vue` | theme cards, reading font, text size, density, expand thinking | W2.5 |
| `/settings/about` | `pages/settings/about.vue` | versions, license, copy diagnostics | W2.5 |
| `/settings/data` | `pages/settings/data.vue` → `DataSettings` | summary, export, import, storage cleanup (Phase 7; Phase 8: automatic cleanup), shared links (`SharesSettingsSection`), encryption key (Phase 7), danger zone (9.8) | C9 (stub), W5.5; W5.6 (`SharesSettingsSection`); W7.13 (Phase 7 sections) |
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

Query parameters used by the UI: `/plugins?filter=&q=` (`filter` = `all | providers | tools | mcp | commands | agents |
disabled`; `agents` = "Agents and skills", Phase 10; not `kind`, which is the plugin kind enum), `/plugins/[id]?tab=`,
`/plugins/new?type=&edit=`, `/settings/providers?configure=`, `/settings/projects?add=1` (Phase 7: opens the Add
project dialog), `/settings/customize?tab=&project=` (Phase 10: `tab` = `agents | commands | skills`, an unknown value
reads as `agents`; `project` = a project id, an unknown id is dropped from the URL and shows "No project"; both are
written back with `router.replace` when the tab or the project select changes), `/login?redirect=`.
Model refs and project ids never appear in paths (the project filter lives in `localStorage`, 7.20; the Customize page
takes its project from the query, never from the sidebar filter).

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
| `data-notice` | `NoticePart` | one muted line with the server's message and an icon per code (codes in API.md 6.4; Phase 6 adds `generated-file-dropped`, icon `ImageOff`, level warning: a generated file that is not a PNG, JPEG, WebP or GIF image, or larger than 20 MB, was not kept; it stands where the file was; Phase 7 adds `workspace-unavailable`, icon `FolderX`, level warning: the chat's project folder could not be opened, so this run has no workspace tools; the message names the folder and the reason, 7.20; Phase 9 adds `compaction-failed`, icon `FoldVertical`, level warning: an automatic compaction failed, so older messages were left out instead, 7.24) |
| `data-compaction` (Phase 9, ADR-040) | `CompactionDivider` (`chat-format.ts` block kind `compaction`) | a full-width divider at the part's position: "Conversation compacted" / "Conversation compacted automatically" / "Context compacted during this response", "Show summary"; the rows before it are dimmed (7.24). A `/compact` reply holds only this part |
| `data-steer` (Phase 9, ADR-042) | `SteerNote` (block kind `steer`) | a right-aligned muted note inside the running reply: a message the user sent while the agent worked, delivered at a step boundary (7.26) |
| `data-activity` (Phase 9, transient) | — | never stored and never a part: `useChat`'s `onData` receives `{ kind: 'compacting' \| 'idle' }` and the streaming reply shows the shimmer "Compacting conversation…" instead of "Thinking…" while it is `compacting` (7.24) |
| `tool-todo_write`, `tool-exit_plan_mode`, `tool-task` (Phase 9, `core-agent`) | `ToolPart` (todo row and plan row, 7.25), `TaskBlock` (block kind `task`, 7.27) | the agent tools: a todo row whose body is a `TodoList`, a plan row with `PlanApprovalCard` while it awaits a decision, a two-line sub-agent block; each falls back to the generic tool row when its input or output does not parse with the shared schemas. Phase 10: a `task` block also renders custom agent types and background calls (7.27, 7.29); an approved plan row shows `PlanFileChip` when the plan was saved as a file (7.25) |
| `tool-skill` (Phase 10, `core-agent`, ADR-045) | `ToolPart` (skill row, 7.28) | "Loaded skill {name}" with the skill's source; the body is `SkillToolBody` (the instructions the agent read) plus "Raw input and output"; falls back to the generic row when the output does not parse |
| `data-task-result` (Phase 10, ADR-046) | `TaskResultNote` (block kind `task-result`) | a finished **background agent** delivered to the agent (7.29): inside a running reply at the step where it was delivered (variant `inline`), or as the only content of a server-started turn's carrier user message (variant `turn`, which renders the notes instead of a bubble) |
| `data-*` | — | ignored unless listed in `docs/API.md`; unknown data parts never render |
| error (message `metadata.error` or stream error) | `ErrorPart` | alert at the end of the message, see 7.4 |

A user message whose `metadata.command` is set shows `CommandBadge` (`SquareTerminal` + `/name`) above the
bubble text; the text stays as typed. A `reply` command answer shows "Command reply" instead of the model name
in the meta row. Phase 10 (7.28): the badge also tells where the command came from and which model it asked for
(`metadata.command.source`, `modelRef`, `allowedTools`).

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
| `output-available` with `preliminary: true` (Phase 9) | `Spinner` while the message streams; `CircleSlash` + "Stopped" (muted) otherwise | a tool that streams progress (an async-generator `execute`, plugin API 1.3.0; the builtin `task`): the output is a snapshot, not the result |
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

**Preliminary outputs** (Phase 9, plugin API 1.3.0): a tool whose `execute` is an async generator streams snapshots of
its output (`output-available` with `preliminary: true`, at most one every 250 ms; the server always sends the final
value as a normal `output-available`). `ToolPart` shows such a part as running while the message streams and as
"Stopped" once the stream ended without a final value (a reload of a stopped run shows the `output-error` the server
stored instead, 7.27). Today only the builtin `task` uses it; a third-party streaming tool gets the generic row with the
latest snapshot as its Output.

**Agent rows** (Phase 9, `core-agent`; renderers in 7.25 and 7.27): `todo_write` (`ListTodo`; argument = the current
item's `activeForm`, else its content; summary "3/7"; body `TodoList` plus "Raw input and output"), `exit_plan_mode`
(`ClipboardList`; argument = the plan's first heading, else its first line; status texts "Plan ready for review",
"Kept planning" (`PencilLine`), "Approved · Accept edits" / "Approved · Ask"; body `PlanBody` plus "Your feedback: …"
when a reason was sent; Phase 10: `PlanFileChip` first when the approved plan was saved, 7.25), `task` (a `TaskBlock`
instead of the row, for every tool named `task`) and, Phase 10, `skill` (`BookOpen`; the row reads "Loaded skill" plus
the skill name, 7.28). The todo, plan and skill
bodies sit in `AgentToolBody` (`data-slot="agent-tool-body"`) with the generic blocks behind "Raw input and output";
these renderers apply to tools of `core-agent` (any tool of that name until the tool list has loaded), and a value
that does not parse keeps the generic blocks. Rows never auto-expand (principle 5); the todo strip is the live view
of the list.

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
  `edit_file` → a `DiffView` of `old_string` → `new_string` without line numbers or hunk headers (`lineNumbers: false`,
  Phase 8; the root then carries `data-numbers="off"`: they would be the snippet's, not the file's) and an "All
  occurrences" badge with `replace_all`; `write_file` → "Create or overwrite {path} · {n} lines" and a 20-line
  `FileContent` preview (the client does not have the old file, so no diff); `shell` → the card title "Run this
  command?", the `description` as text when present, the command in a large mono block, a meta line "In {project}" ("In
  {project}/{cwd}" with a `cwd`, "In {cwd}" when the project name is unknown) and "timeout {n}s" when the call sets
  `timeout_ms`, and the warning (`TriangleAlert`, `text-warning`) "Runs on the server with the server user's
  permissions."; its buttons are Deny / **Run**. The card learns the chat's permission mode and project name from
  `TOOL_APPROVAL_CONTEXT` (`parts/tool-approval-context.ts`), which `ChatView` provides; without it (a card rendered
  outside a chat view) every write tool offers "Accept all edits in this chat" and the meta line has no project.
- **"Always allow" is hidden** for tools with workspace access `execute` (`ToolApprovalCard.workspace`, from
  `ToolSummary.workspace`; before the tools list has loaded, `ToolPart` uses `WORKSPACE_TOOL_ACCESS` for the
  `core-workspace` names, so a shell card never offers it): a shell command is approved one call at a time.
- **"Accept all edits in this chat"** (`tool-approval-accept-edits`) replaces "Always allow {tool}" for tools with
  workspace access `write` while the chat is not already in Accept edits: Allow with it checked sets the chat's
  permission mode to `edits` before the approval is sent (`ToolApprovalDecision.acceptEdits`, 11.1), so the
  continuation already runs in Accept edits; it writes no tool override. A hidden or secret path still asks in Accept
  edits (policy `always`); its card then shows neither checkbox.
- Every card is a `role="group"` named "Approval needed: {tool}" (`toolApprovalLabel`, `parts/tool-row.ts`); a shell
  card is named, and announced once by the polite live region, as "Approval needed: run {command}" (the first
  non-empty line, at most 60 characters).
- **Shell rules** (Phase 8, ADR-038; wireframe 2.15, full spec 7.23): the card of an `execute` tool still offers no
  "Always allow {tool}", but the card of the builtin `shell` renders `AllowRuleOption` below the warning: a checkbox
  "Always allow commands starting with" (`tool-approval-allow-rule`) that, once checked, shows the suggested prefixes
  (`suggestShellRules(command)` from `@harness-forge/shared`; one prefix is an editable input, several are read-only
  chips; `tool-approval-rule-prefix`), the scope `ToggleGroup` **This project** | **All projects**
  (`tool-approval-rule-scope`, default This project) and the hint "Combined commands run only when every part
  matches a rule." Run with the box checked creates the rules first (`ToolApprovalDecision.allowRules`, 11.5), then
  sends the normal approval; Run is disabled while the box is checked and the prefix is invalid. The card shows no
  one-word warning (only the Settings editor does, 7.23). A command that can never be allowed by a rule shows only a
  muted note (`data-slot="allow-rule-note"`) instead of the
  checkbox: "Commands with redirections, substitutions or other shell syntax always ask." (the parser refused it) or
  "No rule can allow this command, so it always asks." (no valid prefix, e.g. `sudo …`). The meta line uses the
  sticky folder: "In {project}/{cwd}" where `cwd` is the call's `cwd` input, else the chat's current shell folder
  (`TOOL_APPROVAL_CONTEXT.shellCwd()`), left out when it is the project folder.
- **Plan approval** (Phase 9, ADR-041; wireframe 2.16, full spec 7.25): the `exit_plan_mode` call of `core-agent`
  always asks (overrides and hooks cannot approve it), and `ToolPart` renders `PlanApprovalCard` instead of
  `ToolApprovalCard`: the plan as Markdown, an optional feedback field and three buttons, **Keep planning**,
  **Approve, ask before edits** and **Approve, accept edits**. An approval sets the chat's permission mode (Ask or Accept
  edits) before the response goes out, so the continuation runs in that mode; Keep planning denies the call with the
  feedback as `reason`, and the agent keeps planning. There is no "Always allow" and no implicit Enter.
- **Sub-agents never show a card** (ADR-043): a call a child agent would need to ask about is denied inside the child
  (its step reads "Skipped", 7.27). The `task` call itself has policy `safe`; a user override `ask` on `task` shows the
  normal card for it.

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
  during a run gets the same answer and toast. Phase 9: while the session knows of a run, Send queues the message
  instead (7.26), so this answer is left for a run that started elsewhere just before the request; a queue request
  answered 409 `run-idle` (the run ended meanwhile) is sent as a normal message once the session is idle.
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
- User: **Copy**, **Edit** (any user message while no run is active), **Rewind files to here** (Phase 8, `History`,
  `message-rewind`: project chats only, after Edit, when file edits follow the message; 7.22), **Delete this version**
  (below). Edit turns the
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
| `submitted` | assistant placeholder: one line (`--transcript-line-height` tall) with `AiShimmer` "Thinking…" (Phase 9: "Compacting conversation…" while the transient activity is `compacting`, 7.24) | Stop; Phase 9: Queue message (below) |
| `streaming` | parts render incrementally (`Markdown final=false` on the growing text part) | Stop; Esc stops; Phase 9: Enter (the send key) queues, and the outline **Queue message** button shows left of Stop while the composer has content |
| `streaming`, image turn (Phase 6) | once the `start` chunk carries `metadata.image` and until the first `file` part: `GeneratingImages` (7.16), `n` placeholder tiles at the aspect ratio + "Generating image… 12s"; then the gallery | Stop; Esc stops (the reply is saved "Stopped", without images) |
| `error` | `ErrorPart` on the last assistant message | Send |

Stop = `session.stop()`: calls `POST /api/chat/:id/stop`, then aborts the client request (the server run
survives disconnects, so a client abort alone would only disconnect). Leaving the page never stops a run;
returning resumes it: `@ai-sdk/vue` 4 has no `resume` option, so the session calls `chat.resumeStream()` on mount
when the chat has an active run (11.1). Phase 9 (ADR-042): Stop also empties the chat's queue; the stop result lists the
dropped messages (`dropped`), `session.stop()` resolves with them, and the tab that pressed Stop puts them back into its
composer (`restoreQueued`, 7.26) with the toast "Queued messages moved back to the composer."; other tabs only see the
queue empty. Sub-agents of the run stop with it (their blocks end "Stopped", 7.27). Phase 10 (ADR-046): **background
agents are not stopped** by Stop or Esc (Claude Code parity); they keep running after the reply and have their own
Stop in the background agents list (7.29), whose footnote says so.

**Composer while a run is active** (Phase 9, ADR-042): the textarea stays enabled and its placeholder becomes "Queue a
message…". Send (Enter, Mod+Enter or the button) does not start a second request: `session.submit()` adds the message
to the server-side queue (`POST /api/chat/:id/queue`), the polite region announces "Message queued", and the message
shows in `QueuedMessages` above the composer until the agent takes it at its next step boundary (a `SteerNote` appears
in the reply) or, when the run is finishing, it becomes the next turn by itself (7.26). Server commands (`/compact` and
plugin commands) are queued as the next turn, never steered. Esc still stops; Stop never moves (the Queue message
button sits to its left). Client commands (`/model`, `/mode`, …) run at once as always.

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
  (inserts `/` and opens `SlashMenu`), Phase 9: "Mention a file" (`AtSign`, `composer-mention`; project chats only:
  inserts `@` at the caret and opens `MentionMenu`, 7.26). Then `ModelPicker`, then `EffortMenu` (only when the model reasons), then
  `ImageOptionsMenu` (Phase 6, only for image models and chat models with image output, below). While dictation
  records or transcribes, `RecordingIndicator` replaces the left tools (7.17; wireframe 2.11).
- Right tools: `PermissionMenu` (only when at least one tool exists and the model has `capabilities.tools`),
  `ContextRing` (only after the first assistant message with usage; never for image models), `MicButton` (Phase 6,
  7.17: right before Send; hidden when the browser cannot record), `SendStopButton`: 32px circle,
  `bg-primary text-primary-foreground`, `ArrowUp` (Send) / filled `Square` (Stop); disabled = `bg-muted
  text-muted-foreground`. Same size in every state. Send is also disabled while voice input runs (tooltip "Finish
  dictation first"). Phase 9: while a run is active and the composer has text or files, `SendStopButton` (prop
  `canQueue`, emit `queue`) adds an outline 32px button **Queue message** (`composer-queue`, `ListPlus` icon, label
  hidden below `sm`, 40px on coarse pointers) left of Stop; it does what Enter does. While the recording indicator shows, `PermissionMenu` and `ContextRing` step aside as well, and
  Alt+M / Alt+R / Alt+P and the `/model`, `/effort`, `/mode` menus do nothing.
- Placeholder: "Reply…" in a chat, "Ask anything…" on `/`, "Describe an image…" whenever an image model is selected;
  Phase 9: "Queue a message…" while a run is active. Textarea font 15px (16px below `md`, iOS zoom).
- **File mentions** (Phase 9, ADR-042; 7.26): in a project chat, `@` at the start of the text or after whitespace opens
  `MentionMenu` with the project's files (`GET /api/projects/:id/files?q=`); picking a file inserts `@path ` and attaches
  a snapshot of the file as a project chip (`composer-attachment` with `data-kind="project"`, `FileCode`); picking a
  folder inserts `@folder/` and keeps the menu open. No menu in chats without a project or inside a word (`a@b`).
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
- Drafts: unsent text per chat is kept in `sessionStorage` (`useComposerDraft`) and restored on return. Phase 9:
  `restoreQueued(items)` (exposed, 10.6) appends the texts of messages a Stop dropped from the queue to the draft
  (separated by blank lines) and restores their files as done chips (`attachments.addRefs`).
- Client commands never reach the server (7.8). Server commands are sent as typed; the server expands them.
- Focus: autofocus on desktop when a chat opens and after sending; never on touch devices. Shift+Esc focuses.

### 7.8 Slash menu (`SlashMenu`, W2.3)

Opens when the textarea starts with `/` (caret in the first token); a popover anchored above the composer,
`Command` list filtered by prefix, max 8 visible rows.

| Group | Items |
|---|---|
| App (client) | `/new` Start a new chat · `/model` Switch model · `/effort` Set reasoning effort · `/mode` Set permission mode · `/help` Show shortcuts and commands |
| Commands (server) | from `plugins.commands` (`GET /api/commands`): `/name`, description, source plugin name (muted, right); Phase 10: replaced by the Project, Personal and Plugins groups below |

↑/↓ move, Enter or Tab completes, Esc closes. Client commands without arguments run at once; `/model`,
`/effort`, `/mode` without an argument open their menu; with one (`/effort high`, `/mode auto`,
`/model anthropic:claude-sonnet-5`) they apply it on Enter and clear the input. `/help` opens `ShortcutsDialog`.
Server commands insert `/name ` and keep the menu closed. Phase 7: `/mode edits` (aliases `/mode accept-edits` and
`/mode accept edits`) selects Accept edits in a project chat; in a chat without a project it changes nothing and shows
the error "Accept edits works in project chats." (7.11). `/mode` accepts a value or a label, case-insensitive, with
hyphens read as spaces (`parseToolMode`); anything else shows "Unknown mode "{value}". Use ask, edits, auto or off."
(`edits` listed only in a project chat). `ClientCommandContext.projectChat` tells the parser whether the chat has a
project.

Phase 9: `/mode plan` selects Plan in a project chat; outside one it changes nothing and shows "Plan mode works in
project chats." (`PLAN_NEEDS_PROJECT`, 7.11); the unknown-mode error lists `plan` with `edits` only in project chats
("Use ask, edits, plan, auto or off."). **`/compact [focus]`** (ADR-040) is a reserved harness command: `GET
/api/commands` lists it (group Commands, with its description from the server), selecting it inserts `/compact `, and
the message is sent like a server command. The server summarizes the conversation into a `data-compaction` reply (7.24);
the optional text after the name is the focus of the summary (at most 1,000 characters). While a run is active it is
queued as the next turn (7.26). Plugins cannot register a command named `compact`.

**Phase 10 (ADR-045): groups, argument hints, `/remember`.** The server items come from
`useCustomizationsStore().slashCommands(projectId)` (`GET /api/commands?projectId=`, 11.7) instead of `plugins.commands`:
the effective commands of the chat's project (none for a chat without a project), the user's personal commands, the
plugin commands and `/compact`, each with its `source` (`harness | plugin | user | project`) and, when the command file
sets them, `namespace`, `argumentHint` and `modelRef`. The menu shows them in four groups, always in this order:

| Group (`data-group`) | Items |
|---|---|
| App (`app`) | the client commands (`/new`, `/model`, `/effort`, `/mode`, `/help`, and `/remember` "Save a note to your instructions", 7.30) and the harness command `/compact` (source `harness`) |
| Project (`project`) | the project's commands from `.harness/commands/` and `.claude/commands/` (source `project`); the namespace (the subfolder, e.g. `frontend`) muted on the right |
| Personal (`personal`) | the user's own commands from Settings → Customize (source `user`) |
| Plugins (`plugin`) | plugin commands (source `plugin`, `core-commands` included); the plugin name muted on the right |

- A group heading shows only when the group has a matching item. A name appears once: the server already resolved
  precedence (project `.harness` > project `.claude` > personal > plugin), so a shadowed command is not listed (the
  Customize page shows it as shadowed, 9.12).
- Each row (`slash-menu-item`, `data-value` = the name, `data-kind` `client | server`, `data-group`): the mono `/name`,
  the argument hint (muted mono, e.g. `<file> [focus]`, `data-slot="slash-menu-hint"`, hidden below `sm`), the
  description, and on the right the namespace or the plugin name (`data-slot="slash-menu-detail"`; App and Personal
  rows show none). A row is named "/{name}, {description}" plus ", arguments {hint}"; each group is a `role="group"`
  labelled by its heading (`aria-hidden`, never focusable). The list is at most 8 rows and at most `40dvh` tall.
- Filtering stays a name prefix match; the client-first order of v1 becomes the group order. Selecting a server command
  inserts `/name ` as before; when it has an argument hint, the ghost hint appears (7.28).
- Freshness: the composer calls `fetchCommands(projectId, { maxAgeMs: 15_000 })` when it mounts, when the chat's
  project changes and each time the slash menu opens (a typed `/`), so a command file saved on disk shows up the next
  time the menu opens; `customization.changed` and `plugin.changed` mark every cached list stale. While the first list
  loads, the App group shows alone.
- **Skills are not in the menu** (not user-invocable in v1.6; a backlog item): the agent loads them itself (7.28).
- Plugins can no longer register a command named `remember` (it became a client command, like `compact` is a harness
  command); such a plugin command is refused at registration (release note).

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
| `plan` | Plan | `ClipboardList` (`text-info`) | Explore and plan; change nothing until you approve the plan (Phase 9) |
| `auto` | Auto | `Zap` | Run tools without asking, except ones marked always-ask |
| `off` | Off | `CircleSlash` | Don't use tools |

The options come from `TOOL_MODE_OPTIONS` (`composer/permission.ts`) in this order. **Accept edits** (Phase 7, ADR-032)
is shown only in project chats or while it is the current value: `ChatComposer` passes `modes` to `PermissionMenu` from
its `projectId` prop (`offeredToolModes({ projectChat, current })`, 10.4), and `PermissionMenu` always keeps the current
mode in the list, so the radio group never loses its value. In Accept edits, safe tools and `ask` tools with workspace
access `write` (`write_file`, `edit_file` on ordinary paths) run without a card; the shell, hidden or secret-looking
paths (policy `always`) and every other tool that asks in Ask still ask. In a chat without a project the stored value
`edits` behaves like Ask (no workspace tool is offered there). Alt+P opens it. Default for new chats:
`settings.defaultToolMode` (Settings → General offers Accept edits too, 9.4).

**Plan** (Phase 9, ADR-041; 7.25) is offered like Accept edits: in project chats, or while it is the current value
(`offeredToolModes` treats `plan` like `edits`: `isProjectOnlyMode` in `composer/permission.ts`). The trigger and the
option use `text-info` (Auto keeps the ember
accent). In Plan the server offers only tools that change nothing (workspace `write` / `execute` tools are left out)
plus `exit_plan_mode`; reading tools that ask in Ask still ask. The agent ends planning with a plan card (7.3), whose
approval switches the mode to Ask or Accept edits. The server enforces Plan in every chat (a chat without a project
simply has no workspace tools then); the UI just does not offer it there.

**Shift+Tab** (Phase 9, `useModeCycle`, `mode-cycle.ts`): in the composer textarea Shift+Tab cycles **Ask → Accept
edits → Plan → Ask** in a project chat; outside project chats the cycle is Ask only, and from Auto or Off the next mode
is Ask (`nextToolMode(current, { projectChat })`). It takes the key only when all of these hold: Shift+Tab without
another modifier and outside an IME composition; the setting `shiftTabModes` is on (Settings → General, 9.4); the
permission menu shows (tools exist, the model calls tools, no recording); neither the slash menu nor the mention menu
is open; and the next mode differs from the current one. Otherwise Shift+Tab moves focus backwards as usual, so there
is no keyboard trap (WCAG 2.1.2). Each switch is announced through the composer's polite region ("Permission mode:
Plan"). The trigger carries `aria-keyshortcuts="Shift+Tab"` while the cycle is on (with Alt+P as before). Alt+P and
`/mode` keep working whatever the setting.

### 7.12 Context ring (`ContextRing`, W2.3)

`AiContext` trigger: 18px circular progress = context used by the last assistant turn (input + output tokens of
its last step) / model `contextWindow`. Color: `text-muted-foreground`; ≥ 80% `text-warning`; ≥ 95%
`text-destructive`. `HoverCard`: "42% of context used", "84K / 200K tokens", input / output / reasoning / cache
rows, "Chat cost $0.12" (sum of message `costUsd`, hidden when unknown). Hidden when the model has no
`contextWindow`, and always for image models (Phase 6: an image turn sends no history). With versions (7.5) the chat
cost sums the **visible** messages only (the active path); the server's `ChatDetail.totals` sums every usage row,
including hidden versions and image generations (the cost actually paid).

Phase 9 (ADR-040): the hover card ends with a footer that follows `settings.resolved.autoCompact`: on → "Older
messages are summarized automatically near the limit. Type /compact to do it now."; off → "Automatic compaction is
off. Older messages are left out near the limit." After `/compact` the reply's `metadata.usage.contextTokens` is the
size after compaction, so the ring drops at once; an automatic compaction lowers it with the next reply's usage.
`ChatDetail.totals` (and so the cost the server reports) includes the summarizer (`compact`) and sub-agent
(`subagent`) usage rows; the ring's chat cost sums message `costUsd`, which already carries both for the reply that
caused them.

### 7.13 Empty state and no-provider callout (W2.2)

- `ChatGreeting`: `BrandMark` 28px, then "What's next, {displayName}?" (Source Serif 4, 32px; "What's next?" when
  `displayName` is empty). Phase 7: `ChatGreeting` has a default slot right under the heading; `pages/index.vue` puts
  `NewChatProjectPicker` there, which renders only when at least one project exists (7.20). The composer follows.
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
- **Agent 2.0 parity** (Phase 9; no `sharePartSchema` change): the server's sanitizer splits an assistant message at
  each steer into user share messages (a steer reads as an ordinary user bubble on the share page, its files following
  the attachments option; the reply's status stays on its last piece), drops compaction markers and activity parts
  (summaries are never shared; the dimming and the divider do not exist there) and leaves out a whole `/compact`
  exchange (the command and its marker-only reply). `ShareToolRow` renders the agent tools when tool details are
  shared: `TaskBody` for `task` (7.27; store-free; never running), `TodoList` for `todo_write` (summary "3/7") and
  `PlanBody` for `exit_plan_mode` ("Approved · …"; a denied plan always reads "Kept planning", without the feedback,
  which the share part does not carry), the latter two inside `AgentToolBody` with the generic blocks behind "Raw input
  and output", with the same test ids as in the chat; without tool details the rows read "Sub-agent", "Updated tasks"
  and "Plan" (no argument; `data-slot="agent-tool-label"`) and stay static.
- **Agent customization** (Phase 10; no `sharePartSchema` change): `ShareToolRow` labels a custom agent type with its
  name and `BotMessageSquare` (without tool details too: "Sub-agent {name}"), adds "· in the background" to a background
  call (its output there is only the launch: "Started in the background"), and renders `skill` rows as "Loaded skill
  {name}" (`BookOpen`; the `SkillToolBody` only with tool details). The server drops `data-task-result` parts and a
  carrier user message that holds nothing else, so background results never appear on share pages; plan file chips
  are not shown there either.

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
tool row (principle 1.2). Rows render their own diff and output; the changes panel (Phase 8, 7.21) shows the chat's net
changes. Wireframe: 2.14 (Phase 8: 2.15).

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
- **Row summary** (`ToolRowSummary`, `tool-row-summary`, `data-tone` `muted` | `success` | `destructive` | `warning`),
  before the status and only once the output exists (`workspaceRowSummary`); plain visible text in mono
  `tabular-nums`, the minus sign is U+2212:

  | Tool | Summary |
  |---|---|
  | `write_file` | a new file "New · 40 lines" (success); a change `+a −d` (success; `+a` in `text-success`, `−d` in `text-destructive`); no change "No changes" (muted); without a diff (the server's diff timed out) "Updated · 40 lines" (muted) |
  | `edit_file` | `+a −d` (success); "No changes" (muted); without a diff "3 replacements" / "1 replacement" (muted) |
  | `shell` | `exit 0` (muted), `exit 1` (destructive), `timed out` (warning), `killed SIGTERM` (warning), `exited` (destructive: no exit code and no signal) |
  | `read_file` | `lines 1–120 of 340` ("of …" only when the total is known), "empty file", "no lines of 340" (the offset is past the end) |
  | `list_directory` | `24 entries` / `1 entry` |
  | `find_files` | `17 files` / `1 file` |
  | `search_files` | `23 matches` / `1 match` |

  Rows still never expand by themselves (principle 5).

  **Spoken labels** (Phase 8, W8.10): `workspaceRowSummary` also returns `label`, what a screen reader says instead of
  the visible text. `ToolRowSummary` renders the visible span `aria-hidden="true"` (it keeps `tool-row-summary` and
  `data-tone`, so the visible text and the e2e checks are unchanged) and a sibling `<span class="sr-only">`
  (`data-slot="tool-row-summary-label"`) with the label; the share page inherits it (`ShareToolRow` uses the same
  component):

  | Visible | Label |
  |---|---|
  | `+12 −3` | "12 lines added, 3 removed" ("1 line added, 1 removed"; one side alone: "3 lines removed", "12 lines added"; `diffStatsLabel(a, d)`, also used by `DiffView` and the changes panel) |
  | "New · 40 lines" / "Updated · 40 lines" | "New file, 40 lines" / "Updated, 40 lines" |
  | `exit 1` / `timed out` / `killed SIGTERM` / `exited` | "Exit code 1" / "Timed out" / "Killed by SIGTERM" / "Exited without an exit code" |
  | `lines 1–120 of 340` | "Lines 1 to 120 of 340" ("Lines 1 to 120" without a total) |
  | every other summary | its visible text |

  **Rule badge** (Phase 8, ADR-038): a `shell` row whose output has `allowedBy` shows `ToolRuleBadge` before the
  summary: a muted `ShieldCheck` icon (`tool-row-rule`, `data-value` = the matched prefixes joined with ", ") with the
  sr-only text ", allowed by rule {prefixes}" and the tooltip "Allowed by rule: {prefixes}". `ToolPart` and
  `ShareToolRow` render it. The server sets `allowedBy` whenever every part of the command matched the run's shell
  rules, whatever the permission mode (in Ask and Accept edits such a call ran without a card; in Auto, or after a user
  override `ask`, it still carries the badge); it is absent when no rule matched, e.g. for a command that is only
  `cd`.
- **Expanded body**: `WorkspaceToolBody` replaces the Input / Output blocks (the error block of `output-error` stays)
  and ends with the toggle **Raw input and output** (`tool-raw-toggle`, `data-state` `open` | `closed`), which shows the
  generic `ToolValueBlock`s; the callers (`ToolPart`, `ShareToolRow`) pass those blocks through its `raw` slot, and the
  toggle renders only when the slot is filled. It passes the server's totals to the `stats` prop of `DiffView` (they
  count cut hunks too; a slot until v1.3) and names the empty list through the `empty` slot of `FileList`.
- **DiffView** (`diff-view`, `data-path`, `data-state` `created` | `modified`, `data-numbers` `on` | `off`): a header
  with the path in mono, a "New file" badge, `+a −d` (the `stats` prop, Phase 8; `null` or absent: counted from the
  hunks; shown when additions + deletions > 0, `aria-hidden` with the sr-only `diffStatsLabel` text) and a `CopyButton`
  for the path ("Copy path"); the lines are a grid (old line number | new line number | sign | text) in
  `font-mono text-xs whitespace-pre` inside an `overflow-x-auto rounded-md border` block, so a long line scrolls inside
  the block and never widens the page. Added lines `bg-success/10` with the sign in `text-success`, removed lines
  `bg-destructive/10` with the sign (U+2212) in `text-destructive`, context `text-muted-foreground`, hunk headers
  `@@ −12,5 +12,7 @@` on `bg-muted/60` (`diff-line`, `data-kind` `add` | `del` | `context`); a
  `\ No newline at end of file` line shows as a muted italic note. Runs of more than 8 unchanged lines fold into "⋯ {n}
  unchanged lines" (3 lines stay next to each change); past `maxLines` (200) "Show {n} more lines" (`diff-expand`,
  `data-action` `unfold` | `show-all`); `truncated` → "Diff truncated by server"; no hunks: "The diff is too large to
  show." when `truncated` (a `null` diff: the server's 2 s diff timeout), else "Empty file." for a new file and "No
  changes." otherwise. Below `sm` one line-number column. The prop `lineNumbers: false` (Phase 8; approval previews;
  until v1.3 the fallthrough attribute `data-numbers="off"`) hides both number columns and the hunk headers (hunks are
  then separated by a `⋯` row); the root renders `data-numbers="on"` or `"off"` itself. Each changed line has the
  sr-only label "Added" or "Removed". No syntax highlighting (backlog). The changes panel uses the same component
  (7.21).
- **TerminalOutput** (`terminal-output`, `data-status` `running` | `ok` | `error` | `timeout` | `killed`): a
  `bg-muted/60` block: the `$ command` line (`terminal-command`), then stdout (`terminal-stdout`, `whitespace-pre-wrap
  break-words`), then stderr under a small "stderr" label (`terminal-stderr`; `text-destructive` only when the exit code
  is not 0); ANSI codes are stripped and carriage returns collapsed on the client too (`terminalText`, `utils/ansi.ts`);
  each stream shows its last 40 lines, with "Show all {n} lines" up to the 64 KB body cap of 7.2 (past it "Showing the
  last 64 KB"); footer badges: "Exit code {n}" (`terminal-exit`, `data-value`; only when there is an exit code), "Timed
  out", the signal, and the duration (`formatDuration`), plus "No output" when both streams are empty; while running a
  Spinner + "Running…"; "Output truncated by server" when a stream's byte count is above 20 KiB (the server keeps the
  first 4 KiB and the last 16 KiB of each stream) and above the bytes of the kept text. Phase 8 (ADR-038, sticky
  folder): the command line reads `{cwd} $ command`, the folder muted (`terminal-cwd`, `data-value` = the
  project-relative folder; left out when it is `.`, the project folder); the folder is the output's `cwd`, while running
  the new prop `cwd` (the call's `cwd` input, else the chat's current shell folder from
  `TOOL_APPROVAL_CONTEXT.shellCwd()`, nothing on the share page). When the output's `endCwd` differs from `cwd`, a
  footer badge reads "Now in {endCwd}" ("Now in the project folder" for `.`; `terminal-cwd-change`, `data-value`), and a
  `cwdNote` from the server shows as a muted line below the badges (`data-slot="terminal-cwd-note"`: "The command ended
  outside the project folder; the next call starts in the project folder." or "The working folder {folder} no longer
  exists, so the command ran in the project folder." / "… can no longer be used, …"). An output with `allowedBy` ends
  with the muted line "Allowed by rule: {prefixes}" (`data-slot="terminal-rule"`). Outputs saved before v1.4 have none
  of these fields and render as before.
- **FileContent** (`file-content`, `data-path`): a header with the path and "Copy path", numbered lines starting at
  `startLine`, 20 lines, then **Show all**; "Showing lines {a}–{b} of {total}" (unless it is the whole file) and
  "Truncated by server" when the output says so; "Empty file." without lines.
- **FileList** (`file-list`; items `file-list-item` with `data-path`, plus `data-type` for directory entries and
  `data-line` for search matches): up to 50 items, then "Show {n} more"; directory entries show their name (folders end
  with `/` and get a `Folder` icon, other entries a `File` icon); search matches are grouped by path with `line:`
  prefixes and the matched line in mono; "More results were cut by the server" when `truncated`. An empty list reads
  "The folder is empty." (`list_directory`), "No files match." (`find_files`) or "No matches." (`search_files`); the
  component's own default is "No results.".
- **While running**: a `shell` row shows `TerminalOutput` with "Running…" as soon as its input is available (expanded
  only when the user opens it); other tools keep the spinner status of 7.2.
- **Approval previews** (`ToolApprovalPreview`, `tool-approval-preview`, `data-kind` `diff` | `content` | `command`;
  7.3): `workspaceApprovalView(toolName, input)` builds `edit_file` → a `DiffView` of `diffLines(old_string,
  new_string)` with `lineNumbers: false` (`data-numbers="off"`; `utils/line-diff.ts`: a small LCS without a dependency;
  past its size cap one hunk with every old line removed, then every new line added), `write_file` → "Create or
  overwrite {path} · {n} lines" and a 20-line `FileContent`, `shell` → the command card;
  `workspaceApprovalKind(toolName, input)` gives the same kind without building the diff (the card picks its title and
  buttons from it). The server's hunks are what the user sees for finished edits; the client only diffs the small
  snippets of a preview.
- **Share page** (7.15): `ShareToolRow` uses the same `workspaceToolView`, `WorkspaceToolBody` and row summary when the
  share includes tool details (the summary and body only for finished calls whose output parses); without tool details
  the row stays static, as before. Values longer than 16,384 characters arrive as `[truncated]` strings and fall back
  to the generic text.

### 7.20 Projects in the chat (`ProjectSwitcher`, `NewChatProjectPicker`, `ChatProjectChip`, W7.9 / W7.10)

A project (ADR-031) is a named folder on the server host inside the allowed roots (`HF_WORKSPACE_ROOTS`); a chat
optionally belongs to one, and the workspace tools work only in chats whose project folder opened (ARCHITECTURE.md
6.13). Projects are managed in Settings → Projects (9.10); the chat UI picks, shows and changes them. Wireframe: 2.12.

- **Project switcher** (`ProjectSwitcher`, `project-switcher`, `data-value` `all` | `none` | the id, accessible name
  "Project filter: {name}"): the first row of `ChatNav`, above New chat (5.3). Row: `Folders` + "All chats", `Folder` +
  "No project" or the project name, or `FolderX` in `text-warning` when its folder is missing (`available: false`),
  then a trailing `ChevronsUpDown`. Menu: a `DropdownMenu` radio group (`max-h-80`, scrolls): All chats · No project ·
  separator · the projects sorted by name (name, the path in mono muted text on a second line, the chat count on the
  right; `project-switcher-option`, `data-value`, `data-state` `checked` | `unchecked`) · separator · **Add project…**
  (`FolderPlus`, `project-add`; the switcher mounts its own `AddProjectDialog`, which opens once the menu has closed,
  and after a project is created the filter switches to it) · **Manage projects** (`Settings2`, `project-manage` →
  `/settings/projects`). No project and the project items appear only once a project exists; without any project the
  menu holds All chats, Add project… and Manage projects. The projects load when the switcher mounts and refresh
  whenever its menu opens (chat counts and folder states change on the server without an event).
- **Filtering**: a pick calls `chats.setProjectFilter()`, which empties the paged list and loads it again with
  `GET /api/chats?projectId=<id>` (`none` for No project; nothing for All chats); a first page that fails shows
  **Retry** under the list. The filter is stored in `localStorage['hf-project-filter']` as the raw value (`all`, `none`
  or the id); an id that is unknown once the projects loaded falls back to All chats. Icon mode: an icon button with
  the tooltip "Project: {name}" ("All chats", "No project"). Mobile: the same row inside the sheet; picking a filter
  does not close the sheet. Empty list: "No chats in {name} yet" / "No chats without a project". Search (Mod+K)
  ignores the filter.
- **New chat** (`NewChatProjectPicker`, `new-chat-project`, `data-value` `none` | the id): a ghost pill (h-8,
  `rounded-full`, 40px on coarse pointers) in the default slot of `ChatGreeting`, right under the heading on `/`: "No
  project ▾" or "{name} ▾" with a `Folder` icon (`FolderX` in `text-warning` when the folder is missing); its
  accessible name is "Project: {name}" (", folder not found" when missing); its menu lists `ProjectMenuItems`
  (`project-option`). Not a composer chip: the 390px toolbar is full. `ChatView` feeds it through its `empty` slot
  props `{ projectId, setProject }` (10.4). Default: the switcher's project when the filter names a known project, else
  No project; changing the filter drops an earlier pick. When the filter is not All chats, a pick also sets the filter
  (No project → `none`), so the new chat appears in the visible list. The first send carries `projectId` (11.1); later
  requests never do. Hidden while no project exists; a value naming an unknown project shows (and checks) No project.
- **Chat header** (`ChatProjectChip`, `chat-project-chip`, `data-value` the id, `data-state` `ok` | `missing`): between
  the title and `⋯`, only when the chat has a project the store knows: ghost h-7 (40px on coarse pointers), `Folder`
  (`FolderX` in `text-warning` when missing) + the name truncated at 14rem; below `sm` icon-only; always named
  "Project: {name}" (", folder not found" when missing). It opens a menu with the label "Move to project", the move
  items (`ProjectMenuItems` with No project) and **Project settings** (`Settings2`, → `/settings/projects`). `ChatView`
  loads the projects once itself (the sidebar may not be mounted, e.g. on mobile).
- **Move to project ▸** (`FolderInput`): a submenu in the header `⋯` menu (`chat-menu-move`, right after Rename; shown
  while a project exists or the chat has one) and in the sidebar row `⋯` menu (`chat-row-move`, right after Rename;
  shown once a project exists) listing No project and every project (`project-option`, the current one checked); the
  submenu opens on hover, click or ArrowRight. The move runs once the menu has closed. Moving = `useMoveChat()(chatId,
  projectId)` (11.4): an optimistic `PATCH /api/chats/:id { projectId }`, then the toast "Moved to {name}" (or "Moved
  out of {name}") with **Undo** (`ProjectMovedToast`, `toast-undo`, 5 s; Undo moves the chat back); when the chat's
  summary is not known locally the toast has no Undo. The row leaves the list when it no longer matches the filter, and
  focus moves to the neighbouring row as after a delete. 409 `run-active` → the change rolls back with the toast "Wait
  for the response to finish before moving this chat."; 404 (the project was deleted meanwhile) → "This project no
  longer exists."; any other failure → "Couldn't move the chat" with the server message. A move changes the
  instructions and tools of the chat's next run only; history is not rewritten.
- **Command palette** (W7.9): a "Projects" section, shown only while searching (keywords project, projects, filter,
  folder): Show all chats (`project-filter-all`) · Show chats without a project (`project-filter-none`, once a project
  exists) · Show {name} (`project-filter-<id>`; each checked, `data-checked="true"`, when it is the current filter) ·
  Add project…
  (`project-add`, → `/settings/projects?add=1`) · with a chat open whose summary is known: Move chat to {name}
  (`project-move-<id>`, every project but the chat's own; keywords move, project) · Move chat out of project
  (`project-move-none`, only when the chat has one). The values are the `command-palette-item` `data-value`s.
  "Settings: Projects" comes from `SETTINGS_LINKS` (5.5, `go-settings-projects`).
- **States**: no workspace roots → the Add dialog's alert (9.10); a folder deleted or moved on disk → the `FolderX`
  warning in the switcher, the chip and the settings row, and the next run shows the `workspace-unavailable` notice
  (7.1) instead of offering workspace tools; a chat's project deleted (`project.changed` with `project: null`) → the
  chip disappears, the chats lose their `projectId` locally, and a filter on that project resets to All chats with the
  toast "The project was deleted. Showing all chats."; the permission mode Accept edits is offered only in project
  chats (7.11).
- **No new shortcuts** (12): the palette covers keyboard reach, and Alt+P still opens the permission menu.

### 7.21 Changes panel (`ChatWorkspace`, `ChangesToggle`, `ChangesPanel`, W8.8; Phase 8)

The one side panel of the app (principle 1.2 as amended by ADR-037): in a **project chat** it lists the files the agent
changed and the project's Git status, each with a diff and **Revert file**. Two views: **This chat** (the net changes
of this chat, from the server's checkpoint journal; works without git; ARCHITECTURE.md 6.16) and **Git** (`git status`
and a diff against HEAD when the project folder is inside a git work tree; 6.17). Data: `GET /api/chats/:id/changes`,
`GET /api/chats/:id/changes/diff?source=&path=`, `GET /api/chats/:id/git` (API.md, `changes` module). Wireframe: 2.15.

- **Mount** (`ChatWorkspace`, `components/workspace/ChatWorkspace.vue`): `pages/chat/[id].vue` wraps `ChatView` in it
  (`chatId`, `projectId` = the session's `projectId` from the registry, the lookup the page already uses for the
  title); no layout or ui store change. It always renders a horizontal `ResizablePanelGroup` around the chat panel, so
  opening or closing the panel never remounts `ChatView` (scroll position and the stream survive). The handle
  (`changes-resize`) and the side panel (an `<aside>` labelled by the panel's `h2`, `ChangesPanel variant="pane"`) are
  added only while the viewport is at least 1024px wide, the panel is open and the chat has a project. Below 1024px the
  same component renders a right `Sheet` (full width below `sm`, `sm:max-w-lg` above, `showCloseButton` off: the
  panel's own 40px close button) holding `ChangesPanel variant="sheet"`. The sheet never opens by itself: below 1024px
  (on load, or a window narrowed while the pane shows) `ChatWorkspace` marks the viewport narrow
  (`setChangesPanelNarrow(true)`), so the panel reads closed while the saved open state stays (Phase 9: earlier
  versions cleared it); only the toggle, Alt+C or the palette open it there. A wide viewport again shows the saved
  state, so narrowing the window and widening it back keeps the pane open. Without a project only the chat panel
  renders. It registers Alt+C (12) and publishes the chat as the palette's changes target (`changes-context.ts`)
  while the chat has a project. DOM ids: the chat panel `#hf-chat-panel`, the handle `#hf-changes-resize`, the pane
  `aside#hf-changes-pane`, the panel root `#hf-changes-panel` (the toggle's `aria-controls`) and its `h2`
  `#hf-changes-heading` (labels the pane and the sheet).
- **Sizes**: the pane defaults to 440px, at least 320, at most 720, and the chat panel keeps at least 40% of the inset
  (at 1024px with the sidebar expanded the inset is 760px, so the pane is then at most about 456px). The px values are
  converted to the group's percentages and recomputed when the group resizes; the transcript keeps its `max-w-3xl`
  column centred in the chat panel (5.7). The panel never collapses the sidebar, and Mod+B is unchanged. The handle
  has a 24px hit area on coarse pointers and moves with the arrow keys.
- **Persistence** (`useChangesPanel`, 11.5; per browser, not per chat): `localStorage['hf-changes-width']` (the pane
  width in px, written from the pane's `resize` event only while the user drags the handle or moves it with the arrow
  keys, so a width the window size forced is never stored; clamped to 320–720 when read and written; not reka's
  `autoSaveId`, which stores percentages, so the pane would drift whenever the window is resized; the pane reads it
  when it opens), `['hf-changes-open']` (`1` / `0`, default closed; the user's choice, written only by an explicit open,
  toggle or close: `setOpen` / `toggle`) and `['hf-changes-view']` (`chat` | `git`, default `chat`). Blocked storage
  keeps the state in memory.
- **Toggle** (`ChangesToggle`, `changes-toggle`, `data-state` `open` | `closed`, `data-count`): a ghost icon button
  (`PanelRight`) in `ChatHeader` between `ChatProjectChip` and `⋯` (5.6), with a count pill of the files this chat
  changed (`workspace.changeCount(chatId)`; hidden at 0, "9+" above 9), `aria-pressed`, `aria-controls` (the pane or
  sheet, while open), the label "Show changes" ("Show changes, 3 files changed") or "Hide changes" and the tooltip
  "Show changes" / "Hide changes" with the Alt+C hint (hidden below `lg` and on touch); 40px on coarse pointers; the
  pill is `data-slot="changes-count"`. It renders nothing without a project and loads the chat's changes once on mount
  (again, forced, when the chat moves to another project), so the count is right before the panel opens.
- **Header** (`ChangesPanel`, `changes-panel`, `data-view` `chat` | `git`, `data-state` `loading` | `ready` | `error` |
  `unavailable`, `data-variant` `pane` | `sheet`): h-12 like the chat header: the `h2` "Changes", `Tabs` **This chat** |
  **Git** (`changes-view-option`, `data-value` `chat` | `git`; the choice persists), **Refresh** (`changes-refresh`,
  `RefreshCw`, "Refresh changes"; spins with `aria-busy` while loading) and **Close** (`changes-close`, `X`, "Close
  changes"). Below it the summary line (`changes-summary`, `data-count`) and the list; the whole panel is one scroll
  area.
- **Summary**: This chat: "3 files changed · +24 −7" ("1 file changed"; the totals of the known line counts, left out
  when none is known). Git: "On {branch} · 4 files changed" ("On {branch}" alone when clean; "Detached at {head}" with
  the first 7 characters of HEAD when there is no branch; "No commits yet" for an unborn HEAD, "No commits yet · 3
  files changed" with files). An unavailable view and This chat without rows show no summary (the empty state says
  it).
- **Rows** (`ChangesFileRow`, `changes-file`, `data-path`, `data-status`, `data-state` `open` | `closed`,
  `data-conflict="true"` when the file changed outside this chat): an accordion; the row is a button with
  `aria-expanded` / `aria-controls`: a 16px status tile (`data-slot="changes-status"`; the letter in `text-foreground`
  on a tint, 14.3, with sr-only text): **A** added (`bg-success/15`, "Added"), **M** modified (`bg-warning/15`,
  "Modified"), **D** deleted (`bg-destructive/15`, "Deleted"), **U** untracked (`bg-muted`, "Untracked"), **R** renamed
  (`bg-info/15`, "Renamed"), **!** conflicted (`bg-destructive/15`, "Conflicted"), **T** type changed (`bg-muted`, "Type
  changed"); the path in mono (truncated from the start, the full path in `title`; a rename reads `{origPath} →
  {path}`); `+a −d` (This chat, when known; `data-slot="changes-counts"`, read as `diffStatsLabel`); `TriangleAlert` in
  `text-warning` (`data-slot="changes-conflict"`) with the sr-only text "changed outside this chat" (This chat,
  `changedOutside`: the file on disk is not what the agent last wrote); then **Revert file** (`changes-file-revert`,
  `data-path`, `Undo2`, "Revert {path}"), shown on hover or focus-within and always on coarse pointers (40px). Revert is
  not offered for a row that is not `revertible` (This chat: the earlier version was too large to store or is no longer
  stored) or for a conflicted Git row. Rows keep the server's order (This chat: most recently changed first; Git: by
  path); This chat leaves out files that are back to their original state (`unchanged`). The server caps the lists (500
  / 2,000 files); there is no virtualization.
- **Diff** (`ChangesFileDiff`): an opened row loads `GET /api/chats/:id/changes/diff?source={view}&path={path}` once (a
  3-line skeleton meanwhile; the request aborts when the row closes; cached in the store until the next refresh) and
  renders `DiffView` (7.19) with the hunks of `FileDiff.diff`, its `added` / `removed` as `stats` and line numbers
  (`added` and `untracked` files as a new file). `binary` → "Binary file. No preview."; `tooLarge` → "This file is too
  large to show a diff."; `baseAvailable: false` (This chat) → "The earlier version of this file is no longer stored,
  so it can't be shown or reverted." (the three notes are `data-slot="changes-diff-note"`); another `null` diff →
  `DiffView`'s "The diff is too large to show."; a failed load → "Couldn't load the diff" with the server message and
  **Retry** (`data-slot="changes-diff-error"`, `data-code`). The wrapper is `data-slot="changes-diff"` (`data-state`
  `loading` | `ready` | `error`). After a refresh an open row keeps its shown diff until the new one arrives. Each
  loaded diff tells the panel its `currentSha` (`changes-context.ts`), the revert's `expectedSha`.

| State | What shows |
|---|---|
| First load | 3 skeleton rows (`data-state="loading"`) |
| Refresh | the Refresh icon spins (`aria-busy`); the rows stay |
| Error | an `Alert` "Couldn't load the changes" with the server message and **Retry** (`changes-error`, `data-code`); earlier rows stay |
| This chat, nothing changed | "No file changes in this chat yet." (`changes-empty`, `data-reason="none"`) |
| No project (the chat's project was deleted) | "This chat has no project." (`no-project`; `data-state="unavailable"`) |
| Git, clean tree | "No changes since the last commit." (`clean`) |
| Git, not a repository | "This project isn't a Git repository." (`not-a-repo`) |
| Git, no git on the server | "Git isn't installed on the server." (`git-missing`) |
| Git refused the repository | "Git refused to read this repository. It may belong to another user (see the projects guide)." (`refused`; typical for a Docker bind mount owned by another uid) |
| Git too slow or failed | "Git took too long to answer." (`timeout`) / "Git couldn't read this repository." (`failed`) |
| Folder missing | `FolderX` + "The project folder wasn't found." (`folder-unavailable`; `data-state="unavailable"`) |
| Truncated | the footer "Showing the first 500 files." (This chat) / "Showing the first 2,000 files." (Git; `data-slot="changes-truncated"`) |
| Untracked changes (This chat) | a muted footer note when shell commands or other workspace tools ran in this chat (`untracked`): "3 shell commands and 1 other tool call in this chat may have changed files too. They aren't listed here." (a zero part is left out; `data-slot="changes-untracked"`) |

- **Refresh triggers** (no polling): `workspace.changed` for this chat or its project (debounced 300ms per chat; agent
  edits arrive at most once a second during a run, so the panel follows a run live; an event from another chat of the
  project also refreshes the open chat's This chat view, for its "changed outside this chat" marks), `run.finished` of
  this chat, an event-stream reconnect (`workspace.refreshLoaded()`), window focus while the Git view is shown, the
  chat moving to another project, and Refresh. A view loads on mount and on a view switch. A refresh drops the view's
  cached diffs and reloads the diffs of open rows.
- **Revert** (`RevertFileDialog`, styled as the `ConfirmDialog` and built on its `AlertDialog` parts, keeping
  `data-slot="confirm-dialog"`, so a successful revert can move focus to the next row itself): title "Revert {name}?"
  (the file name), then by view and status: This chat: "{path} goes back to how it was before this chat changed it."
  (added: "{path} is deleted. This chat created it."); Git: "{path} goes back to the last commit." (untracked: "{path}
  is deleted. Git doesn't track it."; added: "{path} is deleted. It isn't in the last commit."; renamed: "{origPath}
  comes back and {path} is deleted."). A This chat row with `changedOutside` adds "It also changed outside this chat
  after the agent's last edit. Those changes are reverted too." (`data-slot="revert-changed-outside"`); every revert
  adds "The current version is saved first, so you can undo this." Confirm **Revert file** (`changes-revert-confirm`,
  destructive) → `POST /api/chats/:id/changes/revert { source, path, expectedSha }` (`expectedSha` = the `currentSha` of
  the row's loaded diff, `null` when that diff showed the file missing, so a revert never overwrites a version the user
  did not see; left out when the diff was never opened). Success with a `batchId` → the toast "Reverted {path}"
  (`data-slot="changes-reverted-toast"`, 8 s) with **Undo** (`toast-undo`) → `POST /api/chats/:id/changes/undo {
  batchId, conflicts: 'skip' }` → "Restored {path}", or "{path} changed after the revert, so it was not restored." when
  the undo skipped it (a failed undo: "Couldn't restore {path}" with the server message; 409 `run-active`: the
  run-active text below); success without a `batchId` and nothing skipped → a plain "Reverted {path}"; an answer that
  skipped the file (`batchId: null`, e.g. `unavailable` for a This chat base that is too large or no longer stored,
  answered 200) → toast "Couldn't revert {path}" with the skip message. The polite region announces "Reverted {path}";
  the list refreshes through `workspace.changed`. Errors: 409 `run-active` → toast "Wait for the responses in this
  project to finish before reverting files."; 409 `stale` → toast "{path} changed since its diff was loaded. Check it
  again.", the view reloads and the row opens, so its diff reloads; 400 (a conflicted file, a symbolic link, a
  submodule, a filtered path such as Git LFS, a chat without a usable project folder, the Git view not available) and
  every other failure → toast "Couldn't revert {path}" with the server message; 404 → the stale-chat toast of 7.4 ("This
  chat changed elsewhere and was reloaded.") and the view reloads. The dialog cannot be dismissed while the request
  runs.
- **Focus**: a click on the toggle keeps focus on the toggle; Alt+C and the palette item move focus to the active view
  tab when they open the panel; Close (and Alt+C pressed inside the pane) returns focus to the toggle; the sheet traps
  focus, Esc closes it and its `close-auto-focus` returns focus to the toggle. After a revert focus moves to the next
  row (else the previous one, else the active view tab); a canceled or failed revert returns it to the row's Revert
  button.
- **Palette** (W8.8, `palette.ts`): on project chat pages (the `ChatWorkspace` target) the Actions section ends with
  "Show changes" / "Hide changes" (`command-palette-item`, `data-value="toggle-changes"`; keywords changes, diff, git,
  files, panel, revert; the Alt+C hint only while `altShortcuts` is on).
- **Narrow screens**: at 390px the sheet is full width, paths truncate, a diff scrolls sideways inside its own block,
  and the page never scrolls horizontally (14.5).

### 7.22 Rewind files (`RewindDialog`, `MessageActions`, W8.9; Phase 8)

"Rewind files to here" restores the project files this chat changed **after a user message was sent** (ADR-036,
time-based: it covers every version and earlier reverts or rewinds of the chat; edits of other chats are never undone,
they show as conflicts). The conversation itself stays; "Restore files and edit" adds the existing edit flow on top.
Shell commands and other tools are not restorable: the dialog lists them. Wireframe: 2.15.

- **Button** (`MessageActions` prop `canRewind` + emit `rewind`; `message-rewind`, `History`, "Rewind files to here",
  after Edit and before Delete this version, 40px on coarse pointers): on a **user** message only, when the chat has a
  project, no request is in flight (hidden through the transcript's `data-busy`, like Edit) and a `write_file` or
  `edit_file` part in state `output-available` follows the message on the shown path. `ChatTranscript` computes the
  set of such message ids in one backwards pass (only with its new optional prop `projectId`, which `ChatView` passes;
  finished older messages are cached in a `WeakMap`; `rewindable.has(id)` is part of each row's `v-memo`);
  `ChatMessage` passes `canRewind` down and re-emits `rewind`; `ChatTranscript` emits `rewind: [messageId]`; `ChatView`
  ignores it while a request is in flight. The rule only decides visibility; the preview is the truth (edits made
  before v1.4 have no checkpoints, so their preview is empty).
- **Dialog** (`RewindDialog`, `components/workspace/rewind/`, `rewind-dialog`, `data-state` `loading` | `ready` |
  `empty` | `error` | `restoring`, on a wrapper inside `DialogContent`, whose own `data-state` `open` | `closed` belongs
  to reka; owned by `ChatView` like the delete-version dialog; it calls the API itself, the workspace store has no
  rewind members): opening it calls `GET /api/chats/:id/rewind?messageId=` (aborted when it closes; a skeleton
  meanwhile, `data-slot="rewind-loading"`). Title "Rewind files to here?",
  text "Files the agent changed after this message go back to how they were before it. The conversation stays as it
  is.", then the files (`rewind-file`, `data-path`, `data-action` `restore` | `delete` | `unavailable`,
  `data-conflict`): the path in mono, a badge "Restore" / "Delete" (the file was created after the message) / "Can't
  restore" (its earlier version is no longer stored; tooltip "The earlier version of this file is no longer stored."),
  and `TriangleAlert` with the sr-only text "changed outside this chat" on a conflict; the list is named "Files to
  restore"; files that already match are not listed; "and more files" when the server cut the list (500).
  - With a conflict: the unchecked `Checkbox` "Also restore files changed outside this chat" (`rewind-force`): checked
    sends `conflicts: 'force'`, unchecked skips those files.
  - Always the muted line "Shell changes aren't tracked."; when commands ran after the message a warning `Alert`
    (`data-slot="rewind-shell"`) "These commands ran after this message; their effects on files stay:" with the
    latest 10 commands, newest first (`rewind-shell-command`, the first line in mono, truncated with the full command
    in `title`) and "and {n} more" (counted from `untracked.shellCount`); when other workspace tools ran: "Other tools
    changed files too: {tools}. Their changes stay." (unique tool names, latest first).
  - Buttons: Cancel · **Restore files and edit** (outline, `rewind-restore-edit`) · **Restore files** (primary,
    `rewind-restore`; not destructive, since it can be undone). A preview without anything to restore reads "Nothing to
    restore. The files already match." (`data-slot="rewind-empty"`) and offers only Close; a failed preview offers only
    Close too.
- **Restore** → `POST /api/chats/:id/rewind { messageId, conflicts: 'skip' | 'force' }`; the dialog stays open and
  cannot be dismissed while it runs, then emits `restored(result, then)` and closes. **The result toast lives in
  `ChatView`** (`useRewindResultToast()` in `rewind/rewind-toast.ts`; `RewindResultToast`,
  `data-slot="rewind-result-toast"`, 8 s): "Restored {n} files" ("Restored 1 file"; n = restored + deleted) with the
  lines "Skipped {k} files changed outside this chat" and / or "Skipped {k} files that can't be restored", and **Undo**
  (`toast-undo`) when the answer has a `batchId` → `workspace.undo()` (`POST /api/chats/:id/changes/undo { batchId,
  conflicts: 'skip' }`) → the undo's own result toast with the same texts and no Undo; a failed undo → "Couldn't undo
  the rewind" with the server message. Nothing written → the toast "Nothing was restored." with the same lines, or
  "The files already match." when nothing was skipped either. The changes panel refreshes through
  `workspace.changed`; the session does not reload (no message changed).
- **Restore files and edit**: after the restore `ChatView` calls `transcript.startEdit(messageId)`: the existing
  `MessageEditor` opens on that message and Send goes through the unchanged `session.edit()` (a new version, ADR-023).
- **Errors**: a `404` or a `409 conflict` (`run-active`, or no reason) of the preview or the restore closes the dialog
  and goes to its host through the injection key `REWIND_DIALOG_HOST` (`rewind/rewind.ts`; `ChatView` provides it, the
  dialog's emits stay as frozen): 409 → toast "Wait for the responses in this project to finish before rewinding
  files."; when `details.chatId` is this chat (or not named) the session marks it running and follows the run
  (`resumeIfRunning`). 404 → the stale-chat toast of 7.4 and `session.refresh()`. 400 (not a user message, no project,
  the folder unavailable) and every other failure → an inline destructive alert in the dialog (`rewind-error`,
  `data-code`, `role="alert"`): "Couldn't check the files" (the preview) or "Couldn't restore the files" (the restore,
  the list and the buttons stay) with the server message. Without a host every failure shows inline.
- **Focus**: the dialog opens on Cancel while the preview loads, then on **Restore files** (Close when there is
  nothing to restore or the preview failed); an inline restore failure puts it back on Restore files. Cancel, Esc, a
  failure handed to `ChatView` and Restore files return focus to `message-rewind` (`transcript.focusRewind(messageId)`;
  the dialog turns reka's own return off); after Restore files and edit it is in the editor.

### 7.23 Shell rules (`AllowRuleOption`, `AllowlistEditor`, W8.10 / W8.11; Phase 8)

A **shell rule** (ADR-038) is a command prefix: its words must equal the first words of a command part (`pnpm test`
matches `pnpm test --run x`, not `pnpm testx` or `pnpm -C x test`). Project rules apply to the chats of that project,
global rules ("Allowed in every project") to every project. In **Ask** and **Accept edits** a `shell` call runs without
a card when every part of the command (split on `&&`, `||`, `;`, `|` and newlines) matches a rule or is a `cd` into a
folder of the project; **Auto** is unchanged; a user override (`deny` / `ask`) or a `tool.approve` hook still wins. A
command always asks when it uses `$`, backticks, redirections (other than to `/dev/null` and fd copies such as `2>&1`),
`( )`, `{ }`, a trailing `&`, here-docs, unquoted `* ? [`, a word starting with `~` or `#`, shell keywords, a `VAR=x`
prefix, `cd` without a literal folder, or more than 32 parts. The server matches (it reloads the rules for every run);
the web uses the same pure parser (`packages/shared/src/util/shell-command.ts`) only to suggest and validate.

- **On the approval card** (`AllowRuleOption`, `components/workspace/allowlist/`, mounted by `ToolApprovalCard` for the
  builtin `shell` only; 7.3, wireframe 2.15): `ruleSuggestion(command)` (`allow-rule.ts`) asks
  `suggestShellRules(command)` for one prefix per part that needs a rule (deduplicated, in order; `cd` parts need
  none); an empty result replaces the option with the note of 7.3 (`data-slot="allow-rule-note"`). The checkbox
  "Always allow commands starting with" (`tool-approval-allow-rule`, inside `data-slot="allow-rule"`) reveals, once
  checked (`data-slot="allow-rule-details"`; checking it does not move focus):
  - one prefix: an editable `Input` (`tool-approval-rule-prefix`, `data-value`, named by the checkbox label), checked
    on every change with `checkRulePrefix(prefix, command)`: `parseShellRule`, then `matchShellRules(command,
    [canonical])` (the edited rule must still cover the command); several prefixes: read-only mono chips
    (`tool-approval-rule-prefix` each, `data-value`) and the note "This command has several parts: one rule is added
    for each.";
  - the scope `ToggleGroup` (`tool-approval-rule-scope`, `data-value` `project` | `global`, named "Where the rule
    applies"): **This project** (default) or **All projects**; clicking the active item keeps it;
  - the hint "Combined commands run only when every part matches a rule.";
  - inline errors while checked (`tool-approval-rule-error`, `data-code` = the reason below, linked to the input with
    `aria-describedby`); **Run** is disabled while the box is checked and a prefix is invalid (the option emits
    `valid`). The card shows no one-word warning (the Settings editor does).

  Run → the card's `decide` carries `allowRules: { prefixes, scope }` (the canonical prefixes; Deny ignores it) →
  `ToolPart` and `ChatMessage` pass it on → `session.approve()` first awaits `POST /api/shell-rules { projectId,
  prefix }` for each prefix, one after another (`projectId` null for All projects; 409 `exists` counts as saved; every
  prefix is tried even after a failure; This project in a chat without a project fails at once with "This chat has no
  project. Choose All projects for the rule."), then sends the approval unchanged (`addToolApprovalResponse`), so the
  continuation already sees the rules. It never writes an `override: allow` for an `execute` tool (the server refuses
  it with 400). A failed save still sends the approval and then rethrows the first failure: `ChatView` shows the toast
  "Could not save the rule" with its message.
- **Badge**: a call allowed by rules shows `ToolRuleBadge` in its row and "Allowed by rule: …" in its terminal output
  (7.19).
- **Settings** (9.10, wireframe 2.15): each project row's `⋯` menu has **Allowed commands…** (`project-allowlist`,
  `ShieldCheck`) → `AllowlistDialog` (`allowlist-dialog`, title "Allowed commands in {name}"), and its meta line counts
  "{n} allowed commands" ("1 allowed command"; left out at 0). Below the project list `GlobalAllowlistSection`
  (`allowlist-section`, `SettingsSection` "Allowed in every project"). The dialog description and the section
  description carry the explanation "Shell commands that start with one of these run without asking in this
  project." ("in every project" for the global list) "Combined commands run only when every part matches; redirections
  and substitutions always ask." (`allowlistDescription()`, `allowlist/allowlist.ts`). Both render `AllowlistEditor`
  (`data-slot="allowlist-editor"`):
  - the muted risk note "A rule for a script runner such as pnpm test or make also lets the agent run any code it
    writes into the project.";
  - the rules sorted by prefix (`allowlist-rule`, `data-rule-id`, `data-value` = the prefix, in mono) with **Remove**
    (`allowlist-rule-remove`, `Trash2`, "Remove {prefix}"; immediate, no confirmation; when focus was in the editor it
    then moves to the next rule's Remove, else the previous one, else the input; a failure → an error toast with the
    server message). There is no edit: remove the rule and add a new one;
  - the add form: an `Input` (`allowlist-input`, placeholder "pnpm test", named "Start of a command to allow") and
    **Add** (`allowlist-add`; Enter submits) → `checkRulePrefix(prefix)` first, then `shellRules.create({ projectId,
    prefix: canonical })`; the input clears and keeps focus (also after an error); errors inline (`allowlist-error`,
    `role="alert"`, `data-code` = the `parseShellRule` reason or the `HarnessError` code: `conflict` for 409 `exists`,
    `validation_error` for a 400); a valid one-word prefix shows the non-blocking warning "This allows every {word}
    command." (`data-slot="allowlist-warning"`) while typing; a new text clears the error;
  - while the rules load: two skeleton rows and the sr-only "Loading allowed commands…"; empty: "No allowed commands
    yet." (`allowlist-empty`); a failed first load: `SettingsLoadError` "Couldn't load the allowed commands" with
    **Retry**.
- **Validation copy** (the card and the editor; reasons from `parseShellRule`):

| Reason | Text |
|---|---|
| `empty` | "Enter the start of a command." |
| `too-long` | "Use at most 200 characters." |
| `syntax` | "Use a plain command without \|, ;, &&, redirections or substitutions." |
| `command-runner` | "{word} runs other commands, so it can't be allowed by a rule." |
| `shell-builtin` | "{word} changes the shell or runs its arguments, so it can't be allowed by a rule." (`export`, `declare`, `printf`, `read`, `test`, `[`, `set`, `trap`, …) |
| `interpreter` | "A rule for {word} alone would allow any code. Add what follows it, such as a script name." |
| `cd` | "cd needs no rule: changing into a project folder is always allowed." |
| no match (card only) | "This doesn't match the command." |
| 409 `exists` (editor, `data-code="conflict"`) | "This rule already exists." |
| 400 (editor, e.g. the 200-rule cap: "This project already has 200 shell rules. Remove one first.") and other failures | the server message (`data-code` = the `HarnessError` code) |

- **Store**: `useShellRulesStore` (11.5) loads on first use (an editor that mounts before the rules were ever loaded,
  the Settings → Projects page on every visit, or a card that saves a rule: `create` then starts the first load in the
  background) and after an event-stream reconnect when loaded; there is no rule event. A second `fetchAll()` joins the
  running one, which replays the creates and removes made meanwhile; `remove` counts a 404 as removed. Deleting a
  project (`project.changed` with `project: null`, also applied locally by Settings → Projects after its own delete)
  drops its rules (the server deletes them with the project).

### 7.24 Compaction (`CompactionDivider`, `compaction.ts`, W9.11; Phase 9)

A **compaction** (ADR-040) replaces older context with a model-written summary, stored as a `data-compaction` part on
the message path (ARCHITECTURE.md 6.18). For the model the latest marker on the path replaces everything before it;
the stored messages stay and are only dimmed. Three ways it happens: **`/compact [focus]`** (manual; the reply holds
only the marker), **automatic before a reply** (the estimate passed 80% of the context window before the first model
call; the marker opens the reply) and **automatic during a long reply** (between two steps; the marker sits inside the
reply). The marker data (`CompactionData` from `@harness-forge/shared`): `{ trigger: 'manual' | 'auto', keep: 'none' |
'last-user', summary, focus?, todos?, modelRef, messagesCompacted, tokensBefore, tokensAfter, createdAt }`. It has no
state: while the summarizer runs, the server sends the transient `data-activity { kind: 'compacting' }` (then `idle`),
and a failure is the notice `compaction-failed` (the old trimming happened instead) rather than a failed marker.

- **Layout** (`components/chat/compaction/compaction.ts`, pure): `compactionLayout(messages)` runs over
  `compactionMarkers(messages)` from `@harness-forge/shared` (`util/agent-state.ts`; never re-implemented) and returns
  `{ dimmed: ReadonlySet<string> }`: the ids of the messages before the **latest** marker's message, minus the kept user
  message when that marker has `keep: 'last-user'` (the model still sees it, so it stays at full opacity; found with
  `compactionCutoff`). The markers of finished messages are cached in a `WeakMap` (like `rewindable`; the last message
  is never cached, it may still change while it streams). `messageCompaction(message)` gives `ChatMessage` the variant
  of each marker of one message and the part index of its last one: in a row that is not dimmed itself, the blocks
  before that marker are dimmed (an in-run compaction; these blocks get only the dimming classes, no
  `data-compacted`). Earlier markers render as dividers but dim nothing extra. A branch above a marker, a regenerate of
  the reply that held it or a deleted marker message simply shows the path without it (the rule is the server's,
  ADR-023).
- **Divider** (`CompactionDivider`, `compaction-divider`): a full-width row at the part's position (`chat-format.ts`
  block kind `compaction`): two `aria-hidden` rules around the `FoldVertical` icon, the label, the meta line "{n}
  messages summarized · 182K → 9K tokens" ("1 message summarized"; `data-slot="compaction-meta"`, `compactionMeta`;
  `messagesCompacted`, `tokensBefore`, `tokensAfter` formatted by `Intl.NumberFormat` compact notation with at most one
  decimal: 182K, 14.3K, 1.3M; hidden below `sm`) and the toggle **Show summary** / **Hide summary**
  (`compaction-toggle`, `data-state` `open` | `closed`, `aria-expanded`, `aria-controls`; 40px on coarse pointers). The
  variant (`data-variant`) comes from `CompactionMarker.inline` of the shared helpers: an automatic marker with a
  content part before it in its own message (step boundaries, notices and the activity part do not count) is `run`,
  every other marker (manual ones always) is `history`. The label (`compactionLabel`): `trigger: 'manual'` →
  "Conversation compacted"; `auto` + `history` → "Conversation compacted automatically"; `auto` + `run` → "Context
  compacted during this response".
- **Summary** (`compaction-summary`, collapsed by default, not persisted): a card with the header "Summary" and a
  `CopyButton` ("Copy summary"), then a focusable `role="region"` named "Summary" holding "Focus: {focus}" when set
  (`data-slot="compaction-focus"`) and the summary as `Markdown`, and the footnote "The model sees this summary instead
  of the messages above."; `max-h-[50dvh]`, scrolls inside.
- **Dimmed rows** (`ChatMessage` prop `compacted`): the roots `message-user` / `message-assistant` get `data-compacted`
  and `opacity-70 transition-opacity`, back to full opacity on hover and focus-within (actions, versions, rewind and
  copy keep working). No per-row screen-reader text: the divider explains it.
- **While compacting**: the session's `activity` (11.6) is `compacting` from the transient chunk until `idle` or the
  end of the stream; meanwhile the submitted placeholder and the streaming reply show the shimmer "Compacting
  conversation…" instead of "Thinking…". A streaming reply whose last block is a divider shows "Thinking…" until the
  next step renders (so it can flash briefly after an in-run compaction). `ChatView` announces "Conversation
  compacted" once when a new marker arrives in its own stream (markers of a loaded path are only remembered; a resume
  replay of a run counts as its own stream, so the markers it replays are announced too).
- **`/compact`** (7.8): with nothing to compact the reply is the text "There is nothing to compact yet."; Regenerate on
  a `/compact` reply compacts again; the context ring drops right away (7.12). Its usage row has the purpose `compact`.
- **Failure**: the notice `compaction-failed` (warning, `FoldVertical`) with the server text, e.g. "Couldn't compact
  the conversation. Older messages were left out instead."; with `autoCompact` off the old `context-trimmed` notice
  shows instead (9.11).
- **Elsewhere**: the Markdown export renders "_Conversation compacted (N messages summarized)_" ("1 message
  summarized") followed by the summary as a quote; share pages drop the marker and leave out a whole `/compact`
  exchange (the command and its marker-only reply, 7.15); search does not index summaries; chat export / import keeps
  the marker (positional, so it survives the id remapping).
- **Mobile**: the rules shrink, the meta line hides, the summary card scrolls inside `max-h-[50dvh]`; no horizontal
  scroll.

### 7.25 Plan mode and todos (`PlanApprovalCard`, `PlanBody`, `TodoList`, `TodoStrip`, W9.10; Phase 9)

**Plan mode** (ADR-041): permission mode `plan` (7.11) lets the agent read and search but not change anything; it then
calls `exit_plan_mode { plan }` (markdown, at most 50,000 characters) and the user decides on the card. Only project
chats offer it.

- **Card** (`PlanApprovalCard`, `components/chat/agent/`, `plan-approval`, `data-state` `pending` | `sending`; wireframe
  2.16): rendered by `ToolPart` instead of `ToolApprovalCard` while an `exit_plan_mode` part of `core-agent` awaits its
  decision (`approval-requested`). Built on `AiConfirmation` with `border-info/50 bg-info/5`, `role="group"` named "Plan
  ready for review", the source "from core-agent". The plan renders through `PlanBody` (`Markdown`) inside a
  `tabindex="0"` `role="region"` named "Plan" (`plan-approval-plan`, `max-h-[45dvh]`, scrolls). Below it the optional
  `Textarea` "Feedback for the agent (optional)" (`plan-feedback`, 1 → 4 rows, at most 2,000 characters, the server's
  `approvalReasonMaxChars`; a longer text shows "Use at most 2,000 characters." and disables the buttons) and the
  buttons **Keep planning** (`plan-keep-planning`, outline), **Approve, ask before edits** (`plan-approve-ask`, outline)
  and **Approve, accept edits** (`plan-approve-edits`, primary). There is no implicit approval on Enter (the field is a
  plain textarea, not a form); every control is disabled while the decision is sent (`sending`: after a click, or while
  the `disabled` prop is set). The card never takes focus when it appears (the approval is announced, "Plan ready for
  review"); after a decision it asks for the composer's focus through the ui store (`ui.requestComposerFocus()`, not on
  touch devices). While it waits, the row's status reads "Plan ready for review" with an info dot.
- **Decision**: the card emits `decide { approved, mode?, feedback? }`; `ToolPart` emits `approval { id, approved,
  toolName, alwaysAllow: false, planMode, reason }` up to `ChatView`, and `session.approve()` (11.6) first sets the
  chat's `toolMode` (`edits` or `ask`, saved on the chat) and then calls `addToolApprovalResponse({ id, approved, reason
  })`; the continuation therefore runs in the new mode (the server refuses an approval whose continuation would run in
  any mode other than `edits` or `ask`, `auto` included: 400 on `['toolMode']`; the requested mode is stored on the chat
  even then). `mode` is set only with `approved: true`, and the feedback is trimmed. Keep planning sends `approved:
  false` with the feedback as `reason` and keeps `plan`; the agent revises the plan and shows a new card. `ChatView`
  announces "Plan approved. Permission mode: Accept edits." (or "… Ask.") or "Feedback sent. The agent keeps planning."
- **Row after the decision**: "Approved · Accept edits" / "Approved · Ask" (`Check`) or "Kept planning" (`PencilLine`);
  its body is `PlanBody` plus "Your feedback: {reason}" when one was sent. A plan card on another version stays pending
  like any approval (7.3); a new user message supersedes it.
- **Mobile**: the actions are `flex-col-reverse sm:flex-row`, full width, 40px tall on coarse pointers, so "Approve,
  accept edits" is on top.
- **Plan file** (Phase 10, ADR-047; `PlanFileChip`, `components/chat/agent/`, `plan-file`): with **Save approved plans**
  on (`planFiles`, 9.11), approving a plan in a project chat writes it to `<planDirectory>/<YYYY-MM-DD>-<slug>.md` in
  the project (default folder `.harness/plans`; the slug comes from the plan's first heading or line, accents dropped,
  at most 48 characters; a name that exists gets `-2`, `-3`, … up to `-99`). The `exit_plan_mode` output then carries `planPath` (the project-relative path), or `planError`
  when the write failed (the approval itself never fails because of it). The row body of an approved plan starts with
  the chip, before `PlanBody`:
  - saved (`data-state="saved"`, `data-path` = `planPath`): "Saved to" and a focusable mono path chip
    (`data-slot="plan-file-path"`, `FileText`; the folder is cut so the file name stays visible, the full path in a
    tooltip, the accessible name "Plan saved to {path}"), a **Copy path** icon button (`CopyButton`, "Copy path",
    `plan-file-copy`) and, in a project chat, **Show changes** (`plan-file-show-changes`, a link button that opens the
    changes panel on its "This chat" view through
    `useChangesPanel().setOpen(true, { focus: true })`; the file is journaled under the reply, so it is listed there and
    "Rewind files to here" removes it);
  - failed (`data-state="failed"`): a warning line (`TriangleAlert`, `text-warning`) "Couldn't save the plan file:
    {planError}";
  - neither field (the setting was off, the chat has no project, the plan was rejected, an output from before v1.6):
    no chip. The share page shows no chip (`ShareToolRow` renders only the plan).
  - The row's collapsed status stays "Approved · Accept edits" / "Approved · Ask"; the chip is inside the body, so a
    collapsed row never moves.

**Todos** (`todo_write`, `core-agent`, policy `safe`, every chat with tools, plan mode included): the agent replaces
its whole list with each call (at most 50 items `{ id, content, status: pending | in_progress | completed,
activeForm? }`). The current list is the last finished `todo_write` call on the shown path (`latestTodos` from
`@harness-forge/shared`; branch-aware, survives reloads; a sub-agent's todos are not part of it).

- **State** (`components/chat/agent/todos.ts`, pure, over `latestTodos`): `todoState(messages)` →
  `TodoState { todos, done, total, current: TodoItem | null, messageId, live } | null` (`current` = the first
  `in_progress` item; `live` = the list belongs to the last assistant message of the path);
  `todoStripVisible(state, running)` = `total > 0` and (a run is active, or the list is live and not all done);
  `todoSummary(state)` = the collapsed strip's text. A list left behind in an older turn therefore disappears from the
  dock (the row keeps it). This `TodoState` is the web's own type; the shared `latestTodos` returns a different type of
  the same name (`{ todos, counts, messageIndex, partIndex, toolCallId }`), so import each from its own module.
- **List** (`TodoList`, `todo-list`, `<ul role="list">`, `data-variant` `row` | `strip`): `todo-item` per item
  (`data-status`, `data-index`): pending `Circle` muted; in progress `CircleDot` in `text-primary`, `font-medium`,
  showing `activeForm` (else the content); completed `CircleCheck` in `text-success`, muted with a line-through.
  Screen-reader prefixes "To do:", "In progress:", "Done:".
- **Strip** (`TodoStrip`, `todo-strip`, `data-state` `open` | `closed`, `data-count` = total, `data-value` = done):
  mounted by `ChatView` in the composer dock above `QueuedMessages`. Collapsed: one line (h-9, 40px on coarse pointers):
  `ListTodo`, "3/7 · Running the parser tests" (the current item's `activeForm`, else its content; "3/7" without an item
  in progress; "All tasks done" when finished), a `Progress` w-16 (`data-slot="todo-progress"`, hidden below `sm`) and a
  chevron; the whole line is the toggle. Expanded: the `TodoList` (variant `strip`) above that line, inline,
  `max-h-[40dvh]`, scrolls, and the line then reads "Tasks 3/7" (wireframe 2.16). The toggle (`todo-strip-toggle`) is
  named "Show tasks, 3 of 7 done" / "Hide tasks", with `aria-expanded` and `aria-controls` (while open); the open state
  persists in `localStorage['hf-todo-expanded']` (`1` / `0`, default closed; blocked storage keeps it in memory). The
  strip is not a live region.
- **Compaction** keeps the list: the marker's `todos` snapshot goes to the model with the summary.

### 7.26 File mentions, queue and steering (`MentionMenu`, `QueuedMessages`, `SteerNote`, W9.8 / W9.9 / W9.11; Phase 9)

**File mentions** (ADR-042): `@` in the composer of a **project chat** searches the project's files; picking one
attaches a snapshot of it (an upload, like a dropped file) and keeps `@path` in the text, so the model sees the path
too. The chat request is unchanged.

- **Token** (`mentionTokenAt(text, caret)` from `@harness-forge/shared` `util/mentions.ts`): an `@` at the start of the
  text or after whitespace, with no whitespace between it and the caret, a query of at most 256 characters
  (`MENTION_QUERY_MAX_CHARS` = `LIMITS.mentionQueryMaxChars`); `a@b` and e-mail addresses never open the menu, and
  neither does a chat without a project. A quoted token `@"my folder/fi` may hold blanks (no line break) until its
  closing `"`; a quote never closed on the line yields to a later unquoted `@` run at the caret (`@"abandoned quote
  @next|` searches `next`), and a caret after a quoted mention's closing `"` or after the blank that follows a mention
  is outside it. Esc dismisses the menu for that token (remembered until the token's text changes, like the slash
  menu).
- **Search** (`useFileMentions({ projectId, text, caret })`, over `useProjectFiles().search`): `GET
  /api/projects/:id/files?q=<query>&limit=50` 80 ms after the last keystroke, aborting the previous request, with a
  cache of the last 20 queries per project (kept for `LIMITS.mentionIndexTtlMs`, 30 s; a cached query shows at once);
  while a search runs `state` is `loading` and the previous rows stay. The answer `{ items: { path, kind: 'file' | 'dir'
  }[], truncated, indexedAt }` is ranked by the server (`rankPaths`: the score tier first, best first: base-name prefix,
  base-name substring, full-path substring, subsequence of the query's characters in order; case-insensitive; then the
  shorter path, then the path; the empty query lists shallower paths first); the highlight comes from `scorePath(query,
  path).ranges` (shared; rendered as `<mark>` runs, `data-slot="mention-highlight"`, never `v-html`). The server's index
  respects `.gitignore`, skips `node_modules` and `.git`, and leaves secret-looking paths out.
- **Menu** (`MentionMenu`, `mention-menu`, `data-state` `loading` | `ready` | `error`, `data-count`): the same contract
  as `SlashMenu` (an absolutely positioned listbox above the composer; the textarea keeps focus and forwards its keys;
  exposed `handleKeydown`, `activeId`, `listId`), mounted after the slash menu; the keydown chain tries the mention
  menu first, then the slash menu; the textarea's `aria-controls` / `aria-activedescendant` point at whichever menu is
  open. Header (`aria-hidden`) "Files in {project}" ("Files" without a name); rows (`mention-menu-item`, `data-path`,
  `data-kind`, `data-highlighted` on the active row; at least `--row-height`, 40px on coarse pointers): `FileText`
  (file) or `Folder` (dir), the base name (a folder ends with `/`) and the folder in muted text (under the name below
  `sm`); the list scrolls inside `max-h-[40dvh]`; ↑/↓ move, Enter or Tab pick, Esc closes (without rows Enter sends and
  Tab moves focus as usual). States: loading → "Searching files…" only after 150 ms without rows (the delay lives in
  `MentionMenu`); empty "No matching files"; error "Couldn't search files." ("The project folder is unavailable." for
  a 400, a folder that cannot be opened); `truncated` (more entries matched than the limit, or the server's index was
  cut) → the footer "Showing the first 50 matches. Type more to narrow it down." (`data-slot="mention-truncated"`). A
  polite region (`data-slot="mention-announcer"`) says "{n} files" / "1 file" / "No matching files" (or the error)
  500 ms after the rows settle.
- **Pick**: a file → its mention plus one blank replaces the token (`formatMention(path)`, which already starts with
  `@`: `@src/parser.ts `, or `@"my notes.md" ` for a path with whitespace; an existing blank after the token is reused;
  `setTextAndCaret(…, { force: true })`) and
  `attachments.addProject(projectId, path)` adds a chip that uploads at once through `POST
  /api/projects/:id/files/attach { path }` (201 `FileRef`): `composer-attachment` with `data-kind="project"` and
  `data-path`, the `FileCode` icon, the base name, the full path in a tooltip; the same path is attached once. A folder
  → `@folder/` (`@"my folder/"` with the caret before the closing quote) and the menu stays open on that folder. A path
  that cannot be written as a mention (it holds `"` or a line break) just removes the token. The chip and the text are
  independent (removing one keeps the other). Attach failures drop the chip and show an error toast titled "{path}
  can't be attached" (`projectAttachErrorText`): 413 → "Files can be up to 5 MB."; 404 → "The file no longer exists.";
  a 400 on the file type → "Attach images, PDFs or text files."; any other 400 → the server message (a `.git` or
  secret-looking path, a folder that cannot be opened). Send waits for the chip like any upload.
- **Mention a file** in the `+` menu (`composer-mention`, `AtSign`, project chats only) inserts `@` at the caret (with a
  space before it when needed, and one after it when a word follows the caret) and opens the menu.

**Queue and steering** (ADR-042): a message sent while a run is active waits in the chat's queue on the server
(in memory; lost on a server restart; at most 10 messages of at most 256 KiB each, `LIMITS.queueItemsMax` /
`queueItemBytes`). At the next **step boundary** the
run takes every queued message and the model reads it as a user message (a **steer**); the reply shows it as a
`SteerNote`. A message still queued when the run completes becomes the **next turn**, started by the server. Server
commands (`/compact`, plugin commands) always wait for the next turn. While an approval is pending, queued messages wait
for the next run.

- **Submit** (`session.submit(input)` → `'sent' | 'queued'`, 11.6): queues when a request is in flight, the session is
  resuming or the chats store reports a run; `POST /api/chat/:id/queue { message, modelRef, reasoningEffort, toolMode
  }` (a user UI message with a client `msg_` id, its text and uploaded file parts). 409 `run-idle` (the run ended in
  between) → the session waits until it is idle (and any resume settled) and sends the message normally; a submit with
  neither text nor files does nothing. `ChatView` announces "Message queued" for `'queued'`. A submit that was neither
  sent nor queued puts only its text back into the composer (its file chips are not restored): 409 `queue-full` →
  toast "The queue is full. Wait for the agent to take a message."; any other failure → the error toast "Could not
  send the message".
- **List** (`QueuedMessages`, `components/chat/queue/`, `queued-messages`, `data-count`, `data-state` `queued` |
  `approval`; mounted by `ChatView` in the dock between `TodoStrip` and the composer; hidden when empty): header
  "Queued · {n} · sent at the next step" ("Sent after you answer the approval" while the chat awaits an approval); rows
  (`queued-message`, `data-message-id`, `data-state` `queued` | `cancelling`): `Clock`, a paperclip count when the
  message has files, the first line of its text (truncated), a muted "Runs after this response" for a server command,
  and **Edit** (`queued-message-edit`, `Pencil`, "Edit queued message") and **Cancel** (`queued-message-cancel`, `X`,
  "Cancel queued message"; 40px on coarse pointers). Cancel → `DELETE /api/chat/:id/queue/:itemId` (204); a 404
  (already delivered or started) → toast "Already sent to the agent." (`QUEUE_ITEM_GONE_MESSAGE`); another failure →
  the error toast "Could not cancel the message". Edit cancels the item, then restores it into the composer like a
  Stop does (`restoreQueued`, with the toast "Queued messages moved back to the composer."). While a cancel is in
  flight the row shows a spinner instead of the clock, `aria-busy` and disabled actions. After a cancel focus moves to
  the next row's Cancel, else the previous row's, else the textarea. Below `md` more than two rows collapse behind
  "Show {n} more" (`data-slot="queued-messages-more"`). A message without text shows its file names.
- **Sync**: `queue.changed { chatId, items, removed? }` (SSE) replaces the chat's list in every tab (the `chat-queue`
  store, 11.6); `removed` reasons `delivered` | `started` | `cancelled` | `stopped` | `failed` drop rows; a `failed`
  removal shows "Couldn't send a queued message." (`QUEUE_SEND_FAILED_MESSAGE`) with its error in the tab that queued
  it. The session fetches the list (`GET /api/chat/:id/queue`) every time a chat loads, and the store refetches every
  loaded chat after an event-stream reconnect; `chat.deleted` drops it. A message that left a queue never comes back
  (its id is remembered), and an older fetch never overwrites a newer event.
- **Steer note** (`SteerNote`, `components/chat/steer/`, `steer-note`, `data-message-id` = the queued message id):
  inside the running assistant message at the step boundary where it was delivered: right-aligned (`max-w-[85%]`), its
  files first (`FilePart`, like a user message's attachments; `data-slot="steer-files"`), then the text in a
  `bg-muted/70 rounded-2xl px-3 py-2 text-sm` bubble (plain, `whitespace-pre-wrap`, never Markdown;
  `data-slot="steer-text"`), and the muted caption "You · while it worked" (`aria-hidden`); `role="note"` with the
  sr-only prefix "You said while the agent worked:". `useChat`'s `onData` marks the item delivered when its `data-steer`
  chunk arrives (the row leaves the list before the event). After a reload the note stays where it was delivered (the
  server rebuilds the model history by splitting the reply there).
- **Next turn started by the server**: `run.started` with `origin: 'queue'` and a `userMessageId` that is not on the
  shown path makes the session reload the path, then resume the stream (once idle when it was busy), so the queued
  message shows as a user bubble before its reply streams; other tabs follow the same way.
- **Stop** (7.6): the queue is emptied; only the tab that pressed Stop restores the dropped messages into its composer
  (`session.stop()` resolves with `dropped` even when this tab was not streaming the run, so Stop from any tab restores
  them there).
- **Elsewhere**: the Markdown export renders a steer as a "## User (during the run)" section between the parts of the
  reply before and after it; share pages show it as an ordinary user message (7.15); search indexes steer text.

### 7.27 Sub-agents (`TaskBlock`, `TaskBody`, `TaskStepRow`, W9.10; Phase 9)

The `task` tool (`core-agent`, ADR-043) runs a **sub-agent**: a separate agent loop with its own context, started by
the main agent with `{ description, prompt, type: 'explore' | 'general' }`. It never asks for approval (a call that
would ask is skipped), runs at most 3 at a time (20 per reply), streams its progress as preliminary outputs and returns
only its report to the main agent. Type `explore` is read-only; `general` may also do what the chat's mode allows
without asking (writes in Accept edits, everything but always-ask tools in Auto).

- **Data** (`TaskOutput` from `@harness-forge/shared`): `{ status: queued | running | completed | failed | aborted |
  limit, type, description, modelRef, steps: { toolCallId, toolName, summary, state: running | done | error | denied,
  resultPreview? }[] (the last 50), stepsOmitted, report, usage?, costUsd?, startedAt, finishedAt?, error? }`.
- **Block** (`TaskBlock`, `task-block`, `data-state`, `data-kind` `explore` | `general`; `ChatMessage` mounts it for
  block kind `task`, i.e. every tool part named `task`): a `Collapsible` that keeps two lines so nothing shifts on
  completion. Line 1 is the trigger (`task-block-trigger`): chevron, `Telescope` (explore) or `Bot` (general),
  "Explore" / "Agent", the description (truncated), "{n} tool calls · 41s" (`data-slot="task-meta-short"`; the count
  is the kept steps plus `stepsOmitted`; the duration ticks every second while it runs; hidden below `sm` while
  running) and the status cell. Line 2 (`h-5`, `aria-hidden`, `data-slot="task-live"`): while running the latest step
  (`└ read_file "src/auth.ts"`, mono), when finished the first sentence of the report (else of the error). The trigger
  is named "Explore sub-agent: {description}, running, 4 tool calls"
  ("Sub-agent: …" for general; the status words below).
- **Status** (`data-state`, `taskBlockState`): `queued` ("Waiting", `Clock`: over the parallel limit), `running`
  (`Spinner`; a preliminary output while the message streams), `completed` (`Check`), `failed` (`X`), `limit`
  (`TriangleAlert`, "Step limit reached": the report was written at the step limit), `aborted` ("Stopped",
  `CircleSlash`: Stop, or a preliminary output after the stream ended; after a reload the stored `output-error` reads
  "Stopped" when its text matches `/\bstopped\b/i`, which the server's "The run was stopped before the tool finished."
  does, else `failed`; the nested steps are gone then), plus the tool part states `approval` ("Needs approval" with a
  warning dot: a user override `ask` on `task`, `ToolApprovalCard` below) and `denied` ("Denied"; "Skipped because you
  sent a new message" in a tooltip when a newer message superseded it).
- **Expanded** (`TaskBody`, store-free, also used by `ShareToolRow`; `data-slot="task-body"`, a `bg-muted/50` box):
  "Prompt" through `ToolValueBlock`; "Steps" (`data-slot="task-steps"`): the latest 10 only, with **Show all {n}
  steps** (`task-steps-more`) above them when more are kept (at most 50), else "{k} earlier steps were not kept"
  (`data-slot="task-steps-omitted"`; "1 earlier step was not kept") when `stepsOmitted > 0`. A step (`TaskStepRow`,
  `task-step`, `data-tool-name`, `data-state`) reads, left to right: the tool's icon (the workspace tool icons, `Server`
  for MCP tools, else `Wrench`), the name (MCP tools without their server prefix), the summary (mono, quoted), then on
  the right the result preview (muted, `data-slot="task-step-preview"`, hidden below `sm` and for denied steps) and the
  status (`Spinner`, or `CircleSlash` + "Stopped" for a step still `running` when the sub-agent stopped / `Check` / `X`
  / `Ban` + "Skipped"); a denied step has the tooltip and sr-only text "Sub-agents can't ask for approval, so this was
  skipped.". Then an `Alert` "The sub-agent failed: {error}" ("unknown error" without one) above the partial report;
  "Report" as `Markdown` (`task-report`) with a `CopyButton` ("Copy report"); the meta line "{model} · 18K tokens ·
  $0.004 · 41s" (`data-slot="task-meta"`, only once the sub-agent finished; the model id of `modelRef`, tokens by
  `formatTokenCount`, parts without a value left out).
- **Parallel** blocks simply stack; there is no grouping. A block whose input (or output, once there is one) does not
  parse with `taskInputSchema` / `taskOutputSchema` falls back to `ToolPart` (a still-streaming input never counts as
  unparsable).
- **Rewind**: sub-agent writes are journaled under the reply (ADR-036), so "Rewind files to here" counts a `task` output
  with a done `write_file` / `edit_file` step as an edit (`ChatTranscript`'s `rewindable` pass; it sees only the kept
  steps, the last 50), and the changes panel lists those files. A sub-agent's `cd` does not move the chat's shell folder
  (`session.cwd` ignores task steps).
- **Cost**: each sub-agent writes its own usage row (purpose `subagent`); its cost is part of the reply's cost.

**Phase 10 (ADR-045, ADR-046): custom agent types and background calls.** `type` now names any agent of the chat's
catalog: the built-ins `explore` and `general` (alias `general-purpose`) and the user's, the project's and the
plugins' agents (9.12). The input schema trims and lowercases it; the output's `type` is the resolved name, and the
output carries `agent?: { source: builtin | plugin | user | project, description (≤ 200), path? }` (a snapshot taken
when the call ran, so tooltips survive reloads and share pages) and, for a background call, `taskId`. `taskTypeSchema`
stays the built-in enum (the icons); any other name is a custom type. An unknown type ends the call `failed` with an
error that lists the available types (the block shows it like any failure).

- **Kind** (`taskKindOf(type)` in `agent-tools.ts`): `explore` → `Telescope` + "Explore"; `general` → `Bot` + "Agent";
  any other name → `custom`: `BotMessageSquare` + the agent name as the label (`font-medium`, truncated at 24
  characters, the full name in the tooltip). The root `task-block` gets `data-kind` `explore | general | custom` and
  `data-agent-type` = the type name (the output's, else the input's lowercased, with `general-purpose` read as
  `general`). Every type string parses, so nothing falls back to `ToolPart` because of the type alone.
- **Agent card**: when `output.agent` exists, the label (`data-slot="task-agent-label"`) is a `HoverCard` trigger
  (it opens after 400 ms on hover of the label, and when the block's trigger gets keyboard focus) showing
  (`task-agent-card`) the full name, the description and the source line (`task-agent-source`): "Built-in agent",
  "Personal agent", "From {plugin name}" or "Project: {path}" (the path in mono; "Project agent" without one). The
  plugin name comes from the snapshot's `pluginId` through the plugins store (else the id itself); a snapshot without
  `pluginId` uses the plugin that contributes the type (else "From a plugin"). The trigger's `aria-describedby` points
  at a sr-only "{description}. {source}". Without a snapshot, a name cut at 24 characters gets a `Tooltip` with the full
  name. The trigger's accessible name becomes "Sub-agent {name}: {description}, {status}, {n} tool calls" for custom
  types.
- **Background call** (`input.background: true`; `data-background` on the root): the call returns at once with
  `status: 'background'`, the `taskId` and no steps; the sub-agent then runs on its own (7.29). The block reads its live
  state from `AGENT_TASK_CONTEXT` (provided by `ChatView`, 11.7):
  - while the background agent runs (`data-state="running"`, or `queued` while its snapshot says so): the status cell
    shows the spinner and "In background", the short meta reads "Background · {n} tool calls · 1m 2s" (the duration
    ticks), line 2 is its latest step; the trigger name adds ", running in the background";
  - once it finished (the live task, else its delivered result on the shown path): `data-state` = its final status
    (`completed` / `failed` / `aborted` / `limit`, with the 7.27 icons and words; a stop after a server restart reads
    "Stopped" with the error "The server restarted before the task finished."), the short meta keeps the "Background ·"
    prefix, line 2 = the first sentence of its report (else of its error);
  - when no live state is known (the chat came from an import or the task list was pruned; a chat keeps its latest 100
    background tasks): `data-state="background"`, `CircleDashed` and "Started in the background", line 2 empty;
  - expanded: `TaskBody` with the live snapshot (`task.output`, else the launch output), then the reveal link
    `task-block-reveal` (`data-target`): "Show in background agents" (`dock`; opens the dock, scrolls the row into view
    and expands it) while the agent runs, "Go to the result" (`result`; scrolls to its `TaskResultNote` and opens its
    report) once its result is on the shown path; no link otherwise.
- The block never auto-expands, keeps its two lines while the state changes, and its cost is not part of the reply's
  cost (a background agent's usage row is attributed to the reply that launched it, its cost is in its report's meta
  line and in the chat's totals).

### 7.28 Custom commands and skills in the chat (`SlashArgumentHint`, `CommandBadge`, `SkillToolBody`, W10.9 / W10.11; Phase 10)

**Custom commands** (ADR-045) are markdown files: a project's `.harness/commands/**/*.md` (over `.claude/commands/`),
or the user's personal commands from Settings → Customize. The composer lists them in the slash menu (7.8); the server
expands them; the chat request is unchanged.

- **Argument hint** (`SlashArgumentHint`, `components/chat/composer/`, `slash-argument-hint`): after a command with an
  `argumentHint` is inserted (Enter or Tab in the menu, or typed), ghost text shows the expected arguments right after
  the command while the text is exactly `/name` plus one or more blanks, on one line, with the caret at the end: an
  `aria-hidden` mirror absolutely positioned over the textarea with the same padding, font, line height and wrapping,
  holding an invisible `/name ` followed by the muted hint (`<file> [focus]`); `ChatComposer` wraps the textarea in a
  `relative` box of its size (`data-slot="composer-text"`) for it. It hides at the first argument character, when the
  text changes to another command, when the caret leaves the end of the text, or when the textarea scrolls (the
  composer then passes `hint: null`). A sr-only element linked from the textarea's
  `aria-describedby` reads "Arguments: {hint}" while it shows. It never takes keys (Tab still completes from the menu
  only while the menu is open).
- **Expansion** (server, ARCHITECTURE.md 6.24): `$ARGUMENTS` = the whole text after the name, `$1` … `$9` = single
  words (quotes group words), `{{input}}` = the whole text; a body without a placeholder gets the text appended. Lines
  starting with `!` are **not** run and `@path` is **not** expanded: both stay text for the model. The bubble keeps the
  typed text; `metadata.command.expansion` holds what the model got.
- **Model override**: a command file's `model` runs that turn on the given model (the chat keeps its own model; the
  composer's model picker does not change). The reply's meta row names the model that ran. When the model is not
  available (it does not resolve: no key, unknown; or its catalog kind is not `chat`, e.g. an image model), the chat's
  model answers and the reply starts with the notice `command-model-unavailable` (icon `Cpu`, level warning, once per
  reply, the server's text, e.g. "The command's model openai:gpt-6 is not available, so the chat's model answered.").
  The server resolves the chat's own model first (the v1.5 errors and image checks stay), so a chat whose model cannot
  run fails as before even when the command's model could; a command's model never gets the image options.
  Regenerate reuses the stored override.
- **Allowed tools**: a command's `allowed-tools` narrows the tools of that turn (and of its approval continuations and
  regenerations); it never pre-approves anything (unlike Claude Code), so calls still ask as the permission mode says.
- **Badge** (`CommandBadge`, `parts/`, `data-slot="command-badge"`; `UserMessageBubble` passes the message's
  `metadata.command` as the optional `command` prop): `SquareTerminal` + `/name` as before; when
  `metadata.command.modelRef` is set a muted "· {model name}" follows (`data-slot="command-badge-model"`); the tooltip
  (on hover and keyboard focus; the badge's sr-only text carries the same lines) adds the source: "Project command",
  "Personal command", "From {plugin name}" or "Built-in command" (`data-slot="command-badge-source"`; `source` is set
  only for project and personal command files, so plugin and harness commands and messages before v1.6 show no source
  line), the model "Runs on {model name}" (`command-badge-runs-on`) and, with `allowedTools`, "Tools limited to
  {names}" (`command-badge-tools`; comma list, at most 8, then "and {n} more"). Without any of these the badge stays
  the plain v1 badge (no tooltip).
- **Queue**: a project or personal command typed while a run is active is queued as the next turn like every server
  command (never steered; 7.26).

**Skills** (ADR-045) are instructions the agent loads on demand: a project's `.harness/skills/<name>/SKILL.md` (over
`.claude/skills/`), the user's personal skills, or a plugin's. The model sees their names and descriptions in its
instructions and calls the `core-agent` tool `skill { name }` when a task needs one. Skills are **not** in the slash
menu.

- **Row** (`ToolPart`, `tool-row` with `data-tool-name="skill"`): `BookOpen`, "Loaded skill"
  (`data-slot="skill-row-label"`) and the mono skill name (`skill-row-name`; from the input while it runs), then on the
  right the source (`skill-row-source`: "Project", "Personal", the name of the plugin that contributes the skill, found
  in the plugins store, else "Plugin", "Built-in") and the status. Running: "Loading skill" (shimmer); failed:
  "Couldn't load skill" with the error in the body (an unknown skill lists the available ones). The row's accessible
  name is "Loaded skill {name}, {source}". A running call or an output that fails the skill schema keeps the generic
  body.
- **Body** (`SkillToolBody`, `components/chat/agent/`, store-free; `data-slot="skill-body"`, inside `AgentToolBody`):
  the description (`skill-description`), the heading "Folder" with the base folder in mono for project skills
  (`baseDir`, e.g. `.harness/skills/release-notes`, `skill-base-dir`), the heading "Files" with its supporting files
  (`files`, at most 50, mono list, `data-slot="skill-files"`; the agent reads them with `read_file`), the heading
  "Instructions" with the content as `Markdown` (`skill-content`, `max-h-[50dvh]`, scrolls) and the caption "The agent
  read these instructions." (`skill-caption`) plus, when `truncated`, "Cut at 64 KB." Then "Raw input and output". A
  skill call never asks for approval (policy `safe`) and is never offered to sub-agents.
- **Share pages**: `ShareToolRow` shows "Loaded skill {name}" (`BookOpen`) and `SkillToolBody` behind the toggle when
  tool details are shared, a static "Loaded skill" row without them.

### 7.29 Background agents (`BackgroundAgents`, `BackgroundAgentRow`, `TaskResultNote`, W10.10 / W10.11; Phase 10)

A **background agent** (ADR-046) is a sub-agent the main agent started with `task { …, background: true }`: the call
returns at once and the sub-agent keeps working while the main agent goes on, also after the reply ended. When it
finishes, its report is delivered to the main agent **exactly once**: at the next step of a running reply, or, when
the chat is idle, through a new turn the server starts by itself. The UI calls them **background agents** (never
"tasks": "Tasks 3/7" is the todo list, 15).

- **Limits** (shown nowhere except in errors): 3 per chat and 10 per server at a time, 30 minutes each, and the
  **Sub-agent max steps** setting; a call over a limit ends `failed` with the server's text ("At most 3 background
  agents run per chat. Wait for one to finish." / "At most 10 background agents run on this server. Wait for one to
  finish."); the time limit ends one `limit` ("The background agent reached its time limit (30 minutes)."). They never
  ask for approval (like every sub-agent).
- **Stop semantics**: the composer's Stop and Esc **do not** stop background agents (Claude Code parity). They stop
  with their own Stop (below), when the chat or its project is deleted, on Delete all data, on a key rotation (their
  results are kept for the chat's next run) and when the server shuts down (a running one ends `aborted`, "The
  background task was stopped."); a crash or kill leaves a running one `aborted` at the next boot ("The server
  restarted before the task finished."), never resumed.
- **Busy project**: while a background agent of a chat runs, its project counts as busy: Rewind, Revert, Undo, deleting
  the project, moving the chat and deleting a version answer 409 `run-active` and show their existing "Wait for the
  responses in this project to finish …" texts; switching versions still works.

**The dock list** (`BackgroundAgents`, `components/chat/background/`, `background-agents`; mounted by `ChatView` in the
dock between `TodoStrip` and `QueuedMessages`, 5.8). It renders nothing when no task is **visible**: visible =
`running` (a background task has no `queued` status), or finished but not delivered yet (`deliveredAt` null). Data from
`useBackgroundTasksStore` (11.7).

- **Collapsed** (the default below `md`; `data-state="closed"`, `data-count` = running, `data-total` = visible): one
  h-9 line (h-10 on coarse pointers) that is the toggle (`background-agents-toggle`): `Spinner` (a `CircleCheck` when
  none runs), "2 background agents · {latest description} · 1m 12s" ("1 background agent · …"; the duration of the
  longest-running one, ticking), or, when every visible one finished, "1 background agent finished · report pending"
  ("2 background agents finished · reports pending"). The toggle is named "Show background agents, 2 running" ("Show
  background agents, 1 finished") / "Hide background agents", with `aria-expanded` and `aria-controls`. The open state
  persists in `localStorage['hf-background-expanded']` (`1` / `0`; default open from `md`, closed below; blocked storage
  keeps it in memory). A reveal request (below) opens the list without saving that.
- **Expanded** (`data-state="open"`; the list renders above the toggle line, inline, `max-h-[40dvh]`, scrolls): a
  header "Background agents · {n} running" ("Background agents" when none runs) with **Stop all**
  (`background-agents-stop-all`, outline, `Square`; shown while at least one runs, `aria-disabled` while a stop is in
  flight; it stops each running one in turn through the stop route, there is no batch route), the rows (a list named
  "Background agents"), and the footnote (`data-slot="background-agents-footnote"`) "They keep running after the reply.
  Stop in the composer doesn't stop them."
- **Row** (`BackgroundAgentRow`, `background-agent`, `data-task-id`, `data-state` = the task status, `data-kind`
  `explore | general | custom`, `data-agent-type`, `aria-busy` while its stop is in flight). Line 1: the details toggle
  (`background-agent-toggle`, `data-state`, "Show details of {description}" / "Hide details of {description}",
  `aria-expanded`, `aria-controls`; it holds the chevron, the type icon and label (7.27) and the description, which
  wraps under the label below `sm`), "{n} tool calls · {duration}" (`data-slot="background-agent-meta"`; the duration
  ticks while it runs and hides below `sm`), the status cell (`background-agent-status`: a spinner with the sr-only word
  "Running", or the final status icon and word "Finished" / "Failed" / "Stopped" / "Step limit reached"), and **Stop**
  (`background-agent-stop`, `Square`, named "Stop {description}", 32px, 40px on coarse pointers; only while it runs). A
  finished, undelivered row shows "Report pending" (`background-agent-pending`) instead of Stop. Line 2
  (`background-agent-live`, `aria-hidden`): the latest step while it runs (mono, `└ shell "pnpm vitest --run"`), else
  the first sentence of its report (else of its error). Open: `TaskBody` with the input of the launching `task` call
  (its prompt; `BACKGROUND_TASK_INPUT`, provided by `ChatView` from the shown path) and the live output; when the shown
  path does not hold that call (another version, a pruned or imported chat) the row has no details toggle (line 1 is
  plain text).
- **Stopping**: Stop → `backgroundTasks.stop(chatId, taskId)` (`POST /api/chat/:id/tasks/:taskId/stop`); while it is in
  flight the row shows a spinner in place of Stop (`data-slot="background-agent-stopping"`) and `aria-busy`. `'gone'`
  (the answer shows the task had already ended with another status, or a 404) → toast "It already finished." Other
  failures → the error toast "Could not stop the background agent". After a stop, focus moves to the next row's Stop,
  else the previous row's, else the toggle (back to the row's own Stop when the stop failed). A stopped agent still
  delivers its partial report (status `aborted`), at the next run of the chat; a stop never starts a turn by itself.
- **Announcements**: a polite region (`data-slot="background-agents-announcer"`, `aria-live="polite"`, without
  `role="status"`) rendered as a sibling of the list's root, so it exists even while nothing is visible, says
  "Background agent finished: {description}" / "Background agent failed: {description}" / "Background agent stopped:
  {description}" / "Background agent reached its step limit: {description}" for a running task this tab saw end (never
  for states it only loaded). **One announcement per finished background agent per tab**: the dock records each
  agent it announces in `announcedTasks` (`background-agents.ts`, a bounded tab-wide set); `ChatView` announces a
  carrier's results (below) only for the agents the dock did not announce and records them too.
- **Sync**: `task.changed { chatId, task }` (SSE, at most one per second per task plus every status change) upserts the
  task in every tab; every chat load fetches `GET /api/chat/:id/tasks`, an event-stream reconnect refetches every loaded
  chat and every chat whose running task only events reported (`refreshLoaded()`), and `chat.deleted` drops the chat's
  list.
- **Mobile (390px)**: strip (collapsed), background agents (collapsed), queue (two rows) and the composer fit above the
  keyboard; expanded rows wrap the description under the label and hide the duration.

**Results in the transcript** (`TaskResultNote`, `components/chat/agent/`, store-free, `task-result`, `data-task-id`,
`data-status` = the final status, `data-variant` `inline | turn`). Data: the `data-task-result` part `{ taskId,
toolCallId, messageId, output: TaskOutput, deliveredAt }`.

- **Look**: visibly different from `SteerNote` and from tool rows: full width, left-aligned, `rounded-lg border
  border-dashed bg-muted/30 px-3 py-2 text-sm`, `role="note"` named "Background agent result: {description}". Line 1:
  the type icon, "Background agent finished" / "Background agent failed" / "Background agent stopped" / "Background
  agent reached its step limit", then "· {label} · {description}" (label = "Explore", "Agent" or the custom name), and
  on the right "{n} tool calls · 3m 2s" (`data-slot="task-result-meta"`, hidden below `sm`). Line 2: the report's first
  sentence (else the error's, else "No report."; `data-slot="task-result-summary"`) and, on the right, the toggle.
- **Show report** / **Hide report** (`task-result-toggle`, `data-state` `open | closed`, `aria-expanded`,
  `aria-controls`) opens the report (`task-result-report`: the heading "Report", `Markdown` in
  `data-slot="task-result-markdown"`, `max-h-[50dvh]`, scrolls, with a `CopyButton` "Copy report", and the meta line
  "{model} · {tokens} tokens · {cost} · {duration}" like `TaskBody`, `data-slot="task-meta"`); an error shows as the
  7.27 alert "The sub-agent failed: {error}" above it; without a report and an error the body reads "No report."
  (`task-result-empty`). Collapsed by default, not persisted.
- **Inline** (`variant="inline"`): inside a running reply, at the step where the agent received it (block kind
  `task-result` of `chat-format.ts`), like a steer. One note per result.
- **Turn** (`variant="turn"`): when the chat was idle, the server added a **carrier** user message that holds only
  `data-task-result` parts and started a turn from it (`run.started` with `origin: 'task'`). `ChatMessage` renders such
  a message (`isTaskResultMessage(message)`) as its notes, left-aligned, with the caption "Sent to the agent"
  (`aria-hidden`, muted, below the notes), and without a bubble, `MessageActions`, edit, versions switcher or "Rewind
  files to here". The reply below it is a normal assistant message.
- **Server-started turns**: `run.started` with `origin: 'task'` and a `userMessageId` that is not on the shown path makes
  the session reload the path and then resume the stream, exactly like a queue-started turn (7.26); once the carrier
  shows, `ChatView` announces "Background agent finished: {description}" ("… failed", "… stopped", "… reached its step
  limit") for each of its results whose agent the dock has not announced in this tab (carriers of a path loaded later
  are never announced). A turn started this way never
  starts another automatic turn (chain depth 1): a background agent it launches reports at the chat's next run.
- **Elsewhere**: share pages leave results out (and a carrier message with nothing else); the Markdown export renders
  "## Background task: {description} ({status})" and the report; search indexes the report; a branch made above a
  result loses it (the task stays listed in `GET /chat/:id/tasks`).

### 7.30 Remember (`RememberDialog`, W10.9; Phase 10)

`/remember [text]` (a client command, ADR-047) saves a note for the agent where it will be read again. The composer
clears the input and opens `RememberDialog` (`remember-dialog`, a form dialog mounted by `ChatComposer`, so neither the
layout nor the ui store changes), prefilled with the text after `/remember ` (trimmed).

- **Text**: a `Textarea` (`remember-text`, label "Note", 3 → 8 rows, at most 2,000 characters with the counter "{n} /
  2,000"; over the limit: "Use at most 2,000 characters." and Save disabled).
- **Save to** (`RadioGroup` named "Save to"; items `remember-target`, `data-value`):
  1. `project-file` — "{file} in {project}" with "Added as a line at the end of the file." (`{file}` = the project's
     `instructionsFile`: `AGENTS.md`, else `CLAUDE.md`); without one: "AGENTS.md in {project} (new file)". The line is
     written as `- {text}`, journaled under the chat (the changes panel lists it; "Rewind files to here" can remove it).
     Without a known project the labels read "AGENTS.md in a project (new file)" and "Instructions of a project" (both
     targets are disabled then).
  2. `project-instructions` — "Instructions of {project}" with "Kept by harness-forge and sent with this project's
     chats." (appended to the project's instructions, 9.10).
  3. `global` — "Custom instructions" with "Sent with every chat." (appended to Settings → General → Custom
     instructions).
  - Outside a saved project chat (no project, or the draft chat on `/` before its first message: the composer passes
    `chatId` only once the chats store knows the chat), 1 and 2 are disabled (`aria-disabled`); the reason "Open a chat
    in a project to use this." shows once under "Save to" and is linked from the disabled targets' `aria-describedby`.
  - Default: the last choice (`localStorage['hf-remember-target']`, written only after a successful save) when it is
    enabled; otherwise `project-file` in project chats and `global` elsewhere.
- The dialog's title is "Remember", its sr-only description "Save a note to your instructions."; the counter is
  `data-slot="remember-counter"` (`aria-live="off"`).
- **Save** (`remember-save`, disabled while the trimmed text is empty or over the limit, the chosen target is disabled
  or a request runs; Cancel next to it) → `POST /api/memory { target, text, chatId }` (the route `memory.remember`
  through `useApi()`; no store, 11.7; `chatId` left out for the draft chat). The returned project or settings are
  applied to the projects and settings stores. Toasts: "Saved to AGENTS.md" (or the file named in the result; "Created
  AGENTS.md in {project}" when `created`) / "Saved to the instructions of {project}" / "Saved to your custom
  instructions". The dialog closes; `ChatComposer` returns focus to the textarea (desktop only).
- **Errors** inline above the buttons (`remember-error`, `data-code` = the error code, `role="alert"`; the dialog stays
  open), mapped by the answer: a 400 with an issue on `instructions` or a message about the instructions' length →
  "The instructions would be longer than 20,000 characters. Shorten them in Settings first."; 413 → "The file would be
  larger than 1 MB."; a 400 whose message says the project folder is unavailable → "The project folder is
  unavailable."; any other error → the server message (a linked `AGENTS.md`, a chat without a project, …).
- **Keys**: Mod+Enter saves from anywhere in the dialog; an empty dialog opens with focus in the textarea, a
  prefilled one on the selected radio (arrows switch the target); Esc cancels.

---

## 8. Plugins UX spec

### 8.1 Plugin card (`PluginCard`, W3.1)

`Card` (`rounded-lg border bg-card p-4`, whole card links to `/plugins/<id>` except the switch):

| Area | Content |
|---|---|
| Top row | `ProviderIcon` (lg, color variant, plugin icon) · name (`font-medium`) · version (`text-xs mono muted`) · `Switch` (enabled) right |
| Middle | description, 2 lines max |
| Bottom | source badge · "Runs code" badge (outline warning, `Cpu` icon) when `kind === 'code'` or it declares a stdio MCP server · contributions summary ("2 providers · 3 tools · 1 MCP server · 2 commands"; Phase 10: "· 2 agents · 1 skill" from `PluginSummary.contributions.agents` / `skills`) |

Source badge labels: `builtin` → Core · `created` + declarative → Declarative · `created` + code → Code · `zip` →
zip · `npm` → npm · `url` → URL · `link` / `copy` → Local. State overlays: `error` → `border-destructive/60` and
the error message (1 line) + "View logs" link (emits `view-logs`; the list opens `/plugins/<id>?tab=logs`);
`untrusted` → warning badge "Untrusted" + "Review" button (emits `review`; the list opens `TrustDialog`);
`incompatible` → badge "Incompatible" with tooltip "Needs harness {range}"; `loading` → `Spinner` next to the name;
`disabled` → card at 70% opacity, switch off. Builtins appear as one non-removable
"Core providers" card (plus `core-tools`, `core-commands`, `core-mcp`, `core-workspace` (Phase 7) and `core-agent`
(Phase 9) cards); they have no Uninstall. A builtin without an icon of its own draws a glyph instead of a monogram
(`BUILTIN_PLUGIN_GLYPHS` in `plugin-display.ts`: `Boxes`, `Wrench`, `SquareSlash`, `Server`, `FolderCode`, and `Bot`
for `core-agent`).

### 8.2 List page (`/plugins`)

`PageHeader` "Plugins" with actions: search `Input` ("Search plugins", filters name/id/description, synced to
`?q=`), "Install…" (outline), "New plugin" split menu (Provider / Code plugin). Filter from `?filter=`:
`providers | tools | mcp | commands` = plugins contributing that type; `agents` (Phase 10, "Agents and skills") = plugins
contributing agents or skills; `disabled` = plugins not enabled; `all`
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
- Where `required` is set: the code plugin form (scaffold), the Share dialog and the delete-all dialog (always), the Add
  project dialog and the Rotate key dialog (always, Phase 7), the trust dialog (always), the install dialog (when the
  inspection says `requiresTrust`: code, or a stdio MCP server), the Source tab (code plugins: saving, deleting or
  renaming files and Build & reload ask for the password first when the session is not fresh; for a declarative plugin's
  `plugin.json` the prompt comes only after a refusal), the plugin header's Reload (code plugins), the MCP server dialog
  (when the request needs it: a stdio server); the provider wizard runs without `required` (a 403 prompts once, and a
  second refusal is shown as the error instead of prompting again).
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
| Tools | `PluginToolsTable`: name (mono) · description · policy badge (Safe / Ask / Always ask; Phase 9: "Decided per call" when the tool's `policy` is null, i.e. a policy function such as the `shell` tool's; the policy column is 8rem) · **Approval** `Select` (Default / Allow / Ask / Deny → tool pref override; Default clears it; Phase 9: Allow is not offered where the server refuses it — tools with workspace access `execute` and `core-agent`'s `exit_plan_mode` — and a stored `allow` on those reads as Default, matching the effective override `GET /api/tools` reports) · enabled `Switch` |
| MCP servers | status dot + name + transport badge + tool count + **Restart** (`POST /api/mcp/:id/reconnect`); for `core-mcp` the full `McpServersPanel` replaces this section |
| Commands | `/name` (mono) · description |
| Agents (Phase 10) | `PluginCustomizationList` (`plugin-customizations`, `data-kind="agent"`, `data-count`), after Commands, description "Sub-agents the main agent can start.": one row per agent, sorted by name (`plugin-customization`, `data-name`, `data-state` `active \| shadowed`): the mono name, a "Shadowed" badge (`EyeOff`, `data-slot="plugin-customization-shadowed"`, focusable, tooltip and `aria-description` "Not used: {winner} wins.", e.g. "your personal agent") when another agent of the same name wins, the description, and the meta line (`data-slot="plugin-customization-meta"`): the model ("Default model" when unset, "Same as the chat" for `inherit`, else the model ref) · the tools ("All tools" without a list, "No tools" for an empty one, else "{n} tools"); entries come from `customizations.catalog(null)` filtered by `pluginId` and limited to the names the plugin contributes now (a catalog older than a plugin reload may still list a removed one); a contributed name without an entry (the catalog is loading or failed) shows as a name-only row. The page fetches the catalog with `fetchCatalog(null, { maxAgeMs: 15_000 })` whenever the plugin contributes agents or skills (a list younger than 15 s is reused). Footer link "Open in Customize" (`data-slot="plugin-customizations-open"`) → `/settings/customize?tab=agents` |
| Skills (Phase 10) | the same list with `data-kind="skill"`, description "Instructions the agent loads when a task needs them."; rows show the mono name, the Shadowed badge and the description (no meta line); footer link → `/settings/customize?tab=skills` |

A plugin that adds nothing (agents and skills included) shows the unchanged empty state "This plugin does not add
providers, tools, MCP servers or commands." ("This plugin is turned off. Turn it on to register its providers, tools
and commands." while it is off).

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
| Default permission mode | `Select` Ask / Accept edits / Plan / Auto / Off (the options of `TOOL_MODE_OPTIONS`, 7.11; Accept edits since Phase 7, Plan since Phase 9) | `defaultToolMode` |
| Default reasoning effort | `Select` Auto / Off / Low / Medium / High / Max | `defaultReasoningEffort` |
| Max steps per response | `Input` (`inputmode="numeric"`, at most 3 characters) 1–200 (Phase 7; was 1–100), help "How many tool calls and follow-ups one response may chain in chats without a project (1–200)." | `maxSteps` |
| Max steps in project chats | `Input` (`inputmode="numeric"`) 1–200 (Phase 7, `settings-project-max-steps`), help "Agent runs in project chats can take more steps (1–200)." | `projectMaxSteps` |
| Alt shortcuts | `Switch` "Use Alt+M, Alt+R and Alt+P for composer menus, Alt+V to dictate and Alt+C for changes." (Phase 6 added Alt+V, Phase 8 Alt+C) | `altShortcuts` |
| Shift+Tab switches the permission mode | `Switch` (Phase 9, `settings-shift-tab-modes`), help "In the composer, Shift+Tab cycles Ask, Accept edits and Plan. Off: Shift+Tab moves focus." | `shiftTabModes` |
| (section) Agent | `AgentSettingsSection` (Phase 9, 9.11): automatic compaction, compaction model, sub-agent model, sub-agent max steps; Phase 10: save approved plans, plan folder; mounted between the Chat fields and Custom instructions | `autoCompact`, `compactModelRef`, `subagentModelRef`, `subagentMaxSteps`; Phase 10: `planFiles`, `planDirectory` |
| Custom instructions | `Textarea` ("Sent with every chat"; Phase 10: `/remember` can append a line to it, 7.30, so the field shows the stored value again after a `settings` update from the dialog) | `instructions` |

Both step fields save on blur or Enter and Esc restores the saved value; an invalid value shows "Enter a whole number
from 1 to 200." and keeps the saved value; a failed save rolls the field back (defaults: 20 and 100; the bound is
`LIMITS.stepsMax`). The Default permission mode options are the composer's `TOOL_MODE_OPTIONS` (same order, labels and
descriptions); a new chat without a project treats a default of Accept edits like Ask. Phase 9: the options include
Plan (`defaultToolMode: 'plan'`); a new chat without a project then starts in Plan, which the server enforces (no
workspace tools exist there, so it reads like Ask with `exit_plan_mode` offered).

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
Storage cleanup and Encryption key). On load it calls `GET /api/data` (`DataSummary`); the summary line (`data-summary`)
reads "12 chats (2 archived) · 348 messages · 18 files, 24 MB" (messages count every version). A skeleton shows while it
loads, "Could not load the data summary" with **Retry** when it fails; it reloads after every import (and, since Phase
7, after a cleanup and a key rotation). Section order: the summary, Export, Import, Storage cleanup (Phase 7), Shared
links, Encryption key (Phase 7), Danger zone. Import, delete-all, key rotation and cleanup share one lock on the server
(ADR-034, ADR-035): a `409 busy` answer to any of them shows the toast "Another data task is running. Try again when it
finishes." (7.4). Phase 7: `DataSettings` provides `dataSettingsContextKey` (`data-context.ts`: `reloadSummary()`,
`reloadShares()`) so the sections, which keep their "no props, no emits" contracts, can reload the summary line and
Shared links (remounted through a `:key`).

**Export** (`SettingsSection` "Export"): "Download a zip with every chat, including archived chats and every message
version. API keys, passwords, plugins, MCP servers and share links are never included." Phase 10 (ADR-024 amendment,
ADR-044): every backup also holds the personal agents, commands and skills of Settings → Customize
(`customizations.json`, raw markdown, no secrets); the description becomes "Download a zip with every chat, including
archived chats and every message version, and your personal agents, commands and skills. API keys, passwords, plugins,
MCP servers and share links are never included."

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
  Phase 10: its help reads "General and appearance settings, and your personal agents, commands and skills. A personal
  definition you already have with the same name is kept." (a `.json` file: "A chat exported as JSON carries no
  settings."). The web sends the form field `restoreCustomizations` with the same value as `restoreSettings` (true only
  for a backup with the switch on), so the definitions are restored together with the settings; the result panel adds
  "{n} agents, commands and skills restored · {k} kept · {f} failed" ("1 agent, command or skill restored"; zero kept
  and failed counts left out; `data-slot="data-import-customizations"`) when the result carries `customizations`, and
  a restore of at least one definition refetches the loaded customization lists (`customizations.refreshLoaded()`);
- **Import** (`data-import`, `Upload` icon; disabled without a file) → `data.import({ form })` (fields `onConflict`,
  `restoreSettings`, Phase 10 `restoreCustomizations`, then `file`); "Importing…" with a spinner while it runs; 409 `busy` (7.4) and 413
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

- **Check for unused files** (`data-cleanup-check`, outline, `ScanSearch`) → `data.cleanupPreview()` (`GET
  /api/data/cleanup`, a dry run that reads every message, so it shows a spinner); the summary (`data-cleanup-summary`,
  `data-state` `removable` | `empty`): "{files} files · {size} can be removed" (plus ", and {n} leftover files on disk"
  when `blobs + tempFiles` > 0; only leftovers: "{n} leftover files on disk can be removed"), then "{n} recent files
  are kept for 24 hours." when `recentFiles` > 0 (the hours come from `graceMs`), then "Last cleanup {relative time}"
  from `lastRunAt`; nothing to remove → "No unused files." The polite region announces the first line.
- **Remove…** (`data-cleanup-run`, destructive outline; enabled only after a check found something) opens a
  `ConfirmDialog` "Remove unused files?" with "This deletes {files} files ({size}). It can't be undone." ("This deletes
  {n} leftover files on disk. It can't be undone." when only leftovers remain) and **Remove files**
  (`data-cleanup-confirm`, destructive) → `data.cleanup()` (`POST /api/data/cleanup`; not a fresh-auth route) → toast
  "Removed {files} files ({size})" ("Removed {n} leftover files from disk", or "No unused files." when nothing was
  left);
  then the summary line reloads and the check runs again. The confirm counts come from the last check; the server
  re-checks every file when it deletes. 409 `busy` → the busy toast; other failures → an error toast.
- **Plugin data** (Phase 8, ADR-039): the check also scans the files plugins keep in `plugins/.data` for file ids.
  When that scan hit its budget (`pluginData: 'partial'` in the preview) the summary adds the warning "Plugin data is
  too large to scan completely, so a file only a plugin remembers may be removed." (`data-slot="cleanup-plugin-data"`);
  a manual run still proceeds.
- **Automatic cleanup** (Phase 8, ADR-039, W8.11; wireframe 2.15), below the buttons: a `Switch` "Automatic cleanup"
  (`data-cleanup-auto`, `data-state` `checked` | `unchecked`) with the description "Remove unused files on a schedule.
  They're deleted without asking and can't be restored. Files from the last 24 hours are always kept.", and a `Select`
  (`data-cleanup-interval`, `data-value` `daily` | `weekly`, named "Automatic cleanup interval") **Every day** / **Every
  week**, disabled while the switch is off. Both write the one setting `fileSweep` (`off` | `daily` | `weekly`, default
  `off`) through `settings.update()` (optimistic; a failure rolls back with an error toast); turning the switch on
  writes the interval shown (default `daily`). A status line (`data-cleanup-auto-status`, `data-state` `off` | `never` |
  `done` | `skipped`
  | `failed`: the last attempt's status when there is one, even while off; else `never` while on and `off` while off)
  comes from `DataSummary.fileSweep` (`FileSweepStatus { mode, lastAttempt, nextRunAt }`; the section loads `GET
  /api/data` itself on mount, after every change and after a cleanup, so the Data page sends two summary requests; a
  check's answer carries the same state): "Last automatic cleanup {relative time}: removed {n} files ({size})."
  (`done`; "1 file"), "The last automatic cleanup was skipped: plugin data is too large to scan. Run a cleanup by
  hand." (`skipped`), "The last automatic cleanup failed. It tries again after the next interval." (`failed`; no cause
  is shown: the attempt carries only a reason code), then "Next automatic cleanup {relative time}." while the mode is
  not `off` ("Next automatic cleanup soon." once that time has passed; the first run comes at least 24 hours after the
  server started); nothing while off and never run. The automatic run uses the same lock as
  the manual one, so a manual cleanup during it gets the busy toast; a manual cleanup also resets the schedule. The
  setting is a public setting: a backup restores it (9.8 Import, "Restore settings from the backup").

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
- **Rotate key…** (`data-key-rotate`, outline, `RotateCw`) opens `RotateKeyDialog`. It is disabled unless `canRotate`
  is true, the source is `file` and `keyCheck` is not `mismatch`; with `source: 'env'` a note follows: "The key comes
  from HF_MASTER_KEY. Stop the server and run `pnpm key:rotate` with HF_NEW_MASTER_KEY set to the new key.", then two
  command blocks with a copy button each (labels "Docker" and "Source checkout"; `docs/guides/using-projects.md`):
  `docker run --rm -v <volume>:/data -e HF_MASTER_KEY=<old> -e HF_NEW_MASTER_KEY=<new> harness-forge node
  apps/server/dist/main.mjs rotate-key` and `HF_MASTER_KEY=<old> HF_NEW_MASTER_KEY=<new> pnpm key:rotate`.
- A skeleton shows while the status loads; a failure shows `SettingsLoadError` "Could not load the encryption key
  status" with **Retry**.
- `keyCheck: 'mismatch'` → a destructive `Alert` "The master key doesn't match the stored secrets. Saved API keys can't
  be read. Restore the previous key (HF_MASTER_KEY or data/secret.key), or enter the keys again." and rotation stays
  disabled; `unknown` (no secrets yet) shows nothing extra.
- **Rotate key dialog** (`RotateKeyDialog`, `key-rotate-dialog`): title "Rotate the master key?", text "A new key
  encrypts every saved secret again.", then the effects as a list: "Other browsers and devices are signed out; you stay
  signed in." · "Every share link changes ({shares} links): copy the new links from Shared links." · "Running replies
  stop and pending approvals expire ({pendingApprovals} waiting)." · "Older versions of harness-forge can't read the
  secrets afterwards: back up the data directory first."; `Input` "Type ROTATE to confirm" (`key-rotate-confirm`,
  case-sensitive, autofocus) and **Rotate key** (`key-rotate-submit`, destructive, enabled only when the input is exactly
  `ROTATE`); Cancel. `pendingApprovals` counts messages that wait for a decision, while the toast's
  `approvalsExpired` counts the tool calls that were denied (API.md, `keys.ts`), so the two can differ.
- Submit → `keys.rotate({ body: { confirm: 'ROTATE' } })` through `useFreshAuth().run(…, { required: true })` with the
  prompt "Rotating the master key needs your password." (8.4); while the request or the prompt is pending the dialog
  stays open. Success → toast "Master key rotated" with the description "{secrets} secrets encrypted again ·
  {approvalsExpired} approvals expired", `rotated(result)`, the dialog closes, and the section, the summary line and
  Shared links reload (every share URL changed). The response carries a new session cookie for this browser; the
  server then sends `key.rotated` and closes every event stream, and this tab reconnects (11). 409 `env-key` /
  `key-mismatch` (and any other failure) → an inline destructive alert "Couldn't rotate the key" with the server message
  inside the dialog (`data-slot="key-rotate-error"`, `data-code`, `data-reason`); 409 `busy` → the busy toast. The
  counts ("{n} secrets", "{n} approvals", "{n} links") use singular forms for 1.

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
"Add project…", 7.20); the parameter is dropped at once, so the same link works again. The list reloads on every visit
(chat counts and folder states). A skeleton shows while the projects load; a failure shows `SettingsLoadError` "Could
not load the projects" with **Retry**.

- **Rows** (`project-row`, `data-project-id`), sorted by name: the name, the path in mono muted text (truncated, the
  full path in its `title`), "{n} chats" / "1 chat" (`chatCount`), the warning badge "Folder not found"
  (`project-missing`; its tooltip is `issue`) when `available` is false, and a muted "Uses AGENTS.md" / "Uses CLAUDE.md"
  when `instructionsFile` is set; Phase 8: "{n} allowed commands" ("1 allowed command", left out at 0;
  `shellRules.countForProject(id)`).
- **Row `⋯` menu** (`project-row-menu`, `aria-label="Actions for {name}"`): **Rename** (`project-rename` → the name turns
  into `InlineRename`, `project-rename-input`, at most 80 characters; `projects.update(id, { name })`, optimistic) ·
  **Edit instructions…** (`project-instructions` → `ProjectInstructionsDialog`) · **Allowed commands…** (Phase 8,
  `project-allowlist`, `ShieldCheck` → `AllowlistDialog`, 7.23) · **Agents, commands and skills…** (Phase 10,
  `project-customizations`, `WandSparkles` → navigates to `/settings/customize?project=<id>`, 9.12) · **Delete…** (`project-delete` → a
  `ConfirmDialog` "Delete {name}?" with "Its {n} chats stay and move to No project. The folder and its files are not
  touched." ("Its 1 chat stays and moves to No project. …"; without chats "It has no chats. The folder and its files
  are not touched.") and **Delete project**, `project-delete-confirm`, destructive). Delete → `projects.remove(id)` →
  toast "Project deleted" (a project the server no longer knows counts as deleted); 409 `run-active` → toast "Wait for
  the responses in this project to finish before deleting it."; other failures → an error toast.
- **Instructions dialog** (`ProjectInstructionsDialog`, `project-instructions-dialog`): title "Instructions for
  {name}", a `Textarea` (`project-instructions-input`, at most 20,000 characters, `LIMITS.instructionsMaxChars`, with
  the counter "{n} / 20,000"), the note "Sent with every chat in this project, after AGENTS.md / CLAUDE.md from the
  folder." (when the folder has one: "This folder has {file}; it is added first."), Cancel and **Save**
  (`project-instructions-save`) → `projects.update(id, { instructions })` (an empty text saves `null`), `saved(project)`
  and the dialog closes; a failure shows inline. The text resets to the project's instructions whenever it opens.
- **Empty state** (`projects-empty`): "No projects yet. A project is a folder on the server that chats can read and
  edit." and **Add project** (`project-add`).
- **Allowed in every project** (Phase 8, `GlobalAllowlistSection`, `allowlist-section`, mounted by the page below
  `ProjectsSettings`, also when no project exists; the section carries the explanation as its description): the global
  shell rules (7.23). The page loads the rules (`shellRules.fetchAll()`) on every visit, like the projects (the
  editors start the first load when they mount; the page's call joins it); a failed load shows in the editors, with
  Retry. Deleting a project deletes its rules. The `AllowlistDialog` opens with focus on its add input (not on a
  Remove, which acts at once); closing it returns focus to the row menu button.
- **Add project dialog** (`AddProjectDialog`, `add-project-dialog`; title "Add project", description "Choose a folder
  on the server that chats can read and edit."; a form dialog, full width minus 1rem at 390px, `max-h-[90dvh]`, its
  folder list scrolls; it opens with focus on the browser's first entry; also opened from the switcher, 7.20):
  - **Folder browser** (`FolderBrowser`, `folder-browser`, `data-path`, `data-state` `loading` | `ready` | `empty` |
    `error`): with no folder open it lists the roots from `projects.browse()` (`GET /api/projects/browse`; each root
    as its full path in mono; a root whose folder is missing is disabled with "Not found"); then a breadcrumb inside
    `nav aria-label="Folder path"` (the root's folder name, then the path segments; `folder-browser-crumb`,
    `data-path`; the current one `aria-current="page"`), **Parent folder** (`folder-browser-up`, `FolderUp`; at a
    root's top it returns to the list of roots), and the subfolders as buttons (`folder-browser-entry`, `data-path`; a
    click or Enter opens one; the server hides dot folders, `node_modules`, symbolic links and the data directory); an
    empty folder reads "No folders here.". Folders that already are projects show a "Project" badge and are disabled;
    past 500 folders the list ends with "Showing the first 500 folders." The open folder is the selected folder. Each
    browse request aborts the previous one; a polite live region announces "Opened {folder}, {n} folders" and focus
    moves to the first entry (else Parent folder) when focus was in the browser. Errors inline (`folder-browser-error`,
    `data-code` = the `HarnessError` code): 404 → "This folder no longer exists." with **Parent folder** and **Back to
    workspace folders**; 400 / 403 → "Choose a folder inside the workspace folders." (with Back to workspace folders);
    anything else → the server message with **Retry**.
  - **New folder** (`folder-browser-new`, `FolderPlus`; rendered by the dialog right below the browser, because the
    folder is created only on submit): reveals a "Folder name" input (`folder-browser-new-input`) checked like
    `folderNameSchema`: no `/` or `\`, not `.` or `..`, no leading dot, at most 255 characters (inline errors "Use a
    name without slashes.", "Folder names can't start with a dot.", "Use at most 255 characters."). With a name the
    request becomes `{ name, path: <the open folder>, newFolder }`.
  - **Selected** (rendered by the dialog): "Selected: {path}" in mono, the folder the project would use (the open
    folder, or the new folder inside it).
  - **Name** (`add-project-name`, at most 80 characters): the selected folder's basename (or the new folder's name)
    until the user edits it.
  - **Add project** (`add-project-submit`; disabled without a project folder or without a name: the open folder counts
    only when it is not a root itself, so a root can be used only through New folder) →
    `useFreshAuth().run(() => projects.create(body), { required: true })` with `ConfirmPasswordDialog` ("Adding a
    project needs your password.", 8.4); cancelling the prompt shows nothing. Success → toast "Project added",
    `created(project)`, the dialog closes (the switcher then filters by the new project).
  - **Inline errors** (`add-project-error`, `data-code` = the `HarnessError` code): 409 `exists` → "A project for this
    folder already exists." (with a new folder: "A folder with this name already exists."); 400 → the server message
    ("Choose a folder inside the workspace folders.", "This folder is inside the harness-forge data directory.", "A
    server can have up to 200 projects.", …); 403 → "Choose a folder inside the workspace folders."; 404 → "This folder
    no longer exists."; anything else → the server message.
  - **No workspace folders** (every root missing): an `Alert` "No workspace folders. Set HF_WORKSPACE_ROOTS on the
    server." and the submit stays disabled.

### 9.11 Agent settings (`AgentSettingsSection`, W9.12, Phase 9)

`AgentSettingsSection` (`components/settings/agent/`, no props, no emits) is a `SettingsSection` "Agent" with the
description "Long chats, sub-agents and plans." (Phase 9: "Long chats and sub-agents."), mounted by `GeneralSettings` between the Chat fields and Custom instructions
(wireframe 2.16). It reads and writes the settings store through `settings.update` (optimistic, rolled back with an
error toast like every General field) and loads the model catalog on mount when nothing loaded it yet (the selects
and the warning read it). The Shift+Tab switch lives in the General list itself (9.4), right after Alt shortcuts.

| Field | Control and copy | Setting key | Test id |
|---|---|---|---|
| Automatic compaction | `Switch`, help "Summarize older messages when a chat nears the model's context window. When off, older messages are left out instead." | `autoCompact` (default on) | `settings-auto-compact` |
| Compaction model | `SettingsModelSelect` (chat models) with `allowNone` "Same model as the chat", help "Writes the summary when a chat is compacted." | `compactModelRef` (null = the chat's model) | `settings-compaction-model` |
| Sub-agent model | the same select, `allowNone` "Same model as the chat", help "Runs the tasks the agent hands to sub-agents."; when the chosen model cannot call tools (`capabilities.tools` false) a warning `TriangleAlert` "{model} can't call tools, so sub-agents can't use it." (`text-warning`, `data-slot="subagent-model-warning"`, linked to the select by `aria-describedby`; none for a model the catalog does not know) | `subagentModelRef` (null = the chat's model) | `settings-subagent-model` |
| Sub-agent max steps | `Input` (`inputmode="numeric"`) 1–200, the save and validation rules of Max steps (blur or Enter saves, Esc restores, "Enter a whole number from 1 to 200."), help "How many tool calls one sub-agent may chain (1–200)." (Phase 10: it bounds background agents too) | `subagentMaxSteps` (default 30) | `settings-subagent-max-steps` |
| Save approved plans (Phase 10, ADR-047) | `Switch`, help "When you approve a plan in a project chat, it's saved as a Markdown file in the project." | `planFiles` (default off) | `settings-plan-files` |
| Plan folder (Phase 10) | mono `Input` (placeholder `.harness/plans`, at most 200 characters), disabled while Save approved plans is off; help "A folder inside the project. Files are named by date and plan title."; saves on blur or Enter, Esc restores the saved value; checked with the shared settings schema (`settingsSchema.shape.planDirectory`: a relative path without `..` segments, without a `.git` segment, not absolute, not empty): "Use a folder inside the project, like .harness/plans." and "Use at most 200 characters."; a 400 from the server shows the same texts inline and keeps the saved value; any other failure restores the saved value with an error toast; turning Save approved plans off drops an unsaved draft and its error | `planDirectory` (default `.harness/plans`) | `settings-plan-directory` |

- A model that no longer exists in the catalog shows the selects' usual unavailable state; the server then falls back
  to the chat's model (the compaction logs a warning; ARCHITECTURE.md 6.18, 6.22).
- Plan files (Phase 10): the setting applies to the approvals made after it changed; a plan approved in a chat without a
  project is never saved; a failed write shows in the plan row (7.25) and never blocks the approval. The saved files are
  ordinary project files (journaled under the reply: the changes panel lists them, rewind and revert cover them).
- `autoCompact` off: the server trims the oldest messages as before v1.5 (the notice `context-trimmed`); `/compact`
  still works.
- Mobile: labels stack above the controls below `sm`, like the other General fields.

### 9.12 Customize (`/settings/customize`, W10.8, Phase 10)

Agent customization (ADR-044, ADR-045). Three **kinds** of definitions, each a markdown file with YAML frontmatter:
**agents** (sub-agents the main agent can start with `task`; the body is the sub-agent's instructions), **commands**
(slash commands; the body is the prompt) and **skills** (instructions the agent loads on demand; the body is the skill).
They come from four **sources**, lowest precedence first: built-in < plugins < personal (this page, stored in the
database) < the project (`.claude/{agents,commands,skills}`, then `.harness/…`, which wins). A higher source wins a
name; the losers stay listed as **shadowed**. Wireframes: 2.17. User guide: `docs/guides/customizing-agents.md`.

`CustomizeSettings` (`customize-settings`) in the usual `SettingsPage` frame: the page (`pages/settings/customize.vue`)
renders the `PageHeader` "Customize" with the description "Sub-agents, slash commands and skills: yours, your projects'
and your plugins'." and two header actions: **Import…** (`customize-import`, `FileUp`, outline) and **New agent** /
**New command** / **New skill** (`customize-new`, `Plus`, primary, `data-kind`; the label follows the tab). Nav label
"Customize" (5.5).

- **Tabs** (`Tabs`, value synced to `?tab=`): **Agents** · **Commands** · **Skills** (`customize-tab`, `data-value`
  `agents | commands | skills`, `data-count` = the rows of that kind in the current scope, shown as "Agents 6"). Picking
  a tab always writes `?tab=` (the default `agents` too). Below `sm` the tab list scrolls sideways.
- **Project** select (`customize-project-select`, `data-value` = the project id, empty for none; label "Project"):
  "No project" and the projects sorted by name ("Folder not found" muted after a missing one). It writes `?project=`.
  With a project the page shows that project's definitions and how they combine with the others; without one, only
  personal, plugin and built-in definitions. A project the server does not know (404, e.g. deleted) is dropped from
  the query, so the page falls back to "No project".
- **Loading**: on mount and on every project change the page calls `customizations.fetchCatalog(projectId, { refresh:
  true })` (`GET /api/customizations?projectId=&refresh=1`, so files edited on disk show at once) and
  `fetchCommands(projectId, { maxAgeMs: 15_000 })` (the Built-in command rows); a skeleton (two blocks of three rows,
  "Loading your customizations…" for screen readers) while it loads; a failure shows `SettingsLoadError` "Could not
  load your customizations" with the server message and **Retry**. A scope the store marked stale (a change made here,
  `customization.changed` from another tab, a plugin change or an edit on disk noticed by the server) is refetched
  quietly.

**Sections** (`CustomizationSection`, `customize-section`, `data-source`, `data-count`), always in this order; a section
heading reads "{title} · {n}":

| Section (`data-source`) | Contents | Editable |
|---|---|---|
| Personal (`user`) | the user's own definitions of the tab's kind, turned-off ones included | yes |
| In {project} (`project`; only with a project selected) | the project's files of the tab's kind; the heading also shows the scanned folders in mono (`.harness/agents · .claude/agents`); folder-level problems of that kind (a linked folder, more than 200 files, an unreadable folder: the catalog's diagnostics, "{path}: {message}") show as a warning `Alert` under the heading (the section's `notices` slot); an unavailable project folder replaces the rows with an `Alert` (`issue`) and counts 0 | no (edit the files in the project) |
| From plugins (`plugin`) | the definitions contributed by enabled plugins (plugin API 1.4.0); the section is hidden when empty | no |
| Built-in (`builtin`) | Agents: `explore` ("Explore": read-only research) and `general` ("Agent"); Commands: `/compact` (from `GET /commands`, source `harness`) and the client commands (`/new`, `/model`, `/effort`, `/mode`, `/help`, `/remember`, with the composer's descriptions), sorted by name, as rows without a menu that show their description and end their meta line with "Reserved: a personal or project command can't use this name."; Skills: no section | no |

**Rows** (`CustomizationRow`, `customization-row`, `data-kind`, `data-name`, `data-source`, `data-state` `active |
shadowed | invalid | off`, plus `data-customization-id` for personal rows, `data-path` for project rows and
`data-plugin-id` for plugin rows; at least `--row-height` per line, 40px targets on coarse pointers):

- **Line 1**: the kind icon (agents: `Telescope` / `Bot` for the built-ins, `BotMessageSquare` otherwise; commands:
  `SquareSlash`; skills: `BookOpen`), the name (commands as `/name`; mono), the description (one line, truncated; two
  lines below `sm`).
- **Line 2** (muted, `·`-separated, wraps): the source badge ("Personal", "Project", the plugin name, "Built-in"), the
  project path (mono, truncated in the middle) for project rows, the namespace for project commands in a subfolder, the
  model ("{model name}", "Same as the chat" for `inherit`; nothing when unset), the tools ("{n} tools" / "All tools" for
  agents; "Tools limited to {n}" for commands with `allowed-tools`), the argument hint (mono) for commands.
- **State badges**: **Shadowed** (`EyeOff`, muted; tooltip "Not used: {winner} wins.", where `{winner}` is "the
  project's .harness/agents/x.md", "your personal agent" or "the agent from {plugin}"); **Invalid** (`CircleAlert`,
  destructive outline: the definition cannot be used; its diagnostics list is expanded under the row,
  `customization-diagnostics`, one line each, the diagnostic's `message` as is: it already starts with "Line N: " when
  the line is known, so the UI never adds a prefix, e.g. "Line 2: Add a description."); **{n} warnings** (a warning dot; the button
  toggles the same diagnostics list: "Unknown tool: foo", "The model alias sonnet is not supported: the default model
  is used.", "Ignored: color, permissionMode"); **Off** (personal rows turned off: listed, not used, they shadow
  nothing). Info diagnostics (ignored keys) count as warnings in the badge only when there is nothing else.
- **⋯ menu** (`customization-row-menu`, named "Actions for {name}", always visible on touch): personal rows: **Edit…**
  (`customization-edit`) · **Duplicate** (`customization-duplicate`: the editor in new mode with the name
  `{name}-copy`) · **Export .md** (`customization-export`) · **Turn off** / **Turn on** (`customization-toggle`) ·
  separator · **Delete…** (`customization-delete`, destructive); project, plugin and built-in agent rows: **View…**
  (`customization-view`) · **Copy to personal** (`customization-duplicate`: the editor in import mode, prefilled from the
  file) · **Export .md** (`customization-export`) · **Open plugin** (plugin rows, `data-action="open-plugin"`, no test
  id, → `/plugins/{id}`). Built-in command rows have no menu. A chosen item acts once the menu has closed (focus is back
  on the trigger, so a sheet or dialog it opens returns focus there); menu items are 40px tall on coarse pointers.
- **Turn off / on**: `update(id, { enabled })`, optimistic (rolled back with an error toast on failure); Delete… is
  disabled while a toggle or delete of the row is in flight (`busyIds`).

**Editor** (`CustomizationEditor`, `customization-editor`, `data-kind`, `data-mode` `new | edit | import`): a right-side
`Sheet` (`w-full sm:max-w-2xl`, full width at 390px), the body scrolls and the footer is sticky. Title "New agent" /
"Edit {name}" / "Import agent" (commands, skills alike). Built with `@tanstack/vue-form` and the shared parser: the
fields are serialized with `formatDefinition` (`@harness-forge/shared` `util/definitions.ts`) into the markdown that is
saved (`{ kind, content, enabled }`), and every change is re-parsed with `parseDefinition`, so the inline errors are the
server's rules.

| Field | Agent | Command | Skill |
|---|---|---|---|
| Name (`customization-name`, mono) | ✓ (a-z, 0-9, `-`, ≤ 64) | ✓ with a `/` prefix adornment (≤ 32) | ✓ (≤ 64) |
| Description (`customization-description`, `Textarea` 2 → 4 rows, ≤ 1,024) | help "When the main agent should use it. It reads this to decide." | help "Shown in the slash menu." | help "When the agent should load it. It reads this to decide." |
| Tools (`customization-tools-mode` `RadioGroup`, `data-value` `all \| some`, + `customization-tools`) | "All tools the chat allows" / "Only these tools" | label "Allowed tools": "No restriction" / "Only these tools" | — |
| Model (`customization-model`, `SettingsModelSelect`, chat models; `data-value` = the ref, `inherit` or empty) | `allowNone` "Default sub-agent model" (the setting, else the chat's model) and, under the select, the checkbox **Same as the chat** (`inherit`; `SettingsModelSelect` has no extra option, so the checkbox sets it and the select then reads "Same as the chat"; picking a model clears it) | `allowNone` "The chat's model" | — |
| Argument hint (`customization-argument-hint`, mono, ≤ 100, placeholder `<file> [focus]`) | — | ✓ help "Shown after the command while you type its arguments." | — |
| Body (`customization-body`, `MarkdownEditor`, min 16rem, at most `50dvh` on phones) | "Instructions", help "What the sub-agent should do and how. It gets these instead of the main agent's conversation." | "Prompt", help "$ARGUMENTS is the text after the command; $1 to $9 are single words (quotes group words); {{input}} works too. Without a placeholder the text is added at the end." | "Instructions", help "A personal skill is one file. Put scripts and reference files in a project skill folder." |

- **Size**: a counter next to the body's label shows the size of the whole file as saved, "{n} KB / 64 KB" (one
  decimal, e.g. "1.2 KB / 64 KB"; `aria-live="off"`); above 64 KB: "The file can be up to 64 KB." and Save is disabled.
- **ToolMultiSelect** (shown with "Only these tools"): a trigger "Choose tools…" / "1 tool chosen" / "{n} tools chosen"
  (`customization-tools`, `data-count`, named "{label}, {n} tools chosen") opening a `Popover` with a searchable
  `Command` list ("Search tools…"; "No tools found." / "No tools are available.") of the tools grouped by plugin
  (`plugins.tools`, `GET /api/tools`; MCP tools under their server; the `core-agent` tools are left out for agents,
  since a sub-agent never gets them); each option (`customization-tool-option`, `data-tool-name`, `data-state`) has a
  checkbox; the chosen tools show as chips (`customization-tool-chip`, `data-tool-name`) with a remove button "Remove
  {tool}". A name the tool list does not know (an imported Claude Code name that maps to nothing, a tool of a disabled
  plugin) stays as a warning chip with the tooltip "Not available now". At most 64 (further options are disabled).
- **Validation copy**: "Add a name."; "Use lowercase letters, digits and hyphens, starting with a letter."; "{name} is
  a built-in name." (agents `explore`, `general`, `general-purpose`; commands: the client commands and `compact`);
  "Add a description." (agents and skills; a command may leave it empty: the first line of its prompt is used); "Add
  the prompt." (a command without a body); "Use at most {n} characters."; "The file can be up to 64 KB."; a 409
  `exists` shows on the name field: "You already have a {kind} named {name}." ("an agent"); a 400 with diagnostics
  lists them in the form-level alert; parser errors the field rules do not cover show there under the title "The
  definition has errors."; any other error shows in the form-level alert (`customization-error`, `data-code`) with the
  server message (e.g. "You can have up to 200 agents."). Inline errors show once a field was left or a save was tried
  (in import mode at once); parser warnings show under the Tools and Model fields.
- **Saving**: **Save agent** / **Save command** / **Save skill** (`customization-save`; disabled while invalid or
  saving) → `customizations.create({ kind, content })` (new, import) or `update(id, { content })` (edit) → toast "Agent
  saved" ("Command saved", "Skill saved") and the sheet closes (the page refetches the scope and switches to the saved
  kind's tab when it differs); focus returns to the row's menu trigger (or to New / Import…). Mod+Enter in any field
  saves. The sheet opens with focus on Name (new, import) or Description (edit); its sr-only description is the body's
  help text.
- **Closing with changes** (Esc, ×, Cancel, a click outside): `ConfirmDialog` "Discard changes?" with "Your changes are
  lost." and **Discard** (`customization-discard-confirm`, destructive) / **Keep editing**.
- **The body editor** (`MarkdownEditor`, CodeMirror with markdown highlighting, loaded with a dynamic import; a plain
  textarea with the same contract when CodeMirror cannot load): Tab is **not** captured (it moves focus, so there is
  no keyboard trap; indentation uses spaces typed by hand), lint markers show the diagnostics with a line (moved to the
  body's own line numbers), `aria-label` = the field label, the help text linked through `aria-describedby`.

**Viewer** (`CustomizationViewer`, `customization-viewer`): a read-only right-side sheet for project, plugin and
built-in definitions. Title = the name; the frontmatter as a definition list (description, tools, model, argument hint,
source); the raw file (`customizations.sourceOf(entry, projectId)` = `GET
/api/customizations/source?projectId&kind&name&source&path` → `{ content, path? }`; `path` = the entry's own file, so a
shadowed project file shows its own content) in a read-only `MarkdownEditor` with the diagnostics as lint markers; for
project files the path in mono with **Copy path**. Footer: **Copy to personal** (opens the editor in import mode,
prefilled) and **Export .md**. A source that is gone (the file was deleted meanwhile, 404) shows "This file no longer
exists." (`data-slot="customization-viewer-gone"`) with **Close**; another failure shows its message.

**Import and export** (in the browser; no routes):

- **Import…** opens a visually hidden file input (`customize-import-input`, accepts `.md,text/markdown`, one file). A
  file over 256 KB is refused with the toast "{file} is too large" ("Definition files can be up to 64 KB."). The text
  (UTF-8, BOM and CRLF accepted) goes through `parseDefinition` with the current tab's kind and the file name (its stem is
  the name fallback; a `SKILL.md` needs a `name` in its frontmatter or a name typed in the editor). The editor opens in
  import mode, prefilled, with an `Alert` (`customization-import-notes`, `data-count`): "Imported from {file}. Check the
  fields, then save." followed by one line per diagnostic as the parser words it, the ignored keys gathered into one
  line ("Ignored: color, permissionMode"). A file whose only errors concern its name prefills every other field (the
  name stays empty); a file that cannot be parsed at all opens the editor with the errors and the body as typed.
- **Export .md**: personal rows export their stored `content`; other rows the source file. The download is
  `downloadText(content, '{name}.md', 'text/markdown')` (`utils/download.ts`: a Blob and a temporary link); a skill
  exports as `{name}.md` too (save it as `SKILL.md` in a folder named after the skill).

**Delete**: `ConfirmDialog` "Delete {name}?" with "Chats that used it keep their messages. The agent can't start it
anymore." (commands: "You can't run /{name} anymore."; skills: "The agent can't load it anymore.") and **Delete agent** /
**Delete command** / **Delete skill** (`customization-delete-confirm`, destructive) → `customizations.remove(id)` → toast
"Deleted {name}" with **Undo** (`toast-undo`, 5 s; a custom toast, `data-slot="customization-deleted-toast"`), which
re-creates the definition from the content the page kept (a new id, its `enabled` state kept; without kept content the
toast has no Undo). Focus moves to the next row's menu trigger, else the previous one, else New; Undo puts it on the
restored row's menu trigger.

**Empty states** (`customize-empty`, `data-kind`, `data-source`):

- Personal, with **New {kind}** and **Import…** buttons (the section's `empty-actions` slot; `data-action="new"` /
  `data-action="import"`, no test ids): "No personal agents yet. An agent is a sub-agent with its own
  instructions and tools that the main agent can start." · "No personal commands yet. A command is a saved prompt you
  run with /name." · "No personal skills yet. A skill is a set of instructions the agent loads when a task needs it."
- Project: "No agents in {project}. Add Markdown files to .harness/agents/ (or .claude/agents/) in the project folder."
  · "No commands in {project}. Add Markdown files to .harness/commands/ (or .claude/commands/) in the project folder." ·
  "No skills in {project}. Add a folder with a SKILL.md to .harness/skills/ (or .claude/skills/) in the project folder."
- An unavailable project folder: an `Alert` with the catalog's `project.issue` ("The project folder is unavailable:
  {issue}", the server's message incl. the folder path; "The project folder is unavailable." without one) instead of the
  project rows.
- Plugins: the section is hidden when empty.

**What the page never does**: edit or create files in a project (project definitions are read-only in the UI; edit
them in the repository), read `~/.claude` or any folder outside the project, or let a definition change the permission
mode, approve a tool or add a shell rule (a definition's tool list only narrows).

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
(in `ChatHeader`), `AddProjectDialog` ×, `FolderBrowser` ×, `ProjectInstructionsDialog` ×, the helper
`move-chat.ts` (`useMoveChat`, 11.4), and (added by W7.9) `ProjectMovedToast` (the "Moved to {name}" toast with Undo,
rendered through `toast.custom()`), `folder-path.ts` (the dialog's path helpers) and `projects-load.ts`
(`loadProjectsOnce()`, `refreshProjects()`: the quiet loading of the projects for the chat UI).

**`settings/projects/`** (W7.9, Phase 7; C15 ships the stub) — `ProjectsSettings` × (the body of
`/settings/projects`, 9.10).

**`chat/parts/tools/`** (W7.11, Phase 7; C15 ships the stubs) — `WorkspaceToolBody` ×, `DiffView` ×,
`TerminalOutput` ×, `FileContent` ×, `FileList` ×, `ToolApprovalPreview` × and the pure registry `workspace-tools.ts`
(7.19, 11.4), plus (added by W7.11) `ToolRowSummary` (the `tool-row-summary` badge of `ToolPart` and `ShareToolRow`).
`ToolPart`, `ToolApprovalCard` and `ShareToolRow` use them; `parts/tool-approval-context.ts` (`TOOL_APPROVAL_CONTEXT`,
provided by `ChatView`) tells the approval cards the chat's permission mode and project name. The pure helpers
`utils/line-diff.ts` (`diffLines`, `splitLines`) and `utils/ansi.ts` (`stripAnsi`, `collapseCarriageReturns`,
`terminalText`) belong to W7.11 too.

**`settings/data/`, Phase 7** (W7.13; C15 ships the stubs) — `EncryptionKeySection` ×, `RotateKeyDialog` × and
`StorageCleanupSection` × (9.8), rendered by `DataSettings`, which provides `data-context.ts`
(`dataSettingsContextKey`: `reloadSummary()`, `reloadShares()`) to them; their texts and rules live in `data.ts`.

**`workspace/`** (Phase 8, ADR-036 … ADR-038; C20 ships the stubs, contracts in 10.5) — `ChatWorkspace` × (wraps
`ChatView` on `/chat/[id]`: the changes pane or sheet, Alt+C; 7.21); `changes/`: `ChangesToggle` × (in `ChatHeader`),
`ChangesPanel` ×, `ChangesFileRow` ×, `ChangesFileDiff` ×, `ChangesEmpty` ×, `RevertFileDialog` ×, `RevertedToast` ×
(the "Reverted {path}" toast with Undo, shown by `revert-toasts.ts`), the pure helpers `changes-rows.ts` (11.5) and
`changes-context.ts` (the panel context for the diffs' `currentSha` and a `stale` revert, and the changes target of
the palette); `rewind/`: `RewindDialog` × (owned by `ChatView`, 7.22), `RewindResultToast` × (shown by
`useRewindResultToast()` in `rewind-toast.ts`) and `rewind.ts` (`rewindView`, `rewindResultText`,
`REWIND_DIALOG_HOST`); `allowlist/`: `AllowRuleOption` × (in `ToolApprovalCard`), `AllowlistEditor` ×,
`AllowlistDialog` ×, `GlobalAllowlistSection` × (7.23), `allow-rule.ts` and `allowlist.ts` (the texts); and
`nuxt-imports.ts` (re-exports `useHead` for `pages/chat/[id].vue`, so its tests can mock it). Also Phase 8:
`chat/parts/tools/ToolRuleBadge` × (the rule badge of a shell row, 7.19).

**Agent 2.0** (Phase 9, ADR-040 … ADR-043; C25 ships the stubs, contracts in 10.6) — `chat/compaction/`:
`CompactionDivider` × and `compaction.ts` (`compactionLayout`, `compactionLabel`; 7.24); `chat/steer/`: `SteerNote` ×
(7.26); `chat/agent/`: `PlanApprovalCard` ×, `PlanBody` ×, `TodoList` ×, `TodoStrip` ×, `TaskBlock` ×, `TaskBody` ×,
`TaskStepRow` × and `todos.ts` (`todoState`, `todoStripVisible`; 7.25, 7.27); `chat/queue/`: `QueuedMessages` × (7.26);
`chat/composer/`: `MentionMenu` × (7.26) and `mode-cycle.ts` (`nextToolMode`, `useModeCycle`; 7.11); `settings/agent/`:
`AgentSettingsSection` × (9.11). `TaskBody`, `TodoList` and `PlanBody` are store-free (the share page reuses them).
Phase 9 owners: W9.8 (`chat/composer/**` except the permission, mode-cycle, slash-command and context-ring files,
`chat/queue/**`, the mention / attachment / draft / composer-shortcut composables), W9.9 (`useChatSession`,
`useServerEvents`, the `chat-queue` store, `ChatView`), W9.10 (`chat/agent/**`, `chat/parts/**`, the permission,
mode-cycle and slash-command files, `ShareToolRow`), W9.11 (`ChatTranscript`, `ChatMessage`, `MessageActions`,
`chat-format`, `chat/compaction/**`, `chat/steer/**`, `ContextRing`, the share message files), W9.12
(`settings/agent/**`, `GeneralSettings`, `ChatWorkspace`, `useChangesPanel`, `PluginToolsTable`); see
`docs/phases/phase-9-v1-5.md`.

**Agent customization** (Phase 10, ADR-044 … ADR-047; C33 ships the stubs, contracts in 10.7) — `settings/customize/`:
`CustomizeSettings` × (the body of `/settings/customize`, 9.12), `CustomizationSection` ×, `CustomizationRow` ×,
`CustomizationEditor` ×, `CustomizationViewer` ×, `ToolMultiSelect` × and `customize.ts` (sections, badges, row meta,
drafts, the import wrapper and the editor copy); `common/MarkdownEditor` × (CodeMirror through
`plugins/code/editor-setup.ts`); `chat/composer/`: `SlashArgumentHint` ×, `RememberDialog` × and `remember.ts`;
`chat/background/`: `BackgroundAgents` ×, `BackgroundAgentRow` × and `background-agents.ts`; `chat/agent/`:
`TaskResultNote` ×, `SkillToolBody` ×, `PlanFileChip` ×; `plugins/detail/PluginCustomizationList` ×; `utils/download.ts`
(`downloadText`). Added in P10-A: `settings/customize/CustomizationDeletedToast` (the "Deleted {name}" toast with Undo,
W10.8) and `chat/parts/command-badge.ts` (the pure badge lines of `CommandBadge`, W10.11). `TaskResultNote`,
`SkillToolBody` and `TaskBody` are store-free. Phase 10 owners: W10.8 (the page,
`settings/customize/**`, `MarkdownEditor`, `editor-setup`, the `customizations` store, `download`, the Data export and
import sections), W10.9 (`ChatComposer`, `SlashMenu`, `SlashArgumentHint`, `RememberDialog`, `slash-commands.ts`,
`remember.ts`), W10.10 (`useChatSession`, `useServerEvents`, the `background-tasks` store, `ChatView`, `chat-context`,
`chat/background/**`), W10.11 (`chat/agent/**`, `chat/parts/**`, `ChatMessage`, `ChatTranscript`, `UserMessageBubble`,
`MessageActions`, `chat-format`, the share rendering files), W10.12 (`settings/agent/**`, `ProjectsSettings`,
`PluginContributions`, `PluginCustomizationList`, `plugin-display`); see `docs/phases/phase-10-v1-6.md`.

W4.2 (UX polish) may edit every file above in Phase 4. Phase 8 owners: W8.8 (`ChatWorkspace`, `changes/**`, the
workspace store, `useChangesPanel`, `useServerEvents`, `CommandPalette` and `chat-nav/palette*`), W8.9 (`rewind/**`,
`ChatView`, `ChatTranscript`, `ChatMessage`, `MessageActions`, `ChatHeader`), W8.10 (`chat/parts/**`, the share
rendering files, `AllowRuleOption`, `useChatSession`), W8.11 (`settings/projects/**`, `settings/data/**`,
`pages/settings/projects.vue`, the shell rules store, `allowlist/**` but `AllowRuleOption`, `GeneralSettings`); see
`docs/phases/phase-8-v1-4.md`. Phase 7 owners: W7.9 (the projects and chats stores, `projects/**`,
`settings/projects/**`, `ChatNav`, `CommandPalette`), W7.10 (`useChatSession`, `useServerEvents`, the top-level chat
components and pages), W7.11 (`chat/parts/**`, the share rendering files, `line-diff`, `ansi`), W7.12
(`chat/composer/**`, `GeneralSettings`), W7.13 (`settings/data/**`); see `docs/phases/phase-7-v1-3.md`. Phase 6 owners:
W6.7 (`useChatSession` and the top-level chat components), W6.8 (`chat/parts/**`, `ReadAloudButton`, the share rendering
files), W6.9 (`chat/composer/**`, `ModelCaps`), W6.10 (the settings files), W6.11 (`useFreshAuth` and its call sites in
`plugins/**`, `settings/data/**`, `ShareDialog`; `AppBrand`, `ThemeToggle`, `AppSidebar` and the `ui/sidebar` patch);
see `docs/phases/phase-6-v1-2.md`.

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
  header?: (p: { scrolled: boolean; title: string | null; loading: boolean; projectId: string | null }) => any
                                  // above the transcript (ChatHeader); scrolled = the transcript left its top; not
                                  // rendered on 404; + Phase 7: projectId = the chat's project (null = none)
  empty?: (p: { projectId: string | null; setProject: (projectId: string | null) => void }) => any
                                  // above the inline composer of an empty new chat (greeting, callout); + Phase 7: the
                                  // project the first send carries and its setter (NewChatProjectPicker's v-model)
}>()
// + Phase 7: provides TOOL_APPROVAL_CONTEXT ({ toolMode(), projectName() }) to the approval cards and loads the
// projects once; a chat request answered 409 busy puts the message back and shows the key-rotation toast (7.4).

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
  approval: [response: { id: string; approved: boolean; toolName: string; alwaysAllow: boolean
    acceptEdits?: boolean /* + Phase 7 */ }]
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
  projectId?: string | null       // + Phase 7 (C15): a project chat: PermissionMenu offers Accept edits and
                                  // /mode edits works
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
defineProps<{ modelValue: ToolMode; open?: boolean; returnFocusTo?: HTMLElement | null
  modes?: readonly ToolMode[] }>()   // + Phase 7 (C15): default every mode; the current mode always shows
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
(`import DiffView from './tools/DiffView.vue'`). Slots are not frozen: P7-A added the slots marked "+ slot" below
(`DiffView` `stats`, `FileList` `empty`, `WorkspaceToolBody` `raw`), the `DiffView` attribute `data-numbers="off"`,
the `ChatView` slot props (10.4 Chat) and a default slot in `ChatGreeting` (the new-chat picker, 7.13). Phase 8 (C20,
P8-0b) replaced the `DiffView` slot and attribute with the props `stats` and `lineNumbers` (10.5); the signature below
is the v1.4 one.

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
// the chats store filter when the filter is not 'all'. pages/index.vue puts it in ChatGreeting's default slot and binds
// it to ChatView's empty slot props: :model-value="projectId" @update:model-value="setProject".

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
defineSlots<{ raw?: () => any }>()   // + slot: the generic ToolValueBlocks; the toggle renders only when it is filled
// Renders DiffView / TerminalOutput / FileContent / FileList by view.kind, then the toggle tool-raw-toggle
// ("Raw input and output", data-state = open | closed), which shows the raw slot. No root test id
// (data-slot="workspace-tool-body", data-kind = the view kind).

// DiffView (W7.11; stub)
defineProps<{
  hunks: readonly DiffHunk[]      // the server's hunks (workspaceDiffSchema) or utils/line-diff.ts output
  path?: string | null            // project-relative path shown in the header
  created?: boolean               // default false: a new file ("New file" badge)
  truncated?: boolean             // default false: "Diff truncated by server"
  maxLines?: number               // default 200: then "Show {n} more lines"
  stats?: { additions: number; deletions: number } | null   // + Phase 8 (C20; was the `stats` slot): the header's
                                  // "+a −d"; null / absent = counted from the hunks; WorkspaceToolBody and
                                  // ChangesFileDiff pass the server's totals
  lineNumbers?: boolean           // + Phase 8 (C20; was the fallthrough attribute data-numbers="off"), default true;
                                  // false = no line numbers and no hunk headers (approval previews)
}>()
// Root diff-view (data-path, data-state = created | modified, data-numbers = on | off rendered by the component;
// role="region" aria-label "Changes to {path}"); lines diff-line (data-kind = add | del | context); diff-expand
// (data-action = unfold | show-all). No slots and no useAttrs since Phase 8.

// TerminalOutput (W7.11; stub)
defineProps<{ command: string; output: ShellOutput | null; running?: boolean
  cwd?: string | null }>()        // + Phase 8 (C20): the start folder while running (7.19); default null
// output null while running; Phase 8: terminal-cwd (data-value), terminal-cwd-change (data-value) from output.cwd /
// output.endCwd, the cwdNote line and "Allowed by rule: …" from output.allowedBy
// Root terminal-output (data-status = running | ok | error | timeout | killed; aria-label "Output of {command}");
// terminal-command, terminal-stdout, terminal-stderr, terminal-exit (data-value = the exit code).

// FileContent (W7.11; stub)
defineProps<{ path: string; content: string; startLine?: number; totalLines?: number | null; truncated?: boolean }>()
// startLine default 1; 20 lines, then "Show all". Root file-content (data-path).

// FileList (W7.11; stub)
defineProps<{ items: readonly FileListItem[]; truncated?: boolean; maxItems?: number }>()   // maxItems default 50
defineSlots<{ empty?: () => any }>()   // + slot: the text of an empty list (default "No results.")
// Root file-list; items file-list-item (data-path; data-type for entries, data-line for matches); search matches
// grouped by path with "line:" prefixes.

// ToolRowSummary (W7.11; added in P7-A, not a stub) — the summary before a workspace row's status (7.19)
defineProps<{ summary: WorkspaceRowSummary }>()   // { text, tone } from workspaceRowSummary
// Root tool-row-summary (data-tone = muted | success | destructive | warning); "+a −d" colors each side.

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
// mode (11.1). The card injects TOOL_APPROVAL_CONTEXT (parts/tool-approval-context.ts, provided by ChatView):
//   interface ToolApprovalContext { toolMode: () => ToolMode | null; projectName: () => string | null }
// in 'edits' a write tool's card shows neither checkbox; projectName feeds "In {project}" of a shell preview.

// EncryptionKeySection (W7.13; stub) — Settings → Data (9.8). No props, no emits: loads keys.get() itself and owns the
// RotateKeyDialog. Root data-key-section; the button data-key-rotate. After a rotation it reloads itself and calls the
// page's reloadSummary() / reloadShares() (data-context.ts, injected; no-ops outside DataSettings).

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
//                                                           // (offeredToolModes); the current mode always shows
// Slot additions (P7-A, not frozen)
// ChatView (W7.10):       header slot props + projectId; empty slot props { projectId, setProject } (10.4 Chat)
// ChatGreeting (W7.10):   a default slot right under the heading (NewChatProjectPicker on '/')
```

### 10.5 Phase 8 contracts (Workspace 2.0: W8.8 – W8.11; C20 ships the stubs)

The thirteen components marked "stub" are created by C20 in P8-0b with exactly these props, emits and root test ids and
are frozen from Gate P8-0b (a change is a CCR); P8-A implements them behind those contracts. Types from
`@harness-forge/shared`: `ChatChanges`, `FileDiff`, `GitStatus`, `RewindPreview`, `RestoreResult`, `ShellRule`,
`ProjectSummary`, `ShellOutput` (with `endCwd?`, `cwdNote?`, `allowedBy?`); `ChangesView`, `ChangesRow` and
`ChangesEmptyReason` from `components/workspace/changes/changes-rows.ts` (11.5); `ShellRuleScope = 'project' |
'global'` from `components/workspace/allowlist/allow-rule.ts` (11.5). The components are imported by path.

```ts
// ChatWorkspace (W8.8; stub; mounted by pages/chat/[id].vue around ChatView) — 7.21
defineProps<{ chatId: string; projectId: string | null }>()   // projectId null: only the chat panel renders
defineSlots<{ default: () => any }>()                         // the ChatView
// Always a horizontal ResizablePanelGroup (the chat panel never remounts); ≥ 1024px + open + project: the handle
// changes-resize and an <aside> with ChangesPanel variant="pane"; < 1024px: a right Sheet with variant="sheet".
// Registers Alt+C (id toggle-changes, 12). No root test id (data-slot="chat-workspace").

// ChangesToggle (W8.8; stub; mounted by ChatHeader between ChatProjectChip and ⋯) — 7.21
defineProps<{ chatId: string; projectId: string | null }>()
// Renders nothing for a null project. Root changes-toggle (data-state = open | closed, data-count; aria-pressed,
// aria-controls). Fetches the chat's changes once on mount (the count pill).

// ChangesPanel (W8.8; stub) — the header, the two views, the summary and the list (7.21)
defineProps<{ chatId: string; projectId: string; variant: 'pane' | 'sheet' }>()
defineEmits<{ close: [] }>()
// Root changes-panel (id hf-changes-panel; data-view = chat | git, data-state = loading | ready | error | unavailable,
// data-variant = pane | sheet); its h2 "Changes" (id hf-changes-heading) labels the pane and the sheet;
// changes-view-option (data-value), changes-refresh, changes-close, changes-summary (data-count), changes-error
// (data-code). Owns the RevertFileDialog and provides CHANGES_PANEL_CONTEXT (changes-context.ts) to the rows.

// ChangesFileRow (W8.8; stub) — one accordion row
defineProps<{ chatId: string; view: ChangesView; row: ChangesRow; open: boolean }>()
defineEmits<{ 'update:open': [value: boolean]; revert: [row: ChangesRow] }>()
// Root changes-file (data-path, data-status, data-state = open | closed, data-conflict); the button
// changes-file-revert (data-path) unless the row is not revertible; renders ChangesFileDiff while open.

// ChangesFileDiff (W8.8; stub) — the lazy diff of an open row
defineProps<{ chatId: string; view: ChangesView; path: string }>()
// GET /api/chats/:id/changes/diff?source=view&path= through workspace.fileDiff (aborted on unmount), then DiffView
// with the diff's hunks, :stats (its added / removed) and line numbers; the binary / too-large / base-missing notes
// of 7.21. No root test id
// (data-slot="changes-diff", data-state = loading | ready | error).

// ChangesEmpty (W8.8; stub) — the empty and unavailable states
defineProps<{ reason: ChangesEmptyReason }>()
// Root changes-empty (data-reason); the texts of the 7.21 states table.

// RevertFileDialog (W8.8; stub) — the revert confirmation (styled as ConfirmDialog, built on its AlertDialog parts with
// data-slot="confirm-dialog", so a successful revert can move focus to the next row)
defineProps<{
  open: boolean
  chatId: string
  view: ChangesView
  row: ChangesRow | null
  expectedSha?: string | null     // FileDiff.currentSha of the row's loaded diff (null = that diff showed the file
                                  // missing); undefined = the diff was never loaded, nothing is sent
}>()
defineEmits<{ 'update:open': [value: boolean]; reverted: [result: RestoreResult, path: string] }>()
// The confirm button carries changes-revert-confirm. Calls workspace.revert(); shows the "Reverted {path}" toast with
// Undo and the error toasts itself (revert-toasts.ts, 7.21); emits reverted after a success (the panel moves focus).

// RewindDialog (W8.9; stub; owned by ChatView) — 7.22
defineProps<{ open: boolean; chatId: string; messageId: string | null }>()
defineEmits<{ 'update:open': [value: boolean]; restored: [result: RestoreResult, then: 'none' | 'edit'] }>()
// Root rewind-dialog (data-state = loading | ready | empty | error | restoring) on a wrapper inside DialogContent
// (reka owns the content's data-state open | closed); rewind-file (data-path, data-action = restore | delete |
// unavailable, data-conflict), rewind-shell-command, rewind-force, rewind-restore, rewind-restore-edit, rewind-error
// (data-code). Loads GET /api/chats/:id/rewind?messageId= on open and posts POST /api/chats/:id/rewind itself (useApi;
// the workspace store has no rewind members); emits restored(result, then) and closes. ChatView shows the result
// toast with Undo (useRewindResultToast, rewind-toast.ts) and calls transcript.startEdit(messageId) after
// restored(…, 'edit').
// A 404 or a 409 run-active goes to the optional host injected under REWIND_DIALOG_HOST (rewind.ts:
// { refused(failure) }, provided by ChatView: the toasts, following the run, reloading the path); without a host, or
// for any other failure, the error shows inline.

// AllowRuleOption (W8.10; stub; mounted by ToolApprovalCard for the builtin shell) — 7.3, 7.23
defineProps<{ command: string; disabled?: boolean }>()
defineModel<{ prefixes: string[]; scope: ShellRuleScope } | null>()   // null = the box is unchecked
defineEmits<{ valid: [value: boolean] }>()                            // false while checked with an invalid prefix
// Root tool-approval-allow-rule (the checkbox; data-state = checked | unchecked; wrapper data-slot="allow-rule", the
// revealed part data-slot="allow-rule-details"); tool-approval-rule-prefix (the input, or each chip; data-value),
// tool-approval-rule-scope (data-value = project | global), tool-approval-rule-error (data-code). Renders only the
// always-ask note (data-slot="allow-rule-note") when suggestShellRules(command) is empty. The model holds the
// canonical prefixes.

// AllowlistEditor (W8.11; stub) — the rules of one scope (7.23)
defineProps<{ projectId: string | null }>()   // null = the global rules
// allowlist-rule (data-rule-id, data-value), allowlist-rule-remove, allowlist-input, allowlist-add, allowlist-error
// (data-code), allowlist-empty. Reads and writes useShellRulesStore. No root test id (data-slot="allowlist-editor").

// AllowlistDialog (W8.11; stub; opened by the project row menu) — 9.10
defineProps<{ open: boolean; project: ProjectSummary | null }>()
defineEmits<{ 'update:open': [value: boolean] }>()
// Root allowlist-dialog; title "Allowed commands in {name}"; renders AllowlistEditor :project-id="project.id".

// GlobalAllowlistSection (W8.11; stub; mounted by pages/settings/projects.vue below ProjectsSettings) — 9.10
// No props, no emits. Root allowlist-section; a SettingsSection "Allowed in every project" with AllowlistEditor
// :project-id="null".

// ToolRuleBadge (W8.10; stub; mounted by ToolPart and ShareToolRow) — 7.19
defineProps<{ prefixes: readonly string[] }>()   // ShellOutput.allowedBy; renders nothing when empty
// Root tool-row-rule (data-value = the prefixes joined with ", "); ShieldCheck + the sr-only text
// ", allowed by rule {prefixes}"; tooltip "Allowed by rule: {prefixes}".

// Prop and emit additions (C20 declares them in P8-0b; the owners use them in P8-A)
// MessageActions (W8.9):  canRewind?: boolean (default false) + emit rewind: []   // History, after Edit
// ChatMessage (W8.9):     canRewind?: boolean (default false) + emit rewind: []   // passed to MessageActions
//                         approval emit payload + allowRules?: { prefixes: string[]; scope: ShellRuleScope }
// ChatTranscript (W8.9):  emit rewind: [messageId: string]; defineExpose + focusRewind(messageId: string): void,
//                         startEdit(messageId: string): void (opens MessageEditor on that user message unless busy);
//                         + the optional prop projectId?: string | null (P8-A, not frozen; default null: no
//                         "Rewind files to here"), passed by ChatView
// ToolApprovalCard (W8.10): decide payload + allowRules?: { prefixes: string[]; scope: ShellRuleScope }
// ToolPart (W8.10):       approval payload + allowRules? (pass-through); renders ToolRuleBadge for outputs with
//                         allowedBy and passes cwd to TerminalOutput while running
// DiffView (C20, complete in P8-0b): stats?: { additions; deletions } | null, lineNumbers?: boolean (10.4)
// TerminalOutput (W8.10): cwd?: string | null (10.4)
// ChatHeader (W8.9):      mounts ChangesToggle with its chatId and projectId (no new prop)
// ChatView (W8.9):        owns RewindDialog and provides REWIND_DIALOG_HOST; shows the rewind result toast;
//                         provides TOOL_APPROVAL_CONTEXT.projectId / shellCwd (11.5); shows the "Could not save the
//                         rule" toast when session.approve() rethrows a rule failure
```

### 10.6 Phase 9 contracts (Agent 2.0: W9.8 – W9.12; C25 ships the stubs)

The twelve components below are created by C25 in P9-0b with exactly these props, emits and root test ids and are frozen
from Gate P9-0b (a change is a CCR); P9-A implements them behind those contracts. Types from `@harness-forge/shared`
(names as in API.md): `CompactionData`, `SteerData`, `TodoItem`, `TaskInput`, `TaskOutput`, `TaskStep`, `QueueItem`,
`ProjectFileEntry` (`{ path, kind: 'file' | 'dir' }`), `ToolMode`; `ToolPartLike` from `components/chat/chat-format.ts`;
`TodoState` from `components/chat/agent/todos.ts` (11.6). History-derived state comes only from
`packages/shared/src/util/agent-state.ts` and mention parsing / ranking only from `util/mentions.ts`; the components
never re-implement them. Every component is imported by path.

```ts
// CompactionDivider (W9.11; stub; ChatMessage renders it for block kind 'compaction') — 7.24
defineProps<{
  data: CompactionData
  variant: 'history' | 'run'     // 'history' = the first rendered block of its message (manual, or automatic before
                                 // the reply); 'run' = after other blocks of its message (in-run compaction)
}>()
// Root compaction-divider (data-kind = data.trigger, data-variant, data-count = data.messagesCompacted; role="group",
// aria-label = the label); compaction-toggle (data-state = open | closed, aria-expanded, aria-controls);
// compaction-summary (rendered while open). No state attribute: a marker is always finished.

// SteerNote (W9.11; stub; ChatMessage renders it for block kind 'steer') — 7.26
defineProps<{ steer: SteerData }>()   // { id, parts (text | file), queuedAt, deliveredAt }
// Root steer-note (data-message-id = steer.id; role="note", sr-only prefix "You said while the agent worked:").

// PlanApprovalCard (W9.10; stub; ToolPart renders it for core-agent's exit_plan_mode in approval-requested) — 7.25
defineProps<{ part: ToolPartLike; source?: string | null; disabled?: boolean }>()   // source: "from {plugin}"
defineEmits<{ decide: [decision: { approved: boolean; mode?: 'edits' | 'ask'; feedback?: string }] }>()
// Root plan-approval (data-state = pending | sending); plan-approval-plan, plan-feedback, plan-keep-planning,
// plan-approve-ask, plan-approve-edits. mode is set only with approved: true; feedback (trimmed, left out when empty)
// ≤ 2,000 characters. Not store-free: after a decision it calls useUiStore().requestComposerFocus() (desktop only).

// PlanBody (W9.10; stub; store-free) — the plan as Markdown (card, row body, share page)
defineProps<{ plan: string; feedback?: string | null }>()   // feedback: "Your feedback: …" below the plan
// No root test id (data-slot="plan-body"; the feedback line is data-slot="plan-feedback-text").

// TodoList (W9.10; stub; store-free) — the todo_write row body, the strip and the share page
defineProps<{ todos: readonly TodoItem[]; variant?: 'row' | 'strip' }>()   // default 'row'
// Root todo-list (<ul role="list">, data-variant = row | strip); todo-item (data-status = pending | in_progress |
// completed, data-index).

// TodoStrip (W9.10; stub; ChatView mounts it in the dock above QueuedMessages) — 7.25
defineProps<{ state: TodoState | null; running: boolean }>()   // renders nothing unless todoStripVisible(state, running)
// Root todo-strip (data-state = open | closed, data-count = total, data-value = done); todo-strip-toggle
// (aria-expanded, aria-controls); localStorage['hf-todo-expanded'].

// TaskBlock (W9.10; stub; ChatMessage renders it for block kind 'task') — 7.27
defineProps<{ part: ToolPartLike; streaming: boolean; superseded?: boolean }>()
defineEmits<{ approval: [response: { id: string; approved: boolean; toolName: string; alwaysAllow: boolean }] }>()
// Root task-block (data-state = queued | running | completed | failed | limit | aborted | approval | denied,
// data-kind = explore | general); task-block-trigger; renders ToolApprovalCard for an approval-requested task call
// and falls back to ToolPart when input or output do not parse (taskInputSchema / taskOutputSchema).

// TaskBody (W9.10; stub; store-free, also used by ShareToolRow) — the expanded part of a task block
defineProps<{ input: unknown; output: unknown; running: boolean }>()   // parsed inside; unparsable → nothing
// No root test id (data-slot="task-body"); task-step (via TaskStepRow), task-steps-more, task-report; data-slot
// task-steps, task-steps-omitted, task-meta. data-slot="task-live" (line 2) and "task-meta-short" (the trigger's
// count and duration) belong to TaskBlock.

// TaskStepRow (W9.10; stub; store-free) — one step of a sub-agent
defineProps<{ step: TaskStep; running: boolean }>()
// Root task-step (data-tool-name, data-state = running | done | error | denied); data-slot="task-step-preview".

// MentionMenu (W9.8; stub; mounted by ChatComposer after SlashMenu) — 7.26
defineProps<{
  open: boolean
  query: string
  items: readonly ProjectFileEntry[]
  state: 'loading' | 'ready' | 'error'
  errorMessage?: string | null
  truncated: boolean
  projectName: string | null
}>()
defineEmits<{ select: [entry: ProjectFileEntry]; close: [] }>()
defineExpose<{ handleKeydown(e: KeyboardEvent): boolean; activeId: string | undefined; listId: string }>()
// Root mention-menu (data-state, data-count; role="listbox", aria-busy while loading); mention-menu-item
// (data-path, data-kind, data-highlighted on the active row); the same keyboard contract as SlashMenu (true =
// consumed). truncated = the answer's truncated (more matches than the limit, or the server's index was cut).
// data-slot: mention-highlight, mention-status, mention-truncated, mention-announcer (the polite count, a sibling of
// the listbox).

// QueuedMessages (W9.8; stub; ChatView mounts it in the dock between TodoStrip and the composer) — 7.26
defineProps<{ items: readonly QueueItem[]; waitingForApproval?: boolean; cancelling?: readonly string[] }>()
defineEmits<{ cancel: [id: string]; edit: [id: string] }>()
// Root queued-messages (data-count, data-state = queued | approval; renders nothing when empty); queued-message
// (data-message-id, data-state = queued | cancelling), queued-message-edit, queued-message-cancel; "Show {n} more"
// is data-slot="queued-messages-more". Uses the ui store (focus back to the composer when no row is left).

// AgentSettingsSection (W9.12; stub; mounted by GeneralSettings) — 9.11
// No props, no emits. settings-auto-compact, settings-compaction-model, settings-subagent-model,
// settings-subagent-max-steps (the Shift+Tab switch settings-shift-tab-modes belongs to GeneralSettings);
// data-slot="subagent-model-warning". Helpers in settings/agent/agent-settings.ts: SAME_MODEL_LABEL,
// subagentModelWarning(model).

// AgentToolBody (W9.10; not a frozen contract; store-free, used by ToolPart and ShareToolRow) — 7.2, 7.25
// defineSlots<{ default?: () => unknown; raw?: () => unknown }>(): the agent view (TodoList / PlanBody) in a muted box
// (data-slot="agent-tool-body"), then "Raw input and output" (tool-raw-toggle) showing the raw slot (data-slot
// "tool-raw"), like WorkspaceToolBody.

// Prop and emit additions (C25 declares them in P9-0b; the owners use them in P9-A)
// chat-format.ts (W9.11):  MessageBlock kinds + 'compaction' (a valid data-compaction), 'steer' (a valid
//                          data-steer; invalid data renders nothing), 'task' (every tool part named task, matched
//                          by name; TaskBlock falls back to ToolPart when it does not parse); data-activity never
//                          becomes a block. Also exports TASK_TOOL_NAME, PLAN_TOOL_NAME, CORE_AGENT_PLUGIN_ID
// ChatMessage (W9.11):     compacted?: boolean (default false: data-compacted + opacity-70; the blocks before the
//                          last compaction block of a non-compacted message are dimmed by ChatMessage itself);
//                          approval emit payload + planMode?: 'edits' | 'ask', reason?: string
//                          + activity?: 'compacting' | null (default null; the streaming row shows "Compacting
//                          conversation…" instead of "Thinking…")
// ChatTranscript (W9.11):  compactionLayout(messages).dimmed → each row's compacted prop; v-memo keys + the row's
//                          dimmed flag; rewindable also counts task outputs with a done write_file / edit_file step;
//                          + activity?: 'compacting' | null (from session.activity through ChatView; passed to the
//                          submitted placeholder and the streaming last row)
// SubmittedPlaceholder (W9.11): + activity?: 'compacting' | null (default null): "Compacting conversation…" instead
//                          of "Thinking…"
// ToolPart (W9.10):        PlanApprovalCard branch (source = the tool's plugin, else core-agent); preliminary
//                          output-available = running while streaming, else stopped; approval payload + planMode?,
//                          reason?; todo_write / exit_plan_mode rows of core-agent (any tool of that name while the
//                          tool list has not loaded) render through AgentToolBody
// ChatView (W9.9):         the dock (TodoStrip + QueuedMessages before ChatComposer); onSubmit → session.submit();
//                          onStop → composer.restoreQueued(await session.stop()); the plan announcements (7.25)
// ChatComposer (W9.8):     MentionMenu mount, the keydown chain (mention → slash → mode cycle), the aria switch,
//                          useModeCycle, canQueue to SendStopButton; defineExpose + restoreQueued(items: readonly
//                          QueueItem[]): void (texts appended to the draft, files as done chips, the toast "Queued
//                          messages moved back to the composer."; nothing for an empty list); the submit / running
//                          guards dropped (uploads and voice still block)
// SendStopButton (W9.8):   canQueue?: boolean (default false) + emit queue: []   // composer-queue left of Stop
// ComposerAddMenu (W9.8):  projectChat?: boolean (default false) + emit mention: []   // "Mention a file"
// ComposerAttachment (W9.8, useComposerAttachments): source: 'upload' | 'project', path?: string, projectId?: string,
//                          file?: File (absent for project chips and restored files); composer-attachment gains
//                          data-kind and data-path; addProject(projectId, path) (one chip per path; a failed one is
//                          retried); AttachmentRejectionInfo + source?, path?, error? (the server's HarnessError)
// PermissionMenu (W9.10):  aria-keyshortcuts lists Alt+P (altShortcuts on) and Shift+Tab (shiftTabModes on), e.g.
//                          "Alt+P Shift+Tab" (no new prop: it reads the settings store); Plan in text-info;
//                          permission-option data-value="plan"
// ShareToolRow (W9.10):    TaskBody / TodoList / PlanBody for task / todo_write / exit_plan_mode when details exist
//                          (the latter two in AgentToolBody); without details the static labels "Sub-agent", "Updated
//                          tasks", "Plan" (data-slot="agent-tool-label")
// GeneralSettings (W9.12): mounts AgentSettingsSection; the shiftTabModes switch
```

### 10.7 Phase 10 contracts (Agent customization: W10.8 – W10.12; C33 ships the stubs)

The fifteen components below are created by C33 in P10-0b with exactly these props, emits and root test ids and are
frozen from Gate P10-0b (a change is a CCR); P10-A implements them behind those contracts. Types from
`@harness-forge/shared` (names as in API.md 4.28+): `CustomizationKind` (`agent | command | skill`),
`CustomizationSource` (`builtin | plugin | user | project`), `CustomizationEntry` (a catalog row: `{ kind, name,
description, source, id?, pluginId?, path?, namespace?, argumentHint?, modelRef?, tools?, enabled, state, shadowedBy?,
diagnostics }`), `CustomizationList` (`{ items, diagnostics, project, builtAt }`), `Customization` (a personal definition,
discriminated on `kind`: `{ id, kind, name, description, content, enabled, fields, diagnostics, createdAt, updatedAt }`,
`fields` = the parsed frontmatter and body or null), `DefinitionDiagnostic` and `ParsedDefinition`
(`util/definitions.ts`), `CommandSummary`, `ToolSummary`, `BackgroundTask`, `TaskResultData`, `TaskOutput`,
`RememberResult`. `CustomizationDraft` (the editor's structured fields: `{ kind, name, description, tools, model, argumentHint, body }`)
and `CustomizationAction` come from `components/settings/customize/customize.ts` (11.7). Parsing and formatting
definitions happen only through `parseDefinition` / `formatDefinition` of `@harness-forge/shared`; history-derived state
of results only through `taskResultsOf` / `isTaskResultMessage` (`chat-format.ts`). Every component is imported by path.

```ts
// CustomizeSettings (W10.8; stub; the body of pages/settings/customize.vue) — 9.12
// No props, no emits. Reads and writes ?tab and ?project (router.replace). Root customize-settings; renders the tabs
// (customize-tab), the project select (customize-project-select), one CustomizationSection per source, the editor and
// the viewer, and the hidden import input (customize-import-input). The page renders customize-new and customize-import
// in its PageHeader and reaches the body through defineExpose<{ create(): void; import(): void }>.

// CustomizationSection (W10.8; stub) — one source section of one kind
defineProps<{
  source: CustomizationSource
  kind: CustomizationKind
  entries: readonly CustomizationEntry[]
  projectName?: string | null          // "In {project}" (source project)
  folders?: readonly string[]          // the scanned folders shown in the project heading
  issue?: string | null                // an unavailable project folder: an Alert instead of the rows
  busyIds?: readonly string[]          // personal rows with a toggle / delete in flight
}>()
defineEmits<{ action: [action: CustomizationAction, entry: CustomizationEntry] }>()
defineSlots<{ notices?(): any; 'empty-actions'?(): any }>()   // + P10-A (W10.8): folder-level problems under the
                                                              // heading; the personal empty state's New / Import… buttons
// Root customize-section (data-source, data-count); a CustomizationRow per entry; customize-empty (data-kind,
// data-source) when a personal or project section is empty; built-in command rows are passed as entries with
// source 'builtin' and render without a menu.

// CustomizationRow (W10.8; stub)
defineProps<{ entry: CustomizationEntry; busy?: boolean }>()
defineEmits<{ action: [action: CustomizationAction] }>()
// type CustomizationAction = 'edit' | 'view' | 'duplicate' | 'export' | 'toggle' | 'delete' | 'open-plugin'
// Root customization-row (data-kind, data-name, data-source, data-state = active | shadowed | invalid | off, and
// data-customization-id | data-path | data-plugin-id); customization-row-menu; the items customization-edit,
// customization-view, customization-duplicate, customization-export, customization-toggle, customization-delete;
// customization-diagnostics (the expanded list).

// CustomizationEditor (W10.8; stub; mounted by CustomizeSettings) — 9.12
defineProps<{
  open: boolean
  kind: CustomizationKind
  mode: 'new' | 'edit' | 'import'
  customization?: Customization | null   // edit mode
  draft?: CustomizationDraft | null          // new (Duplicate) and import mode
  notes?: readonly string[]                  // import notes (customization-import-notes)
}>()
defineEmits<{ 'update:open': [open: boolean]; saved: [customization: Customization] }>()
// Root customization-editor (data-kind, data-mode); customization-name, customization-description,
// customization-tools-mode (data-value = all | some), customization-tools (the ToolMultiSelect),
// customization-model, customization-argument-hint (commands), customization-body (the MarkdownEditor root),
// customization-save, customization-error (data-code), customization-import-notes, customization-discard-confirm.
// Saves through the customizations store (create / update); the content is formatDefinition(fields).

// CustomizationViewer (W10.8; stub; mounted by CustomizeSettings) — 9.12
defineProps<{ open: boolean; entry: CustomizationEntry | null; projectId: string | null }>()
defineEmits<{ 'update:open': [open: boolean]; copy: [draft: CustomizationDraft] }>()
// Root customization-viewer; loads the file through customizations.sourceOf(entry, projectId).

// ToolMultiSelect (W10.8; stub)
defineProps<{ modelValue: string[] | null; tools: readonly ToolSummary[]; label: string; disabled?: boolean }>()
defineEmits<{ 'update:modelValue': [value: string[] | null] }>()   // null = no restriction ("All tools")
// No root test id (customization-tools is set by the editor); options customization-tool-option (data-tool-name),
// chips customization-tool-chip (data-tool-name, data-state = known | unknown).

// MarkdownEditor (W10.8; stub; components/common/) — a CodeMirror markdown field
defineProps<{
  modelValue: string
  label: string                                  // aria-label of the editable area
  readonly?: boolean
  diagnostics?: readonly DefinitionDiagnostic[]  // lint markers (those with a line)
  minHeight?: string                             // default '16rem'
}>()
defineEmits<{ 'update:modelValue': [value: string]; submit: [] }>()   // submit = Mod+Enter
defineExpose<{ focus(): void }>()                                       // + P10-A (W10.8)
// data-slot="markdown-editor"; never captures Tab; a test id passed by the parent lands on the root (attribute
// fallthrough); an aria-describedby passed by the parent also describes the editable area. CodeMirror comes from a
// dynamic import of createMarkdownEditor (a plain textarea with the same contract when it cannot load); the theme
// follows the document's dark class; at least minHeight tall, at most 50dvh on phones (70dvh above).

// SlashArgumentHint (W10.9; stub; mounted by ChatComposer over the textarea) — 7.28
defineProps<{ text: string; hint: string | null; describedById: string }>()
// Root slash-argument-hint (aria-hidden mirror); renders nothing unless hint is set and text is `/name` plus blanks on
// one line; the sr-only element with id describedById reads "Arguments: {hint}".

// RememberDialog (W10.9; stub; mounted by ChatComposer) — 7.30
defineProps<{ open: boolean; text: string; projectId: string | null; chatId: string | null }>()
defineEmits<{ 'update:open': [open: boolean]; saved: [result: RememberResult] }>()
// Root remember-dialog; remember-text, remember-target (data-value = project-file | project-instructions | global),
// remember-save, remember-error (data-code). projectId null or chatId null disables the project targets.

// BackgroundAgents (W10.10; stub; ChatView mounts it in the dock between TodoStrip and QueuedMessages) — 7.29
defineProps<{
  tasks: readonly BackgroundTask[]          // the chat's visible tasks (visibleTasks), newest first
  stopping?: readonly string[]              // task ids with a stop in flight
  reveal?: { taskId: string; n: number } | null   // a "Show in background agents" request (n bumps on each request)
}>()
defineEmits<{ stop: [taskId: string]; 'stop-all': [] }>()
// Root background-agents (data-state = open | closed, data-count = running, data-total = visible; renders nothing when
// tasks is empty); background-agents-toggle, background-agents-stop-all; data-slot="background-agents-announcer".

// BackgroundAgentRow (W10.10; stub)
defineProps<{ task: BackgroundTask; stopping: boolean; open?: boolean }>()
defineEmits<{ stop: []; 'update:open': [open: boolean] }>()
// Root background-agent (data-task-id, data-state = the task status, data-kind = explore | general | custom,
// data-agent-type); background-agent-toggle, background-agent-stop. Renders TaskBody (store-free) when open, with the
// launching call's input from inject(BACKGROUND_TASK_INPUT) (no details toggle when it returns null). `open` absent =
// uncontrolled.

// TaskResultNote (W10.11; stub; store-free; ChatMessage renders it for block kind 'task-result' and for carriers) — 7.29
defineProps<{ result: TaskResultData; variant: 'inline' | 'turn' }>()
// Root task-result (data-task-id, data-status, data-variant; role="note"); task-result-toggle, task-result-report;
// data-slot="task-result-meta".

// SkillToolBody (W10.11; stub; store-free; ToolPart and ShareToolRow render it for core-agent's skill) — 7.28
defineProps<{ input: unknown; output: unknown }>()   // parsed inside with the shared skill schemas; unparsable → nothing
// No root test id (data-slot="skill-body"; data-slot="skill-files").

// PlanFileChip (W10.11; stub; ToolPart renders it first in the body of an approved exit_plan_mode row) — 7.25
defineProps<{ planPath: string | null; planError: string | null; projectChat: boolean }>()
// Root plan-file (data-state = saved | failed, data-path); renders nothing without planPath and planError.

// PluginCustomizationList (W10.12; stub; PluginContributions renders one per kind) — 8.8
defineProps<{
  kind: 'agent' | 'skill'
  pluginId: string
  entries: readonly CustomizationEntry[]   // customizations.catalog(null) filtered by pluginId and kind
  missing: readonly string[]               // contributed names without an entry (name-only rows)
}>()
// Root plugin-customizations (data-kind, data-count); rows plugin-customization (data-name, data-state = active |
// shadowed), sorted by name.

// Prop and emit additions (C33 declares them in P10-0b; the owners use them in P10-A)
// chat-format.ts (W10.11):   MessageBlock kind + 'task-result' (a valid data-task-result; invalid data renders
//                            nothing); taskResultsOf(messages): Map<taskId, TaskResultData>; isTaskResultMessage(m):
//                            a user message whose parts are only valid data-task-result parts
// ChatMessage (W10.11):      a carrier user message renders TaskResultNote (variant 'turn') + "Sent to the agent"
//                            instead of UserMessageBubble; no MessageActions, edit, BranchSwitcher or rewind for it
// UserMessageBubble, MessageActions (W10.11): never rendered for carriers (isTaskResultMessage)
// TaskBlock (W10.11):        accepts any type string; data-kind + 'custom', data-agent-type, data-background,
//                            data-state + 'background'; reads AGENT_TASK_CONTEXT (absent on share pages: static);
//                            task-block-reveal (data-target = dock | result)
// ToolPart (W10.11):         the skill branch (SkillToolBody in AgentToolBody) and PlanFileChip before PlanBody
// CommandBadge (W10.11):     + the optional prop `command?: CommandInvocation | null` (default null; the message's
//                            metadata.command, passed by UserMessageBubble next to `name`), whose source?, modelRef?
//                            and allowedTools? feed the model suffix and the tooltip (the plan said "no new prop":
//                            the v1 badge only received `name`)
// ShareToolRow (W10.11):     custom type label and icon, "· in the background" for background calls, "Loaded skill"
//                            rows; task-result parts never reach it (the server drops them)
// ChatView (W10.10):         BackgroundAgents in the dock + provide(AGENT_TASK_CONTEXT, …) and (+ P10-A)
//                            provide(BACKGROUND_TASK_INPUT, …); the result announcements (only for agents the dock did
//                            not announce, announcedTasks); onStop never touches background agents
// ChatComposer (W10.9):      items from useCustomizationsStore().slashCommands(projectId) (+ fetchCommands on mount,
//                            project change and slash-menu open); SlashArgumentHint and RememberDialog mounts; the
//                            client action 'remember'
// SlashMenu (W10.9):         SlashItem + group: 'app' | 'project' | 'personal' | 'plugin', argumentHint?, namespace?;
//                            group headings; slash-menu-item + data-group
// PluginContributions (W10.12): the Agents and Skills sections (PluginCustomizationList)
// ProjectsSettings (W10.12): the row menu item project-customizations
// AgentSettingsSection (W10.12): settings-plan-files, settings-plan-directory (no props, no emits)
// DataExportSection, DataImportSection (W10.8): the Phase 10 copy (9.8)
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
// no longer do; summaryOf copies projectId; update(id, { projectId }) patches the row optimistically (a move) and
// rolls back on an error; applyEvent(project.changed with project null) sets projectId to null on loaded rows and
// resets a filter on that project to 'all' (toast "The project was deleted. Showing all chats."); search ignores the
// filter; an id unknown once the projects loaded falls back to 'all'. setProjectFilter with the current filter does
// nothing; a failed first page throws and leaves the list empty and unloaded (the sidebar offers Retry).
// byId(id) also answers for summaries seen outside the visible list (another project's open chat, an archived chat,
// one older than the loaded pages; up to 200 kept aside), so the session, the chip and useMoveChat know their project.
// Exported constants: PROJECT_FILTER_KEY ('hf-project-filter', the raw value) and PROJECT_DELETED_MESSAGE.

// stores/projects.ts — useProjectsStore (+ Phase 7, ADR-031; C15 signature, W7.9 implementation)
state:   { items: ProjectSummary[]; loaded: boolean; loading: boolean }
getters: byId(id: string): ProjectSummary | undefined, sorted (ProjectSummary[] by name)
actions: fetchAll(): Promise<void>
         create(input: ProjectCreate): Promise<ProjectSummary>     // POST /projects; the caller wraps it in useFreshAuth().run
         update(id: string, patch: ProjectUpdate): Promise<ProjectSummary>  // optimistic, rolls back on error
         remove(id: string): Promise<void>                         // 409 run-active is thrown (the caller shows the
                                                                   // toast); a 404 counts as deleted
         browse(path?: string | null, opts?: { signal?: AbortSignal }): Promise<ProjectBrowse>
         applyEvent(event: ServerEvent): void                      // project.changed: upsert, or remove for project null
// create() adds the new project to the list; sorted compares names case- and accent-insensitively, then ids; the
// answer of an older fetchAll() never replaces a newer one.

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

Phase 10 adds the `customizations` and `background-tasks` stores (11.7, frozen from Gate P10-0b); no existing store
signature changes: the settings store carries `planFiles` and `planDirectory` through `Settings`, the plugins store's
`PLUGIN_FILTERS` / `counts` gain `agents` (implementation of the existing `filtered` / `counts` members; `plugins.commands`
stays for `PluginContributions`), and the composer reads its slash items from the customizations store instead of
`plugins.commands`.
Phase 8 adds the `workspace` and `shell-rules` stores (11.5, frozen from Gate P8-0b); no existing store signature
changes, and the settings store carries `fileSweep` through `Settings`. Phase 7 adds the projects store and the two
chats store members above (frozen from Gate P7-0b); the settings store
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
event; unsubscribes with the scope). Phase 7 (W7.10): `project.changed` → `projects.applyEvent` + `chats.applyEvent`
(and every live session drops a deleted project from its own state); `key.rotated` → the chats store reloads its first
page (when it is loaded), the toast "The encryption key was rotated." shows (`KEY_ROTATED_MESSAGE`), and every live
session in the registry whose chat is listed in `chatIds` reloads its path (its pending approvals were denied and its
run stopped; a session with a request in flight reloads once that request settles), not only the open one; the server
closes every event stream right after `key.rotated`, so the client reconnects with backoff (the rotating tab holds a
new cookie; other browsers are signed out and land on `/login`); `refetchLoadedStores()` also calls
`projects.fetchAll()` when the projects store is loaded. Phase 8 (C20 dispatch, W8.8): `workspace.changed` →
`workspace.applyEvent` (the changes panel, 7.21); `run.finished` and `chat.deleted` also go to `workspace.applyEvent`
(after the chats store); `project.changed` goes to projects → **workspace** → chats → shell rules, in that order (the
workspace store finds a deleted project's chats by their project before the chats store detaches them);
`refetchLoadedStores()` also calls `workspace.refreshLoaded()` and, when the shell rules store is loaded,
`shellRules.fetchAll()`. Phase 9 (C25 dispatch, W9.9): `queue.changed` → `chatQueue.applyEvent`; `chat.deleted` also
goes to `chatQueue.applyEvent` (drops the chat's list); `run.started` with `origin: 'queue'` reaches the live session
of that chat through `on()` (11.6); `refetchLoadedStores()` also calls `chatQueue.refreshLoaded()`. Phase 10 (C33
dispatch, W10.10): `task.changed` → `backgroundTasks.applyEvent`; `chat.deleted` also goes to
`backgroundTasks.applyEvent` (drops the chat's list); `customization.changed` and `plugin.changed` →
`customizations.applyEvent` (marks every cached catalog and command list stale and refetches the loaded scopes that a
mounted view uses); `run.started` with `origin: 'task'` reaches the live session like `origin: 'queue'` (11.7);
`refetchLoadedStores()` also calls `backgroundTasks.refreshLoaded()` and `customizations.refreshLoaded()`.

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
  approve(r: ToolApprovalDecision): Promise<void>   // below; Phase 7 adds acceptEdits; Phase 9 planMode / reason (11.6)
  stop(): Promise<void>                   // POST /api/chat/:id/stop, then the client abort (an abort alone only disconnects);
                                          // Phase 9: resolves with the dropped queue items (Promise<QueueItem[]>, 11.6)
  load(): Promise<void>                   // + GET /api/chats/:id, then resumeIfRunning()
  refresh(): Promise<void>                // + reloads the history unless a request is in flight
  resumeIfRunning(): Promise<void>        // + chat.resumeStream() when the server or the chats store reports a run
  switchBranch(messageId: string): Promise<void>  // + Phase 5: POST /api/chats/:id/branch, then the returned path
  refreshBranches(): Promise<void>        // + Phase 5: GET /api/chats/:id after the session's own edit / regenerate
  takeBackUnstored(): HarnessUIMessage | null  // + Phase 5: removes the unstored failed user message (and anything
                                          // after it) from the transcript and returns it; null when there is none
  projectId: ComputedRef<string | null>   // + Phase 7: a new chat: the picker's choice, else the filter's project
                                          // (when it names a known project; a filter change drops the pick); a saved
                                          // chat: its chats store row or its summary, whichever reported a project
                                          // last (else the project its first request sent, until the server
                                          // describes the chat)
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
- **Projects and key rotation** (Phase 7, W7.10). `projectId` goes into the request body only while the chat is not
  persisted (the first request); `setProject` on a saved chat patches `summary` optimistically and restores it when
  `chats.update` fails (the chats store rolls back its row too). `approve({ acceptEdits: true })` sets
  `toolMode = 'edits'` (saved on the chat with `PATCH`) before the approval response goes out. `project.changed` with
  `project: null` clears a pick, the created project and the summary's `projectId` when they name the deleted project.
  `key.rotated` listing this chat reloads the path (`refresh()`), or once the request in flight settles.
  `isBusyConflict(error)` (exported) recognizes the `409 busy` answer of a chat request during a key rotation.
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
modules (11.4); Phase 8: `useChangesPanel()` and the helpers of 11.5.

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

Exports added in P7-A (not frozen; the frozen signatures above are unchanged):

```ts
// move-chat.ts: type MoveChat = (chatId: string, projectId: string | null) => Promise<void>; MOVE_UNDO_MS (5000);
//   MOVE_RUN_ACTIVE_MESSAGE, MOVE_NOT_FOUND_MESSAGE
// workspace-tools.ts: isWorkspaceToolName(name), workspaceApprovalKind(toolName, input) (the preview kind without the
//   diff), countDiffLines(hunks) → { additions, deletions }, commandFirstLine(command) (the first non-empty line, at
//   most 60 characters), diffSummaryText(additions, deletions), MINUS_SIGN ('−', U+2212), types WorkspaceRowSummary
//   ({ text, tone }) and WorkspaceRowSummaryTone
// parts/tool-row.ts: toolApprovalLabel(toolName, input) ("Approval needed: run {command}" / "Approval needed: {tool}")
// parts/tool-approval-context.ts: TOOL_APPROVAL_CONTEXT, interface ToolApprovalContext (10.4)
// utils/line-diff.ts: splitLines(text) (LF lines; one trailing newline ends the last line), type DiffLinesOptions
// utils/ansi.ts: collapseCarriageReturns(text) (\r\n → \n; a \r-rewritten line keeps its last non-empty segment),
//   terminalText(text) (stripAnsi + collapseCarriageReturns: what TerminalOutput shows)
// composer/permission.ts: offeredToolModes({ projectChat, current }) → ToolMode[], EDITS_NEEDS_PROJECT
//   ("Accept edits works in project chats."), TOOL_MODE_OPTIONS now with edits
// composer/slash-commands.ts: parseToolMode(value) → ToolMode | null; ClientCommandContext.projectChat: boolean
// composables/useChatSession.ts: isBusyConflict(error) (409 busy)
// composables/useServerEvents.ts: KEY_ROTATED_MESSAGE ("The encryption key was rotated.")
// projects/folder-path.ts: baseName, joinPath, samePath, isWithinRoot, rootOf, folderCrumbs, folderNameError,
//   pathSeparator (POSIX and Windows paths)
// projects/projects-load.ts: loadProjectsOnce(), refreshProjects() (never reject)
// settings/data/data.ts: the Storage cleanup and Encryption key texts (cleanupHeadline, recentFilesLine,
//   cleanupConfirmText, cleanupResultMessage, secretsLabel, rotateEffects, keyRotatedDescription, KEY_SOURCE_LABELS,
//   KEY_MISMATCH_MESSAGE, ROTATE_KEY_COMMANDS, BUSY_MESSAGE), canRotateKey(status), isBusyConflict(error),
//   conflictReason(error)
// settings/data/data-context.ts: dataSettingsContextKey, useDataSettingsContext()
// settings/general.ts: STEPS_MAX (LIMITS.stepsMax), STEPS_ERROR; TOOL_MODE_OPTIONS mirrors the composer's
```

### 11.5 Phase 8 modules

C20 creates these in P8-0b with exactly these signatures (frozen from Gate P8-0b) and stub bodies; P8-A implements
them. Owners: W8.8 the workspace store, `useChangesPanel` and `changes-rows.ts`; W8.11 the shell rules store; W8.10 the
`useChatSession`, `TOOL_APPROVAL_CONTEXT` and `workspace-tools.ts` additions; `allow-rule.ts` is complete in P8-0b.

```ts
// stores/workspace.ts — useWorkspaceStore (+ Phase 8, ADR-036 / ADR-037; 7.21, 7.22)
interface ChangesEntry<T> { data: T | null; loading: boolean; error: HarnessError | null; loadedAt: number | null }
state:   { chat: Record<string, ChangesEntry<ChatChanges>>   // by chat id: the This chat view
           git: Record<string, ChangesEntry<GitStatus>> }    // by chat id: the Git view (the route is chat-scoped)
getters: chatChanges(chatId): ChatChanges | null, gitStatus(chatId): GitStatus | null,
         changeCount(chatId): number          // This chat files whose status is not 'unchanged' (the toggle's pill)
actions: fetchChatChanges(chatId: string, opts?: { force?: boolean }): Promise<void>   // GET /chats/:id/changes
         fetchGit(chatId: string, opts?: { force?: boolean }): Promise<void>           // GET /chats/:id/git
         fileDiff(chatId: string, source: ChangesView, path: string, opts?: { signal?: AbortSignal }): Promise<FileDiff>
                                              // GET /chats/:id/changes/diff; cached until the next refresh
         revert(chatId: string, input: { source: ChangesView; path: string; expectedSha?: string | null })
           : Promise<RestoreResult>           // POST /chats/:id/changes/revert
         undo(chatId: string, batchId: string): Promise<RestoreResult>   // POST …/changes/undo, conflicts: 'skip'
         applyEvent(event: ServerEvent): void
         refreshLoaded(): Promise<void>       // after an event-stream reconnect: refetch every loaded entry
// fetch* keep a failure in the entry (error) and never reject; a second call while one runs joins it unless force
// (force aborts the older request, so an older answer never overwrites a newer one); a successful fetch sets loadedAt
// (strictly increasing) and drops that view's cached diffs (open rows then reload theirs). revert / undo throw
// HarnessError (409 run-active / stale, 400, 404). applyEvent (refetches only loaded entries, debounced
// WORKSPACE_REFRESH_DEBOUNCE_MS = 300 ms per chat; later events restart the timer and add their views):
// workspace.changed → the This chat entry of data.chatId, the Git entries of the loaded chats of data.projectId (a
// chat's project: its loaded ChatChanges.projectId, else the chats store) and the This chat entry of the open chat
// (ui.activeChatId) when it belongs to that project (its "changed outside this chat" marks); run.finished → that
// chat's loaded entries; chat.deleted → drop its entries; project.changed with project null → drop the entries of
// that project's chats. The rewind preview and apply are one-shot calls of RewindDialog (useApi()); the Undo of its
// result toast uses undo().

// stores/shell-rules.ts — useShellRulesStore (+ Phase 8, ADR-038; 7.23)
state:   { items: ShellRule[]; loaded: boolean; loading: boolean }
getters: global: ShellRule[]                          // projectId null, sorted by prefix
         forProject(projectId: string): ShellRule[]   // sorted by prefix
         countForProject(projectId: string): number
actions: fetchAll(): Promise<void>                    // GET /shell-rules; joins a load already running, and that
                                                      // load replays the creates / removes made meanwhile; throws
                                                      // HarnessError (the rules shown before stay)
         create(input: { projectId: string | null; prefix: string }): Promise<ShellRule>
                                                      // POST /shell-rules; 409 exists, 400 and 404 are thrown; the
                                                      // stored (canonical) rule joins the list; never loaded before →
                                                      // starts the first load in the background
         remove(id: string): Promise<void>            // DELETE /shell-rules/:id; a 404 counts as removed
         applyEvent(event: ServerEvent): void         // project.changed with project null: drop that project's rules
// No update action: a rule is removed and added again (no rule edit).

// composables/useChangesPanel.ts — the panel state, one shared state for the app (module singleton, like
// useImageOptions)
function useChangesPanel(): {
  open: Readonly<Ref<boolean>>          // localStorage['hf-changes-open'] ('1' / '0'); default false; Phase 9: a
                                        // read-only computed: the saved choice, false while the viewport is narrow
                                        // (setChangesPanelNarrow) and no explicit open happened there
  view: Ref<ChangesView>                // localStorage['hf-changes-view']; default 'chat'
  width: Ref<number>                    // px, localStorage['hf-changes-width']; default 440, clamped to 320–720
  focusRequest: Readonly<Ref<number>>   // increases when Alt+C or the palette opens the panel: focus the active tab
  setOpen(value: boolean, opts?: { focus?: boolean }): void   // an explicit open / close: shown (also as the sheet
                                                              // below 1024px) and saved
  toggle(opts?: { focus?: boolean }): void
}
function setChangesPanelNarrow(narrow: boolean): void
                                        // + Phase 9 (W9.12, additive export): ChatWorkspace's viewport class; true
                                        // (below 1024px) makes open read false without touching the saved choice,
                                        // false shows the saved choice again
// Also exported: CHANGES_OPEN_KEY, CHANGES_VIEW_KEY, CHANGES_WIDTH_KEY, CHANGES_WIDTH ({ default: 440, min: 320,
// max: 720 }), CHANGES_SHORTCUT ('toggle-changes'), CHANGES_SHORTCUT_KEYS ('alt+code:KeyC'), clampChangesWidth(value)
// (a non-number gives the default) and the ChangesPanelState type. Blocked storage keeps the state in memory. Width
// writes are clamped; ChatWorkspace writes the width only while the user drags or keys the handle (7.21).

// components/workspace/changes/changes-rows.ts — pure helpers of the panel
type ChangesView = 'chat' | 'git'
type ChangesStatus = 'added' | 'modified' | 'deleted' | 'untracked' | 'renamed' | 'conflicted' | 'typechange'
interface ChangesRow {
  path: string
  origPath: string | null           // Git renames
  status: ChangesStatus
  additions: number | null          // This chat only; null = not counted
  deletions: number | null
  changedOutside: boolean           // This chat: the file on disk is not what the agent last wrote
  revertible: boolean               // This chat: its base state is stored; Git: not conflicted
  edits: number | null              // This chat: the recorded changes of the file
  staged: boolean | null            // Git only
  unstaged: boolean | null
}
type ChangesEmptyReason = 'none' | 'clean' | GitUnavailableReason   // GitUnavailableReason from @harness-forge/shared
                                  // (no-project, folder-unavailable, git-missing, not-a-repo, refused, timeout, failed)
function chatChangeRows(changes: ChatChanges): ChangesRow[]   // from ChatChangeFile; leaves out 'unchanged' files;
                                                              // keeps the server's order (most recently changed first)
function gitChangeRows(status: GitStatus): ChangesRow[]       // from GitStatusFile; the server's order (by path)
function statusTile(status: ChangesStatus): { letter: string; label: string }   // { letter: 'A', label: 'Added' }
function changesSummary(view: ChangesView, data: ChatChanges | GitStatus): string   // the summary line (7.21); ''
                                  // when unavailable or for This chat without rows
function changesEmptyReason(view: ChangesView, data: ChatChanges | GitStatus): ChangesEmptyReason | null
                                  // unavailable without a reason: no-project (This chat) / failed (Git)
// W8.8 additions: CHANGES_PANEL_ID ('hf-changes-panel'), CHANGES_HEADING_ID ('hf-changes-heading'), the StatusTile
// type, changesTruncatedNote(view), untrackedNote(untracked): string | null, rowLabel(row) ('{origPath} → {path}'),
// fileName(path)

// components/workspace/allowlist/allow-rule.ts — complete in P8-0b (C20): the copy of 7.23 over the shared parser
type ShellRuleScope = 'project' | 'global'
interface AllowRules { prefixes: string[]; scope: ShellRuleScope }   // ToolApprovalDecision.allowRules
function checkRulePrefix(prefix: string, command?: string):
  | { ok: true; canonical: string; warning: string | null }   // warning: "This allows every {word} command."
  | { ok: false; code: RulePrefixErrorCode; message: string }
                                  // RulePrefixErrorCode = ShellRuleRejectReason (the parseShellRule reason)
                                  //   | 'no-match'
function ruleErrorMessage(code: RulePrefixErrorCode, prefix: string): string   // the validation copy of 7.23
function ruleSuggestion(command: string): { prefixes: string[]; note: string | null }
                                  // suggestShellRules(command), or the always-ask / no-rule note when it is empty
function ruleProjectId(scope: ShellRuleScope, projectId: string | null): string | null   // global → null
// Also: ALWAYS_ASK_NOTE, NO_RULE_NOTE, SEVERAL_RULES_NOTE, COMBINED_COMMANDS_HINT, RULE_EXISTS_MESSAGE. The Settings
// texts (allowlistDescription(scope), allowlistError(error), allowedCommandsLabel(count), …) live in allowlist.ts.

// composables/useChatSession.ts — additions (W8.10)
interface ChatSession {
  // … the members of 11.1
  cwd: ComputedRef<string | null>   // + currentShellCwd(chat.messages): the folder the next shell call starts in
                                    //   (null = the project folder; derived like the server, so it follows versions)
}
interface ToolApprovalDecision {
  // … the members of 11.1
  allowRules?: { prefixes: string[]; scope: ShellRuleScope }
                                    // + approve() first awaits POST /shell-rules for each prefix, one after another
                                    //   (projectId: the session's project for 'project', null for 'global'; 409
                                    //   exists counts as saved; every prefix is tried; 'project' without a project
                                    //   fails without a request), then sends the approval; a failed save still sends
                                    //   it, then rethrows the first failure. approve() never sends override: allow
                                    //   for a tool with workspace access execute
}

// components/chat/parts/tool-approval-context.ts — additions (provided by ChatView)
interface ToolApprovalContext {
  toolMode: () => ToolMode | null
  projectName: () => string | null
  projectId: () => string | null    // + the chat's project (the scope This project)
  shellCwd: () => string | null     // + session.cwd: "In {project}/{cwd}" and the running TerminalOutput
}

// components/chat/parts/tools/workspace-tools.ts — additions (W8.10)
function currentShellCwd(messages: readonly HarnessUIMessage[]): string | null
  // the valid endCwd of the last finished (output-available) core shell part of an assistant message on the path,
  // scanned backwards ('.' = the project folder); a finished output WITHOUT endCwd (exec, a kill, the command's own
  // EXIT trap, an output saved before v1.4) left the folder as it was and is skipped, like the server's
  // initialShellCwd (ARCHITECTURE.md 6.13); for parallel calls of one step the last part wins; null when no part
  // reports one (= the project folder)
function shellFolder(cwd: string | null | undefined): string | null
  // the folder to show (no leading ./, no trailing /); null for the project folder ('.', './', '') and for none
function diffStatsLabel(additions: number, deletions: number): string   // "12 lines added, 3 removed" (7.19);
                                                                        // "No changes" for 0 / 0
// Also exported: MINUS_SIGN (U+2212). WorkspaceRowSummary gains label: string (the spoken text, 7.19); the terminal
// view gains cwd: string | null (the output's cwd, else the input's)
```

### 11.6 Phase 9 modules

C25 creates these in P9-0b with exactly these signatures (frozen from Gate P9-0b) and inert bodies; P9-A implements
them. Owners: W9.9 the `chat-queue` store and the `useChatSession` additions; W9.8 `useProjectFiles` and
`useFileMentions`; W9.10 `mode-cycle.ts` (with `useModeCycle`) and `todos.ts`; W9.11 `compaction.ts`. The pure helpers of
`@harness-forge/shared` (`findCompaction`, `compactionMarkers`, `splitSteers`, `latestTodos` in `util/agent-state.ts`;
`mentionTokenAt`, `formatMention`, `scorePath`, `rankPaths` in `util/mentions.ts`) are complete from P9-0a (C23) and
are the only implementation of these rules on the web.

```ts
// stores/chat-queue.ts — useChatQueueStore (+ Phase 9, ADR-042; 7.26)
state:   { byChat: Record<string, QueueItem[]>; loaded: Record<string, true> }
getters: items(chatId: string): readonly QueueItem[]          // [] when unknown
actions: fetch(chatId: string): Promise<void>                 // GET /chat/:id/queue; replaces the list
         enqueue(chatId: string, body: QueueAddBody): Promise<QueueItem>
                                                              // POST /chat/:id/queue ({ message, modelRef,
                                                              // reasoningEffort, toolMode }); the item joins the list;
                                                              // 409 run-idle / queue-full / exists and 400 / 404 are
                                                              // thrown (HarnessError)
         cancel(chatId: string, itemId: string): Promise<'cancelled' | 'gone'>
                                                              // DELETE /chat/:id/queue/:itemId; 204 → 'cancelled',
                                                              // 404 → 'gone' (delivered or started meanwhile)
         markDelivered(chatId: string, itemId: string): void  // a data-steer chunk arrived: drop the row now
         applyEvent(event: ServerEvent): void                 // queue.changed: replace the chat's list (the event wins
                                                              // over local state); chat.deleted: drop the chat
         refreshLoaded(): Promise<void>                       // after an event-stream reconnect: fetch every loaded chat
// Lists are per chat and live only in memory (the server's queue does not survive a restart either). Every event,
// local change and fetch start bumps a per-chat version, so an answer of an older fetch never replaces a newer list;
// the ids of messages that left a queue (and of the ones this tab queued) are remembered (bounded, 500), so a late
// answer or event never shows a departed message again. A `failed` removal of a message this tab queued toasts
// QUEUE_SEND_FAILED_MESSAGE ("Couldn't send a queued message.") with the error as its description. Also exported:
// QUEUE_ITEM_GONE_MESSAGE ("Already sent to the agent.", shown by ChatView for 'gone').

// composables/useProjectFiles.ts — (+ Phase 9) the two project-file calls through useApi(); no store
function useProjectFiles(): {
  search(projectId: string, q: string, opts?: { limit?: number; signal?: AbortSignal }): Promise<ProjectFileSearch>
                                    // GET /projects/:id/files?q=&limit= (limit default LIMITS.mentionResultsMax, 50)
                                    // → { items, truncated, indexedAt }; truncated = more matches than the limit or a
                                    // cut index
  attach(projectId: string, path: string, opts?: { signal?: AbortSignal }): Promise<FileRef>
                                    // POST /projects/:id/files/attach { path } → 201 FileRef; 400 / 404 / 413 thrown
}

// composables/useFileMentions.ts — (+ Phase 9) the mention menu state of one composer
function useFileMentions(opts: {
  projectId: Ref<string | null>     // null: never opens
  text: Ref<string>
  caret: Ref<number>
}): {
  token: ComputedRef<{ start: number; end: number; query: string } | null>   // mentionTokenAt(text, caret)
  open: ComputedRef<boolean>        // a token, a project and not dismissed
  items: Readonly<Ref<readonly ProjectFileEntry[]>>
  state: Readonly<Ref<'loading' | 'ready' | 'error'>>
  error: Readonly<Ref<HarnessError | null>>
  truncated: Readonly<Ref<boolean>>
  dismiss(): void                   // Esc: remembered for this token until it changes
  apply(entry: ProjectFileEntry): { text: string; caret: number; keepOpen: boolean }
                                    // replaceMentionToken (composer/mention-menu.ts): file → formatMention(path) + ' '
                                    // (formatMention already starts with '@'; an existing blank is reused); dir →
                                    // formatMention('dir/') and keepOpen; an unmentionable path just drops the token
}
// 80 ms debounce (MENTION_SEARCH_DEBOUNCE_MS), aborts the previous search, caches the last 20 queries per project
// (MENTION_CACHE_SIZE) for LIMITS.mentionIndexTtlMs (30 s); state is 'loading' from a query change until the answer
// (the rows of the previous answer stay meanwhile). "Searching files…" only after 150 ms is MentionMenu's delay.
// composer/mention-menu.ts also exports replaceMentionToken, mentionRowLabel (the highlight runs), pathBaseName,
// mentionCountLabel, mentionErrorMessage and projectAttachErrorText (the toast texts of 7.26).

// components/chat/composer/mode-cycle.ts — (+ Phase 9) Shift+Tab (7.11): nextToolMode and useModeCycle
function nextToolMode(current: ToolMode, opts: { projectChat: boolean }): ToolMode
                                    // project chat: ask → edits → plan → ask; outside: ask; auto / off → ask
function useModeCycle(opts: {
  enabled: () => boolean            // settings.resolved.shiftTabModes && the permission menu shows && no menu is open
  current: () => ToolMode
  projectChat: () => boolean
  set(mode: ToolMode): void         // the composer's v-model:tool-mode
  announce(text: string): void      // the composer's polite region: "Permission mode: Plan"
}): { handleKeydown(e: KeyboardEvent): boolean }   // true = consumed (preventDefault); false = native focus move
// Also exported: MODE_CYCLE_SHORTCUT ('composer-cycle-mode', 'shift+tab', display-only in ShortcutsDialog, group
// Composer, described "Switch the permission mode").

// components/chat/agent/todos.ts — (+ Phase 9) pure, over latestTodos (7.25)
interface TodoState {
  todos: readonly TodoItem[]
  done: number
  total: number
  current: TodoItem | null          // the first in_progress item
  messageId: string                 // the message holding the todo_write call
  live: boolean                     // that message is the last assistant message of the path
}
function todoState(messages: readonly HarnessUIMessage[]): TodoState | null
function todoStripVisible(state: TodoState | null, running: boolean): boolean
function todoSummary(state: TodoState): string   // "3/7 · Running the parser tests" / "3/7" / "All tasks done"
// TodoState is the web's own type; the shared util/agent-state.ts exports another TodoState (latestTodos' result:
// { todos, counts, messageIndex, partIndex, toolCallId }). The row helpers (currentTodo, todoLabel, doneTodos,
// todoListOf, planTitle, planOf, planModeOf, taskBlockState, taskMetaLine, …) live in components/chat/agent/
// agent-tools.ts.

// components/chat/compaction/compaction.ts — (+ Phase 9) pure, over compactionMarkers (7.24)
function compactionLayout(messages: readonly HarnessUIMessage[]): { dimmed: ReadonlySet<string> }
function messageCompaction(message: HarnessUIMessage): {
  variants: ReadonlyMap<number, 'history' | 'run'>   // by part index, for each valid marker of the message
  lastIndex: number | null                          // the last marker's part index (ChatMessage dims the blocks before)
}
function compactionLabel(data: CompactionData, variant: 'history' | 'run'): string
function compactionMeta(data): string   // "42 messages summarized · 182K → 9K tokens" (Intl compact notation)
function compactionVariant(message: HarnessUIMessage, partIndex: number): 'history' | 'run'
                                    // 'run' for an automatic marker with CompactionMarker.inline (a content part
                                    // before it in its message); 'history' otherwise and when the part is no marker

// composables/useChatSession.ts — additions (W9.9)
interface ChatSession {
  // … the members of 11.1 and 11.5
  submit(input: { text: string; files: FileRef[] }): Promise<'sent' | 'queued'>
                                    // + queues while busy, resuming or running (POST /chat/:id/queue with a new client
                                    //   message id); 409 run-idle → whenIdle(), then send(); 'sent' = send() ran
  queue: ComputedRef<readonly QueueItem[]>          // + chatQueue.items(id)
  cancelQueued(itemId: string): Promise<'cancelled' | 'gone'>
                                                    // + chatQueue.cancel; 'gone' → QueuedMessages' host shows
                                                    //   "Already sent to the agent."
  stop(): Promise<QueueItem[]>      // + Phase 9: the stop result's dropped items (only this tab restores them; also
                                    //   when this tab was not streaming the run); a failed stop request resolves []
  todos: ComputedRef<TodoState | null>              // + todoState(chat.messages)
  activity: Readonly<Ref<'compacting' | null>>      // + the transient data-activity of the current stream (null when
                                                    //   idle or after the stream ended)
}
interface ToolApprovalDecision {
  // … the members of 11.1 and 11.5
  planMode?: 'edits' | 'ask'        // + approve() sets toolMode (saved on the chat) before addToolApprovalResponse
  reason?: string                   // + sent as addToolApprovalResponse({ id, approved, reason }) (plan feedback)
}
// useChat gets onData: data-steer → chatQueue.markDelivered(id, steer.id); data-activity → activity (reset when the
// request ends). run.started with origin 'queue' and a userMessageId not on the shown path → refresh(), then
// resumeStream() (deferred until idle when busy). Every chat load also fetches the chat's queue (chatQueue.fetch).
// submit: a 409 run-idle waits for whenIdle() and any resume, then send(); input without text and files → 'sent'
// with nothing sent; the dropped items of stop() leave the list at once (markDelivered).
```

`activity` is how the transient `data-activity` reaches the transcript (`ChatView` passes it to the streaming row,
7.24); it is part of the P9-0b session interface like the other additions.

### 11.7 Phase 10 modules

C33 creates these in P10-0b with exactly these signatures (frozen from Gate P10-0b) and inert bodies, except
`taskResultsOf` / `isTaskResultMessage` and `AGENT_TASK_CONTEXT`, which are complete; P10-A implements the rest. Owners:
W10.8 the `customizations` store, `customize.ts`, `download.ts` and `editor-setup.ts`; W10.9 `remember.ts` and the
`slash-commands.ts` additions; W10.10 the `background-tasks` store, `background-agents.ts`, `chat-context.ts` and the
`useChatSession` additions; W10.11 `chat-format.ts`. The pure helpers of `@harness-forge/shared` (`parseDefinition`,
`formatDefinition`, `resolvePrecedence` in `util/definitions.ts`; `splitArguments`, `expandArguments` in
`util/arguments.ts`; `CLAUDE_TOOL_ALIASES`, `normalizeToolList` in `util/tool-names.ts`; `TASK_RESULT_PART_TYPE`,
`splitTaskResults`, `taskResultText` in `util/agent-state.ts`) are complete from P10-0a (C29) and are the only
implementation of these rules on the web.

```ts
// stores/customizations.ts — useCustomizationsStore (+ Phase 10, ADR-044 / ADR-045; 9.12, 7.8)
state:   { catalogs: Record<string, CustomizationList>          // key = projectId ?? '' (the scope)
           commands: Record<string, CommandSummary[]>           // key = projectId ?? ''
           loadedAt: Record<string, number>                     // per 'catalog:<key>' / 'commands:<key>'
           stale: Record<string, true> }
getters: catalog(projectId: string | null): CustomizationList | null
         personal(kind: CustomizationKind): readonly CustomizationEntry[]   // the source 'user' entries of catalog(null)
         entriesOf(projectId: string | null, kind: CustomizationKind): readonly CustomizationEntry[]
                                    // every entry of that kind in the scope (with its project-relative state)
         slashCommands(projectId: string | null): readonly CommandSummary[]   // [] until loaded
actions: fetchCatalog(projectId: string | null, opts?: { maxAgeMs?: number; refresh?: boolean }): Promise<CustomizationList>
                                    // GET /customizations?projectId=&refresh=1; single-flight per scope; a cached list
                                    // younger than maxAgeMs and not stale is returned as is
         fetchCommands(projectId: string | null, opts?: { maxAgeMs?: number }): Promise<readonly CommandSummary[]>
                                    // GET /commands?projectId=; the same caching rules; a 404 (a deleted project)
                                    // caches []
         get(id: string): Promise<Customization>                 // GET /customizations/:id (the editor's content)
         sourceOf(entry: CustomizationEntry, projectId: string | null): Promise<string>
                                    // the content of GET /customizations/source?projectId&kind&name&source&path
                                    // (project, plugin, builtin; path = entry.path, so a shadowed project file shows
                                    // its own content); personal entries: get(entry.id).content
         create(body: { kind: CustomizationKind; content: string; enabled?: boolean }): Promise<Customization>
         update(id: string, patch: { content?: string; enabled?: boolean }): Promise<Customization>
                                    // { enabled } alone is optimistic and rolls back on an error
         remove(id: string): Promise<void>                           // a 404 counts as removed
         applyEvent(event: ServerEvent): void   // customization.changed, plugin.changed: mark every key stale and
                                                // refetch the scopes fetched in the last minute
         refreshLoaded(): Promise<void>         // after an event-stream reconnect
// Every mutation marks every key stale (a personal command changes every scope's command list). An answer of an older
// fetch never replaces a newer one (per-key versions). 409 exists / 400 with diagnostics are thrown (HarnessError).

// stores/background-tasks.ts — useBackgroundTasksStore (+ Phase 10, ADR-046; 7.29)
state:   { byChat: Record<string, BackgroundTask[]>; loaded: Record<string, true>; stopping: Record<string, true> }
getters: tasks(chatId: string): readonly BackgroundTask[]            // [] when unknown; newest first (as the route)
         visible(chatId: string): readonly BackgroundTask[]          // visibleTasks(tasks(chatId))
         byId(chatId: string, taskId: string): BackgroundTask | null
actions: fetch(chatId: string): Promise<void>                        // GET /chat/:id/tasks; replaces the list (merges
                                                                     // when an event or stop came after it started)
         stop(chatId: string, taskId: string): Promise<'stopped' | 'gone'>
                                    // POST /chat/:id/tasks/:taskId/stop; the returned task is upserted; 'stopped' when
                                    // it answers aborted, 'gone' when it had already ended otherwise (the route answers
                                    // an ended task as it is) or on a 404; a second stop of the same task joins the
                                    // one in flight
         stopAll(chatId: string): Promise<number>                    // stop() for every running task in turn;
                                                                     // resolves with the number stopped; tries all,
                                                                     // then throws the first failure
         applyEvent(event: ServerEvent): void   // task.changed: upsert (an event never loses to an older fetch);
                                                // chat.deleted: drop the chat (it never comes back)
         refreshLoaded(): Promise<void>         // after an event-stream reconnect: fetch every loaded chat and every
                                                // chat with a running task only events reported
// Per-chat versions like chat-queue: every event, local change and fetch start bumps the chat's version. A snapshot
// never loses to an older one: running < ended < delivered, and while running the one with more tool calls wins (the
// DTO has no updatedAt).

// components/chat/chat-context.ts — + AGENT_TASK_CONTEXT (complete in P10-0b; ChatView provides, TaskBlock injects)
const AGENT_TASK_CONTEXT: InjectionKey<{
  projectId(): string | null
  task(taskId: string): BackgroundTask | null        // the live row from the store
  tasksLoaded(): boolean                             // the chat's list was fetched at least once
  result(taskId: string): TaskResultData | null      // the delivered result on the shown path (taskResultsOf)
  reveal(taskId: string): void                       // opens the dock list and expands the row
  showResult(taskId: string): boolean                // scrolls to the result note and opens its report; false = none
}>
// + P10-A (W10.10): the input of the `task` call that launched a background agent, read from the shown path
// (ChatView provides, BackgroundAgentRow injects; null when the path does not hold that call)
const BACKGROUND_TASK_INPUT: InjectionKey<(task: BackgroundTask) => TaskInput | null>

// components/chat/chat-format.ts — additions (complete in P10-0b)
function taskResultsOf(messages: readonly HarnessUIMessage[]): Map<string, TaskResultData>   // by taskId, path order
function isTaskResultMessage(message: HarnessUIMessage): boolean
// MessageBlock kind + 'task-result' ({ kind, part: TaskResultData, index }).

// components/chat/agent/agent-tools.ts — additions (W10.11)
function taskKindOf(type: string): 'explore' | 'general' | 'custom'   // general-purpose → general
function taskTypeLabel(type: string): string                          // "Explore", "Agent" or the name
// + P10-A: taskTypeLabelShort (cut at TASK_TYPE_LABEL_MAX_CHARS = 24 with "…"), taskAgentTypeOf / taskAgentTypeName
// (data-agent-type), taskAgentSourceText (the agent card's source line), taskIsBackground, backgroundTaskState (live
// task → delivered result → 'background'), skillSourceText, skillNameOf, taskResultHeading, taskResultSummary,
// planFileOf (planPath / planError of an exit_plan_mode output); TASK_STATE_WORDS.background = 'started in the
// background'; taskTriggerLabel(…, { background }) appends ", running in the background".

// components/chat/background/background-agents.ts — pure (W10.10)
function visibleTasks(tasks: readonly BackgroundTask[]): BackgroundTask[]   // running, or deliveredAt null
function summaryLine(tasks: readonly BackgroundTask[], now: number): string // the collapsed line (7.29)
function announcementFor(prev: BackgroundTask | null, next: BackgroundTask): string | null
const BACKGROUND_EXPANDED_KEY = 'hf-background-expanded'
// + P10-A: isRunningTask, toggleName, headerLine, ENDED_STATUS_WORDS (Finished / Failed / Stopped / Step limit
// reached), endedAnnouncement(output), announcedTasks (the tab-wide bounded record: one announcement per agent and tab,
// shared by BackgroundAgents and ChatView; createAnnouncedTasks(max = 500)), taskToolCallCount, taskRunMs,
// focusAfterStop, BACKGROUND_FOOTNOTE, BACKGROUND_GONE_MESSAGE, BACKGROUND_STOP_FAILED_MESSAGE.

// components/chat/composer/slash-commands.ts — additions (W10.9)
interface SlashItem { /* … v1 members */ group: 'app' | 'project' | 'personal' | 'plugin'; argumentHint?: string; namespace?: string }
function slashGroupOf(command: CommandSummary): SlashItem['group']    // harness → app, project, user → personal, plugin
// CLIENT_COMMAND_DESCRIPTIONS.remember = 'Save a note to your instructions'; resolveClientCommand('/remember x') →
// { type: 'remember', text: 'x' }; argumentHintAt(text, items): string | null (the hint while the text is `/name `).
// + P10-A: SLASH_GROUPS (value + heading, in display order), slashItemDetail(item) (the namespace, else a plugin row's
// plugin name), slashItemLabel(item) (the row's accessible name); filterSlashItems returns the matches in group order.

// components/chat/composer/remember.ts — pure (W10.9)
const REMEMBER_TARGETS: readonly { value: RememberTarget; needsProject: boolean }[]
const REMEMBER_TARGET_KEY = 'hf-remember-target'
function defaultTarget(projectChat: boolean, last: string | null): RememberTarget
function rememberToast(result: RememberResult, projectName: string | null): string
function rememberErrorText(error: HarnessError): string
// + P10-A: REMEMBER_NEEDS_PROJECT, REMEMBER_TEXT_MAX (LIMITS.rememberTextMaxChars, counted after trimming),
// REMEMBER_TOO_LONG, rememberCounter(length), rememberTargetCopy(target, project | null) (label + description; "a
// project" without a known project).

// components/chat/parts/command-badge.ts — pure (+ P10-A, W10.11)
function commandSourceText(source: CommandSource, pluginName?: string | null): string
function commandToolsText(tools: readonly string[]): string         // at most COMMAND_TOOLS_LISTED_MAX = 8 names
function commandBadgeLines(command, names: { plugin, model }): { source; model; tools }   // each string | null

// components/plugins/list/plugin-display.ts — additions (W10.12)
function customizationMeta(entry): string[]          // agents: [model, tools]; skills: []
function shadowedNote(entry, pluginName): string | null   // "Not used: {winner} wins."
function customizeRoute(kind: 'agent' | 'skill'): { path: '/settings/customize'; query: { tab: 'agents' | 'skills' } }

// components/settings/customize/customize.ts — pure (W10.8)
type CustomizationAction = 'edit' | 'view' | 'duplicate' | 'export' | 'toggle' | 'delete' | 'open-plugin'
interface CustomizationDraft {      // the editor's structured fields; formatDefinition turns them into the content
  kind: CustomizationKind
  name: string
  description: string
  tools: string[] | null            // agents: tools; commands: allowed-tools; null = no restriction
  model: string | null              // a model ref, 'inherit' (agents) or null
  argumentHint: string | null       // commands
  body: string                      // instructions / prompt / skill content
}
function sectionsOf(list: CustomizationList | null, kind: CustomizationKind): { source: CustomizationSource; entries: CustomizationEntry[] }[]
function stateBadge(entry: CustomizationEntry): { label: string; tone: 'muted' | 'warning' | 'destructive' } | null
function rowMeta(entry: CustomizationEntry, pluginName: (id: string) => string): string[]
function draftFromUser(customization: Customization): CustomizationDraft             // from its parsed fields
function draftFromEntry(entry: CustomizationEntry, content: string): CustomizationDraft   // parseDefinition inside
function importDraft(file: File, kind: CustomizationKind): Promise<{ draft: CustomizationDraft; notes: string[] }>
const EDITOR_COPY: Readonly<Record<CustomizationKind, { title: string; body: string; bodyHelp: string; save: string }>>
// + P10-A: CUSTOMIZE_TABS / kindOfTab (?tab), SECTION_ORDER, builtinCommandEntries (the Built-in command rows),
// RESERVED_COMMAND_NOTE, hasRowMenu, kindFolders, middleTruncate, shadowedTooltip, rowDiagnostics, sourceLabel,
// rowMetaItems (rowMeta's items with mono / title), emptyDraft, draftFromDefinition, IMPORT_MAX_BYTES (256 KB) /
// importTooLarge, importNotes, draftDefinition / draftContent / sameDraft, CONTENT_MAX_BYTES / sizeLabel / draftBytes,
// nameError / descriptionError / argumentHintError / bodyError / existsError, diagnosticField, freeName (Duplicate),
// deleteCopy, EDITOR_FIELD_COPY, PERSONAL_EMPTY / projectEmpty, bodyDiagnostics (frontmatter lines → body lines).

// utils/download.ts — (+ Phase 10, W10.8)
function downloadText(text: string, fileName: string, type = 'text/plain'): void   // Blob + a temporary <a download>

// components/plugins/code/editor-setup.ts — addition (W10.8)
function createMarkdownEditor(parent: HTMLElement, opts: {
  dark: boolean; readonly: boolean; label: string; describedBy?: string
  onChange(value: string): void; onSubmit(): void
}): {
  view: EditorView; setValue(value: string): void; setDiagnostics(d: readonly DefinitionDiagnostic[]): void
  setDark(dark: boolean): void; setReadOnly(readonly: boolean): void; setLabel(label: string, describedBy?: string): void
  focus(): void; destroy(): void
}
// No Tab capture (no indentWithTab), Mod+Enter → onSubmit, markdown language, line numbers and wrapping, the one-dark
// theme in dark mode, aria-readonly when read-only, lint markers (placeDefinitionDiagnostics: the whole line of each
// diagnostic that has one; messages already start with "Line N: ").

// composables/useChatSession.ts — additions (W10.10)
interface ChatSession {
  // … the members of 11.1, 11.5 and 11.6
  backgroundTasks: ComputedRef<readonly BackgroundTask[]>   // + backgroundTasks.tasks(id)
  stopBackgroundTask(taskId: string): Promise<'stopped' | 'gone'>   // + backgroundTasks.stop(id, taskId)
}
// load() also calls backgroundTasks.fetch(id); run.started with origin 'task' and a userMessageId that is not on the
// shown path → refresh(), then resumeStream() (deferred until idle), exactly like origin 'queue'; stop() never
// touches background tasks.
```

The `customizations` store is the only reader of the customization routes; the Plugins detail page reads the global
catalog through it (`catalog(null)`), the composer its command lists, the Customize page everything. The remember call
(`POST /api/memory`) and the task stop route are used through `useApi()` (the dialog) and the background-tasks store.

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
| Alt+C | show or hide the changes panel (Phase 8, 7.21); opening it focuses the active view tab; closing it while focus is inside returns focus to the toggle | project chat pages, also in inputs; not while focus is in another dialog, menu or listbox (it works inside the changes sheet) | W8.8 (id `toggle-changes`, `alt+code:KeyC` = `CHANGES_SHORTCUT_KEYS`, `alt: true`, `allowInInputs`, group Chat, described "Show or hide changes"; registered by `ChatWorkspace` while the chat has a project) |
| Shift+Tab | switch the permission mode: Ask → Accept edits → Plan → Ask in project chats; from Auto or Off → Ask (Phase 9, 7.11); otherwise the native reverse focus move | the composer textarea only, while the permission menu shows, no slash or mention menu is open, no IME composition, `shiftTabModes` on, and the next mode differs | W9.10 (`useModeCycle`, called by the textarea's keydown after the menus; display-only registry entry `composer-cycle-mode`, `shift+tab`, group Composer, "Switch the permission mode") |
| Enter | send (`sendKey = enter`); Phase 9: while a response runs, queue the message (7.26) | composer | W2.3; W9.8 |
| Mod+Enter | send (`sendKey = mod-enter`); Phase 9: while a response runs, queue the message | composer | W2.3; W9.8 |
| Shift+Enter | new line | composer | W2.3 |
| Esc | close the open menu/dialog (Phase 9: the mention menu first); else cancel a recording or transcription (Phase 6); else stop the running response (Phase 9: also while messages are queued; they return to the composer) | composer / chat | W2.3; W6.9 (dictation: the textarea's keydown handles Esc inside the composer; outside inputs the registry entry `composer-dictation-cancel`, registered after `composer-stop` so it wins while dictation runs) |
| Esc (outside inputs and overlays) | stop reading aloud (Phase 6, 7.18), before stopping a running response | chat pages | W6.8 (registry entry `read-aloud-stop`, group Chat; registered only while something is read and removed when the reading ends) |
| ↑ (empty composer) | edit the last user message | composer | W2.3 |
| ← / → | previous / next version of a message | focus inside a `BranchSwitcher` | W5.2 (component keydown, not the registry) |
| Mod+S | save the active file | code editor | W3.4 |
| Mod+Enter | save (Phase 10): the Customize editor sheet (any field, the body editor included) and the Remember dialog | `CustomizationEditor`, `RememberDialog` | W10.8 / W10.9 (component keydown, not the registry) |
| Esc | close the Customize editor sheet (asks "Discard changes?" when it has changes) or the viewer; close the Remember dialog | sheets and dialogs | reka-ui (the editor turns every close request of its sheet, Esc included, into "Discard changes?" while it has changes) |
| ↑ / ↓ / Enter / Tab | navigate and pick in palette, slash menu, model picker; Phase 9: the mention menu (Enter / Tab on a folder opens it and keeps the menu open) | overlays | components |

Rules:
- **Browser-reserved combos are never used**: Mod+N, Mod+Shift+N, Mod+T, Mod+Shift+T, Mod+W, Mod+Shift+W,
  Mod+Tab, Mod+L, Mod+R, Mod+D, Mod+P, Mod+Q. New chat is therefore Mod+Shift+O (as on claude.ai); the page calls
  `preventDefault()` so Chrome's Ctrl+Shift+O (bookmarks manager) and Firefox's Ctrl+K / Ctrl+B do not fire.
- Alt shortcuts match `event.code` (Option+M types `µ` on macOS), are ignored when Ctrl or Meta is also pressed,
  and can be turned off in Settings → General (`altShortcuts`, which covers Alt+V too). Alt+V calls
  `preventDefault()` like every matched shortcut, which should keep Firefox on Windows from opening its View menu
  (unverified). Phase 6 kept Alt+V; the Alt+J fallback of the plan was not needed.
- Esc priority: close an open overlay (Phase 9: in the composer the mention menu first, then the slash menu) → cancel a
  recording or transcription (composer) → cancel an inline edit → stop reading aloud (outside inputs) → stop streaming. The registry tries the latest registration first and skips an entry
  whose `when` is false: `composer-dictation-cancel` only takes Esc while dictation runs, and `read-aloud-stop` exists
  only while something is read.
- Shortcuts never fire while an IME composition is active or inside CodeMirror (except Mod+S and Mod+K).
- Phase 7 adds no shortcut (every free combo clashes with a browser shortcut): projects are reached through the
  switcher (Tab and Enter), the command palette's Projects section (7.20) and Alt+P for the permission mode.
- Phase 8 adds **Alt+C** (the changes panel, only on project chat pages) and the palette item "Show changes" / "Hide
  changes" (`toggle-changes`; it shows the Alt+C hint only while `altShortcuts` is on). It follows the Alt rule above:
  it matches `event.code` (AltGr layouts and Option+C on macOS work), obeys `altShortcuts`, and calls
  `preventDefault()`; its `when` skips it while focus is in a dialog, alert dialog, menu or listbox other than the
  changes sheet (those keep their own keys). Rejected: Alt+D (focuses the address bar on
  Windows), Mod+Shift+D (bookmarks all tabs), Mod+\ (fails on AltGr layouts). Known caveat, as for Alt+V: Alt+C opens
  the History menu of Firefox in some locales (German); `preventDefault()` should keep it closed (unverified). Rewind
  and shell rules have no shortcut (the message action row and the approval card are reached with Tab).
- Phase 9 adds **Shift+Tab** in the composer only (Claude Code parity). It is not a registry shortcut: the textarea's
  keydown calls `useModeCycle().handleKeydown` after the mention and slash menus, and the registry holds a
  display-only entry for the shortcuts dialog. The narrow conditions above keep reverse tabbing intact everywhere else
  (outside the textarea, with a menu open, without tools, in a chat without a project while in Ask, and with the
  setting `shiftTabModes` off), so a keyboard user is never trapped; Alt+P (when Alt shortcuts are on) and `/mode`
  stay the other ways to change the mode. Enter while a response runs queues the message instead of being ignored;
  the plan card, the queue rows, the todo strip and the task blocks have no shortcuts (Tab reaches them; the plan card
  never approves on Enter).
- Phase 10 adds no global shortcut. Mod+Enter saves inside the Customize editor and the Remember dialog (handled by the
  components, so it never sends the composer's message; with `sendKey = mod-enter` the composer is not focused while
  they are open). The `MarkdownEditor` never captures Tab (Tab and Shift+Tab move focus), so the editor sheet has no
  keyboard trap; Mod+K and Mod+/ still work inside it (as in every CodeMirror field). **Esc in the composer never stops
  background agents**: it closes an open mention or slash menu first, then cancels dictation, then stops the running
  reply only (7.6, 7.29); background agents stop from their own Stop buttons. The slash menu, the argument hint and the dock add no shortcut (Tab reaches the dock's toggle, rows and Stop
  buttons).
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

Usage: `<Button :data-testid="testIds.newChat">`. Ids are kebab-case and static; the identity of repeated elements goes
into data attributes (`data-chat-id`, `data-message-id`, `data-model-ref`, `data-provider-id`, `data-plugin-id`,
`data-tool-name`, `data-server-id`, `data-state`, `data-status`, `data-value`, `data-step`, `data-step-item`,
`data-path`, `data-kind`, `data-action`, `data-code`, `data-level`, `data-dirty`, `data-hidden`; Phase 5 adds
`data-index`, `data-count`, `data-share-id`, `data-role`, `data-outdated`, `data-expired`; Phase 6 reuses them for
galleries and adds no new attribute name; Phase 7 adds `data-project-id` and `data-tone`; Phase 8 adds `data-conflict`,
`data-view`, `data-rule-id` and `data-variant`; Phase 9 adds `data-compacted`; Phase 10 adds `data-group`,
`data-agent-type`, `data-background`, `data-source`, `data-name`, `data-customization-id`, `data-task-id`, `data-mode`,
`data-target` and `data-total`). Playwright uses `getByTestId()` plus
attribute filters. Ids are never reused for a different element; removing one is a CCR. The Phase 5 ids are collected
in 13.6, except the two Settings → Models ids added in P5-B (`model-select-option`, `model-row-menu`, 13.4); the Phase 6
ids in 13.7; the Phase 7 ids in 13.8; the Phase 8 ids in 13.9; the Phase 9 ids in 13.10; the Phase 10 ids in 13.11.

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
`command-palette-item`s (`data-value` `project-filter-all` / `project-filter-none` / `project-filter-<id>`,
`project-add`, `project-move-<id>` / `project-move-none`; a checked filter has `data-checked="true"`; the nav entry is
`go-settings-projects`); the move toast's Undo is `toast-undo`, as in the "Chat deleted" toast. `project-add` marks
every "Add project" control (the switcher item, the Settings → Projects header button and its empty state), as
`share-copy` marks every "Copy link".

| Id | Key (`testIds.*`) | Element | Data attributes |
|---|---|---|---|
| `project-switcher` | `projectSwitcher` | `ProjectSwitcher` trigger (first row of `ChatNav`; named "Project filter: {name}") | `data-value` (`all` / `none` / project id) |
| `project-switcher-option` | `projectSwitcherOption` | a filter item of the switcher menu | `data-value` (`all` / `none` / project id), `data-state` (reka: `checked` / `unchecked`) |
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
| `file-list-item` | `fileListItem` | one item of a file list | `data-path`, `data-type` (directory entries: `file` / `dir` / `symlink` / `other`), `data-line` (search matches) |
| `tool-approval-preview` | `toolApprovalPreview` | `ToolApprovalPreview` root inside an approval card | `data-kind` (`diff` / `content` / `command`) |
| `tool-approval-accept-edits` | `toolApprovalAcceptEdits` | "Accept all edits in this chat" checkbox | `data-state` (reka: `checked` / `unchecked`) |
| `data-key-section` | `dataKeySection` | `EncryptionKeySection` root | |
| `data-key-rotate` | `dataKeyRotate` | "Rotate key…" | |
| `key-rotate-dialog` | `keyRotateDialog` | `RotateKeyDialog` content | |
| `key-rotate-confirm` | `keyRotateConfirm` | "Type ROTATE to confirm" input | |
| `key-rotate-submit` | `keyRotateSubmit` | "Rotate key" submit | |
| `data-cleanup-section` | `dataCleanupSection` | `StorageCleanupSection` root | |
| `data-cleanup-check` | `dataCleanupCheck` | "Check for unused files" | |
| `data-cleanup-summary` | `dataCleanupSummary` | the preview summary block | `data-state` (`removable` / `empty`) |
| `data-cleanup-run` | `dataCleanupRun` | "Remove…" | |
| `data-cleanup-confirm` | `dataCleanupConfirm` | confirm button of the cleanup `ConfirmDialog` | |

E2e hooks that are not test ids (Phase 7, no CCR needed): the Encryption key section marks its parts with `data-slot` —
`key-status` (the status list, with `data-source` = `file` / `env` and `data-key-check` = `ok` / `mismatch` /
`unknown`), `key-source`, `key-version`, `key-rotated`, `key-secrets`, `key-mismatch-alert`, `key-env-note`,
`key-rotate-commands`; the Rotate key dialog `key-rotate-effects` and `key-rotate-error` (`data-code`, `data-reason` =
the conflict reason). The workspace tool parts use `data-slot` too: `workspace-tool-body` (`data-kind`), `tool-raw`,
`diff-hunk`, `diff-note`, `diff-empty`, `server-truncated`, `file-line`, `file-range`, `file-empty`, `file-list-empty`,
`file-list-group`, `terminal-timeout`, `terminal-signal`, `terminal-duration`, `replace-all` (the "All occurrences"
badge), `command`, `command-description`, `command-meta`, `command-warning` (the shell preview), `project-moved-toast`;
show-all buttons carry `data-action="show-all"` (`data-stream` in `TerminalOutput`). The project filter is stored raw in
`localStorage['hf-project-filter']` (`all`, `none` or a project id).

### 13.9 Changes panel, rewind, shell rules and automatic cleanup (Phase 8)

The 39 new ids of Phase 8. C20 copies this table verbatim into `utils/testids.ts` in P8-0b (the key column is the
`testIds` key) under a `// Changes panel, rewind, shell rules and automatic cleanup (Phase 8)` comment; the file stays
frozen through P8-A. New data attributes: `data-conflict` (`true` on a file changed outside this chat), `data-view`
(`chat` / `git`), `data-rule-id` (a shell rule id) and `data-variant` (`pane` / `sheet` on `changes-panel`, P8-A).
Reused ids: the revert and rewind toasts' Undo is `toast-undo`; the palette item is a `command-palette-item` with
`data-value="toggle-changes"`; the revert confirmation is styled as a `ConfirmDialog` (built on its `AlertDialog` parts,
content `data-slot="confirm-dialog"`) whose confirm button carries `changes-revert-confirm`; the shell approval card
stays a `tool-approval` with `tool-approval-allow` / `tool-approval-deny`; rows stay `tool-row`s. There are no ids for a
rule edit (rules are removed and added, never edited).

| Id | Key (`testIds.*`) | Element | Data attributes |
|---|---|---|---|
| `changes-toggle` | `changesToggle` | `ChangesToggle` in the chat header | `data-state` (`open` / `closed`), `data-count` |
| `changes-panel` | `changesPanel` | `ChangesPanel` root (pane or sheet) | `data-view` (`chat` / `git`), `data-state` (`loading` / `ready` / `error` / `unavailable`), `data-variant` (`pane` / `sheet`) |
| `changes-view-option` | `changesViewOption` | a view tab (This chat / Git) | `data-value` (`chat` / `git`), `data-state` (reka: `active` / `inactive`) |
| `changes-refresh` | `changesRefresh` | "Refresh changes" | |
| `changes-close` | `changesClose` | "Close changes" | |
| `changes-resize` | `changesResize` | the resize handle of the desktop pane | |
| `changes-summary` | `changesSummary` | the summary line | `data-count` (listed files) |
| `changes-file` | `changesFile` | one file row | `data-path`, `data-status` (`added` / `modified` / `deleted` / `untracked` / `renamed` / `conflicted` / `typechange`), `data-state` (`open` / `closed`), `data-conflict` |
| `changes-file-revert` | `changesFileRevert` | "Revert {path}" of a row | `data-path` |
| `changes-empty` | `changesEmpty` | `ChangesEmpty` | `data-reason` (`ChangesEmptyReason`) |
| `changes-error` | `changesError` | "Couldn't load the changes" alert | `data-code` |
| `changes-revert-confirm` | `changesRevertConfirm` | confirm button "Revert file" of the revert dialog | |
| `message-rewind` | `messageRewind` | "Rewind files to here" in the action row of a user message | |
| `rewind-dialog` | `rewindDialog` | a wrapper inside the `RewindDialog` content (reka owns the content's own `data-state` `open` / `closed`) | `data-state` (`loading` / `ready` / `empty` / `error` / `restoring`) |
| `rewind-file` | `rewindFile` | one file of the preview | `data-path`, `data-action` (`restore` / `delete` / `unavailable`), `data-conflict` |
| `rewind-shell-command` | `rewindShellCommand` | one shell command listed in the warning | |
| `rewind-force` | `rewindForce` | "Also restore files changed outside this chat" checkbox | `data-state` (reka: `checked` / `unchecked`) |
| `rewind-restore` | `rewindRestore` | "Restore files" | |
| `rewind-restore-edit` | `rewindRestoreEdit` | "Restore files and edit" | |
| `rewind-error` | `rewindError` | inline error of the dialog | `data-code` |
| `tool-approval-allow-rule` | `toolApprovalAllowRule` | "Always allow commands starting with" checkbox of a shell card | `data-state` (reka: `checked` / `unchecked`) |
| `tool-approval-rule-prefix` | `toolApprovalRulePrefix` | the prefix input (one prefix) or each prefix chip (several) | `data-value` (the prefix) |
| `tool-approval-rule-scope` | `toolApprovalRuleScope` | This project / All projects toggle group | `data-value` (`project` / `global`) |
| `tool-approval-rule-error` | `toolApprovalRuleError` | inline rule error of the card | `data-code` (the `parseShellRule` reason or `no-match`) |
| `tool-row-rule` | `toolRowRule` | `ToolRuleBadge` of a shell row (chat and share page) | `data-value` (the matched prefixes, joined with ", ") |
| `project-allowlist` | `projectAllowlist` | "Allowed commands…" item of a project row menu | |
| `allowlist-dialog` | `allowlistDialog` | `AllowlistDialog` content | |
| `allowlist-section` | `allowlistSection` | `GlobalAllowlistSection` root | |
| `allowlist-input` | `allowlistInput` | the new-rule input of an `AllowlistEditor` | |
| `allowlist-add` | `allowlistAdd` | "Add" of an `AllowlistEditor` | |
| `allowlist-error` | `allowlistError` | inline error of an `AllowlistEditor` | `data-code` (a `parseShellRule` reason or the `HarnessError` code: `conflict` for 409 `exists`, `validation_error` for a 400) |
| `allowlist-rule` | `allowlistRule` | one rule row | `data-rule-id`, `data-value` (the prefix) |
| `allowlist-rule-remove` | `allowlistRuleRemove` | "Remove {prefix}" | |
| `allowlist-empty` | `allowlistEmpty` | "No allowed commands yet." | |
| `terminal-cwd` | `terminalCwd` | the folder before `$` in `TerminalOutput` | `data-value` (the project-relative folder) |
| `terminal-cwd-change` | `terminalCwdChange` | the "Now in {folder}" badge | `data-value` (the new folder; `.` = the project folder) |
| `data-cleanup-auto` | `dataCleanupAuto` | "Automatic cleanup" switch (Settings → Data) | `data-state` (reka: `checked` / `unchecked`) |
| `data-cleanup-interval` | `dataCleanupInterval` | "Every day / Every week" select trigger | `data-value` (`daily` / `weekly`) |
| `data-cleanup-auto-status` | `dataCleanupAutoStatus` | the automatic cleanup status line | `data-state` (`off` / `never` / `done` / `skipped` / `failed`) |

E2e hooks that are not test ids (Phase 8, no CCR needed): `data-slot` = `chat-workspace`; changes panel
`changes-count` (the toggle's pill), `changes-status` (a row's tile), `changes-counts` (a row's `+a −d`),
`changes-conflict` (a row's warning icon), `changes-diff` (`data-state` `loading` / `ready` / `error`),
`changes-diff-error` (`data-code`), `changes-diff-note`, `changes-truncated`, `changes-untracked`,
`changes-reverted-toast`, `revert-changed-outside`, `confirm-dialog` (the revert dialog content); rewind
`rewind-loading`, `rewind-empty`, `rewind-shell`, `rewind-result-toast`; shell rules `allow-rule`,
`allow-rule-details`, `allow-rule-note`, `allowlist-editor`, `allowlist-warning`; tool rows `tool-row-summary-label`
(the sr-only label next to `tool-row-summary`), `terminal-cwd-note`, `terminal-rule`; Settings → Data
`cleanup-plugin-data`. DOM ids: `#hf-chat-panel`, `#hf-changes-resize`, `aside#hf-changes-pane`, `#hf-changes-panel`,
`#hf-changes-heading`. The panel state is stored in `localStorage['hf-changes-width']` (px), `['hf-changes-open']`
(`1` / `0`) and `['hf-changes-view']` (`chat` / `git`).

### 13.10 Agent 2.0: compaction, plan mode, todos, sub-agents, mentions and the queue (Phase 9)

The 32 new ids of Phase 9. C25 copied this table verbatim into `utils/testids.ts` in P9-0b (the key column is the
`testIds` key) under the comment `// Agent 2.0: compaction, plan mode, todos, sub-agents, mentions, queue, agent
settings (Phase 9)`; the file stayed frozen through P9-A. The only new attribute name is `data-compacted` (`"true"` on
the `message-user` / `message-assistant` rows before the latest compaction, 7.24; the blocks dimmed inside a row by an
in-run compaction get only the dimming classes). Reused ids with new values: `composer-attachment` gains `data-kind`
(`upload` / `project`) and `data-path` (project chips); `permission-option` gets `data-value="plan"`; agent tool rows
stay `tool-row`s (`data-tool-name` `todo_write` / `exit_plan_mode`; a `task` call renders `task-block` instead); the
share page reuses these ids for `TaskBody`, `TodoList` and `PlanBody` inside `share-tool-row-output`; the `/compact`
item is a `slash-menu-item` with `data-value="compact"`; the compaction notice is a `data-slot="notice-part"` line with
`data-code="compaction-failed"` like every `data-notice`. `settings-compaction-model` keeps its name although the
setting key is `compactModelRef`.

| Id | Key (`testIds.*`) | Element | Data attributes |
|---|---|---|---|
| `compaction-divider` | `compactionDivider` | `CompactionDivider` root | `data-kind` (`manual` / `auto`: the trigger), `data-variant` (`history` / `run`), `data-count` (messages summarized) |
| `compaction-toggle` | `compactionToggle` | "Show summary" / "Hide summary" | `data-state` (`open` / `closed`) |
| `compaction-summary` | `compactionSummary` | the expanded summary card | |
| `plan-approval` | `planApproval` | `PlanApprovalCard` root | `data-state` (`pending` / `sending`) |
| `plan-approval-plan` | `planApprovalPlan` | the scrollable plan region | |
| `plan-feedback` | `planFeedback` | "Feedback for the agent (optional)" textarea | |
| `plan-approve-edits` | `planApproveEdits` | "Approve, accept edits" | |
| `plan-approve-ask` | `planApproveAsk` | "Approve, ask before edits" | |
| `plan-keep-planning` | `planKeepPlanning` | "Keep planning" | |
| `todo-strip` | `todoStrip` | `TodoStrip` root in the dock | `data-state` (`open` / `closed`), `data-count` (total), `data-value` (done) |
| `todo-strip-toggle` | `todoStripToggle` | the strip's toggle | |
| `todo-list` | `todoList` | `TodoList` root (row body, strip, share page) | |
| `todo-item` | `todoItem` | one item | `data-status` (`pending` / `in_progress` / `completed`), `data-index` |
| `task-block` | `taskBlock` | `TaskBlock` root | `data-state` (`queued` / `running` / `completed` / `failed` / `limit` / `aborted` / `approval` / `denied`), `data-kind` (`explore` / `general`) |
| `task-block-trigger` | `taskBlockTrigger` | the block's collapsible trigger (line 1) | |
| `task-step` | `taskStep` | `TaskStepRow` root | `data-tool-name`, `data-state` (`running` / `done` / `error` / `denied`) |
| `task-steps-more` | `taskStepsMore` | "Show all {n} steps" | |
| `task-report` | `taskReport` | the report block | |
| `mention-menu` | `mentionMenu` | `MentionMenu` root | `data-state` (`loading` / `ready` / `error`), `data-count` |
| `mention-menu-item` | `mentionMenuItem` | one file or folder | `data-path`, `data-kind` (`file` / `dir`) |
| `composer-mention` | `composerMention` | "Mention a file" in the `+` menu | |
| `queued-messages` | `queuedMessages` | `QueuedMessages` root in the dock | `data-count`, `data-state` (`queued` / `approval`) |
| `queued-message` | `queuedMessage` | one queued message | `data-message-id`, `data-state` (`queued` / `cancelling`) |
| `queued-message-edit` | `queuedMessageEdit` | "Edit queued message" | |
| `queued-message-cancel` | `queuedMessageCancel` | "Cancel queued message" | |
| `composer-queue` | `composerQueue` | "Queue message" left of Stop | |
| `steer-note` | `steerNote` | `SteerNote` root inside a reply | `data-message-id` (the queued message id) |
| `settings-auto-compact` | `settingsAutoCompact` | "Automatic compaction" switch | `data-state` (reka: `checked` / `unchecked`) |
| `settings-compaction-model` | `settingsCompactionModel` | "Compaction model" select trigger | |
| `settings-subagent-model` | `settingsSubagentModel` | "Sub-agent model" select trigger | |
| `settings-subagent-max-steps` | `settingsSubagentMaxSteps` | "Sub-agent max steps" input | |
| `settings-shift-tab-modes` | `settingsShiftTabModes` | "Shift+Tab switches the permission mode" switch | `data-state` (reka: `checked` / `unchecked`) |

E2e hooks that are not test ids (Phase 9, no CCR needed): `data-slot` = `task-live` (a task block's second line),
`task-meta-short` (its count and duration), `task-body`, `task-steps`, `task-steps-omitted`, `task-step-preview`,
`task-meta` (the body's meta line), `todo-progress` (the strip's progress bar), `compaction-meta` (the divider's meta
line), `compaction-focus`, `context-compaction-note` (the context ring's compaction footer), `mention-highlight` (the
matched runs of a mention row), `mention-status`, `mention-truncated`, `mention-announcer`, `plan-body`,
`plan-feedback-text`, `agent-tool-body` (the body of a `todo_write` / `exit_plan_mode` row), `agent-tool-label` (a
share row's static label), `steer-text`, `steer-files`, `queued-messages-more`, `subagent-model-warning`; also
`data-variant` (`row` / `strip`) on `todo-list` and `data-highlighted` on the active `mention-menu-item`. The strip
state is stored in `localStorage['hf-todo-expanded']` (`1` / `0`).

### 13.11 Agent customization: Customize, commands, skills, background agents, plan files, Remember (Phase 10)

The 56 new ids of Phase 10. C33 copies this table verbatim into `utils/testids.ts` in P10-0b (the key column is the
`testIds` key) under the comment `// Agent customization: Customize, commands, skills, background agents, Remember
(Phase 10)`; the file stays frozen through P10-A (a new id is a CCR). New attribute names: `data-group`,
`data-agent-type`, `data-background`, `data-source`, `data-name`, `data-customization-id`, `data-task-id`, `data-mode`,
`data-target`, `data-total`. Reused ids with new values: `task-block` gains `data-kind="custom"`, `data-agent-type` (the
type name), `data-background` (`"true"` on background calls) and `data-state="background"` (a background call whose live
state is unknown); `slash-menu-item` gains `data-group` (`app` / `project` / `personal` / `plugin`; the `/remember` item
has `data-value="remember"`); the skill row is a `tool-row` with `data-tool-name="skill"`; the Undo of a deleted
definition is `toast-undo`; the editor's model select carries `model-select-option` rows like every
`SettingsModelSelect`; the palette entry is a `command-palette-item` with `data-value="go-settings-customize"`; the
command-model notice is a `data-slot="notice-part"` line with `data-code="command-model-unavailable"`. There is no
`customization-user-invocable` and no `data-skill` attribute: skills are not user-invocable in v1.6.

| Id | Key (`testIds.*`) | Element | Data attributes |
|---|---|---|---|
| `settings-nav-customize` | `settingsNavCustomize` | the Customize link of `SettingsNav` | |
| `customize-settings` | `customizeSettings` | `CustomizeSettings` root | |
| `customize-tab` | `customizeTab` | one tab trigger (Agents / Commands / Skills) | `data-value` (`agents` / `commands` / `skills`), `data-count`, `data-state` (reka: `active` / `inactive`) |
| `customize-project-select` | `customizeProjectSelect` | the Project select trigger | `data-value` (a project id, empty for none) |
| `customize-new` | `customizeNew` | "New agent" / "New command" / "New skill" in the header | `data-kind` (`agent` / `command` / `skill`) |
| `customize-import` | `customizeImport` | "Import…" in the header | |
| `customize-import-input` | `customizeImportInput` | the visually hidden file input (`.md`) | |
| `customize-section` | `customizeSection` | `CustomizationSection` root | `data-source` (`user` / `project` / `plugin` / `builtin`), `data-count` |
| `customize-empty` | `customizeEmpty` | the empty state of a personal or project section | `data-kind`, `data-source` (`user` / `project`) |
| `customization-row` | `customizationRow` | `CustomizationRow` root | `data-kind`, `data-name`, `data-source`, `data-state` (`active` / `shadowed` / `invalid` / `off`), `data-customization-id` (personal), `data-path` (project), `data-plugin-id` (plugin) |
| `customization-row-menu` | `customizationRowMenu` | the row's `⋯` trigger ("Actions for {name}") | |
| `customization-edit` | `customizationEdit` | "Edit…" (personal) | |
| `customization-view` | `customizationView` | "View…" (project, plugin, built-in) | |
| `customization-duplicate` | `customizationDuplicate` | "Duplicate" (personal) / "Copy to personal" (others) | |
| `customization-export` | `customizationExport` | "Export .md" | |
| `customization-toggle` | `customizationToggle` | "Turn off" / "Turn on" (personal) | `data-state` (`on` / `off`: the current value) |
| `customization-delete` | `customizationDelete` | "Delete…" (personal) | |
| `customization-delete-confirm` | `customizationDeleteConfirm` | "Delete agent" / "Delete command" / "Delete skill" in the confirm dialog | |
| `customization-diagnostics` | `customizationDiagnostics` | the diagnostics list under a row | `data-count`; each item `data-level` (`error` / `warning` / `info`) |
| `customization-editor` | `customizationEditor` | `CustomizationEditor` sheet content | `data-kind`, `data-mode` (`new` / `edit` / `import`) |
| `customization-name` | `customizationName` | the Name input | |
| `customization-description` | `customizationDescription` | the Description textarea | |
| `customization-tools-mode` | `customizationToolsMode` | the Tools radio group | `data-value` (`all` / `some`) |
| `customization-tools` | `customizationTools` | the `ToolMultiSelect` trigger | `data-count` |
| `customization-tool-option` | `customizationToolOption` | one tool in the tool list | `data-tool-name`, `data-state` (`checked` / `unchecked`) |
| `customization-tool-chip` | `customizationToolChip` | one chosen tool chip | `data-tool-name`, `data-state` (`known` / `unknown`) |
| `customization-model` | `customizationModel` | the Model select trigger | `data-value` (a model ref, `inherit`, or empty) |
| `customization-argument-hint` | `customizationArgumentHint` | the Argument hint input (commands) | |
| `customization-body` | `customizationBody` | the body `MarkdownEditor` root | |
| `customization-save` | `customizationSave` | "Save agent" / "Save command" / "Save skill" | |
| `customization-error` | `customizationError` | the form-level error alert | `data-code` |
| `customization-import-notes` | `customizationImportNotes` | the import notes alert | `data-count` |
| `customization-viewer` | `customizationViewer` | `CustomizationViewer` sheet content | `data-kind`, `data-source` |
| `customization-discard-confirm` | `customizationDiscardConfirm` | "Discard" in the "Discard changes?" dialog | |
| `slash-argument-hint` | `slashArgumentHint` | `SlashArgumentHint` mirror (ghost text) | |
| `remember-dialog` | `rememberDialog` | `RememberDialog` content | |
| `remember-text` | `rememberText` | the note textarea | |
| `remember-target` | `rememberTarget` | one "Save to" radio item | `data-value` (`project-file` / `project-instructions` / `global`), `data-disabled` (reka) |
| `remember-save` | `rememberSave` | "Save" | |
| `remember-error` | `rememberError` | the inline error | `data-code` |
| `task-result` | `taskResult` | `TaskResultNote` root | `data-task-id`, `data-status` (`completed` / `failed` / `aborted` / `limit`), `data-variant` (`inline` / `turn`) |
| `task-result-toggle` | `taskResultToggle` | "Show report" / "Hide report" | `data-state` (`open` / `closed`) |
| `task-result-report` | `taskResultReport` | the expanded report | |
| `task-block-reveal` | `taskBlockReveal` | "Show in background agents" / "Go to the result" in an expanded task block | `data-target` (`dock` / `result`) |
| `plan-file` | `planFile` | `PlanFileChip` root | `data-state` (`saved` / `failed`), `data-path` |
| `background-agents` | `backgroundAgents` | `BackgroundAgents` root in the dock | `data-state` (`open` / `closed`), `data-count` (running), `data-total` (visible) |
| `background-agents-toggle` | `backgroundAgentsToggle` | the list's toggle line | |
| `background-agents-stop-all` | `backgroundAgentsStopAll` | "Stop all" | |
| `background-agent` | `backgroundAgent` | `BackgroundAgentRow` root | `data-task-id`, `data-state` (the task status), `data-kind` (`explore` / `general` / `custom`), `data-agent-type` |
| `background-agent-toggle` | `backgroundAgentToggle` | a row's details toggle (chevron, type and description; only when the launching `task` call is on the shown path) | `data-state` (`open` / `closed`) |
| `background-agent-stop` | `backgroundAgentStop` | a row's Stop | |
| `settings-plan-files` | `settingsPlanFiles` | "Save approved plans" switch | `data-state` (reka: `checked` / `unchecked`) |
| `settings-plan-directory` | `settingsPlanDirectory` | "Plan folder" input | |
| `plugin-customizations` | `pluginCustomizations` | `PluginCustomizationList` root (plugin detail) | `data-kind` (`agent` / `skill`), `data-count` |
| `plugin-customization` | `pluginCustomization` | one agent or skill of a plugin | `data-name`, `data-state` (`active` / `shadowed`) |
| `project-customizations` | `projectCustomizations` | "Agents, commands and skills…" in a project row menu | |

E2e hooks that are not test ids (Phase 10, no CCR needed): `data-slot` = `markdown-editor` (the CodeMirror root),
`skill-body`, `skill-files`, `task-result-meta`, `background-agents-announcer`, `background-agents-footnote`,
`command-badge-source` (the source line of a command badge's tooltip); `data-group` on the slash menu's group headings.
Added in P10-A (all `data-slot` unless noted): composer `composer-text` (the textarea's box), `slash-menu-hint`,
`slash-menu-detail`, `remember-counter`; transcript `task-agent-label`, `task-agent-card`, `task-agent-source` (the
custom agent card), `task-result-summary`, `task-result-markdown`, `task-result-empty`, `task-meta` (also in a result
note), `skill-row-label`, `skill-row-name`, `skill-row-source`, `skill-description`, `skill-base-dir`, `skill-content`,
`skill-caption`, `plan-file-path`, `plan-file-copy`, `plan-file-show-changes`, `command-badge`, `command-badge-model`,
`command-badge-runs-on`, `command-badge-tools`; dock `background-agent-meta`, `background-agent-status`,
`background-agent-live`, `background-agent-pending`, `background-agent-stopping`; share `share-task-background` ("· in
the background"); Customize `customization-deleted-toast` (its Undo is `toast-undo`), `customization-viewer-gone`,
`data-action="new"` / `data-action="import"` (the personal empty state's buttons) and `data-action="open-plugin"` (the
row menu item); plugins `plugin-customization-shadowed`, `plugin-customization-meta`, `plugin-customizations-open`;
data `data-import-customizations` (the result panel's definitions line).
Stored in `localStorage`: `hf-background-expanded` (`1` / `0`; a reveal opens the list without writing it) and
`hf-remember-target` (the last target, written after a successful save).

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
  project" submenu returns focus to its `⋯` trigger (the row or the header), and a move that takes the row out of the
  filtered list then moves focus to the neighbouring row, as a delete does. "Add project…" in the switcher opens the
  dialog once the menu has returned focus to the trigger, so the dialog gives it back there. Opening a folder in the
  `FolderBrowser` moves focus to its first entry (else Parent folder) when focus was in the browser, and the polite
  region announces "Opened {folder}, {n} folders"; the Add project dialog opens on the browser's first entry. The Rotate
  key dialog focuses "Type ROTATE to confirm"; closing it returns focus to "Rotate key…", closing its password prompt
  returns focus to the dialog's Rotate key button. After a cleanup check, a "Remove…" that became disabled under the
  keyboard focus hands focus back to "Check for unused files". "Show {n} more lines" and "Show all" keep focus on
  the same place of the expanded block. Checking "Accept all edits in this chat" does not move focus; Allow then
  collapses the card like any decision.
- Phase 8: a click on the changes toggle keeps focus on it; Alt+C and the palette item move focus to the active view
  tab when they open the panel; Close (and Alt+C with focus inside the pane) returns focus to the toggle; the sheet
  traps focus and returns it to the toggle when it closes (Esc too). After a revert focus moves to the next row (else
  the previous one, else the active view tab); a canceled or failed revert returns it to the row's Revert button. The
  rewind dialog sits on Cancel while the preview loads, then on Restore files (Close when there is nothing to restore
  or the preview failed); an inline restore failure puts it back on Restore files; Cancel, Esc, a failure handed to
  `ChatView` (404 / 409) and Restore files return focus to "Rewind files to here"; Restore files and edit leaves it in
  the message editor. Checking "Always allow commands starting with" keeps focus on the checkbox. The
  `AllowlistDialog` opens on its add input and returns focus to the row menu button; an `AllowlistEditor` keeps focus
  in its input after Add (also after an error) and, when focus was in the editor, moves it to the next rule's Remove
  (else the previous one, else the input) after a removal.
- Phase 9: the mention menu, like the slash menu, never takes focus (the textarea forwards ↑/↓/Enter/Tab/Esc and the
  listbox is reached through `aria-activedescendant`); picking an entry keeps the caret after the inserted `@path `.
  Shift+Tab in the textarea switches the permission mode only under the conditions of 7.11 and otherwise moves focus
  backwards as usual (no keyboard trap). Queueing a message keeps focus in the textarea (it clears); after a Stop the
  restored text is in the textarea with the caret at its end. Cancelling a queued message moves focus to the next row's
  Cancel (else the previous row's, else the textarea); Edit puts the text into the textarea and focuses it. The plan
  card does not take focus when it appears (it is announced instead); its buttons are reached with Tab, there is no
  Enter shortcut, and after a decision focus goes to the textarea (desktop). Opening the todo strip, a summary or a task
  block keeps focus on its toggle.
- **Dock stacking** (Phase 9): the composer dock (5.8) stacks, top to bottom, the todo strip, the queued messages and the
  composer, all in the `max-w-3xl` column; Tab order follows that order (strip toggle → queue rows → composer). The
  strip is collapsed by default and caps its open list at `40dvh`; the queue shows at most two rows on phones before
  "Show {n} more"; the transcript's bottom padding follows the dock's measured height, so the last line never hides
  behind it. Phase 10: the background agents list sits between the strip and the queue (strip toggle → background
  agents toggle and rows → queue rows → composer); it is collapsed by default below `md` and caps its open list at
  `40dvh`.
- Phase 10: the Customize editor sheet opens with focus on Name (new and import mode) or Description (edit mode, where
  the name keeps its value); closing it (saved, cancelled or discarded) returns focus to the element that opened it
  (the row's `⋯` trigger, New or Import…); the "Discard changes?" dialog opens on **Keep editing** and returns focus to
  the field that had it. The viewer opens on its Close button and returns focus to the row's `⋯` trigger. After a
  delete focus moves to the next row's `⋯` trigger (else the previous one, else New); Undo puts it on the restored row.
  Choosing a file in Import… opens the editor with focus on Name. The tabs, the project select and the row menus are
  reka components (arrow keys inside, Tab between them). In the body editor Tab and Shift+Tab move focus (never
  indent). The slash menu's group headings are not focusable; the argument hint never takes focus. The Remember dialog
  focuses the textarea when it is empty, else the selected target; closing it returns focus to the composer textarea
  (desktop). Opening the dock list keeps focus on its toggle; after a Stop focus moves to the next row's Stop (else the
  previous one, else the toggle); Stop all keeps focus on itself until it disappears, then the toggle. "Show in
  background agents" opens the list and focuses the row's details toggle (its Stop, else the list's toggle, when the
  row has none); "Go to the result" scrolls to the note, opens its report (clicking the toggle only while it is closed)
  and focuses the toggle. A carrier message is not focusable (it has no actions); its notes' toggles are.

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
  {path}" whose changed lines carry the sr-only words "Added" / "Removed"; a terminal block is a group named "Output of
  {command}" (the first line) and its exit badge reads "Exit code {n}"; row summaries were plain visible text ("+12 −3",
  "exit 1") with no extra sr-only wording in v1.3 (Phase 8 adds spoken labels, below). The new-chat picker is named
  "Project: {name}" too; root entries of the folder browser whose folder is missing say "{path}, not found". Every
  approval card is a group named "Approval needed: {tool}"; the shell approval is named and announced as "Approval
  needed: run {command}", and its warning is text inside the card. The Encryption key and Storage cleanup sections have
  headings; "Rotate key…" and "Remove…" name their action; the cleanup check result is announced in a polite region.
- Phase 8: a row summary's visible text is `aria-hidden` and a sibling sr-only span says its label ("12 lines added, 3
  removed", "Exit code 1", "Timed out", "Lines 1 to 120 of 340", "New file, 40 lines"; 7.19), on the share page too. The
  changes toggle is a toggle button (`aria-pressed`, `aria-controls`) named "Show changes, {n} files changed" / "Hide
  changes"; the desktop pane is an `<aside>` labelled by its `h2` "Changes"; the views are reka `Tabs`; each file row
  is a button with `aria-expanded` / `aria-controls` whose status letter has sr-only text ("Added", "Modified", …), and
  whose conflict icon says "changed outside this chat"; "+a −d" reads as `diffStatsLabel`; Revert is named "Revert
  {path}"; a polite region announces "Reverted {path}". "Rewind files to here" names its action; the dialog's file
  badges are text ("Restore", "Delete", "Can't restore"; the last one is focusable for its tooltip) and the list is
  named "Files to restore"; its inline error is a `role="alert"`. The rule badge of a shell row adds ", allowed by rule
  {prefixes}" to the row's name; the allow-rule checkbox has a visible label, which also names the prefix input (or the
  chip list), and the scope group is named "Where the rule applies"; inline rule errors are linked with
  `aria-describedby`. The editor's input is named "Start of a command to allow", its error is a `role="alert"`, and a
  loading list says "Loading allowed commands…" (sr-only). The automatic cleanup switch has a visible label and its
  description, the interval select is named "Automatic cleanup interval"; the status line is plain text. The pane's
  resize handle is named "Resize changes".
- Phase 9: a compaction divider is a `role="group"` named by its label ("Conversation compacted"), its rules are
  `aria-hidden`, the toggle has `aria-expanded` / `aria-controls`; dimmed rows carry no extra text. The plan card is a
  `role="group"` named "Plan ready for review" with the plan in a focusable `role="region"` named "Plan" and a labelled
  feedback field; it is announced once ("Plan ready for review"), and the decisions are announced ("Plan approved.
  Permission mode: Accept edits.", "Feedback sent. The agent keeps planning."). Todo items carry the sr-only prefixes
  "To do:", "In progress:", "Done:"; the strip toggle is named "Show tasks, 3 of 7 done" / "Hide tasks" and is not a
  live region. A task block's trigger is named "Explore sub-agent: {description}, running, 4 tool calls" ("Sub-agent:
  …" for the general type; "completed", "failed", "stopped", "step limit reached"); its live second line is
  `aria-hidden`; a skipped step's reason is in its tooltip and its sr-only text. The mention menu is a `role="listbox"`
  named "Files in {project}", `aria-busy` while loading, with a debounced (500 ms) polite count "{n} files" / "No
  matching files". A steer note is a `role="note"` with the sr-only prefix "You said while the agent worked:". The queue
  is a list named "Queued messages"; its buttons are "Edit queued message" / "Cancel queued message"; queueing announces
  "Message queued". A permission switch by Shift+Tab announces "Permission mode: {label}" through the composer's polite
  region, and the permission trigger gets `aria-keyshortcuts="Shift+Tab"` while the cycle is on. `ChatView` announces
  "Conversation compacted" once per new marker of its own stream.
- Phase 10: the Customize page has one `h1` (the page title) and an `h2` per section ("Personal · 2"); the tabs are reka
  `Tabs` with their counts in the accessible name ("Agents, 6"); each row is a list item whose name, description and
  meta line are text, its badges carry text ("Shadowed", "Invalid", "2 warnings", "Off"; the shadowed tooltip is also
  the badge's `aria-describedby`), and its `⋯` trigger is named "Actions for {name}"; the diagnostics list is a `ul`
  named "Problems in {name}". The editor sheet is a dialog named by its title; every field has a visible label, the
  inline errors are linked with `aria-describedby` and `aria-invalid`, the form-level error is a `role="alert"`; the
  tools radio group is named "Tools" ("Allowed tools" for commands); the tool chips' remove buttons are named "Remove
  {tool}" and an unknown chip says "{tool}, not available now"; the body editor's editable area has `aria-label` =
  its field label and `aria-multiline="true"`; the size counter is `aria-live="off"`, its over-limit message is part of
  the field's description. The viewer is a dialog named by the definition's name, its file read-only (`aria-readonly`).
  The slash menu's groups are `role="group"` elements labelled by their heading ("App", "Project", "Personal",
  "Plugins"); an item's accessible name is "/{name}, {description}" plus ", arguments {hint}" when it has a hint; the
  argument hint's mirror is `aria-hidden` and the textarea's description reads "Arguments: {hint}" while it shows. A
  custom task block's trigger is named "Sub-agent {name}: {description}, {status}, {n} tool calls" (", running in the
  background" for a background call); a skill row is named "Loaded skill {name}, {source}". The background agents list
  is a `region` named "Background agents"; its toggle has `aria-expanded` / `aria-controls`; the rows are a list
  named "Background agents"; each Stop is named "Stop {description}"; the announcer is a polite region without
  `role="status"`, a sibling of the list's region (present even when nothing is visible), and it announces each
  finished background agent once per tab (`ChatView` skips the agents it already announced). A custom task block's
  trigger is described (`aria-describedby`) by "{description}. {source}" of its agent card. A result note is a `role="note"` named "Background agent result: {description}"; its toggle has
  `aria-expanded` / `aria-controls`; the carrier caption "Sent to the agent" is `aria-hidden` (the note's name already
  says it). The Remember dialog is named "Remember" and described by the sr-only "Save a note to your instructions.";
  its radio group is named "Save to"; a disabled target has `aria-disabled` and its reason in `aria-describedby`; the
  error is a `role="alert"` (Save's `aria-describedby` points at it). The plan file chip's path has the full path as its accessible
  name ("Plan saved to {path}"); Copy path and Show changes name their actions.

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
| ≥ 1024 (`lg`) | full layout, kbd hints visible; Phase 8: the changes panel is a pane next to the chat (below: a right sheet) |
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
- Phase 8 screens: at ≥ 1024px the changes panel is a resizable pane (320–720px, the chat panel keeps at least 40%);
  below 1024px it is a right sheet, full width below `sm` (no horizontal page scroll with a diff open: the diff
  scrolls inside its block); the rewind dialog and the allowed commands dialog follow the form-dialog rule. On touch
  screens the toggle, the row buttons, Revert (always visible), "Rewind files to here", the allow-rule checkbox, the
  scope toggles, the rewind dialog's buttons and its force checkbox, the editor's Remove and Add, the toast Undo
  buttons, and the cleanup switch and select are at least 40px (`pointer-coarse:h-10` / `size-10`, checkboxes through
  a larger hit area); the pane's resize handle has a 24px hit area.
- Phase 9 screens: at 390px the dock (strip, queue, composer) fits above the keyboard with the strip collapsed; the plan
  card's buttons stack full width (`flex-col-reverse`, 40px each, "Approve, accept edits" on top) and its plan region
  scrolls inside `max-h-[45dvh]`; a compaction summary scrolls inside `max-h-[50dvh]` and its meta line hides; a task
  block keeps its two lines (the tool-call count and duration hide while it runs); the mention menu spans the composer
  width, caps at `max-h-[40dvh]`, shows the folder under the file name and has 40px rows; no expanded task block,
  summary or plan causes a horizontal page scroll (long paths and code scroll inside their blocks). On touch screens the
  strip toggle, the queue's Edit and Cancel, the Queue message button, the task trigger, the plan buttons, the mention
  rows and the summary toggle are at least 40px.
- Phase 10 screens: at 390px the Customize page has no horizontal scroll (the tab list scrolls sideways inside itself,
  rows wrap their meta line, paths truncate in the middle), the header actions wrap under the title, the editor and the
  viewer are full-width sheets whose footers stay visible above the keyboard, the body editor is at most `50dvh` tall
  and scrolls inside, the tool list popover spans the sheet width; the slash menu with group headings caps at
  `max-h-[40dvh]` and hides the argument hints of its rows; the dock (strip, background agents and queue collapsed or two
  rows, composer) fits; a result note's meta line hides; the Remember dialog follows the form-dialog rule. On touch
  screens the row `⋯` triggers (always visible), the tabs, the project select, the editor's buttons and tool chips'
  remove buttons, the dock toggle, the row toggles, Stop and Stop all, the result toggle, the Remember radios and Save,
  Copy path and Show changes are at least 40px.
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
causes no horizontal page scroll. Phase 8 adds `mobile/changes.spec.ts` (W8.12): the panel opens as a right sheet at
390px, an open diff causes no horizontal page scroll, Esc returns focus to the toggle, and the rewind dialog fits.
Phase 9 adds `mobile/agent.spec.ts` (W9.13): the dock (strip, queue and composer) fits at 390px, no horizontal scroll
with a task block or a summary expanded, the plan buttons stack and are at least 40px, and the mention menu fits;
`mobile/changes.spec.ts` gains a check that the panel's open state survives a narrow viewport. Phase 10 adds
`mobile/customize.spec.ts` (W10.13): no horizontal scroll on `/settings/customize`, the editor sheet fits with its
footer visible, the tabs scroll, the row menus are at least 40px; and `mobile/agent.spec.ts` gains the dock with the
strip, the background agents and the queue fitting at 390px, the Remember dialog and the grouped slash menu.

### 14.7 Tablet e2e and media permissions (Phase 6)

`playwright.config.ts` (K4) adds a `tablet` project: `devices['Galaxy Tab S9 landscape']` (1024×640, Chromium, touch,
so `pointer: coarse` matches and the sidebar is not a sheet). It runs only `e2e/specs/tablet/*.spec.ts`; the `chromium`
project ignores `specs/(mobile|tablet)/`. `tablet/touch-targets.spec.ts` (W6.12) collapses the sidebar and asserts that
the icon rail is 56px wide and every icon button is at least 40×40px. Phase 7 (W7.14) extends it to the project
switcher, the chip and the approval controls; Phase 8 (W8.12) to the changes toggle, the file rows, Revert,
"Rewind files to here", and the allow-rule checkbox and scope; Phase 9 (W9.13) to the queue's Edit and Cancel, the strip
toggle, the task trigger, the plan buttons and the mention rows; Phase 10 (W10.13) to the dock toggle, a row's Stop,
Stop all, the Customize row menus, the Remember radios and the editor's footer buttons.

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
- **Terms** (Phase 9; use these words in UI copy and docs, not their synonyms):
  - **sub-agent** (not "subagent", "child agent" or "worker"; the code says `task` and "child"): a separate agent the
    main agent starts with the `task` tool; the two types read "Explore" and "Agent".
  - **queue** / **queued**: messages sent while the agent works, waiting on the server ("Queued · 2", "Queue a
    message…", "Queue message").
  - **steer** is internal (code, docs, `data-steer`): the UI never says it and describes a delivered message as "You ·
    while it worked" / "You said while the agent worked:".
  - **compact** / **compaction**: replacing older messages with a summary ("Conversation compacted", `/compact`); never
    "condense", "truncate" or "trim" (trimming is the older behavior that leaves messages out: "Older messages were left
    out").
  - **plan** / **plan mode**: the permission mode "Plan"; the agent's list of steps is the **plan**, its progress list
    is **tasks** ("Tasks 3/7", "Updated tasks"; the tool is `todo_write`).
  - **mention**: `@path` in the composer ("Mention a file").
- **Terms** (Phase 10):
  - **background agent** (not "background task", "job" or "worker"): a sub-agent the agent started in the background;
    it keeps running after the reply, and Stop in the composer doesn't stop it ("Background agents · 2 running",
    "Background agent finished"). The UI never calls it a **task**: "Tasks" is the todo list (above). The code and the
    API say `task` / `background task` (`background_tasks`, `bgt_`, `task.changed`); the Markdown export keeps the
    heading "Background task: …" (a document for other readers, ADR-046).
  - **agent** / **custom agent**: a sub-agent type with its own instructions and tools ("New agent", "Personal agent");
    the built-ins stay "Explore" and "Agent" in the transcript.
  - **command**: a saved prompt run with `/name` ("New command"); **skill**: instructions the agent loads when a task
    needs them ("Loaded skill"); never "prompt template", "macro" or "playbook".
  - **personal** (the user's own, stored in harness-forge), **project** (files in `.harness/` or `.claude/`), **from
    plugins**, **built-in**: the four sources; **shadowed**: listed but not used because a higher source has the name
    ("Not used: … wins."); never "overridden" in the UI.
  - **Customize** (the settings page, 9.12); **Remember** (the dialog and `/remember`).

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
| Project of a chat (Phase 7) | "No project" · "Move to project" · "Project settings" · "Moved to {name}" · "Moved out of {name}" · "Undo" · "Wait for the response to finish before moving this chat." · "This project no longer exists." · "Couldn't move the chat" (other failures, with the server message) · "Project: {name}, folder not found" · palette: "Show all chats" · "Show chats without a project" · "Show {name}" · "Add project…" · "Move chat to {name}" · "Move chat out of project" |
| Settings → Projects (Phase 7) | "Projects" · "Folders on the server that chats can read and edit." · "Add project" · "{n} chats" · "1 chat" · "Folder not found" · "Uses AGENTS.md" · "Uses CLAUDE.md" · "Rename" · "Edit instructions…" · "Delete…" · "Delete {name}?" · "Its {n} chats stay and move to No project. The folder and its files are not touched." · "Its 1 chat stays and moves to No project. The folder and its files are not touched." · "It has no chats. The folder and its files are not touched." · "Delete project" · "Project deleted" · "Wait for the responses in this project to finish before deleting it." · "Instructions for {name}" · "Sent with every chat in this project, after AGENTS.md / CLAUDE.md from the folder." · "This folder has {file}; it is added first." · "No projects yet. A project is a folder on the server that chats can read and edit." · "Could not load the projects" |
| Add project (Phase 7) | "Add project" · "Choose a folder on the server that chats can read and edit." · "Folder path" · "Parent folder" · "Not found" · "{path}, not found" · "Project" (badge) · "{name}, already a project" · "No folders here." · "Back to workspace folders" · "Retry" · "Showing the first 500 folders." · "Selected: {path}" · "New folder" · "Folder name" · "Use a name without slashes." · "Folder names can't start with a dot." · "Use at most 255 characters." · "Name" · "Opened {folder}, {n} folders" · "Project added" · "A project for this folder already exists." · "A folder with this name already exists." · "Choose a folder inside the workspace folders." · "This folder no longer exists." · "No workspace folders. Set HF_WORKSPACE_ROOTS on the server." · "Adding a project needs your password." · a 400 shows the server's message ("This folder is inside the harness-forge data directory.", "This folder contains the harness-forge data directory.", "A server can have up to 200 projects.", …) |
| Workspace tools (Phase 7) | "New · {n} lines" · "Updated · {n} lines" · "No changes" · "{n} replacements" · "exit {n}" · "exited" · "timed out" · "killed {signal}" · "lines {a}–{b} of {n}" · "no lines of {n}" · "empty file" · "{n} entries" · "{n} files" · "{n} matches" (singular forms for 1) · "Raw input and output" · "New file" · "Copy path" · "⋯ {n} unchanged lines" · "Show {n} more lines" · "Diff truncated by server" · "The diff is too large to show." · "Empty file." · "No changes." · "Added" · "Removed" · "Changes to {path}" · "stderr" · "Show all {n} lines" · "Showing the last 64 KB" · "Exit code {n}" · "Timed out" · "No output" · "Running…" · "Output truncated by server" · "Output of {command}" · "Showing lines {a}–{b} of {total}" · "Truncated by server" · "Show all" · "Show {n} more" · "More results were cut by the server" · "The folder is empty." · "No files match." · "No matches." · "No results." |
| Workspace approvals (Phase 7) | "Run this command?" · "In {project}" / "In {project}/{cwd}" · "timeout {n}s" · "Runs on the server with the server user's permissions." · "Run" · "Create or overwrite {path} · {n} lines" · "All occurrences" · "Accept all edits in this chat" · "Approval needed: run {command}" |
| Permission mode (Phase 7) | "Accept edits" · "Edit project files without asking; ask before shell commands" · "Accept edits works in project chats." · notice icon `FolderX` for `workspace-unavailable` (the text comes from the server) |
| General (Phase 7) | "Max steps per response" · "How many tool calls and follow-ups one response may chain in chats without a project (1–200)." · "Max steps in project chats" · "Agent runs in project chats can take more steps (1–200)." · "Enter a whole number from 1 to 200." |
| Settings → Data (Phase 7) | "Storage cleanup" · "Remove uploaded and generated files that no chat, share link, plugin or setting uses anymore. Files from the last 24 hours are kept, and deleting a chat or a version keeps its files until the next cleanup." · "Check for unused files" · "{files} files · {size} can be removed" · "and {n} leftover files on disk" · "{n} leftover files on disk can be removed" · "{n} recent files are kept for 24 hours." · "Last cleanup {time}" · "No unused files." · "Remove…" · "Remove unused files?" · "This deletes {files} files ({size}). It can't be undone." · "This deletes {n} leftover files on disk. It can't be undone." · "Remove files" · "Removed {files} files ({size})" · "Removed {n} leftover files from disk" · "Encryption key" · "API keys and other secrets are encrypted on this server with a master key." · "Source" · "Key file in the data directory" · "HF_MASTER_KEY environment variable" · "Version" · "Rotated" · "Never" · "Secrets" · "{n} encrypted" · "{n} can't be read" · "Rotate key…" · "Could not load the encryption key status" · "The key comes from HF_MASTER_KEY. Stop the server and run `pnpm key:rotate` with HF_NEW_MASTER_KEY set to the new key." · "Docker" · "Source checkout" · "Copy the Docker command" · "Copy the source checkout command" · "The master key doesn't match the stored secrets. Saved API keys can't be read. Restore the previous key (HF_MASTER_KEY or data/secret.key), or enter the keys again." · "Rotate the master key?" · "A new key encrypts every saved secret again." · "Other browsers and devices are signed out; you stay signed in." · "Every share link changes ({n} links): copy the new links from Shared links." · "Running replies stop and pending approvals expire ({n} waiting)." · "Older versions of harness-forge can't read the secrets afterwards: back up the data directory first." · "Type ROTATE to confirm" · "Rotate key" · "Rotating the master key needs your password." · "Couldn't rotate the key" · "Master key rotated" · "{n} secrets encrypted again · {m} approvals expired" · "The encryption key was rotated." · danger zone: "Delete every chat, including archived chats, every message version and every share link. API keys, plugins, projects and settings are kept." |
| Busy (Phase 7) | "Another data task is running. Try again when it finishes." (Data page; was "Another import or delete is running. Try again when it finishes.") · "The server is rotating its encryption key. Try again in a moment." (chat requests) |
| Changes panel (Phase 8) | "Changes" · "This chat" · "Git" · "Show changes" · "Show changes, {n} files changed" · "Hide changes" · "Refresh changes" · "Close changes" · "{n} files changed" · "1 file changed" · "On {branch}" · "Detached at {head}" · "No commits yet" · "Added" · "Modified" · "Deleted" · "Untracked" · "Renamed" · "Conflicted" · "Type changed" · "changed outside this chat" · "Revert {path}" · "Couldn't load the changes" · "Retry" · "No file changes in this chat yet." · "No changes since the last commit." · "This project isn't a Git repository." · "Git isn't installed on the server." · "Git refused to read this repository. It may belong to another user (see the projects guide)." · "Git took too long to answer." · "Git couldn't read this repository." · "The project folder wasn't found." · "Showing the first 500 files." · "Showing the first 2,000 files." · "{n} shell commands and {m} other tool calls in this chat may have changed files too. They aren't listed here." · "Binary file. No preview." · "This file is too large to show a diff." · "The earlier version of this file is no longer stored, so it can't be shown or reverted." · "Couldn't load the diff" · "This chat has no project." (`no-project`) · "Resize changes" (the handle) · "Show or hide changes" (the Alt+C entry in the shortcuts dialog) · palette: "Show changes" / "Hide changes" |
| Revert (Phase 8) | "Revert {name}?" · "{path} goes back to how it was before this chat changed it." · "{path} is deleted. This chat created it." · "{path} goes back to the last commit." · "{path} is deleted. Git doesn't track it." · "{path} is deleted. It isn't in the last commit." · "{origPath} comes back and {path} is deleted." · "It also changed outside this chat after the agent's last edit. Those changes are reverted too." · "The current version is saved first, so you can undo this." · "Revert file" · "Reverted {path}" · "Undo" · "Restored {path}" · "{path} changed after the revert, so it was not restored." · "Wait for the responses in this project to finish before reverting files." · "{path} changed since its diff was loaded. Check it again." · "Couldn't revert {path}" (with the server or skip message) · "Couldn't restore {path}" (a failed Undo, with the server message) · a 404: "This chat changed elsewhere and was reloaded." |
| Rewind (Phase 8) | "Rewind files to here" · "Rewind files to here?" · "Files the agent changed after this message go back to how they were before it. The conversation stays as it is." · "Restore" · "Delete" · "Can't restore" · "The earlier version of this file is no longer stored." · "and more files" · "Also restore files changed outside this chat" · "Shell changes aren't tracked." · "These commands ran after this message; their effects on files stay:" · "and {n} more" · "Other tools changed files too: {tools}. Their changes stay." · "Files to restore" (the list's name) · "Cancel" · "Restore files and edit" · "Restore files" · "Nothing to restore. The files already match." · "Close" (empty or failed preview) · "Couldn't check the files" (a failed preview) · "Couldn't restore the files" (a failed restore) · toast (`ChatView`): "Restored {n} files" · "Restored 1 file" · "Skipped {k} files changed outside this chat" · "Skipped {k} files that can't be restored" ("1 file") · "Nothing was restored." · "The files already match." · "Undo" · "Couldn't undo the rewind" · "Wait for the responses in this project to finish before rewinding files." · a 404: "This chat changed elsewhere and was reloaded." |
| Shell rules (Phase 8) | "Always allow commands starting with" · "This project" · "All projects" · "Where the rule applies" (the scope group's name) · "Combined commands run only when every part matches a rule." · "This command has several parts: one rule is added for each." · "Commands with redirections, substitutions or other shell syntax always ask." · "No rule can allow this command, so it always asks." · "Could not save the rule" · "This chat has no project. Choose All projects for the rule." · "Allowed by rule: {prefixes}" · ", allowed by rule {prefixes}" · "Allowed commands…" · "Allowed commands in {name}" · "{n} allowed commands" · "1 allowed command" · "Allowed in every project" · "Shell commands that start with one of these run without asking in this project." / "… in every project." · "Combined commands run only when every part matches; redirections and substitutions always ask." · "A rule for a script runner such as pnpm test or make also lets the agent run any code it writes into the project." · "Add" · "Start of a command to allow" (the input's name; placeholder "pnpm test") · "Remove {prefix}" · "No allowed commands yet." · "Loading allowed commands…" (sr-only) · "Couldn't load the allowed commands" · "Retry" · "This allows every {word} command." · validation (7.23): "Enter the start of a command." · "Use at most 200 characters." · "Use a plain command without \|, ;, &&, redirections or substitutions." · "{word} runs other commands, so it can't be allowed by a rule." · "{word} changes the shell or runs its arguments, so it can't be allowed by a rule." · "A rule for {word} alone would allow any code. Add what follows it, such as a script name." · "cd needs no rule: changing into a project folder is always allowed." · "This doesn't match the command." · "This rule already exists." |
| Shell rows (Phase 8) | "Now in {folder}" · "Now in the project folder" · "In {project}/{cwd}" (the sticky folder) · notes from the server: "The command ended outside the project folder; the next call starts in the project folder." · "The working folder {folder} no longer exists, so the command ran in the project folder." · "The working folder {folder} can no longer be used, so the command ran in the project folder." · spoken summaries: "{a} lines added, {d} removed" · "1 line added" · "{d} lines removed" · "New file, {n} lines" · "Updated, {n} lines" · "Exit code {n}" · "Timed out" · "Killed by {signal}" · "Exited without an exit code" · "Lines {a} to {b} of {n}" · "Lines {a} to {b}" |
| Settings → Data (Phase 8) | "Automatic cleanup" · "Remove unused files on a schedule. They're deleted without asking and can't be restored. Files from the last 24 hours are always kept." · "Every day" · "Every week" · "Last automatic cleanup {time}: removed {n} files ({size})." · "The last automatic cleanup was skipped: plugin data is too large to scan. Run a cleanup by hand." · "The last automatic cleanup failed. It tries again after the next interval." · "Next automatic cleanup {time}." · "Next automatic cleanup soon." (the time has passed) · "Automatic cleanup interval" (the select's name) · "Plugin data is too large to scan completely, so a file only a plugin remembers may be removed." |
| General (Phase 8) | "Use Alt+M, Alt+R and Alt+P for composer menus, Alt+V to dictate and Alt+C for changes." |
| Compaction (Phase 9) | "Compacting conversation…" · "Conversation compacted" · "Conversation compacted automatically" · "Context compacted during this response" · "{n} messages summarized · {before} → {after} tokens" ("1 message summarized"; sizes like 182K, 14.3K, 1.3M) · "Show summary" · "Hide summary" · "Summary" (card header and region name) · "Copy summary" · "Focus: {focus}" · "The model sees this summary instead of the messages above." · "There is nothing to compact yet." (the `/compact` reply) · notice `compaction-failed` (text from the server, e.g. "Couldn't compact the conversation. Older messages were left out instead.") · context ring: "Older messages are summarized automatically near the limit. Type /compact to do it now." · "Automatic compaction is off. Older messages are left out near the limit." |
| Plan mode (Phase 9) | "Plan" · "Explore and plan; change nothing until you approve the plan" · "Plan mode works in project chats." · "Use ask, edits, plan, auto or off." · "Permission mode: {label}" (announcement) · "Plan ready for review" · "Plan" (the region's name) · "Feedback for the agent (optional)" · "Use at most 2,000 characters." · "Keep planning" · "Approve, ask before edits" · "Approve, accept edits" · "Kept planning" · "Approved · Accept edits" · "Approved · Ask" · "Your feedback: {text}" · "Plan approved. Permission mode: Accept edits." · "Plan approved. Permission mode: Ask." · "Feedback sent. The agent keeps planning." |
| Tasks (Phase 9) | "Tasks {done}/{total}" (open strip) · "{done}/{total} · {activeForm}" ("{done}/{total}" without an item in progress) · "All tasks done" · "Show tasks, {done} of {total} done" · "Hide tasks" · "To do:" · "In progress:" · "Done:" (sr-only prefixes) · share: "Updated tasks" |
| Sub-agents (Phase 9) | "Explore" · "Agent" · "{n} tool calls · {duration}" ("1 tool call") · "Waiting" · "Stopped" · "Step limit reached" · "Needs approval" · "Denied" · "Skipped" · "Sub-agents can't ask for approval, so this was skipped." · "Prompt" · "Steps" · "Report" · "Copy report" · "Show all {n} steps" · "{k} earlier steps were not kept" ("1 earlier step was not kept") · "{model} · {tokens} tokens · {cost} · {duration}" (tokens like "18K") · "The sub-agent failed: {error}" ("unknown error" without one) · "Explore sub-agent: {description}, {status}, {n} tool calls" · "Sub-agent: {description}, …" · share: "Sub-agent" |
| Mentions (Phase 9) | "Mention a file" · "Files in {project}" ("Files" without a project name) · "Searching files…" · "No matching files" · "{n} files" / "1 file" (announcement) · "Couldn't search files." · "The project folder is unavailable." · "Showing the first 50 matches. Type more to narrow it down." · "{path} can't be attached" · "Files can be up to 5 MB." · "The file no longer exists." · "Attach images, PDFs or text files." |
| Queue (Phase 9) | "Queue a message…" (placeholder) · "Queue message" · "Message queued" (announcement) · "Queued · {n} · sent at the next step" · "Sent after you answer the approval" · "Runs after this response" · "Edit queued message" · "Cancel queued message" · "Show {n} more" · "Already sent to the agent." · "The queue is full. Wait for the agent to take a message." · "Couldn't send a queued message." · "Queued messages moved back to the composer." (after Stop and after Edit) · "Could not send the message" · "Could not cancel the message" (error toast titles) · "{n} files attached" / "1 file attached" (sr-only) · "Queued messages" (the list's name) · steer note: "You · while it worked" · "You said while the agent worked:" (sr-only) |
| General → Agent (Phase 9) | "Shift+Tab switches the permission mode" · "In the composer, Shift+Tab cycles Ask, Accept edits and Plan. Off: Shift+Tab moves focus." · "Agent" · "Long chats and sub-agents." · "Automatic compaction" · "Summarize older messages when a chat nears the model's context window. When off, older messages are left out instead." · "Compaction model" · "Writes the summary when a chat is compacted." · "Same model as the chat" · "Sub-agent model" · "Runs the tasks the agent hands to sub-agents." · "{model} can't call tools, so sub-agents can't use it." · "Sub-agent max steps" · "How many tool calls one sub-agent may chain (1–200)." · "Switch the permission mode" (the Shift+Tab entry in the shortcuts dialog) |
| Plugins tools table (Phase 9) | "Decided per call" (a tool whose policy is decided per call, e.g. `shell`) |
| Settings → Customize (Phase 10) | "Customize" · "Sub-agents, slash commands and skills: yours, your projects' and your plugins'." · "Import…" · "New agent" · "New command" · "New skill" · "Agents" · "Commands" · "Skills" · "Project" · "No project" · "Personal · {n}" · "In {project} · {n}" · "From plugins · {n}" · "Built-in · {n}" · "Personal" · "Project" · "Built-in" · "All tools" · "{n} tools" · "Tools limited to {n}" · "Same as the chat" · "Shadowed" · "Not used: {winner} wins." · "Invalid" · "{n} warnings" ("1 warning") · "Off" · "Actions for {name}" · "Edit…" · "View…" · "Duplicate" · "Copy to personal" · "Export .md" · "Turn off" · "Turn on" · "Open plugin" · "Delete…" · "Reserved: a personal or project command can't use this name." · "Could not load your customizations" · "Loading your customizations…" (sr-only) · "Retry" · "Folder not found" (project select) · "The project folder is unavailable: {issue}" ("The project folder is unavailable." without one) · "Problems in {name}" (the diagnostics list's name) · "{path}: {message}" (folder notices) · empty states: "No personal agents yet. An agent is a sub-agent with its own instructions and tools that the main agent can start." · "No personal commands yet. A command is a saved prompt you run with /name." · "No personal skills yet. A skill is a set of instructions the agent loads when a task needs it." · "No agents in {project}. Add Markdown files to .harness/agents/ (or .claude/agents/) in the project folder." · "No commands in {project}. Add Markdown files to .harness/commands/ (or .claude/commands/) in the project folder." · "No skills in {project}. Add a folder with a SKILL.md to .harness/skills/ (or .claude/skills/) in the project folder." |
| Customize editor (Phase 10) | "New agent" · "Edit {name}" · "Import agent" (and the command / skill forms) · "Name" · "Description" · "When the main agent should use it. It reads this to decide." · "Shown in the slash menu." · "When the agent should load it. It reads this to decide." · "Tools" · "Allowed tools" · "All tools the chat allows" · "No restriction" · "Only these tools" · "Choose tools…" · "1 tool chosen" · "{n} tools chosen" · "Search tools…" · "No tools found." · "No tools are available." · "Remove {tool}" · "Not available now" · "{tool}, not available now" (sr-only) · "Model" · "Default sub-agent model" · "The chat's model" · "Same as the chat" · "Argument hint" · "Shown after the command while you type its arguments." · "Instructions" · "Prompt" · "What the sub-agent should do and how. It gets these instead of the main agent's conversation." · "$ARGUMENTS is the text after the command; $1 to $9 are single words (quotes group words); {{input}} works too. Without a placeholder the text is added at the end." · "A personal skill is one file. Put scripts and reference files in a project skill folder." · "{n} KB / 64 KB" · "Add a name." · "Use lowercase letters, digits and hyphens, starting with a letter." · "{name} is a built-in name." · "Add a description." · "Add the prompt." · "Use at most {n} characters." · "The file can be up to 64 KB." · "You already have a {kind} named {name}." ("You already have an agent named {name}.") · "The definition has errors." · "Save agent" · "Save command" · "Save skill" · "Agent saved" · "Command saved" · "Skill saved" · "Cancel" · "Discard changes?" · "Your changes are lost." · "Discard" · "Keep editing" · import: "Imported from {file}. Check the fields, then save." · "{file} is too large" · "Definition files can be up to 64 KB." · viewer: "Copy path" · "This file no longer exists." · "Close" · delete: "Delete {name}?" · "Chats that used it keep their messages. The agent can't start it anymore." · "You can't run /{name} anymore." · "The agent can't load it anymore." · "Delete agent" · "Delete command" · "Delete skill" · "Deleted {name}" · "Undo" |
| Slash menu and commands (Phase 10) | groups "App" · "Project" · "Personal" · "Plugins" · "Save a note to your instructions" (`/remember`) · "Arguments: {hint}" (sr-only) · badge tooltip: "Project command" · "Personal command" · "From {plugin}" · "Built-in command" · "Runs on {model}" · "Tools limited to {names}" · "and {n} more" · notice `command-model-unavailable` (text from the server, e.g. "The command's model {model} is not available, so the chat's model answered.") |
| Custom agents and skills in the chat (Phase 10) | "Built-in agent" · "Personal agent" · "From {plugin}" ("From a plugin" when unknown) · "Project: {path}" ("Project agent" without a path) · "Sub-agent {name}: {description}, {status}, {n} tool calls" · "Loaded skill" · "Loading skill" · "Couldn't load skill" · "Loaded skill {name}, {source}" · skill sources "Project" · "Personal" · "{plugin}" ("Plugin" when unknown) · "Built-in" · skill body headings "Folder" · "Files" · "Instructions" · "The agent read these instructions." · "Cut at 64 KB." · command badge: "Command" (sr-only) · "· {model}" · notice icon `Cpu` |
| Background agents (Phase 10) | "In background" · "Background · {n} tool calls · {duration}" · ", running in the background" · "Started in the background" · "Show in background agents" · "Go to the result" · "Background agents · {n} running" ("Background agents" when none runs) · "{n} background agents · {description} · {duration}" ("1 background agent · …") · "{n} background agents finished · reports pending" ("1 background agent finished · report pending") · "Show background agents, {n} running" · "Show background agents, {n} finished" · "Hide background agents" · "Stop all" · "Stop {description}" · "Show details of {description}" · "Hide details of {description}" · "Running" (sr-only) · ended rows "Finished" · "Failed" · "Stopped" · "Step limit reached" · "Report pending" · "They keep running after the reply. Stop in the composer doesn't stop them." · "It already finished." · "Could not stop the background agent" · server texts (they may say "task"): "The server restarted before the task finished." · "The background task was stopped." · "The background agent reached its time limit (30 minutes)." · "At most 3 background agents run per chat. Wait for one to finish." · "At most 10 background agents run on this server. Wait for one to finish." · announcements: "Background agent finished: {description}" · "Background agent failed: {description}" · "Background agent stopped: {description}" · "Background agent reached its step limit: {description}" · notes: "Background agent finished" · "Background agent failed" · "Background agent stopped" · "Background agent reached its step limit" · "Background agent result: {description}" · "No report." · "Show report" · "Hide report" · "Report" · "Copy report" · "Sent to the agent" · share: "· in the background" |
| Remember (Phase 10) | "Remember" · "Save a note to your instructions." (sr-only description) · "Note" · "{n} / 2,000" · "Use at most 2,000 characters." · "Save to" · "{file} in {project}" · "AGENTS.md in {project} (new file)" · "AGENTS.md in a project (new file)" · "Instructions of a project" (without a known project) · "Added as a line at the end of the file." · "Instructions of {project}" · "Kept by harness-forge and sent with this project's chats." · "Custom instructions" · "Sent with every chat." · "Open a chat in a project to use this." · "Save" · "Cancel" · "Saved to {file}" · "Created AGENTS.md in {project}" · "Saved to the instructions of {project}" · "Saved to your custom instructions" · "The instructions would be longer than 20,000 characters. Shorten them in Settings first." · "The file would be larger than 1 MB." · "The project folder is unavailable." |
| Plan files and General → Agent (Phase 10) | "Long chats, sub-agents and plans." · "Save approved plans" · "When you approve a plan in a project chat, it's saved as a Markdown file in the project." · "Plan folder" · "A folder inside the project. Files are named by date and plan title." · "Use a folder inside the project, like .harness/plans." · "Use at most 200 characters." · chip: "Saved to" · "Plan saved to {path}" · "Copy path" · "Show changes" · "Couldn't save the plan file: {error}" |
| Plugins and projects (Phase 10) | "Agents and skills" (filter) · "{n} agents" ("1 agent") · "{n} skills" ("1 skill") · "Agents" · "Sub-agents the main agent can start." · "Skills" · "Instructions the agent loads when a task needs them." · "Default model" · "Same as the chat" · "All tools" · "No tools" · "{n} tools" · "Shadowed" · "Not used: {winner} wins." · "Open in Customize" · "Agents, commands and skills…" (project row menu); the plugin detail's empty state keeps "This plugin does not add providers, tools, MCP servers or commands." |
| Settings → Data (Phase 10) | "Download a zip with every chat, including archived chats and every message version, and your personal agents, commands and skills. API keys, passwords, plugins, MCP servers and share links are never included." · "General and appearance settings, and your personal agents, commands and skills. A personal definition you already have with the same name is kept." · result panel: "{n} agents, commands and skills restored" ("1 agent, command or skill restored") · "{k} kept" · "{f} failed" |
