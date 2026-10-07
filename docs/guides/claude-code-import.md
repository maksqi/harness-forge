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
| `settings.json` → `hooks` | personal hooks; command hooks arrive **turned off**, prompt hooks arrive on; other handler types (`http`, `mcp_tool`, `agent`), prompt hooks on an event that takes none and events harness-forge does not have are listed as Unsupported |
| `settings.json` → `permissions.allow` `Bash(npm run test:*)`, `Bash(npm run test *)`, `Bash(git status)` | global shell rules (`npm run test`, `git status`); an exact rule such as `Bash(git status)` becomes a prefix rule and says so ("Becomes a prefix rule: longer commands that start the same way are allowed too.") |
| `settings.json` → whole-tool `permissions.deny` (`WebFetch`, `Write`) | tool preferences set to **Deny** (`web_fetch`, `write_file`) |
| `settings.json` → `outputStyle` | your default output style (Settings → General) |
| `CLAUDE.md` | your custom instructions (Settings → General): **Append** (default), **Replace** or **Skip** |
| `~/.claude.json` → `mcpServers` | global MCP servers (Plugins → MCP servers); a stdio server arrives **turned off**, an `http` / `sse` server on |
| `~/.claude.json` → `projects["/path"].mcpServers` | global MCP servers, always **turned off**, with a note naming the project they came from |

Agents, commands and skills keep their Markdown exactly (keys harness-forge does not use stay in the file); a file
without a `name:` gets one from its path (the file name; for skills the folder; for commands every folder below
`commands/` joined with `-`), written into its frontmatter. Claude model names such as `model: sonnet` work once you
pick a model for them in **Settings → General → Agent → Claude model names** (a full `claude-…` id also runs on the
Anthropic provider when it is configured and knows the model).

## 2. What is never read

The wizard reads **only** the paths of section 1 — an allowlist, not a list of exclusions. It never opens
`.credentials.json`, `projects/` (your Claude Code conversations), `history.jsonl`, `todos/`, `shell-snapshots/`,
`statsig/`, `plugins/` or `settings.local.json`. From `~/.claude.json` only the two `mcpServers` maps are kept; your
account, keys and history in that file are dropped before anything else reads it.

These are **listed but never applied** (the preview's **Unsupported** group says why): other permission rules (`Read(…)`,
`ask` rules, `defaultMode`, `additionalDirectories`), the settings that run a command (`apiKeyHelper`, `statusLine`,
`awsAuthRefresh`, `awsCredentialExport`, `otelHeadersHelper`), `env` values (their names are listed; they are used only
to fill the variables of imported MCP servers), `model`, `enabledPlugins` and `extraKnownMarketplaces` (install
plugins from **Plugins → Marketplaces**: [Claude Code plugins](claude-code-plugins.md)). Other `settings.json` keys are
ignored.

## 3. Choose where to read from

**Step 1 of 3 · Choose what to read** asks "Where is your .claude folder?" and offers three sources:

