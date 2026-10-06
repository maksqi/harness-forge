# Import from Claude Code

harness-forge v1.8 (ADR-055) copies the setup you already have in Claude Code — your agents, commands, skills, output
styles, hooks, allowed shell commands, `CLAUDE.md` and MCP servers — into harness-forge in one step. The import is a
**one-time copy**: harness-forge never keeps reading your Claude Code folder, and importing again later shows what
changed.

Open it from **Settings → Customize → Import from Claude Code…** (or **Settings → Data → Import from Claude Code…**). A
wizard in three steps reads a `.claude` folder, shows a preview of everything it found, and imports what you keep
checked.

Reference: [ARCHITECTURE.md 6.35](../ARCHITECTURE.md) (how the import works) and 10.13 (security),
[UI.md 9.14](../UI.md) (the screens), [API.md](../API.md) (the `claudeImport` routes). Related guides:
[customizing the agent](customizing-agents.md), [hooks and project MCP servers](hooks-and-project-mcp.md),
[Claude Code plugins](claude-code-plugins.md).

## 1. What is imported

| In your Claude Code folder | Becomes in harness-forge |
|---|---|
| `agents/*.md` | personal agents (Settings → Customize → Agents) |
| `commands/**/*.md` (up to three subfolders) | personal commands (`commands/git/push.md` becomes `/git-push`); a command with `` !`cmd` `` lines arrives **turned off** (section 6) |
| `skills/<name>/SKILL.md` | personal skills (the `SKILL.md` only: a personal skill is one file) |
| `output-styles/*.md` | personal output styles |
| `settings.json` → `hooks` | personal hooks; command hooks arrive **turned off**, prompt hooks arrive on |
| `settings.json` → `permissions.allow` `Bash(npm run test:*)`, `Bash(npm run test *)`, `Bash(git status)` | global shell rules (`npm run test`, `git status`); an exact rule such as `Bash(git status)` becomes a prefix rule and says so ("also allows longer commands") |
| `settings.json` → whole-tool `permissions.deny` (`WebFetch`, `Write`) | tool preferences set to **Deny** (`web_fetch`, `write_file`) |
| `settings.json` → `outputStyle` | your default output style (Settings → General) |
| `CLAUDE.md` | your custom instructions (Settings → General): **Append** (default), **Replace** or **Skip** |
| `~/.claude.json` → `mcpServers` | global MCP servers (Plugins → Core MCP); a stdio server arrives **turned off** |
| `~/.claude.json` → `projects["/path"].mcpServers` | global MCP servers, **turned off**, with a note naming the project they came from |

Agents, commands and skills keep their Markdown exactly (keys harness-forge does not use stay in the file); a command
without a `name:` gets one from its file name. Claude model names such as `model: sonnet` work once you pick a model
for them in **Settings → General → Agent → Claude model names**.

## 2. What is never read

The wizard reads **only** the paths of section 1 — an allowlist, not a list of exclusions. It never opens
`.credentials.json`, `projects/` (your Claude Code conversations), `history.jsonl`, `todos/`, `shell-snapshots/`,
`statsig/`, `plugins/` or `settings.local.json`. From `~/.claude.json` only the two `mcpServers` maps are kept; your
account, keys and history in that file are dropped before anything else reads it.

These are **listed but never applied** (the preview's **Unsupported** group says why): other permission rules (`Read(…)`,
`ask` rules, `defaultMode`, `additionalDirectories`), `apiKeyHelper`, `statusLine`, `env` values (their names are
listed; they are used only to fill the variables of imported MCP servers), `model`, `enabledPlugins` and
`extraKnownMarketplaces` (install plugins from **Plugins → Marketplaces**: [Claude Code plugins](claude-code-plugins.md)).

## 3. Choose where to read from

**Step 1 of 3** offers three sources:

- **Choose your .claude folder…** (the default): pick the folder in your browser's folder dialog (on macOS press
  ⌘⇧. to show hidden folders). The browser sends only the files of section 1, nothing else. Add **+ .claude.json (MCP
  servers)** to import your MCP servers: `~/.claude.json` sits next to the folder, not inside it. This works whatever
  machine runs harness-forge.
- **Upload a zip…**: a zip of your `.claude` folder (up to 32 MB). The server opens it and reads only the files of
  section 1. Useful when your browser cannot pick folders.
- **Scan … on this server**: reads the Claude Code folder of the server's own user, at `HF_CLAUDE_HOME` (by default
  `~/.claude` of the user that runs harness-forge). It asks for your password (when one is set and your last login is
  more than 10 minutes old), because it reads files on the server. It is disabled with a reason when the server turned
  it off (`HF_CLAUDE_HOME=0`), the folder does not exist, or the server cannot read it. The scan follows symbolic links
  (dotfile managers link these files) to regular files, never into the harness-forge data folder; the preview marks
  such items "linked".

All three give the same preview for the same files.

## 4. The preview

**Step 2 of 3** lists what was found by group (Agents, Commands, Skills, Output styles, Hooks, MCP servers, Allowed
shell commands, Denied tools, Instructions, Settings, Unsupported). Each item shows its file and a status:

