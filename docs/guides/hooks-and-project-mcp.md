# Hooks and project MCP servers

harness-forge v1.7 (ADR-048 … ADR-050) lets shell commands react to what the agent does, and lets a repository bring
its own MCP servers, the way Claude Code does:

- **Hooks** — shell commands that run at eight points of the agent's work: before and after a tool call, when you send
  a message, when the agent finishes a reply, and more. A hook can block a call, add context for the agent, change a
  tool's input, or make the agent continue. They use Claude Code's `hooks` format, so the hooks of a Claude Code
  `settings.json` work as they are.
- **Project hooks** — the `hooks` of a project's `.harness/settings.json` or `.claude/settings.json` run in that
  project's chats, but only after you **approve** them.
- **Project MCP servers** — the servers of a project's `.mcp.json` join that project's chats (after approval), with
  `${VARIABLES}` whose values you store for the project.

Hooks come from three places that add up: your **personal** hooks (Settings → Customize → **Hooks**), the
**project's** approved hooks, and **plugins** (`contributes.hooks`, plugin API 1.5.0). Output styles, the other v1.7
feature, have their own guide: [output styles](output-styles.md). The `` !`cmd` `` lines of command files are in
[customizing the agent](customizing-agents.md#commands-harnesscommandsnamemd).

Reference: [ARCHITECTURE.md 6.28 – 6.30](../ARCHITECTURE.md#628-hooks-adr-048) (how hooks, project trust and project MCP
servers work) and [10.12](../ARCHITECTURE.md) (security), [UI.md 7.31, 7.33, 9.13](../UI.md) (the screens),
[PLUGINS.md](../PLUGINS.md#declarative-hooks-plugin-api-150) (hooks in plugins), [API.md](../API.md) (the `hooks`,
`projectTrust` and `projectMcp` routes).

## 1. Your first hook

1. Open **Settings → Customize → Hooks** and press **New hook**.
2. Choose the **Event** (for example **PreToolUse**: before a tool runs).
3. For a tool event, fill in **Tools**: the tool names the hook is for, separated by `|` (`Bash|Edit`). Claude Code
   names work (section 5). Leave it empty, or write `*`, for every tool.
4. Write the **Command**. It runs with a shell in the project folder (outside projects, in a private, empty folder)
   and gets the event as JSON on its standard input (section 3).
5. Set the **Timeout** (seconds, 1 – 600, default 60) and press **Save hook**.

Saving a new hook, or changing one, asks for your password when a password is set (a hook runs commands on your
server without asking). Turning a hook off and deleting it do not. The switch **Run hooks** at the top of the tab
turns every command hook off at once, from every source.

**Import…** reads Claude Code settings JSON (a whole `settings.json`, or just its `hooks` object), shows what it found,
and adds the hooks you keep checked: invalid ones are listed unchecked with the reason, and `prompt` hooks are skipped
(harness-forge runs `command` hooks only). Each row's menu offers **Copy as JSON** to take a hook back to Claude Code.

Personal hooks are kept in harness-forge's database (at most 100). They are **never** part of a backup: copy them as
JSON if you move servers.

## 2. The format

A hook configuration is Claude Code's `hooks` object: per event, a list of groups, each with an optional `matcher` and
its command handlers.

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "sh .harness/hooks/guard.sh", "timeout": 10 }]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Write|Edit|MultiEdit",
        "hooks": [{ "type": "command", "command": "sh \"$CLAUDE_PROJECT_DIR/.claude/hooks/format.sh\"" }]
      }
    ]
  }
}
```

| Key | Meaning |
|---|---|
| event (`PreToolUse`, …) | one of the eight events (section 3); an unknown event is ignored, with a note |
| `matcher` | optional; tool names for `PreToolUse` and `PostToolUse` (section 5); leave it out for the other events |
| `type` | `command` (a `prompt` hook is skipped: not supported) |
| `command` | the shell command, at most 4,096 characters |
| `timeout` | optional, in seconds, 1 – 600; default 60 |

Every matching handler of an event runs, all of them **in parallel** (at most 20 per event). A hook that finishes
quietly (exit 0, nothing to report) leaves no trace in the chat; a decision, context, a failure or a message shows as a
small **hook note** in the reply, or inside the tool's row for tool hooks.

## 3. The eight events

| Event | When it runs | What it can do |
|---|---|---|
| `PreToolUse` | before a tool call runs (once per call, also in sub-agents) | **deny** the call, **ask** you (shows the approval card; denied inside a sub-agent), **allow** it without the card (only where section 10 says), or **change its input** |
| `PostToolUse` | after a tool call succeeded (also in sub-agents) | give the agent **feedback** or context, which it reads at its next step; **stop** the agent |
| `UserPromptSubmit` | when you send a message, or queue one while the agent works, before anything is stored | **refuse** the message (it stays in the composer with the reason), or **add context** for the agent |
| `Notification` | when a reply ends waiting for your approval | nothing (observe it: send yourself a notification) |
| `Stop` | when the agent is about to finish a reply | make it **continue** with a reason: harness-forge starts a follow-up turn by itself (at most 5 in a row) |
| `SubagentStop` | when a sub-agent is about to finish | make it **continue** for one more round (at most 2); nothing is stored |
| `PreCompact` | before the conversation is compacted (`/compact` or automatically) | nothing (observe it) |
| `SessionStart` | before a chat's first reply, and before the first reply after a compaction | **add context** for the agent, or **refuse** the message |

`Stop` hooks never run when the reply was stopped, failed, ended waiting for an approval or the agent stopped because
of a hook, nor while a queued message is waiting (it goes first). Sub-agents run only `PreToolUse`, `PostToolUse` and
`SubagentStop` hooks.

### What a hook receives (stdin)

The event as one JSON object, with Claude Code's field names plus a `harness` object:

| Field | Events | Value |
|---|---|---|
| `session_id` | all | the chat id |
| `cwd` | all | the hook's working folder (the project folder, else the private hooks folder) |
| `hook_event_name` | all | the event |
| `permission_mode` | all | `default` (Ask, Off), `plan`, `acceptEdits` (Accept edits), `bypassPermissions` (Auto) |
| `tool_name` | `PreToolUse`, `PostToolUse` | the Claude Code name when the tool has one (`Bash`, `Write`, `Edit`, `Read`, …), else the harness name |
| `tool_input` | `PreToolUse`, `PostToolUse` | the input the model sent |
| `tool_use_id` | `PreToolUse`, `PostToolUse` | the tool call id |
| `tool_response` | `PostToolUse` | the tool's output |
| `prompt` | `UserPromptSubmit` | the text of your message |
| `stop_hook_active` | `Stop`, `SubagentStop` | `true` when this reply is already a hook continuation: check it to avoid loops |
| `trigger`, `custom_instructions` | `PreCompact` | `manual` or `auto`; the focus of `/compact <focus>` (or null) |
| `source` | `SessionStart` | `startup` or `compact` |
| `message`, `notification_type` | `Notification` | the text; `permission_prompt` |
| `harness` | all | `{ version: 1, chatId, projectId, messageId?, modelRef, origin, tool?, source }`: `origin` is how the run started (`request`, `queue`, `task`, `hook`), `tool` the harness tool name, `source` where this hook comes from (`personal`, `project`, `plugin`) |

The payload is at most 256 KiB: a large `tool_response` is cut first, then `tool_input`. There is no
`transcript_path`: harness-forge keeps chats in its database, not in transcript files.

### Exit codes

| Exit | Meaning |
|---|---|
| `0` | success: a JSON object on stdout is read (below); otherwise plain stdout is **context** for `UserPromptSubmit` and `SessionStart` and ignored for the other events |
| `2` | **block**, with stderr as the reason: `PreToolUse` denies the call ("Blocked by hook: …"); `PostToolUse` sends the reason to the agent as feedback (the call already ran); `UserPromptSubmit` refuses your message; `Stop` and `SubagentStop` make the agent continue with the reason; for the other events it changes nothing |
| other, or a timeout | a **non-blocking error**: the note "A PostToolUse hook failed: exit 1" (or "… timed out after 60s") shows the start of stderr, and the agent goes on |

A hook that times out is killed with everything it started (its process group).

### JSON output (stdout, exit 0)

| Field | Events | Effect |
|---|---|---|
| `continue: false` | `PostToolUse`, `UserPromptSubmit`, `SessionStart`, `Stop` | stop: after a `PostToolUse` the agent stops after this step ("A hook stopped the agent: …"); `UserPromptSubmit` and `SessionStart` refuse the message; a `Stop` hook ends the reply without a continuation |
| `stopReason` | with `continue: false` | the reason shown to you |
| `systemMessage` | all | a line shown to you in the hook note (not sent to the agent) |
| `suppressOutput` | all | accepted; harness-forge never shows a hook's raw stdout anyway |
| `decision: "block"`, `reason` | `PostToolUse`, `Stop`, `SubagentStop`, `UserPromptSubmit`; `PreToolUse` (legacy) | as exit 2, with `reason` as the reason; for `PreToolUse` it denies |
| `decision: "approve"` | `PreToolUse` (legacy) | the same as `permissionDecision: "allow"` |
| `hookSpecificOutput.hookEventName` | all | must equal the event, else the object is ignored (with a note) |
| `hookSpecificOutput.permissionDecision` | `PreToolUse` | `allow`, `deny` or `ask` |
| `hookSpecificOutput.permissionDecisionReason` | `PreToolUse` | the reason shown with a `deny` or an `ask` |
| `hookSpecificOutput.updatedInput` | `PreToolUse` | replaces the tool's input (at most 64 KiB; checked against the tool's input schema: an invalid one fails the call) |
| `hookSpecificOutput.additionalContext` | `PostToolUse`, `UserPromptSubmit`, `SessionStart` | context for the agent |

A field an event does not use is ignored (with a note). When several hooks answer the same event: **deny** wins over
**ask**, which wins over **allow**; the first `updatedInput` wins, in the order personal → plugin → project; contexts
and reasons are joined (at most 10,000 characters of context per event); the agent goes on only when every hook lets
it (`continue`).

## 4. Where hooks run

- **Working folder**: the chat's project folder; in a chat without a project, a private empty folder of the server
  (`<data dir>/hooks`).
- **Shell**: the same runner as the agent's `shell` tool (`bash -c`, else `sh -c`), in its own process group. Write
  portable POSIX `sh` and avoid tools the server may not have (such as `jq`) when you share hooks.
- **Environment**: the minimal environment of the shell tool (no `HF_*` variables, no API keys) plus
  `HARNESS_PROJECT_DIR` and `CLAUDE_PROJECT_DIR` (both the working folder); plugin hooks also get `HARNESS_PLUGIN_ROOT`
  and `CLAUDE_PLUGIN_ROOT` (the plugin's folder). No stdin other than the payload.
- **Limits**: 60 s by default (up to 600 s) per hook; at most 16 hook processes on the server at a time (others wait);
  stdout is read up to 64 KiB and stderr up to 16 KiB; Stop (and Esc) in the composer kills the hooks of that reply.

## 5. Matchers and tool names

A matcher is a short pattern, not a regular expression:

- alternatives separated by `|`: `Bash|Edit`;
- `*` (or `.*`) matches any run of characters: `mcp__github__*`, `Notebook*`;
- each alternative must match the **whole** name, **case-sensitively** (`bash` does not match `Bash`);
- allowed characters: letters, digits, `_`, `.`, `-`, space and `*`; a matcher with `^ $ [ ( + ? \ {` is **invalid**:
  it is listed with a note and **never runs** (`^Bash.*$` → write `Bash`);
- empty, missing or `*`: every tool.

A tool is matched under its harness name and its Claude Code names:

| Harness tool | Also matched as |
|---|---|
| `shell` | `Bash` |
| `read_file` | `Read` |
| `write_file` | `Write` |
| `edit_file` | `Edit`, `MultiEdit` |
| `search_files` | `Grep` |
| `find_files` | `Glob` |
| `list_directory` | `LS` |
| `web_fetch` | `WebFetch` |
| `mcp__<server id>__<tool>` | for a project MCP server also `mcp__<name in .mcp.json>__<tool>` (Claude Code's name) |

Other tools (`todo_write`, `task`, `skill`, `exit_plan_mode`, `generate_image`, `current_time`, plugin tools) match only
their own names. The hook editor shows which tools a matcher matches as you type ("Matches shell (Bash), edit_file
(Edit)").

## 6. Project hooks and approval

A project can ship hooks in its settings files, read in this order: `.harness/settings.json`,
`.harness/settings.local.json`, `.claude/settings.json`, `.claude/settings.local.json`. Their hooks add up (an
identical hook in two files runs once). **Only the `hooks` key is read**: `permissions`, `env`, `model` and every other
key of a Claude Code settings file are ignored, so a repository can never grant itself tools, approvals or environment
variables. The files are read like every project definition: inside the project folder only, no symbolic links,
regular files of at most 256 KiB; a broken file is listed with the problem, never an error.

**Nothing in a cloned repository runs until you approve it.** A project hook is **Needs approval** until you review
it:

- the chat header shows **{n} to review** while a project chat has pending items; the same review is in Settings →
  Projects (**Review commands and hooks…**) and Settings → Customize → Hooks (**Review {n}…**);
- the **Review** dialog shows every hook (and every `.mcp.json` server and every command file with `!` lines) with its
  exact command, the file it comes from and the scripts it calls; tick what you would run yourself and press
  **Approve** (your password is asked when one is set). There is no "Approve all": "Select all" works per group, after
  you have seen it;
- an approval pins a **hash** of the hook (event, matcher, command, timeout) **and of the scripts its command names**
  (`./…`, `.claude/…`, `.harness/…`, `"$CLAUDE_PROJECT_DIR"/…` and relative paths of script files; up to 8 files of at
  most 1 MiB). Editing the hook **or one of those scripts** makes it pending again; the hash is checked once more right
  before every run;
- a pending hook simply does not run (harness-forge never asks in the middle of a reply);
- **Revoke** in the dialog takes an approval back (no password needed);
- a warning marks hooks that run repository code harness-forge cannot pin (`npm test`, `make`, `pnpm lint`: what they
  run can change without changing the hook), and scripts that are missing.

Approvals belong to the project: they are kept by Delete all data, removed with the project, and never part of a
backup.

### Stop hooks and continuations

A `Stop` hook that blocks (exit 2, or `decision: "block"`) makes the agent continue: harness-forge adds a small note
"A Stop hook asked the agent to continue" (captioned "Sent to the agent") and starts a new turn by itself with the
reason. In that turn `stop_hook_active` is `true`. After **5** continuations in a row the chain ends, with a notice
that says so. A message you queue goes first; a continuation never starts while an
approval is pending; pressing Stop during the hooks cancels it.

## 7. `.mcp.json`: MCP servers of a project

Put a `.mcp.json` at the project root (Claude Code's format):

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}" }
    },
    "docs": {
      "type": "http",
      "url": "https://${DOCS_HOST:-docs.example.com}/mcp",
      "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" }
    }
  }
}
```

- **Type**: a server with `command` is `stdio`; otherwise `type` (`http`, the default, or `sse`) with a `url`
  (`http:` / `https:` only; redirects are refused). At most 20 servers.
- **Variables**: `${NAME}` and `${NAME:-default}` in `command`, `args`, `env` values, `url` and `headers` values take
  their values **only from what you store for this project** in its **MCP servers** dialog (Settings → Projects →
  **MCP servers…**, or the project chip's menu in a chat). They are encrypted on the server, used only for this
  project's servers and never read from the server's environment: even `${HOME}` must be set in the dialog (any other
  `$…` stays as written). Saving variables asks for your password, because a value can change what an approved server
  runs. A server with a missing variable (and no default) does not start ("Set {n} variables").
- **Approval**: every server, stdio or remote, needs approval in the review dialog (section 6), which shows the exact
  command or URL and the names of its environment variables and headers (never their values). A server on a local or
  private address is marked with a warning, not refused (local servers are the main use). Any change to its entry makes
  it pending again.
- **Lifecycle**: an approved server starts with the first reply in one of the project's chats (the reply waits up to
  5 seconds for it; a slower server's tools arrive in a later reply, with the notice that it was not ready), stops after
  10 idle minutes, and stops at once when you revoke it, change the file or its variables, delete the project or stop
  the server. A stdio server runs in the project folder, in its own process group, with the minimal environment plus
  its own `env`.
- **Tools**: named `mcp__<id>__<tool>`, where the id comes from the server's name (lower case, spaces, `_` and `.`
  become `-`, at most 32 characters: `My_Server.v2` → `my-server-v2`). They are offered only in this project's chats and
  ask for approval by default (a tool the server marks read-only runs without asking, a destructive one always asks). A
  project server with the id of one of your global MCP servers **replaces** it in this project's chats ("Replaces your
  server github in this project's chats."). Tool preferences (enabled, overrides) apply by tool name.
- `HF_SAFE_MODE=1` starts no project MCP server.

## 8. Kill switches

| Switch | Effect |
|---|---|
| **Run hooks** (Settings → Customize → Hooks; setting `hooksEnabled`) | no command hook runs, from any source |
| `HF_WORKSPACE_SHELL=0` (environment) | no shell string runs at all: no command hook, no `!` line of a command, no `shell` tool |
| `HF_SAFE_MODE=1` (environment) | no command hook, no project MCP server, no user plugin |

Plugin **code** hooks (`ctx.hooks.on`, PLUGINS.md 9) are not command hooks: the switches above do not stop them (safe
mode loads no user plugin, so there are none). The Hooks tab says when the server turned hooks off ("Hooks are turned
off on this server (HF_WORKSPACE_SHELL=0)." / "… (safe mode).").

## 9. Security notes

- A hook runs **without asking**, with the server user's permissions, every time its event happens: only add commands
  you understand. That is why saving a personal hook, approving a project item and saving MCP variables ask for your
  password.
- Project content is untrusted: nothing from a repository runs before you approve its exact text; any change needs a
  new approval; scripts named by a hook are part of the approval; repository code run by a tool such as `npm test` is
  not, and the review says so.
- A hook's context and messages reach the agent and the transcript (and so your backups); share pages leave hook notes
  out. Never print secrets from a hook.
- Hook payloads, outputs, commands and variable values are never written to the server log at `info` level.
- There is no sandbox: run harness-forge in Docker (or as a dedicated user) when this matters.

## 10. Differences from Claude Code

| Claude Code | harness-forge | Why |
|---|---|---|
| a `PreToolUse` `allow` skips every permission prompt | `allow` skips the card only for a call that would ask and is neither the shell (or another `execute` tool) nor an always-ask tool | a repository's hook must not approve shell commands for you; use shell rules or Auto |
| `transcript_path` in the payload | not sent | chats live in the database |
| `prompt` hooks | skipped (with a note) | only `command` hooks run |
| every key of `settings.json` is read | only `hooks` | `permissions` and `env` must not come from a cloned repository |
| `~/.claude/settings.json` | not read | personal hooks live in Settings → Customize (use Import…) |
| `.mcp.json` variables from the environment | only from values stored for the project | the server's environment holds its own secrets |
| project hooks run once you trust the folder | each hook, server and `!` command is approved on its own, pinned by hash | per-item consent, re-asked after any change |
| `UserPromptSubmit` when the agent reads the message | when you send (or queue) it, so a refused message never reaches the chat | the refusal shows in the composer at once |
| `PreToolUse` per permission check | once per tool call (its decision is kept when you answer the card) | |
| matchers are regular expressions | a safe subset (names, `\|`, `*`) | no regular expression is built from repository text |

## 11. A worked example: block recursive deletes

`.harness/hooks/guard.sh` in the project:

```sh
#!/bin/sh
# PreToolUse guard: refuse shell commands that delete recursively and forcibly.
payload=$(cat)
if printf '%s' "$payload" | grep -Eq 'rm[[:space:]]+-[A-Za-z]*(rf|fr)'; then
  echo "Recursive force deletes are not allowed in this project. Delete files one by one." >&2
  exit 2
fi
exit 0
```

`.harness/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "sh .harness/hooks/guard.sh", "timeout": 10 }] }
    ]
  }
}
```

Open a chat in the project: the header shows **1 to review**; review and approve the hook (the dialog lists
`sh .harness/hooks/guard.sh` and the script). When the agent tries `rm -rf build`, the shell row reads **Blocked by
hook** with the reason, and the agent reads it too. Edit `guard.sh` and the hook is pending again until you re-approve
it.

A context hook is even simpler: a `SessionStart` hook whose command prints text (`git log --oneline -5`) gives the agent
that text at the start of every chat of the project.

## 12. Troubleshooting

- **My hook never runs**: check the Hooks tab: **Off**, **Needs approval** (a project hook), **Invalid** (the reason is
  listed: an unknown event, a matcher with regular-expression characters, a `prompt` hook), the **Run hooks** switch or
  a server alert (`HF_WORKSPACE_SHELL=0`, safe mode). For a tool hook, check the matcher against the tool's names
  (section 5).
- **The hook ran but nothing happened**: exit 0 without JSON is silent except for `UserPromptSubmit` and `SessionStart`
  (whose stdout is context); JSON must be one object, with `hookSpecificOutput.hookEventName` equal to the event.
- **"A hook failed: exit 1"**: the note shows the start of stderr; run the command yourself in the project folder with
  a sample payload: `printf '%s' '{"tool_name":"Bash","tool_input":{"command":"ls"}}' | sh .harness/hooks/guard.sh`.
- **`allow` still shows the card**: hooks cannot approve the shell or always-ask tools (section 10).
- **A Stop hook loops**: check `stop_hook_active` and let the hook pass when it is `true`; the chain stops after 5
  continuations anyway.
- **A project hook keeps going back to Needs approval**: a script it names changes (a build writes it, line endings
  change); move generated files out of the hook's path.
- **My `.mcp.json` server is missing**: it must be at the project root; it needs approval and its variables; safe mode
  starts none; open the project's **MCP servers** dialog for its status and error, and **Reconnect**.
