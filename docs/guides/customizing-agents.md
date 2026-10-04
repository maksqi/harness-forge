# Customizing the agent: agents, commands, skills, background agents, plan files and Remember

harness-forge v1.6 ("Agent customization", ADR-044 … ADR-047) lets you shape the agent the way Claude Code does:

- **Agents** — your own sub-agent types, each with its instructions, a narrower set of tools and its own model. The
  main agent starts them with the `task` tool, next to the built-in **Explore** and **Agent**.
- **Commands** — saved prompts you run with `/name` in the composer, with arguments (`$ARGUMENTS`, `$1` …), an
  optional model for that turn and an optional, narrower tool set.
- **Skills** — instructions the agent loads only when a task needs them (a release checklist, a style guide, how to
  fill a PDF form), optionally with supporting files.
- **Background agents** — a sub-agent the agent starts in the background keeps working while the conversation goes on,
  and reports back when it is done.
- **Plan files** — approved plans saved as Markdown files in the project.
- **`/remember`** — a note saved to `AGENTS.md`, to the project's instructions or to your custom instructions.

Agents, commands and skills are plain Markdown files with a small YAML header (frontmatter). Put them in a project
folder (`.harness/` or `.claude/`, so they travel with the repository), keep personal ones in **Settings → Customize**,
or install them with a plugin. Files written for Claude Code mostly work as they are; section 6 lists the differences.

