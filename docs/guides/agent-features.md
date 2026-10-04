# Agent features: compaction, plan mode, todos, mentions, steering and sub-agents

harness-forge v1.5 ("Agent 2.0", ADR-040 … ADR-043) adds the features that keep long agent work on track: long chats are
**compacted** into a summary instead of losing their oldest turns, a read-only **plan mode** ends with a plan you
approve, the agent keeps a **todo list** you can watch, **`@` mentions** attach project files, messages you send while
the agent works are **queued** and reach it at the next step, and **sub-agents** explore or work in parallel with their
own context.

Most of this works in any chat with a model that can call tools. Plan mode, `@` mentions and the file work of
sub-agents need a **project chat** (see [using projects](using-projects.md)).

v1.6 builds on these: your own sub-agent types, slash commands and skills, background sub-agents, saved plan files and
`/remember` are in [customizing the agent](customizing-agents.md).

Reference: [ARCHITECTURE.md 6.18 – 6.22](../ARCHITECTURE.md#618-context-compaction-adr-040) (how it works) and
[10.10](../ARCHITECTURE.md#1010-agent-20-security-phase-9-adr-040--adr-043) (security),
[UI.md 7.24 – 7.27, 9.11](../UI.md#724-compaction-compactiondivider-compactionts-w911-phase-9) (the screens),
[PLUGINS.md 1](../PLUGINS.md#builtin-plugins) (the `core-agent` tools), [API.md](../API.md) (the `chatQueue` and
`projectFiles` routes).

## 1. Compaction: long chats keep their context

Every model has a context window. Before v1.5 a chat that outgrew it silently left its oldest messages out. Now the
oldest part of the conversation is replaced by a **summary** written by a model, and the agent continues from it.

- **Automatically** (Settings → General → Agent → **Automatic compaction**, on by default): before every model call,
  also between the steps of a long agent run, the server estimates the size of the context. Above 80 % of the model's
  window it summarizes everything so far and keeps your latest request next to the summary. A divider "Conversation
  compacted automatically" (or "Context compacted during this response" inside a long reply) shows where it happened.
- **By hand**: type `/compact` (or pick it in the `/` menu). Add a focus to steer the summary:
  `/compact keep the failing test names and the file paths`. The context ring drops right away.
- **What you see**: the messages above the divider stay in the chat, dimmed (hover to read them at full strength).
  **Show summary** opens what the model now sees instead of them. Copy, rewind, versions and search still work on them.
- **What the model sees**: the summary (with the todo list at that point), then everything after the divider. The
  summary is written in sections: your requests and intent, files and code, errors and fixes, all your messages,
  pending tasks, the current work and the next step.
- **Versions**: compaction follows the message tree. Editing a message above a divider starts a branch without that
  compaction; regenerating the reply that compacted drops it too.
- **Which model writes the summary**: **Compaction model** (default: the chat's own model). A small, fast model with a
  large context window works well. The summary costs one extra model call, listed in the chat's usage (purpose
  `compact`).
- **When it fails** (the model errors, or the setting is off): the old behavior applies and the oldest messages are left
  out; a notice says so, and the reply does not try to compact again. At most 10 automatic compactions happen in one
  reply. A failed `/compact` shows the error in its reply and changes nothing. `/compact` needs a chat model: with an
  image model picked in the composer it is refused.
- **Not shared**: share links never include summaries (a `/compact` exchange is left out of them entirely), and chat
  search does not index them. The Markdown export does.

## 2. Plan mode: look first, then change

Plan mode is a **permission mode** (next to Ask, Accept edits, Auto and Off), offered in project chats.

- **Turn it on**: the permission menu in the composer (**Plan**; Alt+P opens the menu), `/mode plan`, or **Shift+Tab**
  in the composer, which cycles Ask → Accept edits → Plan → Ask (from Auto or Off it goes to Ask; Settings → General →
  **Shift+Tab switches the permission mode**; turn it off if you use Shift+Tab to move focus backwards). A screen
  reader hears "Permission mode: Plan".
- **What the agent can do**: read, list and search files and use tools that change nothing. Tools that write files or
  run shell commands are not even offered to the model. Tools that ask in Ask still ask.
- **The plan card**: when the agent is done exploring it calls `exit_plan_mode` with a markdown plan. The card shows it
  with three buttons:
  - **Approve, accept edits**: the chat switches to Accept edits and the agent starts implementing at once (file edits
    run without asking; shell commands still ask unless a shell rule allows them).
  - **Approve, ask before edits**: the chat switches to Ask; every change asks first.
  - **Keep planning**: the agent stays in plan mode and revises the plan. Write what to change in **Feedback for the
    agent** (up to 2,000 characters); the feedback is sent with whichever button you press.
- **Enforced on the server**: plan mode is not a hint. The server builds the tool set and decides approvals; the plan
  card can never be approved by an "Always allow" setting (Plugins → Agent tools offers no Allow for `exit_plan_mode`)
  or a plugin hook, and a plan is only approved together with a switch to Accept edits or Ask (the server refuses any
  other mode, Auto included).

## 3. Todos: watch the agent's task list

The agent keeps a short task list with the `todo_write` tool (up to 50 items, each pending, in progress or done). It
runs without asking, in every chat with tools.

- **The strip** above the composer shows "3/7 · Running the parser tests" with a progress bar while the agent works,
  and after the reply as long as its list still has open items ("All tasks done" when everything is done). Open it to
  see every task; it remembers whether it was open.
- **The row** of each `todo_write` call in the reply shows the count ("3/3") and the list.
- The list belongs to the message path: switching to another version shows that version's list. It survives reloads and
  compaction (the summary carries it).

## 4. `@` mentions: attach project files

In a project chat, type `@` (or use **+** → **Mention a file**) and start typing a file name.

- The menu searches the project's files: names that start with what you typed first, then names that contain it, then
  full paths, then fuzzy matches (the letters in order); `.gitignore`d files, `node_modules`, `.git` and secret-looking
  files (`.env`, keys, …) are left out. Pick a folder to look inside it. The list shows the first 50 matches; type more
  to narrow it.
- Picking a file inserts `@src/parser.ts` into your text (so the model sees the path; a path with spaces is written
  `@"my notes.md"`) and attaches a **snapshot** of the file, like a dropped file. Later edits of the file do not change
  the attachment; ask the agent to `read_file` it for the current version.
- Limits: text files, images and PDFs up to **5 MB**; `.git` content and secret-looking files cannot be attached.
- The chip and the `@path` text are independent: remove either one on its own.

## 5. Steering: talk to the agent while it works

You no longer have to wait for a reply to finish.

- **Send while it works**: the composer stays open ("Queue a message…"). Press Enter (or **Queue message** next to
  Stop): the message waits in a queue above the composer.
- **Delivered at the next step**: when the agent finishes its current step (a tool call, typically), it takes every
  queued message and reads it before it continues. The message then shows inside the reply where it was delivered
  ("You · while it worked"). Use it to correct course: "Use the vitest filter instead".
- **Or as the next message**: a message still queued when the reply finishes is sent as the next message
  automatically, and the tab follows it (several queued messages: the first starts the next reply, the others reach it
  at its first step).
- **Edit or cancel** a queued message from its row until it is delivered.
- **Stop** cancels the reply and empties the queue; the queued texts and files come back into your composer.
- **Commands wait**: `/compact` and plugin commands are never sent into a running reply; they run as the next message.
- **While an approval is pending**, queued messages wait for the next run (after you answer).
- Limits: 10 messages per chat, each up to 256 KB. The queue lives in the server's memory: a server restart empties it
  (a restart also stops running replies).
- Every open tab sees the same queue.

## 6. Sub-agents: explore and work in parallel

The agent can start **sub-agents** with the `task` tool: separate agent loops with their own context. A sub-agent gets a
description and a prompt, works on its own, and returns only a **report** to the main agent, so long explorations no
longer flood the main conversation.

- **Types**: **Explore** (read-only: reading, listing and searching) and **Agent** (general: whatever the chat's mode
  allows without asking).
- **Never asks you**: a sub-agent only gets the tools that would run without an approval card in the chat's current
  mode. In Ask that means read-only tools (no file edits, no shell); in Accept edits an **Agent** sub-agent also gets
  file edits and the shell, where only the commands your shell rules allow run; in Auto everything except always-ask
  tools. A call that would still need approval is skipped ("Sub-agents can't ask for approval, so this was skipped.").
  An **Explore** sub-agent, and every sub-agent in plan mode, is read-only.
- **Live blocks**: each sub-agent shows as a block with its latest step; open it for the prompt, the steps (the last 50),
  the report and its model, tokens, cost and time. Several run side by side.
- **Limits**: 3 at once (more wait), 20 per reply, **Sub-agent max steps** (Settings → General → Agent; default 30, up
  to 200; at the limit the sub-agent writes its report), and about 9.5 minutes each. A sub-agent cannot start
  sub-agents.
- **Model**: **Sub-agent model** (default: the chat's model). It must be able to call tools (the setting warns when it
  can't); a cheaper, faster model is often enough for exploring. A model that is no longer available falls back to the
  chat's model. Each sub-agent's usage is listed in the chat's cost (purpose `subagent`).
- **Files**: edits made by sub-agents are journaled like the main agent's, so **Rewind files to here** and the changes
  panel cover them. A sub-agent's `cd` does not move the chat's shell folder.
- **Stop** stops every sub-agent of the reply. After a reload, a stopped sub-agent shows as stopped without its steps.
- To turn sub-agents off, disable the `task` tool in Plugins → Agent tools.

## 7. Settings

| Where | Setting | Default |
|---|---|---|
| General | Shift+Tab switches the permission mode (`shiftTabModes`) | on |
| General → Agent | Automatic compaction (`autoCompact`) | on |
| General → Agent | Compaction model (`compactModelRef`) | the chat's model |
| General → Agent | Sub-agent model (`subagentModelRef`) | the chat's model |
| General → Agent | Sub-agent max steps (`subagentMaxSteps`) | 30 (1–200) |
| General | Default permission mode (`defaultToolMode`) | Ask (Plan is offered too) |

No environment variable is needed for any of this.

## 8. What is enforced, and the limits

| Feature | Enforced by the server | Limits |
|---|---|---|
| Compaction | the latest summary on the message path replaces older messages for the model; stored messages are never rewritten | summary 60,000 characters, focus 1,000, 10 automatic compactions per reply, triggered at 80 % of the window |
| Plan mode | the tool set (no write / execute tools) and the approvals (`exit_plan_mode` always asks; approving it requires switching to Accept edits or Ask) | plan 50,000 characters, feedback 2,000 |
| Todos | derived from the stored `todo_write` calls | 50 items |
| Mentions | the path guard (no `..`, no links out of the project, no `.git`, no secret-looking files), the upload checks | 5 MB per file, 50 results, 50,000 indexed files per project |
| Queue | bounded, per chat, emptied by Stop, chat deletion, key rotation and shutdown; server commands never steer | 10 messages of 256 KB per chat |
| Sub-agents | no approval request ever comes from a sub-agent; depth 1; writes journaled | 3 at once, 20 per reply, max steps setting, 570 s each |

The server never logs summaries, queued or steered texts, todo or plan texts, sub-agent prompts or reports, mention
searches or file contents at the `info` level.

## 9. Troubleshooting

- **"Conversation compacted" appears too often**: the model's context window is small; pick a model with a larger
  window, or a **Compaction model** with a large window (the summary then has room for more detail).
- **The summary misses something important**: run `/compact <what to keep>` yourself before the automatic one does, or
  edit a message above the divider to continue from the full history in a new branch.
- **Plan is not in the permission menu**: plan mode is offered in project chats only (`/mode plan` elsewhere answers
  "Plan mode works in project chats."). Move the chat into a project first (the server would accept `plan` elsewhere,
  but without workspace tools it adds nothing).
- **Shift+Tab moves focus instead of switching modes**: the setting is off, a menu is open, the composer is not focused,
  the model cannot call tools, or there is nothing to switch to (outside a project chat Ask is the only mode in the
  cycle).
- **`@` opens no menu**: the chat has no project, or `@` is inside a word (`a@b`).
- **A sub-agent "skipped" a step**: that call needed your approval in the current mode. Switch to Accept edits (file
  edits, and shell commands that match a shell rule; add the rule first), then ask again.
- **A queued message disappeared after a restart**: the queue lives in memory; send it again.