- **Choose your .claude folder…** (the default): press **Choose folder…** and pick the folder in your browser's folder
  dialog (on macOS press ⌘⇧. to show hidden folders). The browser sends only the files of section 1, nothing else, and
  says "{n} files picked" or "Nothing to import in this folder." (files over their size limit are listed as "Too large,
  not sent: …"). Press **.claude.json (MCP servers)** to add your MCP servers: `~/.claude.json` sits next to the
  folder, not inside it (a `.claude.json` inside the picked folder is not sent). This works whatever machine runs
  harness-forge.
- **Upload a zip…**: press **Choose zip…** and pick a zip of your `.claude` folder (up to 32 MiB). The browser sends it
  as it is; the server opens it and reads only the files of section 1. One folder that holds everything (a zipped
  `.claude/`) is stripped, and a `.claude.json` at the top of the zip, next to that folder, counts as your
  `~/.claude.json`. Useful when your browser cannot pick folders.
- **Scan {path} on this server**: reads the Claude Code folder of the server's own user, at `HF_CLAUDE_HOME` (by
  default `~/.claude` of the user that runs harness-forge; the line under it reads "Reads the folder on this server. It
  needs your password."). It asks for your password ("Scanning this server's Claude Code folder needs your password.")
  when one is set and your last login is more than 10 minutes old, because it reads files on the server. It is
  disabled with a reason when the server turned it off ("Scanning is turned off on this server (HF_CLAUDE_HOME=0)."),
  the folder does not exist ("There is no .claude folder at {path}.") or the server cannot read it ("harness-forge
  can't read {path}."). The scan follows symbolic links (dotfile managers link these files) to regular files, never
  into the harness-forge data folder; the preview marks such items "linked". A scan stops after 10 seconds and keeps
  what it read so far; the preview then says "The scan stopped after 10 seconds; the files it had not read yet are not
  part of the plan."

All three give the same preview for the same files. Press **Continue** to read them.

The limits: one agent, command, skill or output style file 64 KiB, `settings.json` 256 KiB, `CLAUDE.md` 1 MiB,
`.claude.json` 16 MiB (".claude.json is larger than 16 MiB."), everything together 32 MiB ("The upload is larger than
32 MiB."); at most 200 definitions of each kind and 1000 items; an upload holds at most 10 000 files, a zip at most
20 000 entries. The preview counts the files the server did not use: "{n} files were not used (too large, not readable
or not on the list)."

## 4. The preview

**Step 2 of 3 · Choose what to import** says "Found {n} items" and lists them by group (Agents, Commands, Skills,
Output styles, Hooks, MCP servers, Allowed shell commands, Denied tools, Instructions, Settings, Unsupported). Each item
shows its file and a status:

| Status | Meaning | Default |
|---|---|---|
| **New** | harness-forge has nothing with this name | imported |
| **Replaces yours** | you already have a personal definition with this name and different content | **Keep mine** (not imported); choose **Replace** or **Import as {name}-2** |
| **Unchanged** | the same content is already here (for hooks: the same handler; for shell rules: the same prefix) | nothing to do (no checkbox) |
| **Conflict** | the name is built in or reserved (an agent named `explore`), another file of this import already uses it, or an MCP server with this id exists with another command or URL | **Keep mine** (not imported); choose **Import as {name}** (for MCP servers also **Replace**) |
| **Unsupported** | a setting harness-forge does not use | never imported; the reason is shown |
| **Invalid** | the file cannot be read (broken header, too long) | never imported; the problem is shown |

- Checking an item that reads Replaces yours or Conflict picks the first choice its select offers after Keep mine
  (**Replace**, else **Import as {name}**); change it in the item's select.
- **Select all {n}** per group selects or clears the group's items (with the same choices); a partly selected group
  shows a dash.
- Items that run commands on the server show "Imported turned off: it runs shell lines." (stdio MCP servers:
  "Imported turned off: it starts a program.") and a switch **Turn on after import** (usable once the item is
  checked). A server from a project of `.claude.json` shows "From the project {path}: imported turned off." and has no
  switch. The footer says "Includes {n} items that run commands on this server." when you selected any.
- An MCP server whose `${VARIABLES}` are not set in your `settings.json` `env` (and have no `${VAR:-default}`) shows
  "Needs {names}" with a password field per variable. Values come from your `settings.json` `env` or what you type here
  — **never** from the server's environment — and are sent only with the import.
- **Instructions** (`CLAUDE.md`): the item's select **Add to your instructions** offers **Append** (the default: after
  your current custom instructions, a blank line between), **Replace** (replaces them) and **Skip** (leaves them). When
  appending would pass the 20 000 characters the instructions hold, only Replace and Skip are offered (Skip is the
  default). When your instructions already contain it, it is Unchanged. Lines such as `@docs/rules.md` stay as text
  ("Its @path lines are kept as text."; harness-forge does not follow them).

**Back** returns to step 1 with what you picked. Escape, × or a click outside ask "Discard this import?" ("Nothing is
imported. The preview is dropped.", **Discard** / **Keep reviewing**). The preview keeps your files on the server for
10 minutes; after that, **Import** answers "This preview expired. Start again." with a **Start again** button.

## 5. Import

Press **Import {n} items** (it is never the default button, so Enter in a field of the preview does not press it).
harness-forge asks for your password when one is set and your last login is more than 10 minutes old ("Importing hooks
and commands that run on this server needs your password." when you selected something that runs commands, else
"Importing from Claude Code needs your password."). Nothing closes the wizard while the import runs. **Step 3 of 3 ·
Import finished** shows what happened: "Imported {n} items · {s} skipped · {f} failed" (no skipped or failed part when
it is zero), "{t} commands turned off (they run shell lines)" and "{m} MCP servers turned off" when there are any, then
the failed items with their reasons. **Open Customize** opens the tab of the first imported kind, **MCP servers** (when
servers were imported) opens Plugins → MCP servers, **Close** closes the wizard.

Imported hooks, commands, styles and shell rules work at once in every chat (hooks and commands that run shell lines
only after you turn them on, below). Personal definitions and personal hooks are yours from now on: edit them in
Settings → Customize; they are not linked to the Claude Code files any more.

## 6. Turned-off items

Command hooks, commands with `` !`cmd` `` lines and stdio MCP servers run programs on the server **without asking**
each time. So, unless you switched **Turn on after import** on for them in the preview, they arrive turned off (the
MCP servers of a project in `.claude.json` always do):

- a hook: Settings → Customize → **Hooks** → the row's menu → **Turn on** (asks for your password);
- a command: Settings → Customize → **Commands** → **Turn on**;
- an MCP server: Plugins → **MCP servers** → the server's switch.

Read them first: a hook from your laptop may call scripts that do not exist on the server (`~/.claude/hooks/guard.sh`
is a path on your laptop), or tools the server does not have (`jq`, `python3`).

## 7. Importing again

Run the wizard again whenever your Claude Code setup changed: items you already imported and did not change read
**Unchanged**; changed definitions read **Replaces yours** (kept unless you choose **Replace**); new ones read **New**.
Hooks are compared by their whole handler (a changed hook is a new one: delete the old row yourself), MCP servers by
id and their command and arguments or URL (plus the names, not the values, of their environment variables or headers),
shell rules by prefix (an existing one reads Unchanged). Replacing a definition keeps its on / off state (a command
that gains `` !`cmd` `` lines is turned off unless you turned it on in the preview); replacing an `http` / `sse` server
keeps its on / off state too. An item that changed since the preview was built fails with "The item changed since the
folder was read. Read the folder again."

## 8. Docker

The Docker image sets `HF_CLAUDE_HOME=0`: the server scan is off (the container's own home folder has no Claude Code
setup) and only the browser sources work. To scan your folder anyway, mount it **and** your `~/.claude.json` read-only
into the container user's home and point the variable at the folder:

```sh
docker run -d --name harness-forge -p 8787:8787 -v harness-forge-data:/data \
  -v ~/.claude:/home/node/.claude:ro -v ~/.claude.json:/home/node/.claude.json:ro \
  -e HF_CLAUDE_HOME=/home/node/.claude \
  -e HF_PASSWORD='a long passphrase' harness-forge
```

Both must be readable by the container user (uid 1000). The scan reads `.claude.json` next to a folder named `.claude`
(else inside the folder), so the shorter one-mount form `-v ~/.claude:/claude:ro -e HF_CLAUDE_HOME=/claude` imports
everything **except** the MCP servers of your `~/.claude.json` (add that file in the browser instead, or use the
two-mount form above).

`HF_CLAUDE_HOME` accepts an absolute path, `0` (off) or nothing (`~/.claude` of the server user); anything else (a
relative path, for example) stops the server at start with a message ("Use 0 (the import scan is off) or the absolute
path of a Claude Code folder, e.g. /claude.").

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
- **An imported agent runs on the default sub-agent model, or a command answers "The command's model sonnet is not
  available, so the chat's model answered."**: pick a model for `sonnet` in Settings → General → Agent → Claude model
  names.
- **An MCP server failed with "Set the variables … to import this server (needs-variables)."**: the server was not
  created; read the folder again and type the missing values in the preview.
- **A hook does nothing**: it was imported turned off (section 6), or the script it runs is not on the server. An
  imported prompt hook asks its own `model` when that resolves, else the **Hook model** of Settings → General → Agent,
  else the small model of the chat's provider, else the chat's model (see
  [hooks and project MCP servers](hooks-and-project-mcp.md)).