Reference: [ARCHITECTURE.md 6.23 – 6.27](../ARCHITECTURE.md#623-customization-catalog-adr-044) (how it works) and
[10.11](../ARCHITECTURE.md#1011-agent-customization-security-phase-10-adr-044--adr-047) (security),
[UI.md 7.28 – 7.30, 9.12](../UI.md#912-customize-settingscustomize-w108-phase-10) (the screens),
[PLUGINS.md](../PLUGINS.md#declarative-agents-plugin-api-140) (agents and skills in plugins), [API.md](../API.md) (the
`customizations`, `memory` and `chatTasks` routes). The features of v1.5 (plan mode, sub-agents, the queue) are in
[agent features](agent-features.md).

## 1. Where definitions live

| Source | Where | Edited in | Wins over |
|---|---|---|---|
| Built-in | the agents `explore` and `general`; the commands `/compact`, `/new`, `/model`, `/effort`, `/mode`, `/help`, `/remember` | — (reserved names) | — |
| Plugins | `contributes.agents` / `contributes.skills` / `contributes.commands` of an installed plugin | the plugin | built-in |
| Personal | the harness-forge database (all your chats, every project) | Settings → Customize | plugins |
| Project, `.claude/` | `.claude/agents/`, `.claude/commands/`, `.claude/skills/` in the project folder | your editor or the agent (with approval) | personal |
| Project, `.harness/` | `.harness/agents/`, `.harness/commands/`, `.harness/skills/` in the project folder | your editor or the agent (with approval) | everything |

A project's definitions apply only to the chats of that project. When two sources define the same name, the higher one
wins and the other is listed as **shadowed** (Settings → Customize shows both, and why). `.harness/` exists so a
repository can override what it shares with Claude Code without editing `.claude/`.

```
my-project/
  AGENTS.md                         project instructions (read in every chat of the project)
  .harness/
    agents/
      code-reviewer.md              an agent: the file stem is its default name
    commands/
      review.md                     /review
      frontend/
        component.md                /component, shown with the namespace "frontend"
    skills/
      release-notes/
        SKILL.md                    a skill: one folder per skill
        template.md                 a supporting file the agent reads with read_file
    plans/
      2026-10-04-move-auth.md       a saved plan (section 9)
  .claude/
    agents/ commands/ skills/       the same layout, lower precedence
```

Nothing is read from your home folder (`~/.claude`, `~/.harness`): personal definitions live in Settings → Customize.

## 2. The file format

Every definition is a Markdown file that starts with a YAML header between two `---` lines (at the very first byte of
the file; a UTF-8 BOM is fine). The rest of the file is the body.

```markdown
---
name: code-reviewer
description: Reviews a diff or a set of files for bugs, risky changes and missing tests. Use it after larger edits.
---
The body: the agent's instructions, the command's prompt or the skill's content.
```

- **Names**: agents and skills use `a-z`, `0-9` and `-`, start with a letter, at most 64 characters; commands at most 32.
  Without `name`, the file name is used (`review.md` → `review`), or for a skill its folder name.
- **Description**: required for agents and skills, recommended for commands (the slash menu shows it). The agent
  **reads** the descriptions of agents and skills to decide when to use them, so say *when*: "Use it after larger
  edits.", "Load it before writing release notes." Longer than 1,024 characters is cut.
- **Size**: at most 64 KB per file, the header at most 8 KB. Text only (a binary file is skipped).
- **Lists**: `tools` and `allowed-tools` take a comma-separated string (`Read, Grep, Glob`) or a YAML list.
- Problems never break anything: a file that cannot be used is listed as **Invalid** with the reason ("Line 2: Add a
  description."), and warnings ("Unknown tool: foo") are shown next to the definition.

### Agents (`.harness/agents/<name>.md`)

```markdown
---
name: code-reviewer
description: Reviews a diff or a set of files for bugs, risky changes and missing tests. Use it after larger edits.
tools: Read, Grep, Glob, LS
model: anthropic:claude-sonnet-5
---
You review code changes.

1. Read the changed files and the code around the change.
2. List real bugs first, then risky changes, then missing tests.
3. Quote file paths and line numbers. Do not rewrite the code.
```

| Key | Meaning |
|---|---|
| `name`, `description` | required |
| `tools` | optional: the only tools this agent may use (harness names such as `read_file`, or Claude Code names, section 6). It can only **narrow**: the agent never gets a tool that would need your approval in the chat's current mode, the agent tools (`task`, `todo_write`, …) or `generate_image`. Without `tools`, it gets everything a sub-agent may use in that mode |
| `model` | optional: a model ref such as `openai:gpt-6` (used when that provider is connected; else the default below), or `inherit` (the chat's model). Without it: Settings → General → Agent → **Sub-agent model**, else the chat's model |
| body | the agent's instructions; it reads them after harness-forge's sub-agent preamble and before your custom instructions. A sub-agent does not see the conversation: the main agent writes it a prompt |

The main agent sees the list of agent types (names and descriptions) and picks one when a task fits. You can also ask
for one: "Use the code-reviewer agent on the auth changes." In the chat a custom agent shows as a block with its name
(hover it for the description and where it comes from).

### Commands (`.harness/commands/<name>.md`)

```markdown
---
description: Review a file for bugs and risky changes
argument-hint: <file> [focus]
model: anthropic:claude-sonnet-5
allowed-tools: Read, Grep, Glob
---
Review $1 for bugs and risky changes. Focus on: $ARGUMENTS.
Report the findings as a list with line numbers.
```

| Key / placeholder | Meaning |
|---|---|
| `description` | shown in the slash menu |
| `argument-hint` | shown after the command while you type its arguments (`/review <file> [focus]`); write it as is, brackets need no quotes |
| `model` | optional: this turn runs on that model; the chat keeps its own model. When the model is not available (no key, unknown, an image model), the chat's model answers and the reply says so |
| `allowed-tools` | optional: the tools of this turn are limited to this list (also for the approvals and regenerations of the turn). It never approves anything: calls still ask as the permission mode says |
| `$ARGUMENTS` | everything you typed after `/review ` |
| `$1` … `$9` | single words of it; quotes group words (`/review "src/a b.ts" naming` → `$1` = `src/a b.ts`) |
| `{{input}}` | same as `$ARGUMENTS` (the syntax of plugin templates) |
| no placeholder | your text is added after the body, separated by a blank line |

Subfolders group commands: `.harness/commands/frontend/component.md` is `/component`, shown with the label
"frontend" (the folder is only a label; names must stay unique). The bubble shows what you typed; the expanded prompt
is what the model gets. A command typed while the agent works waits for the next turn (like every server command).

### Skills (`.harness/skills/<name>/SKILL.md`)

```markdown
---
name: release-notes
description: How this project writes release notes. Load it before writing or editing release notes.
---
# Release notes

1. Group the changes as Added, Changed, Fixed.
2. One line per change, in the imperative mood, with the pull request number.
3. Use template.md in this folder as the skeleton.
```

| Key | Meaning |
|---|---|
| `name`, `description` | required (the name defaults to the folder name) |
| body | the skill; the agent reads it when it loads the skill |
| other files in the folder | supporting files (up to 50 are listed, three folders deep; hidden and secret-looking files and links are left out). The agent gets the folder's path and reads them with `read_file`, without asking |

The agent sees the names and descriptions of the skills (up to 50) and loads one with the `skill` tool when a task
matches; the chat shows a row "Loaded skill release-notes". Skills are not slash commands in v1.6 (you cannot type
`/release-notes`); ask the agent to use it instead. A personal or plugin skill is one file: put everything it needs in
its body.

## 3. Precedence, duplicates and reserved names

- **Same name, different sources**: project `.harness/` > project `.claude/` > personal > plugin > built-in. The winner
  is used; the others are listed as **Shadowed** ("Not used: the project's .harness/agents/code-reviewer.md wins.").
- **Same name in one folder** (two command files `review.md` in different subfolders): the first path in alphabetical
  order wins; the other is marked as a duplicate.
- **Reserved**: agents `explore`, `general` and `general-purpose` (Claude Code's name for `general`, which the agent may
  use); commands `/compact`, `/new`, `/model`, `/effort`, `/mode`, `/help`, `/remember`. A definition with such a name is
  **Invalid**. (A plugin command named `remember` is refused since v1.6.)
- **Turned off** personal definitions are listed as **Off** and shadow nothing.

## 4. Personal definitions: Settings → Customize

**Settings → Customize** (also from the command palette, and from **Agents, commands and skills…** in a project's menu
in Settings → Projects) lists everything by tab (**Agents**, **Commands**, **Skills**) and source: **Personal**, **In
{project}** (pick the project at the top), **From plugins** and **Built-in**.

- **New agent / command / skill** opens an editor with fields for the header (name, description, tools, model, argument
  hint) and a Markdown editor for the body; it saves the same file format as above. Ctrl+Enter (⌘Enter on macOS) saves.
  Tab in the body editor moves to the next field (it does not indent).
- **Edit**, **Duplicate**, **Export .md** (download the file), **Turn off / Turn on** and **Delete** (with Undo) are in
  each personal row's menu.
- **Import…** reads a `.md` file (an agent, command or skill from a repository or from Claude Code; up to 64 KB) into
  the editor, with notes about what was ignored; check it and save.
- **Project and plugin definitions are read-only** here: **View** shows the file, **Copy to personal** makes an
  editable copy, **Export .md** downloads it. Edit project files in the repository.
- Personal definitions are part of every backup (Settings → Data → Export); **Restore settings from the backup** brings
  them back on import (one you already have with the same name is kept). Delete all data keeps them.
- At most 200 personal definitions of each kind.

## 5. Using them in the chat

- **Commands**: type `/`. The menu groups the commands: **App** (built-in, `/remember`, `/compact`), **Project**,
  **Personal** and **Plugins**. After you pick one, a faded hint shows its arguments. Project commands appear only in
  that project's chats; a command file saved on disk shows up when you open the menu again (it can take up to half a
  minute). The bubble's badge tells where the command came from and which model it asked for.
- **Agents**: the main agent decides when to use one; mention it by name to ask for it. Each runs as a sub-agent block
  with its name; it never asks you for approval (a call that would need it is skipped), like every sub-agent.
- **Skills**: the main agent loads them; the "Loaded skill" row shows what it read.
- **Changes to files** made by custom agents are journaled like the main agent's: **Rewind files to here** and the
  changes panel cover them.

## 6. Claude Code files: what is used, what is ignored, and why

harness-forge reads `.claude/agents`, `.claude/commands` and `.claude/skills` of a project directly. Most files work
unchanged; these are the differences:

| In the file | harness-forge | Why |
|---|---|---|
| tool names `Read`, `Write`, `Edit`, `MultiEdit`, `Grep`, `Glob`, `LS`, `Bash`, `WebFetch` | mapped to `read_file`, `write_file`, `edit_file`, `edit_file`, `search_files`, `find_files`, `list_directory`, `shell`, `web_fetch`; `mcp__…` names kept | same tools, other names |
| other tool names (`Task`, `TodoWrite`, `NotebookEdit`, …) | left out with a warning ("Unknown tool") | there is no such tool, and a sub-agent never gets the agent tools |
| `Bash(git:*)`-style patterns | the tool (`shell`) is kept, the pattern is ignored with a warning; every shell call still asks unless your shell rules allow it | harness-forge has its own shell rules (Settings → Projects) |
| a `tools` value that is neither text nor a list | **no tools** at all, with a warning | a broken list must not grant everything |
| `allowed-tools` of a command | **narrows** the turn's tools; it does **not** pre-approve them | in Claude Code it pre-approves; a cloned repository must not be able to approve the shell for you |
| `model: sonnet` / `opus` / `haiku` | the default model is used (a note says so) | harness-forge uses explicit model refs (`provider:model`), any provider |
| `model: inherit` | the chat's model | same meaning |
| lines starting with `!` in a command (`!git status`) | left as text; **never run** | a command file must not run programs |
| `@path` in a command (`@src/main.ts`) | left as text; **never expanded** | ask the agent to read the file, or mention it with `@` in the composer |
| other header keys (`color`, `permissionMode`, `hooks`, …) | ignored (listed as "Ignored" in the editor) | not supported; a file can never change the permission mode |
| YAML anchors and aliases (`&x`, `*x`) | the header is read line by line instead, aliases are not expanded (a warning) | protects against oversized headers |
| `~/.claude/…` (your home folder) | not read | use Settings → Customize (or Import…) for personal definitions |
| sub-agents that start sub-agents | not supported (depth 1) | the same rule as for the built-in sub-agents |
| skills as `/skill-name` commands | not in v1.6 | the agent loads skills itself |

## 7. Trust: what a definition can and cannot do

Definition files come with repositories you clone, so harness-forge treats them like `AGENTS.md`: their **text** can
steer the model (check what a repository ships), but they can **never give themselves rights**:

- a `tools` or `allowed-tools` list only removes tools; it never adds one, never approves a call, never changes the
  permission mode, never creates a tool override or a shell rule;
- `model` works only with providers you connected;
- command bodies never run programs or read files by themselves;
- the agent cannot quietly rewrite them: writing to `.harness/` or `.claude/` always asks, even in Accept edits (reading
  them does not);
- symbolic links, files larger than 64 KB, binary files and more than 200 files per folder are skipped; only `.harness/`
  and `.claude/` inside the project folder are read.

## 8. Background agents

The agent can start a sub-agent **in the background** (`task` with `background: true`): the call returns at once, the
reply goes on (or ends), and the **background agent** keeps working. When it is done, its report reaches the agent
**exactly once**:

- while the agent is still replying, at its next step (a dashed note "Background agent finished" appears in the reply);
- when the chat is idle, harness-forge starts a new turn by itself with the report (the note stands where your message
  would be, captioned "Sent to the agent"), and the agent continues from it;
- when an approval is pending, or the turn that started it was itself started by a background agent, the report waits
  for your next message.

**Above the composer**, the **Background agents** list shows what runs ("2 background agents · Find flaky tests ·
1m 12s"); open it for each agent's live steps, a **Stop** per agent and **Stop all**.

- **Stop in the composer (or Esc) does not stop background agents** (as in Claude Code). Use their own Stop. Deleting
  the chat or its project, Delete all data, a key rotation and stopping the server stop them too. A stopped agent still
  reports what it found.
- **Limits**: 3 at a time per chat and 10 on the server, 30 minutes and **Sub-agent max steps** each. They never ask for
  approval.
- **While one runs, its project is busy**: Rewind, Revert, Undo, deleting the project, moving the chat and deleting a
  message version wait until it ends ("Wait for the responses in this project to finish…"). Switching versions works.
- **A server restart** ends running background agents (they show as stopped: "The server restarted before the task
  finished."); their reports are delivered at the chat's next turn.
- Their file edits are journaled under the reply that started them (Rewind covers them); their cost is in the chat's
  totals and in each agent's report line.
- Share links never include background results.

## 9. Plan files

Turn on **Settings → General → Agent → Save approved plans**. When you approve a plan in a project chat (plan mode,
see [agent features](agent-features.md#2-plan-mode-look-first-then-change)), harness-forge writes it to
`.harness/plans/<date>-<title>.md` (for example `.harness/plans/2026-10-04-move-auth-to-server-sessions.md`; a name that
exists gets `-2`, `-3`, …).

- **Plan folder** changes the folder: a path inside the project, such as `docs/plans` (no `..`, not `.git`, at most 200
  characters).
- The plan row shows "Saved to <path>" with **Copy path** and **Show changes**; the file is listed in the changes panel,
  and **Rewind files to here** removes it.
- When the file cannot be written, the row says why; the approval goes on anyway.
- Off by default; chats without a project never save plans.

## 10. Remember

Type `/remember` (optionally followed by the note: `/remember Run pnpm check before every commit.`) and choose where to
save it:

| Target | Effect |
|---|---|
| **AGENTS.md in {project}** | adds the line `- <note>` at the end of the project's `AGENTS.md` (else `CLAUDE.md`; with neither, a new `AGENTS.md` is created). Listed in the changes panel; Rewind can remove it |
| **Instructions of {project}** | appends the note to the project's instructions (Settings → Projects → Edit instructions) |
| **Custom instructions** | appends the note to Settings → General → Custom instructions (every chat) |

The project targets work in project chats only. Notes are up to 2,000 characters; the instructions can hold 20,000
characters and `AGENTS.md` up to 1 MB. A linked (symbolic link) `AGENTS.md` is refused.

## 11. Limits

| What | Limit |
|---|---|
| A definition file | 64 KB, header 8 KB, description 1,024 characters, argument hint 100 characters, 64 tool names |
| Project folders | 200 files per folder, commands up to 3 subfolders deep, skills with up to 50 listed supporting files |
| Personal definitions | 200 per kind |
| Listed to the model | 30 agent types and 50 skills, descriptions cut at 250 characters |
| A command's expanded prompt | 64 KB |
| Background agents | 3 per chat and 10 per server at once, 30 minutes each, Sub-agent max steps; the latest 100 per chat are kept |
| `/remember` | 2,000 characters per note; `AGENTS.md` up to 1 MB; instructions up to 20,000 characters |
| Plan folder | a relative path inside the project, at most 200 characters |

Changes on disk show up within 10 seconds (Settings → Customize reads the folders again when it opens).

## 12. Troubleshooting

- **My project agent does not appear**: check Settings → Customize with the project selected. **Invalid** shows the
  reason; **Shadowed** names the winner; nothing at all means the file is not where it should be (`.harness/agents/x.md`,
  not deeper; `.md` only; not a symbolic link, and no link in `.harness` or `.harness/agents` either) or the project
  folder is unavailable.
- **A command shows in one chat but not another**: project commands exist only in that project's chats.
- **The command ran on the chat's model**: the command's `model` is not available (no key for that provider, an unknown
  model, or an image model); the reply's notice says so.
- **The custom agent did not get a tool from its list**: a sub-agent only gets tools that run without approval in the
  chat's mode. In Ask that means read-only tools; switch to Accept edits for file edits (shell commands also need a
  shell rule).
- **"Loaded skill" never happens**: the agent loads a skill only when its description matches the task. Make the
  description say when to load it, or ask: "Use the release-notes skill."
- **A background agent keeps running after I pressed Stop**: by design. Stop it in the Background agents list above the
  composer.
- **Rewind says the project is busy**: a background agent of a chat in the project is still running; stop it or wait.
- **`/remember` cannot save to the project**: the chat has no project (or it has not been sent yet); choose Custom
  instructions, or move the chat into a project.
