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

v1.8 (ADR-056, ADR-057) adds **prompt hooks** (a small model judges the event instead of a shell command; section 3),
five more events (`PostToolUseFailure`, `PermissionRequest`, `SubagentStart`, `PostCompact`, `SessionEnd`), Claude
Code's handler fields (`args`, `async`, `if`, `statusMessage`), the `transcript_path` file, and editing a project's
hooks and `.mcp.json` from the UI (section 6). Your hooks from `~/.claude/settings.json` can be copied with
[Import from Claude Code](claude-code-import.md); the hooks of Claude Code plugins work too
([Claude Code plugins](claude-code-plugins.md)).

Reference: [ARCHITECTURE.md 6.28 – 6.30](../ARCHITECTURE.md#628-hooks-adr-048) (how hooks, project trust and project MCP
servers work), 6.36 – 6.37 (v1.8: project file editing, prompt hooks, the new events and transcripts) and
[10.12](../ARCHITECTURE.md) (security), [UI.md 7.31, 7.33, 7.34, 9.13, 9.14](../UI.md) (the screens),
[PLUGINS.md](../PLUGINS.md#declarative-hooks-plugin-api-150) (hooks in plugins), [API.md](../API.md) (the `hooks`,
`projectTrust` and `projectMcp` routes).

## 1. Your first hook

1. Open **Settings → Customize → Hooks** and press **New hook**.
2. Choose the **Type** (v1.8): **Command** runs a shell command, **Prompt** asks a model (section 3, "Prompt hooks").
   Then choose the **Event** (for example **PreToolUse**: before a tool runs).
3. For a tool event, fill in **Tools**: the tool names the hook is for, separated by `|` (`Bash|Edit`). Claude Code
   names work (section 5). Leave it empty, or write `*`, for every tool. A matcher with regular-expression characters
   cannot be saved ("Use tool names, | and * only.").
4. Write the **Command**. It runs with a shell in the project folder (outside projects, in a private, empty folder)
   and gets the event as JSON on its standard input (section 3).
5. Set the **Timeout** (seconds, 1 – 600, default 60) and press **Save hook**.

Saving a new hook, or changing one, asks for your password when a password is set and your last login is more than 10
minutes old (a hook runs commands on your server without asking). Turning a hook off and deleting it do not. The switch
**Run hooks** at the top of the tab turns every command hook off at once, from every source.

