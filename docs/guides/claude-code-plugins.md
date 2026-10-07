# Claude Code plugins and marketplaces

harness-forge v1.8 (ADR-053, ADR-054) installs **Claude Code plugins** as they are — the folder you would install in
Claude Code, with its commands, agents, skills, output styles, hooks and MCP servers — and browses **Claude Code
marketplaces** such as Anthropic's official one. A Claude Code plugin keeps its own files and layout; harness-forge
reads them in place, gives its commands the plugin's prefix (`/review-kit:review`) and asks for your trust before
anything in it runs a program.

Reference: [PLUGINS.md 17](../PLUGINS.md#17-claude-code-plugins) (the format: fields, names, variables, `userConfig`),
[ARCHITECTURE.md 6.33 – 6.34](../ARCHITECTURE.md) (how it works) and 10.13 (security), [UI.md 8.13](../UI.md) (the
screens). Moving your personal Claude Code setup (agents, commands, hooks, `CLAUDE.md`) is a different feature:
[Import from Claude Code](claude-code-import.md).

## 1. Install a plugin

Open **Plugins → Install…**. Every tab accepts a Claude Code plugin; harness-forge recognizes one by its
`.claude-plugin/plugin.json` or one of its components (`commands/`, `agents/`, `skills/<name>/SKILL.md`, a `SKILL.md` at
the top, `output-styles/`, `hooks/hooks.json` or `.mcp.json`), at the top of the archive or inside one top folder. A
`plugin.json` at the top means a harness plugin instead.

| Tab | Use it for |
|---|---|
| **GitHub** | a repository: **Repository** `owner/repo` (or `owner/repo#v1.2.0`, or the `https://github.com/…` address), an optional **Branch, tag or commit** and an optional **Folder in the repository** (`plugins/commit-commands` for a plugin inside a larger repository) |
| **Zip** | a zip of the plugin folder (up to 20 MB) |
| **Local folder** | a folder on the server: **Copy** (a snapshot) or **Link** (used in place, reloaded when it changes) |
| **npm**, **URL** | a plugin published as an npm package or a downloadable archive with an integrity hash |

**GitHub without git**: harness-forge asks GitHub which commit the branch or tag points to and downloads the archive of
**that exact commit** over HTTPS; it never runs `git`. The preview shows the commit ("Resolved commit 3f2a9c1"), so
what you install is what you reviewed. Only the folder you named is extracted (up to 50 MB for the repository's zip).

Press **Inspect**: the preview shows the badge **Claude Code plugin**, what it adds ("3 commands · 1 agent · 2 hooks · 1
MCP server"), how its commands are called ("Commands run as /commit-commands:commit."), the settings it asks for
("Asks for: GITHUB_TOKEN (secret)") and what harness-forge ignores (under "Ignored": ".lsp.json (LSP servers are not
supported; they are never started.)"). A plugin that runs programs lists every command under "Runs these commands" and needs your trust (section
3); then **Install** (your password when one is set and your last login is more than 10 minutes old).

## 2. What you get

- **Commands** in the slash menu under **Plugins**, named `/<plugin>:<command>` (a command in a subfolder gets one more
  part: `/review-kit:db:migrate`). You can also type the short form (`/migrate`) while no command has exactly that name
  and no other command ends the same way; so `/review` stays the builtin `/review`, and `/review-kit:review` is the
  plugin's. They expand like command files: `$ARGUMENTS`, `$0` / `$ARGUMENTS[0]`, named arguments, `` !`cmd` `` lines
  (in project chats) and `@file` references.
- **Agents** the main agent can start (`review-kit:code-reviewer`). An agent's `model: sonnet` (or `opus`, `haiku`,
  `fable`) uses the model you chose for that name in **Settings → General → Agent → Claude model names**.
- **Skills** the agent loads when a task needs them; a skill keeps its folder, and the agent can read the folder's
  files (only those) with the `skill` tool.
- **Output styles** in the composer's style menu (`review-kit:terse`).
- **Hooks** (Claude Code's `hooks/hooks.json`, command and prompt hooks) that run in every chat while the plugin is on
  and trusted; Settings → Customize → Hooks lists them under **From plugins** (the hooks of a Claude Code plugin you have
  not trusted yet are listed on its plugin page instead). A hook's arguments show `${user_config.KEY}` as written: the
  option's value is filled in only when the hook process starts.
- **MCP servers** whose tools join every chat (one server is named after the plugin: `review-kit`).
- **Settings**: the plugin's `userConfig` options appear on its **Configuration** tab (a sensitive option is a secret
  field, stored encrypted). Saving reloads the plugin. Values reach its MCP servers and hooks; secret values never go
  into the text the model reads.

A plugin that sets `defaultEnabled: false` installs turned off: turn it on from its card. Claude Code plugins cannot be
edited in harness-forge (no Source tab); edit the original and install it again.

## 3. Trust

A Claude Code plugin needs your **trust** when it can run programs: a command hook, a stdio MCP server or a command
with `` !`cmd` `` lines. A plugin of Markdown only (commands, agents, skills, styles), prompt hooks or remote (HTTP) MCP
servers needs none.

Trusting pins a fingerprint of **every file** of the plugin — scripts included — and of the files' executable bits.
The fingerprint is checked again whenever the plugin loads: at the start of the server, on a reload and when you trust
it. A plugin whose files changed (an update, an edit of its copy in the data directory) is then **Untrusted** and runs
nothing until you review it again and press **Trust**; a script edited on disk in between keeps running until that
next check. A **linked** folder is different: you trust the folder itself (it is pinned by its path), so editing its
files never asks again; link only folders you control. Executable bits from the zip or folder are kept, so a hook can run
`${CLAUDE_PLUGIN_ROOT}/scripts/check.sh` directly; write hook scripts in POSIX `sh` if you share them (the Docker image
has no `python3` or `jq`).

What harness-forge never runs: LSP servers (`.lsp.json`), `bin/` (it is not put on the shell's `PATH`), themes,
monitors, workflows, the plugin's own `settings.json` and `http` / `mcp_tool` / `agent` hooks; they are listed under
"Ignored". An MCP server's `oauth` settings and `headersHelper` are dropped (the server connects without them; a note on
the plugin's Overview), and a server that uses `${CLAUDE_PROJECT_DIR}` is skipped (plugin servers are global).

## 4. Marketplaces

A marketplace is a catalog of Claude Code plugins (a `.claude-plugin/marketplace.json`). Open **Plugins →
Marketplaces**:

- **Anthropic's official plugins**: the card offers `anthropics/claude-plugins-official`; harness-forge sends no request
  until you press **Add marketplace** (× hides the card).
- **Add marketplace…**: a GitHub repository (`owner/repo`, optionally `#branch`), the URL of a hosted
  `marketplace.json`, or a folder on the server. harness-forge fetches it once; it never refreshes by itself.
- Pick a marketplace (or **All**), search, filter by category, and press **Install…** on a plugin: the same preview and
  trust step as section 1. **Installed** plugins show **Open**; plugins harness-forge cannot install say "Unsupported
  source (…)" (a git server other than GitHub, a plugin built by a command).
- **Refresh** (or **Refresh all**) reads the marketplace again; **Remove…** forgets it and **keeps** the plugins you
  installed from it.

The names `claude-plugins-official`, `claude-code-plugins`, `claude-community` and `anthropic-…` are accepted only from
repositories of `anthropics`, so another repository cannot pose as Anthropic's catalog.

## 5. Updates

Nothing updates by itself. After a **Refresh**, a plugin whose marketplace offers another version (or, without
versions, another commit) shows **Update to {version}** in the marketplace, an update badge on its card, a banner on its
page ("Version {version} is available from {marketplace}.") and a count next to **Marketplaces** in the sidebar.
**Update…** shows the preview again: review it, trust it again when it runs programs, and install. A plugin you
installed from GitHub updates by installing the repository again (the same id from the same source replaces it).

## 6. Offline, limits and privacy

- `HF_OFFLINE=1` refuses adding and refreshing GitHub or URL marketplaces and installing from GitHub or from a
  marketplace entry that needs the network ("Adding, refreshing and installing from marketplaces and GitHub need the
  network (HF_OFFLINE=1). npm and URL installs from the install dialog, zip uploads and local folders work offline.");
  folder marketplaces (and their entries that sit in the folder) and zip, folder, npm and URL installs still work.
- GitHub allows 60 requests per hour without a token (v1.8 has no token setting): adding or refreshing a GitHub
  marketplace uses one or two, an install one or two. When the limit is reached, harness-forge says how long to wait
  (when GitHub tells it); an install then downloads the branch's archive directly, without the commit lookup, when it
  can.
- Only public repositories work. Every download goes over HTTPS to GitHub's or the archive's host, never to an address
  on your local network.
- Marketplaces and plugins are not part of backups (Settings → Data); Delete all data keeps them.

## 7. Differences from Claude Code

| Claude Code | harness-forge | Why |
|---|---|---|
| marketplaces and plugins update automatically (official ones) | never automatic; an update is a review | code from the network never runs unseen |
| `git` sources of any host, `--sparse`, `command` sources | GitHub archives, archive URLs, npm, folders; other git hosts are unsupported | no git on the server |
| a plugin's `allowed-tools` pre-approve tools | they only narrow the tools; calls ask as your permission mode says | a plugin cannot approve the shell for you |
| `${VAR}` in MCP servers from your environment | a secret setting you fill on the plugin's Configuration tab | the server's environment holds its own secrets |
| plugin MCP servers with `${CLAUDE_PROJECT_DIR}` | skipped | plugin servers are global, not per project |
| trust per marketplace | trust per plugin, pinned to every file | any change needs a new review |
| `bin/`, LSP servers, themes, monitors, workflows | ignored | not supported in v1.8 |
| `/plugin:command` or `/command` | the same (the short form only while unique) | |

## 8. Troubleshooting

- **"Unsupported source (git)"**: the entry points to a git server other than GitHub (or uses a `command` source):
  download the plugin and install it as a zip or folder.
- **The plugin is Untrusted after an update or an edit**: review and trust it again (its files changed).
- **A hook script fails with "permission denied"**: the archive lost the executable bit (some zip tools drop it); call
  it with `sh "${CLAUDE_PLUGIN_ROOT}/…"` in `hooks.json`.
- **GitHub's request limit was reached** (a 429 answer): wait the time shown, or install from a zip.
- **An MCP server of the plugin is missing or cannot log in**: open the plugin's Overview: a server that uses the
  project folder (`${CLAUDE_PROJECT_DIR}`) is skipped, and a server that needs OAuth or a `headersHelper` connects
  without them (a note says so), so its host may refuse it.
- **My command is not in the slash menu**: type the plugin's prefix (`/review-kit:`); a short name works only when
  nothing has that exact name and no other command ends the same way.