| Status | Meaning | Default |
|---|---|---|
| **New** | harness-forge has nothing with this name | imported |
| **Replaces yours** | you already have a personal definition with this name and different content | **Keep mine** (skip); choose **Replace** or **Import as {name}-2** |
| **Unchanged** | the same content is already here | nothing to do (no checkbox) |
| **Conflict** | the name is built in or reserved (an agent named `explore`), or an MCP server with this id differs | **Import as …** (rename); for MCP servers also **Replace** or **Keep mine** |
| **Unsupported** | a setting harness-forge does not use | never imported; the reason is shown |
| **Invalid** | the file cannot be read (broken header, too large) | never imported; the problem is shown |

- **Select all** per group selects or clears the group; a partly selected group shows a dash.
- Items that run commands on the server show "Imported turned off: it runs shell lines." (MCP servers: "it starts a
  program.") and a switch **Turn on after import**. The footer says "Includes {n} items that run commands on this
  server." when you selected any.
- An MCP server whose `${VARIABLES}` are not set in your `settings.json` `env` shows "Needs …" with a field per
  variable. Values come from your `settings.json` `env` or what you type here — **never** from the server's environment.
- **Instructions** (`CLAUDE.md`): **Append** adds it after your current custom instructions (a blank line between),
  **Replace** replaces them, **Skip** leaves them. When your instructions already contain it, it is Unchanged. Lines
  such as `@docs/rules.md` stay as text (harness-forge does not follow them).

The preview keeps your files on the server for 10 minutes; after that, **Import** answers "This preview expired. Start
again."

## 5. Import

Press **Import {n} items** (Space or a click; Enter never imports). harness-forge asks for your password when one is set
and your last login is more than 10 minutes old ("Importing hooks and commands that run on this server needs your
password." when you selected something that runs commands). **Step 3 of 3** shows what happened: "Imported {n} items ·
{s} skipped · {f} failed", how many commands were turned off, and the failed items with their reasons; **Open
Customize** and **MCP servers** take you to the results.

Imported hooks, commands, styles and shell rules work at once in every chat (hooks and commands that run shell lines
only after you turn them on, below). Personal definitions and personal hooks are yours from now on: edit them in
Settings → Customize; they are not linked to the Claude Code files any more.

## 6. Turned-off items

Command hooks, commands with `` !`cmd` `` lines and stdio MCP servers run programs on the server **without asking**
each time. So, unless you switched **Turn on after import** on for them in the preview, they arrive turned off:

- a hook: Settings → Customize → **Hooks** → the row's menu → **Turn on** (asks for your password);
- a command: Settings → Customize → **Commands** → **Turn on**;
- an MCP server: Plugins → **Core MCP** → the server's switch.

Read them first: a hook from your laptop may call scripts that do not exist on the server (`~/.claude/hooks/guard.sh`
is a path on your laptop), or tools the server does not have (`jq`, `python3`).

## 7. Importing again

Run the wizard again whenever your Claude Code setup changed: items you already imported and did not change read
**Unchanged**; changed definitions read **Replaces yours** (kept unless you choose **Replace**); new ones read **New**.
Hooks are compared by their whole handler (a changed hook is a new one: delete the old row yourself), MCP servers by
id and command / URL, shell rules by prefix. Replacing a definition keeps its on / off state.

## 8. Docker

The Docker image sets `HF_CLAUDE_HOME=0`: the server scan is off (the container's own home folder has no Claude Code
setup) and only the browser sources work. To scan a folder anyway, mount it read-only and point the variable at it:

```sh
docker run -d --name harness-forge -p 8787:8787 -v harness-forge-data:/data \
  -v ~/.claude:/claude:ro -e HF_CLAUDE_HOME=/claude \
  -e HF_PASSWORD='a long passphrase' harness-forge
```

The files must be readable by the container user (uid 1000). The scan reads `.claude.json` inside that folder or next
to a folder named `.claude`; for the MCP servers of your `~/.claude.json`, add the file in the browser instead, or
mount both as `/home/node/.claude` and `/home/node/.claude.json` and set `HF_CLAUDE_HOME=/home/node/.claude`.

`HF_CLAUDE_HOME` accepts an absolute path, `0` (off) or nothing (`~/.claude` of the server user); anything else stops
the server at start with a message.

## 9. Security notes

- Only the files of section 1 are read; your credentials, conversations and history never are.
- Secrets stay on the server: the preview sent to your browser holds names and short summaries, never a file's
  content, an environment value or a header value; the server log records counts only.
- Nothing that runs commands is turned on unless you asked for it in the preview, and the import itself needs your
  password.
- Imported shell rules only allow command prefixes harness-forge accepts as rules (never `bash`, `python`, `npx` or
  `cd`); Claude Code's `deny` rules for whole tools become **Deny** preferences, which only restrict.

## 10. Troubleshooting

- **"Nothing to import in this folder."**: you picked the wrong folder (pick `.claude` itself, not your home folder),
  or the browser hid dot-files.
- **The scan is disabled**: the reason under it says why (`HF_CLAUDE_HOME=0`, no folder, not readable).
- **An agent says "The model alias sonnet is not supported"**: pick a model for `sonnet` in Settings → General → Agent →
  Claude model names.
- **An MCP server failed with "needs-variables"**: type the missing values in the preview, or add them to the
  server's environment fields in Plugins → Core MCP afterwards.
- **A hook does nothing**: it was imported turned off (section 6), or the script it runs is not on the server.