**Import…** reads Claude Code settings JSON (a whole `settings.json`, or just its `hooks` object), shows what it found,
and adds the hooks you keep checked: invalid ones are listed unchecked with the reason; `prompt` hooks were skipped in
v1.7 and are imported since v1.8 (`http`, `mcp_tool` and `agent` hooks are still skipped). Each row's menu offers
**Copy as JSON** to take a hook back to Claude Code. To bring over everything of your Claude Code folder at once
(hooks, agents, commands, MCP servers…), use **Import from Claude Code…** ([guide](claude-code-import.md)).

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
| event (`PreToolUse`, …) | one of the thirteen events (section 3; eight in v1.7); an unknown event is ignored (Import… lists it in its notes) |
| `matcher` | optional; tool names for `PreToolUse`, `PostToolUse`, `PostToolUseFailure` and `PermissionRequest` (section 5); for `SessionStart` it matches the source (`startup` / `compact`), for `PreCompact` and `PostCompact` the trigger (`manual` / `auto`), for `Notification` the type (`permission_prompt`), for `SubagentStart` and `SubagentStop` (v1.8) the agent type (`explore`, `general`, a custom agent's name; `general-purpose` matches `general`), for `SessionEnd` the reason (`other`); `UserPromptSubmit` and `Stop` ignore it |
| `type` | `command`, or (v1.8) `prompt` (section 3); `http`, `mcp_tool` and `agent` are skipped with a note |
| `command` | the shell command, at most 4,096 characters |
| `timeout` | optional, in seconds, 1 – 600; default 60 (30 for a prompt hook; in a settings file a larger value is cut to 600 and an invalid one uses the default, each with a note; fractions round up) |
| `args` (v1.8) | optional, a list: the command runs in **exec form**: each word of `args` is quoted, so a value can never add a command (`{"command": "node", "args": ["scripts/check.mjs", "--strict"]}`) |
| `async` (v1.8) | optional, `true`: the hook runs in the background; it cannot block or add context (its timeout still applies) |
| `if` (v1.8) | optional: run only for one tool (`"Write"`) or one kind of shell command (`"Bash(git push *)"`, `"Bash(npm run test:*)"`); any other rule makes the hook invalid (it never runs) |
| `statusMessage` (v1.8) | optional: shown instead of "Running hook…" while the hook runs |
| `prompt`, `model`, `continueOnBlock` (v1.8) | the fields of a prompt hook (section 3) |

Every matching handler of an event runs, all of them **in parallel** (at most 20 per event). A hook that finishes
quietly (exit 0, nothing to report) leaves no trace in the chat; a decision, context, a failure or a message shows as a
small **hook note** in the reply, or inside the tool's row for tool hooks.

## 3. The events

| Event | When it runs | What it can do |
|---|---|---|
| `PreToolUse` | before a tool call runs (once per call, also in sub-agents) | **deny** the call, **ask** you (shows the approval card; denied inside a sub-agent), **allow** it without the card (only where section 10 says), or **change its input** |
| `PostToolUse` | after a tool call succeeded (also in sub-agents) | give the agent **feedback** or context, which it reads at its next step; **stop** the agent |
| `UserPromptSubmit` | when you send a message, or queue one while the agent works, before anything is stored (not for `/compact` or a message to an image model) | **refuse** the message (it stays in the composer with the reason), or **add context** for the agent |
| `Notification` | when a reply ends waiting for your approval (`message`: "The agent needs your permission to use Bash.") | nothing (observe it: send yourself a notification) |
| `Stop` | when the agent is about to finish a reply | make it **continue** with a reason: harness-forge starts a follow-up turn by itself (at most 5 in a row) |
| `SubagentStop` | when a sub-agent is about to finish | make it **continue** for one more round (at most 2); nothing is stored |
| `PreCompact` | before the conversation is compacted (`/compact` or automatically) | nothing (observe it) |
| `SessionStart` | before a chat's first reply, and before the first reply after a compaction (also for a queued message that starts the turn) | **add context** for the agent, or **refuse** the message (only with `continue: false`) |
| `PostToolUseFailure` (v1.8) | after a tool call failed (not when you stopped it) | give the agent **feedback** about the failure (exit 2, `decision: "block"` or context) |
| `PermissionRequest` (v1.8) | when harness-forge is about to show you an approval card for a tool call (main agent only) | **allow** the call (only where a `PreToolUse` allow could, section 10) or **deny** it, with `hookSpecificOutput.decision: { "behavior": "allow" \| "deny", "message"?, "updatedInput"? }`; exit 2 decides nothing |
| `SubagentStart` (v1.8) | when a sub-agent starts, before its first step | **add context** for the sub-agent (`additionalContext` goes into its first message) |
| `PostCompact` (v1.8) | after the conversation was compacted | nothing (observe it) |
| `SessionEnd` (v1.8) | when you delete one chat (not on Delete all data, a project delete or a server stop); it runs in the background with a short budget (1.5 s, up to its own timeout of at most 60 s) | nothing (clean up: `reason` is `other`) |

`Stop` hooks never run when the reply was stopped, failed, ended waiting for an approval or the agent stopped because
of a hook, nor while a queued message is waiting (it goes first). Sub-agents run only `PreToolUse`, `PostToolUse` and
`SubagentStop` hooks; v1.8: `SubagentStart` runs when one starts.

### What a hook receives (stdin)

The event as one JSON object, with Claude Code's field names plus a `harness` object:

| Field | Events | Value |
|---|---|---|
| `session_id` | all | the chat id |
| `cwd` | all | the hook's working folder (the project folder, else the private hooks folder) |
| `hook_event_name` | all | the event |
| `permission_mode` | all | `default` (Ask, Off), `plan`, `acceptEdits` (Accept edits), `bypassPermissions` (Auto) |
| `tool_name` | `PreToolUse`, `PostToolUse` | the Claude Code name when the tool has one (`Bash`, `Write`, `Edit`, `Read`, …), else the harness name |
| `tool_input` | `PreToolUse`, `PostToolUse` | `PreToolUse`: the input the model sent; `PostToolUse`: the input the tool ran with (after an `updatedInput`) |
| `tool_use_id` | `PreToolUse`, `PostToolUse` | the tool call id |
| `tool_response` | `PostToolUse` | the tool's output |
| `prompt` | `UserPromptSubmit` | the text of your message |
| `stop_hook_active` | `Stop`, `SubagentStop` | `true` when this reply is already a hook continuation: check it to avoid loops |
| `trigger`, `custom_instructions` | `PreCompact` | `manual` or `auto`; the focus of `/compact <focus>` (empty when there is none) |
| `source` | `SessionStart` | `startup` or `compact` |
| `message`, `notification_type` | `Notification` | "The agent needs your permission to use <tools>." (Claude Code names, at most 3, then "and N more"); `permission_prompt` |
| `harness` | all | `{ version: 1, chatId, projectId, messageId?, modelRef, origin, tool?, source }`: `origin` is how the run started (`request`, `queue`, `task`, `hook`), `tool` the harness tool name, `source` where this hook comes from (`personal`, `project`, `plugin`) |
| `transcript_path` (v1.8) | all | the chat as a Claude Code-style JSONL file (below); left out when it could not be written |
| `error` (v1.8) | `PostToolUseFailure` | the error text of the failed call (at most 16 KiB) |
| `tool_name`, `tool_input`, `tool_use_id` (v1.8) | `PostToolUseFailure`, `PermissionRequest` | as for `PreToolUse` |
| `agent_id`, `agent_type` (v1.8) | `SubagentStart`, `SubagentStop`, and every hook that runs inside a sub-agent | the sub-agent's call id and its type |
| `trigger` (v1.8) | `PostCompact` | `manual` or `auto` |
| `reason` (v1.8) | `SessionEnd` | `other` |

The payload is at most 256 KiB: a large `tool_response` is cut first, then `tool_input`, `prompt`,
`custom_instructions` and `message`, and a cut payload carries `harness.truncated: true`. v1.7 sent no
`transcript_path` (chats live in the database); v1.8 writes one when a hook needs it (below).

### Exit codes

| Exit | Meaning |
|---|---|
| `0` | success: a JSON object on stdout is read (below); otherwise plain stdout is **context** for `UserPromptSubmit` and `SessionStart` and ignored for the other events |
| `2` | **block**, with stderr as the reason: `PreToolUse` denies the call ("Blocked by hook: …"); `PostToolUse` sends the reason to the agent as feedback (the call already ran); `UserPromptSubmit` refuses your message; `Stop` and `SubagentStop` make the agent continue with the reason; `SessionStart`, `PreCompact` and `Notification` cannot block: it is a non-blocking error ("The hook exited with code 2, but SessionStart hooks cannot block.") |
| other, or a timeout | a **non-blocking error**: the note "A PostToolUse hook failed: exit 1" (or "A PostToolUse hook timed out after 60s"), whose **Show output** reads "The hook failed with exit code 1." (or "The hook timed out."); stderr is never shown, it is only the reason of an exit 2; the agent goes on |

A hook that times out is killed with everything it started (its process group).

### JSON output (stdout, exit 0)

| Field | Events | Effect |
|---|---|---|
| `continue: false` | `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `SessionStart`, `Stop`, `SubagentStop` | stop: after a `PreToolUse` or `PostToolUse` the agent stops after this step ("A hook stopped the agent: …"); `UserPromptSubmit` and `SessionStart` refuse the message; a `Stop` hook ends the reply without a continuation (even when another hook blocks); a `SubagentStop` hook ends the sub-agent without another round; `PreCompact` and `Notification` ignore it |
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

One hook note sums up what the hooks of one event did, the strongest result first: for `PreToolUse` "Blocked by a
PreToolUse hook: …" (deny), then "A hook asked you to confirm this call: …" (ask), "Allowed by a PreToolUse hook"
(allow), "Input changed by a PreToolUse hook" (`updatedInput`); then "A hook stopped the agent: …" (`continue: false`,
which also wins over a `Stop` block); then a block: "A Stop hook asked the agent to continue" for `Stop`, "A
PostToolUse hook told the agent: …" for `PostToolUse`; then "Hook added context · {event}", then "A {event} hook
failed: exit {n}". A hook that only sends a `systemMessage` gets a context note with the line "Hook: {message}".
`SubagentStop` and `Notification` leave no note.

### Prompt hooks (v1.8)

A **prompt hook** asks a model instead of running a command. It is cheaper to write than a script and good at judgment
calls ("did the tests run?", "does this edit touch secrets?"):

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [{ "type": "prompt", "prompt": "Did the agent run the tests and did they pass? $ARGUMENTS", "timeout": 30 }] }
    ],
    "PreToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [{ "type": "prompt", "prompt": "Refuse edits that add API keys or passwords to a file.", "continueOnBlock": true }]
      }
    ]
  }
}
```

- **Events**: `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `UserPromptSubmit`, `Stop`, `SubagentStop` and
  `PermissionRequest` (elsewhere a prompt hook is skipped with a note).
- **The prompt**: `$ARGUMENTS` is replaced by the event's JSON (the payload above); without `$ARGUMENTS` the JSON is
  added at the end; `\$` writes a literal `$`. At most 16,384 characters.
- **The model**: the hook's `model` (a model ref such as `anthropic:claude-haiku-4-5`, or a Claude name such as
  `haiku`, which uses Settings → General → Agent → Claude model names), else **Settings → General → Agent → Hook model**,
  else the small model of the chat's provider, else the chat's model. Reasoning is off and the answer is short (512
  tokens); at most 8 prompt hooks call a model at once on the server; each call is counted in the chat's usage.
- **The answer** the model must give: `{"ok": true}`, or `{"ok": false, "reason": "…"}` (`"impossible": true` lets a
  `Stop` / `SubagentStop` end anyway). harness-forge also accepts the object inside a code fence; anything else is a
  failed hook ("The model's answer could not be read."), which never blocks.
- **What `ok: false` does**: `PreToolUse` denies the call and ends the reply (with `continueOnBlock`: denies it and the
  agent goes on with the reason); `PostToolUse` ends the reply (with `continueOnBlock`: the reason goes back to the
  agent); `PostToolUseFailure` sends the reason to the agent; `UserPromptSubmit` refuses your message; `Stop` and
  `SubagentStop` make the agent continue (unless `impossible`); `PermissionRequest` only records it. **`ok: true`
  decides nothing**: it never approves a call.
- **Switches and trust**: **Run hooks** and safe mode turn prompt hooks off (`HF_WORKSPACE_SHELL=0` does not: they run
  no shell); a project's prompt hooks need approval like its command hooks; a plugin whose hooks are all prompt hooks
  needs no trust.

### `transcript_path` (v1.8)

Claude Code hooks often read the conversation from the file named in `transcript_path`. harness-forge writes such a
file **only when a hook is about to run**: `<data dir>/transcripts/<chat id>.jsonl` (readable by the server user
only), one JSON line per message of the chat's current path in Claude Code's shape (`type`, `uuid`, `parentUuid`,
`sessionId`, `timestamp`, `cwd`, `message: { role, content }` with text, `tool_use` and `tool_result` blocks; tool
results cut at 16 KiB; reasoning and attachments left out; at most 8 MiB, the oldest messages dropped first). It is
rebuilt when you switch versions, deleted with the chat, and never part of a backup. When it cannot be written, the
payload has no `transcript_path`. Do not rely on it in a `SessionEnd` hook (the chat is being deleted).

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
- allowed characters: letters, digits, `_`, `.`, `-` and `*`, and blanks only around `|` (`Bash | Edit`; "A tool name in
  the matcher contains a blank." otherwise); a matcher with `^ $ [ ( + ? \ {` is **invalid** and **never runs**
  (`^Bash.*$` → write `Bash`): a personal hook with one cannot be saved ("Invalid matcher: …"; the editor says "Use
  tool names, | and * only."), and in a settings file or a plugin the whole group is dropped and only a note about the
  file is shown;
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
| `task` | `Task` |
| `todo_write` | `TodoWrite` |
| `exit_plan_mode` | `ExitPlanMode` |
| `skill` | `Skill` |
| `mcp__<server id>__<tool>` | for a project MCP server also `mcp__<name in .mcp.json>__<tool>` (Claude Code's name) |

The payload's `tool_name` uses the Claude Code name when there is one. Other tools (`generate_image`, `current_time`,
plugin tools) match only their own names. The hook editor shows which tools a matcher matches as you type ("Matches
shell (Bash), edit_file (Edit)").

## 6. Project hooks and approval

A project can ship hooks in its settings files, read in this order: `.claude/settings.json`,
`.claude/settings.local.json`, `.harness/settings.json`, `.harness/settings.local.json`. Their hooks add up (an
identical hook in two files runs once and is listed under the first file). **Only the `hooks` key is read**:
`permissions`, `env`, `model` and every other key of a Claude Code settings file are ignored, so a repository can never
grant itself tools, approvals or environment variables. The files are read like every project definition: inside the
project folder only, no symbolic links, regular files of at most 256 KiB; a broken file is listed with the problem,
never an error (a linked file, or a file under a linked `.claude` folder, is "not an object": it is not read).

**Nothing in a cloned repository runs until you approve it.** A project hook is **Needs approval** until you review
it:

- the chat header shows **{n} to review** while a project chat has pending items (its accessible name: "Review {n}
  items in {project} that can run commands"); the same review is in Settings → Projects (**Review commands and
  hooks…**) and Settings → Customize → Hooks (**Review {n}…**);
- the **Review** dialog shows every hook (and every `.mcp.json` server and every command file with `!` lines) with its
  exact command, the file it comes from and the scripts it calls; tick what you would run yourself and press
  **Approve** (Space or a click; Enter never approves; your password is asked when one is set and your last login is
  more than 10 minutes old). There is no "Approve all": "Select all" works per group, after you have seen it. When an
  item changed while the dialog was open, nothing is approved and the dialog asks you to check it again;
- an approval pins a **hash** of the hook (event, matcher, command, timeout) **and of the scripts its command names**
  (`./…`, `.claude/…`, `.harness/…`, `"$CLAUDE_PROJECT_DIR"/…` or `"$HARNESS_PROJECT_DIR"/…`, relative paths of script
  files and bare script names such as `sh count.sh` or `node hook.mjs`; options, assignments and URLs never count; up to
  8 files of at most 1 MiB). Editing the hook **or one of those scripts** makes it pending again; the hash is checked
  once more right before every run. A named file that is missing, linked, secret-looking or larger than 1 MiB, or a
  word that names no file (`echo notes.sh`), is shown as "Runs notes.sh (not found)" with the warning "A file this
  command runs is missing.";
- a pending hook simply does not run (harness-forge never asks in the middle of a reply);
- **Revoke** in the dialog takes an approval back (no password needed);
- a warning marks hooks (and servers and commands) that run repository code harness-forge cannot pin (`npm test`,
  `make`, `pnpm lint`: what they run can change without changing the hook; an interpreter such as `node x.mjs` or
  `python x.py`: the script is pinned, the files it imports are not), and scripts that are missing.

Approvals belong to the project: they are kept by Delete all data, removed with the project, and never part of a
backup.

### Editing project hooks and files in the UI (v1.8)

Settings → Customize → Hooks (with the project selected) edits a project's hooks in place: **Edit…** on a project hook
opens the hook editor on it, **New hook** offers **Where** (personal, or one of the project's four settings files) and
**Delete…** removes the handler. harness-forge rewrites only the `hooks` key of that settings file (every other key and
their order stay). A project's `.mcp.json` is edited from its **MCP servers** dialog (**Edit .mcp.json…**), and its
agents, commands, skills and output styles from their Customize tabs ([customizing the agent](customizing-agents.md)).

- **Saving never approves**: a hook, server or command with shell lines you save is **Needs approval** like any other
  change; the message "Saved {path}. {n} items need your approval." offers **Review**, which opens the review dialog
  (your password is asked there, not when you save).
- **Changed on disk**: when the file changed after you opened it (the agent, an editor, `git pull`), saving says
  "{file} changed on disk after you opened it." — **Load from disk** drops your edit, **Overwrite** saves yours.
- Saving works while a chat of the project runs (one write at a time per file). UI edits are not part of the
  agent's rewind history: a later rewind sees them as changes made outside the chat.

### Stop hooks and continuations

A `Stop` hook that blocks (exit 2, or `decision: "block"`) makes the agent continue: harness-forge adds a small note
"A Stop hook asked the agent to continue" (captioned "Sent to the agent") and starts a new turn by itself with the
reason (the agent reads `<hook-feedback event="Stop">…</hook-feedback>`, "(no reason given)" without one). In that turn
`stop_hook_active` is `true`. After **5** continuations in a row the chain ends, with the notice "Stopped after 5 hook
continuations in a row.". A message you queue goes first; a continuation never starts while an approval is pending;
pressing Stop during the hooks cancels it.

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
  (`http:` / `https:` only: a URL with variables must start with `http://`, `https://` or a variable, and it is checked
  again once the variables are filled in; redirects are refused). At most 20 servers; a server name has at most 64
  characters.
- **Variables**: `${NAME}` and `${NAME:-default}` in `command`, `args`, `env` values, `url` and `headers` values take
  their values **only from what you store for this project** in its **MCP servers** dialog (Settings → Projects →
  **MCP servers…**, or the project chip's menu in a chat). They are encrypted on the server, used only for this
  project's servers and never read from the server's environment: even `${HOME}` must be set in the dialog (any other
  `$…` stays as written). A default is literal text up to the next `}`: it cannot hold another variable
  (`${A:-${B}}` does not read `B`), and an empty stored value uses the default. Saving variables asks for your password
  (when your last login is more than 10 minutes old), because a value can change what an approved server runs. A
  server with a missing variable (and no default) does not start ("Set {n} variables"); a stored variable no server
  uses any more is still listed, so you can clear it.
- **Approval**: every server, stdio or remote, needs approval in the review dialog (section 6), which shows the exact
  command or URL and the names of its environment variables and headers (never their values). The hash also covers the
  script files its command and arguments name (`node ./server.js`). A server on a local or private address (or a local
  name such as `localhost` or `*.local`) is marked with a warning, not refused (local servers are the main use); the
  check reads the URL as written, without a DNS lookup, so a host that comes from a variable without a default is not
  flagged. Any change to its entry makes it pending again.
- **Lifecycle**: an approved server starts with the first reply in one of the project's chats that uses tools (the
  reply waits up to 5 seconds for it; a slower server's tools arrive in a later reply, with the notice "The project MCP
  server "<name>" is not ready, so its tools were not sent."), stops after 10 idle minutes (not while a reply of the
  project or one of its tool calls runs), restarts when its variables change, and stops at once when you revoke it,
  change or remove its entry, delete the project or stop the server. A server that crashed starts again with the next
  reply. A stdio server runs in the project folder, in its own process group, with the minimal environment plus its
  own `env`.
- **Tools**: named `mcp__<id>__<tool>`, where the id comes from the server's name (lower case, spaces, `_` and `.`
  become `-`, other characters are dropped, at most 32 characters, `server` when nothing is left, `-2`, `-3` … when
  the id is taken: `My_Server.v2` → `my-server-v2`). They are offered only in this project's chats and
  ask for approval by default (a tool the server marks read-only runs without asking, a destructive one always asks). A
  project server with the id of one of your global MCP servers **replaces** it in this project's chats ("Replaces your
  server github in this project's chats."). Tool preferences (enabled, overrides) apply by tool name.
- `HF_SAFE_MODE=1` starts no project MCP server (they are listed **Off**). `HF_WORKSPACE_SHELL=0` does not stop them:
  it turns off shell strings, and a stdio server is started as a program, not through the shell.

## 8. Kill switches

| Switch | Effect |
|---|---|
| **Run hooks** (Settings → Customize → Hooks; setting `hooksEnabled`) | no command hook runs, from any source |
| `HF_WORKSPACE_SHELL=0` (environment) | no shell string runs at all: no command hook, no `!` line of a command (personal, project or plugin), no `shell` tool; project MCP servers still start |
| `HF_SAFE_MODE=1` (environment) | no command hook, no project MCP server, no user plugin (the `!` lines of personal and approved project commands still run) |

Plugin **code** hooks (`ctx.hooks.on`, PLUGINS.md 9) are not command hooks: the switches above do not stop them (safe
mode loads no user plugin, so there are none). The Hooks tab says when the server turned hooks off ("Hooks are turned
off on this server (HF_WORKSPACE_SHELL=0)." / "… (safe mode).").

## 9. Security notes

- A hook runs **without asking**, with the server user's permissions, every time its event happens: only add commands
  you understand. That is why saving a personal hook, approving a project item and saving MCP variables ask for your
  password (when your last login is more than 10 minutes old).
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
| a `PreToolUse` `allow` skips every permission prompt | `allow` skips the card only for a call that would ask and is neither the shell (or another `execute` tool) nor an always-ask tool, and never in Plan mode (the note still reads "Allowed by a PreToolUse hook" while the card shows) | a repository's hook must not approve shell commands for you; use shell rules or Auto |
| `transcript_path` in the payload | v1.8: sent (a JSONL file written when a hook runs; v1.7 sent none) | chats live in the database; the file is a copy for hooks |
| `prompt` hooks | v1.8: supported for seven events (v1.7 skipped them); their `ok: true` never approves | a model's answer must not grant a permission |
| `http`, `mcp_tool` and `agent` hooks | skipped (with a note) | not supported |
| the 33 Claude Code events | 13 (`PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `UserPromptSubmit`, `Notification`, `Stop`, `SubagentStart`, `SubagentStop`, `PreCompact`, `PostCompact`, `SessionStart`, `SessionEnd`); others are ignored | the others have no counterpart here |
| `SessionEnd` when a session ends | only when you delete one chat | a chat never "ends" otherwise |
| every key of `settings.json` is read | only `hooks` | `permissions` and `env` must not come from a cloned repository |
| `~/.claude/settings.json` | not read by chats; v1.8: copied once with Import from Claude Code | personal hooks live in Settings → Customize |
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

- **My hook never runs**: check the Hooks tab: **Off**, **Needs approval** (a project hook), the **Run hooks** switch or
  a server alert (`HF_WORKSPACE_SHELL=0`, safe mode). A hook of a settings file or a plugin that the tab does not list
  at all was dropped: the notes above the list say why ("{file}: …": a matcher with regular-expression characters, an
  `http` hook, an unknown event, an `if` rule harness-forge cannot read). An imported hook may be **Off** (Import from
  Claude Code turns command hooks off). For a tool hook, check the matcher against
  the tool's names (section 5).
- **The hook ran but nothing happened**: exit 0 without JSON is silent except for `UserPromptSubmit` and `SessionStart`
  (whose stdout is context); JSON must be one object, with `hookSpecificOutput.hookEventName` equal to the event.
- **"A PostToolUse hook failed: exit 1"**: the note does not show stderr (only an exit 2 uses it, as the reason); run
  the command yourself in the project folder with a sample payload:
  `printf '%s' '{"tool_name":"Bash","tool_input":{"command":"ls"}}' | sh .harness/hooks/guard.sh`.
- **`allow` still shows the card**: hooks cannot approve the shell or always-ask tools, and nothing in Plan mode
  (section 10); the note still reads "Allowed by a PreToolUse hook".
- **A Stop hook loops**: check `stop_hook_active` and let the hook pass when it is `true`; the chain stops after 5
  continuations anyway.
- **A project hook keeps going back to Needs approval**: a script it names changes (a build writes it, line endings
  change); move generated files out of the hook's path.
- **My `.mcp.json` server is missing**: it must be at the project root; it needs approval and its variables; safe mode
  starts none; open the project's **MCP servers** dialog for its status and error, and **Reconnect**.
- **A prompt hook never blocks**: check the **Hook model** (Settings → General → Agent) and the note under the reply
  ("A {event} hook failed": the model could not be reached or its answer could not be read); `ok: true` never blocks.
- **I saved a project hook and it does not run**: saving never approves; review it (the chip **{n} to review**).
