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

v1.7 (ADR-051, ADR-052) adds: commands whose `` !`cmd` `` lines run and whose `@path` references are inlined (section 2;
for a project's command files only after you approve them), skills you run yourself as `/skill-name` (section 2),
**output styles** (a fourth kind, [output styles](output-styles.md)) and **hooks** and project **`.mcp.json`** servers
([hooks and project MCP servers](hooks-and-project-mcp.md)).

v1.8 (ADR-055, ADR-056, ADR-058) adds: Claude Code's newer header keys (agents `disallowedTools`, `maxTurns`, `color`,
`skills`; commands and skills `when_to_use`, `arguments`, `disallowed-tools`, `context: fork`; skills `allowed-tools`
and `model`; section 2), `$ARGUMENTS[0]` / `$0` and named arguments, Claude model names (`model: sonnet`) through
Settings → General → Agent, editing a project's files from Settings → Customize (**Edit…** on a project row, section 4),
copying your `~/.claude` folder with **Import from Claude Code** ([guide](claude-code-import.md)) and Claude Code
plugins ([guide](claude-code-plugins.md)).

Reference: [ARCHITECTURE.md 6.23 – 6.27](../ARCHITECTURE.md#623-customization-catalog-adr-044) (how it works) and
[10.11](../ARCHITECTURE.md#1011-agent-customization-security-phase-10-adr-044--adr-047) (security),
[UI.md 7.28 – 7.30, 9.12](../UI.md#912-customize-settingscustomize-w108-phase-10) (the screens),
[PLUGINS.md](../PLUGINS.md#declarative-agents-plugin-api-140) (agents and skills in plugins), [API.md](../API.md) (the
`customizations`, `memory` and `chatTasks` routes). The features of v1.5 (plan mode, sub-agents, the queue) are in
[agent features](agent-features.md).

## 1. Where definitions live

| Source | Where | Edited in | Wins over |
|---|---|---|---|
| Built-in | the agents `explore` and `general`; the commands `/compact`, `/new`, `/model`, `/effort`, `/mode`, `/help`, `/remember` (v1.7: `/output-style`); the output styles Default, Explanatory, Learning (v1.7) | — (reserved names) | — |
| Plugins | the agents, skills and commands an installed plugin contributes (`contributes.agents` / `contributes.skills` / `contributes.commands` of its manifest, or registered by its code) | the plugin | built-in |
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
    output-styles/
      terse.md                      v1.7: an output style (see the output styles guide)
    settings.json                   v1.7: only its "hooks" are read, after approval (see the hooks guide); also
                                    settings.local.json
  .claude/
    agents/ commands/ skills/       the same layout, lower precedence (v1.7: also output-styles/ and settings.json)
  .mcp.json                         v1.7: the project's MCP servers, after approval (see the hooks guide)
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

- **Names**: agents and skills use `a-z`, `0-9` and `-`, start with a letter, at most 64 characters; commands at most
  32. Upper-case letters are lowered (`Code-Reviewer` → `code-reviewer`). Without `name`, the file name is used
  (`review.md` → `review`), or for a skill its folder name.
- **Description**: required for agents and skills, recommended for commands (the slash menu shows it; without one, the
  first line of the body is used). The agent **reads** the descriptions of agents and skills to decide when to use
  them, so say *when*: "Use it after larger edits.", "Load it before writing release notes." Longer than 1,024
  characters is cut.
- **Size**: at most 64 KB per file, the header at most 8 KB. Text only: a larger or binary file is listed as
  **Invalid**.
- **Lists**: `tools` and `allowed-tools` take a comma-separated string (`Read, Grep, Glob`), a space-separated one
  (`Read Grep Glob`) or a YAML list. `mcp__github__*` matches every tool whose name starts with it, and
  `mcp__github` every tool of that MCP server.
- Problems never break anything: a file that cannot be used is listed as **Invalid** with the reason ("Line 2: Add a
  description."), and warnings ("Unknown tool: foo; it matches nothing.") are shown next to the definition. A header
  that is not valid YAML but has plain `key: value` lines is read line by line: the definition still works, with a
  warning.

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
| `tools` | optional: the only tools this agent may use (harness names such as `read_file`, or Claude Code names, section 6). It can only **narrow** what a sub-agent may use in the chat's current mode: a tool that can only ask there is never offered, and a tool that decides per call (file edits, the shell) runs only the calls that need no approval (in Accept edits: file edits, and the shell commands your shell rules allow; every other call is denied). It never gets the agent tools (`task`, `skill`, `todo_write`, …) or `generate_image`. Without `tools`, it gets everything a sub-agent may use in that mode |
| `model` | optional: a model ref such as `openai:gpt-6` (used when that provider is connected; else the default below, with a warning), or `inherit` (the chat's model; the editor's **Same as the chat**). Without it: Settings → General → Agent → **Sub-agent model**, else the chat's model. v1.8: also a Claude model name (`sonnet`, `opus`, `haiku`, `fable`) or a full `claude-*` id, resolved through Settings → General → Agent → **Claude model names** |
| `disallowedTools` (v1.8) | optional: tools removed before `tools` narrows the set (`Bash(rm *)` removes the whole `shell` tool) |
| `maxTurns` (v1.8) | optional, 1–200: at most this many steps (the **Sub-agent max steps** setting still applies, the smaller wins) |
| `color` (v1.8) | optional: `red`, `blue`, `green`, `yellow`, `purple`, `orange`, `pink` or `cyan`; marks the agent's blocks in the chat |
| `skills` (v1.8) | optional, up to 5 skill names: their content is added to the agent's instructions when it starts (up to 32 KB) |
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
| `model` | optional: this turn runs on that model; the chat keeps its own model (which must still be usable: it is checked first). When the command's model is not available (no key, unknown, an image model), the chat's model answers and the reply starts with "The command's model … is not available, so the chat's model answered." |
| `allowed-tools` | optional: the tools of this turn are limited to this list (also for the approvals and regenerations of the turn). It never approves anything: calls still ask as the permission mode says. List `task` or `skill` too when the turn should start sub-agents or load skills; in plan mode `exit_plan_mode` always stays |
| body | the prompt (required) |
| `$ARGUMENTS` | everything you typed after `/review ` |
| `$1` … `$9` | single words of it; quotes group words (`/review "src/a b.ts" naming` → `$1` = `src/a b.ts`) |
| `$ARGUMENTS[0]`, `$0`, `$name` (v1.8) | Claude Code's newer forms: a file that uses `$0` or `$ARGUMENTS[` or declares `arguments: [file, focus]` counts words **from 0** (`$0` = the first word, `$file` = the word named `file`); every other file keeps `$1` as the first word, so v1.6 – v1.7 commands expand as before; `\$` writes a literal `$` |
| `when_to_use`, `disallowed-tools`, `context: fork` + `agent` (v1.8) | `when_to_use` is added to the description; `disallowed-tools` removes tools for the turn; `context: fork` runs the command (or skill) as a sub-agent of type `agent` (default `general`) and only its report comes back |
| `{{input}}` | same as `$ARGUMENTS` (the syntax of plugin templates) |
| no placeholder | your text is added after the body, separated by a blank line |
| `` !`cmd` `` (v1.7) | runs `cmd` in the project folder before the model is called; its output replaces the span (section below) |
| `@path` (v1.7) | inlines the project file `path` (`@README.md`, `@src/config.ts`) after the prompt; quote a path that is followed by punctuation (`@"README.md",`) |

**Shell lines and file references** (v1.7, ADR-052). A command can gather context before the model answers:

```markdown
---
description: Summarize the working tree
---
Here is the current state of the repository:

!`git status --short`
!`git log --oneline -5`

Summarize what changed and what is left to do. Follow the conventions in @"CONTRIBUTING.md".
```

- A span is `` !`command` `` on one line (no backtick inside). Spans run one after the other in the project folder,
  through the same shell as the agent's `shell` tool, with its minimal environment plus `HARNESS_PROJECT_DIR` and
  `CLAUDE_PROJECT_DIR` (the project folder): 30 s each, 60 s in total, at most 10 per command (later spans stay text).
  The output is stdout then stderr (the start and the end of each), cut to 16 KB with `[output truncated]`; a timeout
  adds `[timed out]`, a non-zero exit code `[exit code N]`, and a span past the time budget is replaced by
  `[skipped: time limit]`.
- `@path` (a path with a `.` or `/`, outside spans) inlines that project file, at most 32 KB each (a longer one is cut)
  and 10 per command: the `@path` text stays where it is and the file is added after the prompt and your arguments as
  a `<file path="…">` block (a binary file as `[binary file not inlined]`). Secret-looking paths (`.env`, keys), `.git`
  paths, files outside the project and symbolic links are refused; a missing or refused file stays as text. An unquoted
  path runs to the next blank, so punctuation right after it is part of the path (`@README.md,` looks for
  `README.md,`): add a blank or quote it, `@"README.md",`.
- Spans and `@path` inside a fenced code block stay text.
- **Your arguments never go inside a span**: the file is scanned before `$ARGUMENTS` and friends are replaced, so
  `/status ; rm -rf x` cannot inject a command.
- Spans and file references work **only in project chats** and only while the shell is on. A command with spans is
  refused in a chat without a project ("The /status command runs shell lines, which need a chat in a project."), when
  the project folder is not available ("The /status command runs shell lines, but the project folder of this chat is
  not available.") and with `HF_WORKSPACE_SHELL=0` ("The /status command runs shell lines, but shell commands are
  turned off on this server (HF_WORKSPACE_SHELL=0)."); without a project, `@path` simply stays text. Spans run in every
  permission mode (typing the command is your explicit request), after the `SessionStart` / `UserPromptSubmit` hooks:
  those hooks see what you typed and the command's name (never the expansion), and when one refuses the message no
  span runs and no file is read. The checks above come first, and a project command's approval is checked again right
  before its spans run. A command whose prompt would be
  larger than 64 KB even with empty span outputs is refused before any span runs.
- **Trust**: your personal commands and the `template` commands of loaded plugins run their spans directly (a
  declarative plugin with spans needs the plugin trust step first; the prompt a plugin's `run` command returns is not
  scanned); a **project's** command file with spans runs them only after you **approve** it in the project's review
  dialog (the same one as project hooks; the approval pins the file's spans, and the scripts they name, by hash; any
  change needs a new approval; a file with a span longer than 4,096 characters is never listed, so it can never be
  approved). An unapproved one is refused in the composer ("/status runs shell lines you haven't approved. Review the
  project's files to run it." with **Review…**); your text stays.
- The result is **frozen** into the message: regenerating the reply or answering an approval reuses it, the spans never
  run twice. Span output is not journaled (like a command you type in a terminal).
- A personal command with spans restored from a backup comes back **turned off**: check it, then turn it on.

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
| `user-invocable` (v1.7) | optional, default `true`: the skill is also listed in the slash menu as `/name` |
| `disable-model-invocation` (v1.7) | optional, default `false`: `true` keeps the skill away from the agent (not listed to it, not loadable with the `skill` tool); it runs only when you type `/name` |
| `argument-hint` (v1.7) | optional: shown after `/name` while you type its arguments |
| `allowed-tools`, `model`, `when_to_use`, `arguments`, `disallowed-tools`, `context: fork` + `agent` (v1.8) | as for commands; `${CLAUDE_SKILL_DIR}` in the body is the skill's folder |
| body | the skill; the agent reads it when it loads the skill |
| other files in the folder | supporting files (up to 50 are listed, three folders deep; hidden, secret-looking and gitignored files, `node_modules`, links and the `SKILL.md` itself are left out). The agent gets the folder's path and reads them with `read_file`, without asking. They are listed only while the project folder is available |

The agent sees the names and descriptions of the skills (up to 50) and loads one with the `skill` tool when a task
matches; the chat shows a row "Loaded skill release-notes". Since v1.7 you can also run a skill yourself: type
`/release-notes [what you want]` (the slash menu lists skills in its **Skills** group); your text is added to the
skill's content like a command's arguments (`$ARGUMENTS` works too; a skill's `!` spans and `@path` stay text), and the
badge on your message says it was a skill. Skill names may have up to 64 characters in the menu; when a command and a
skill share a name, the command wins. A personal or plugin skill is one file: put everything it needs in its body.

## 3. Precedence, duplicates and reserved names

- **Same name, different sources**: project `.harness/` > project `.claude/` > personal > plugin > built-in. The winner
  is used; the others are listed as **Shadowed** ("Not used: the project's .harness/agents/code-reviewer.md wins.").
- **Same name in one folder** (two command files `review.md` in different subfolders): the first path in alphabetical
  order wins; the other is listed as **Shadowed** with a warning ("Not used: .harness/commands/a/review.md has the same
  name and comes first in .harness/commands.").
- **Reserved**: agents `explore`, `general` and `general-purpose` (Claude Code's name for `general`, which the agent may
  use); commands `/compact`, `/new`, `/model`, `/effort`, `/mode`, `/help`, `/remember` and (v1.7) `/output-style`. A
  definition with such a name is **Invalid**. (A plugin command named `remember` is refused since v1.6, one named
  `output-style` since v1.7.)
- **A command and a skill with the same name** (v1.7): the command wins in the slash menu; the skill can still be
  loaded by the agent.
- **Turned off** personal definitions are listed as **Off** and shadow nothing.

## 4. Personal definitions: Settings → Customize

**Settings → Customize** (also from the command palette, and from **Agents, commands and skills…** in a project's menu
in Settings → Projects) lists everything by tab (**Agents**, **Commands**, **Skills**) and source: **Personal**, **In
{project}** (pick the project at the top), **From plugins** and **Built-in**.

- **New agent / command / skill** opens an editor with fields for the header (name, description, tools, model, argument
  hint) and a Markdown editor for the body; it saves the same file format as above. **Tools** is "All tools the chat
  allows" (commands: "No restriction") or **Only these tools**; an agent's **Model** has a **Same as the chat**
  checkbox (`model: inherit`). Ctrl+Enter (⌘Enter on macOS) saves. Tab in the body editor moves to the next field (it
  does not indent).
- **Edit**, **Duplicate**, **Export .md** (download the file), **Turn off / Turn on** and **Delete** (with Undo) are in
  each personal row's menu.
- **Import…** reads a `.md` file (an agent, command or skill from a repository or from Claude Code; up to 64 KB) into
  the editor, with notes about what was ignored; check it and save.
- **Project and plugin definitions are read-only** here: **View** shows the file, **Copy to personal** makes an
  editable copy, **Export .md** downloads it (and **Open plugin** opens a plugin's page). Edit project files in the
  repository. v1.8: a project row's **Edit…** (and **Edit** in the viewer) opens the file itself in an editor: the raw
  file is saved as you wrote it (keys harness-forge does not know stay), checked first, and refused with "{file} changed
  on disk after you opened it." when the file changed meanwhile (**Load from disk** or **Overwrite**); **New file…** in
  the project's section creates one in `.harness/` or `.claude/`, and **Delete…** removes one. Saving never approves a
  command's `!` lines: they wait for the review ("Saved {path}. 1 item needs your approval." → **Review**). Folder problems (a symbolic link that was skipped, a folder over the limit) show as notes above the
  project's list.
- A plugin's agents and skills are also listed on its page in the **Plugins** tab (the filter **Agents and skills**
  finds such plugins), with **Open in Customize**.
- Personal definitions are part of every backup (Settings → Data → Export); **Restore settings from the backup** brings
  them back on import (one you already have with the same name is kept). Delete all data keeps them.
- At most 200 personal definitions of each kind.
- v1.7 adds two tabs: **Output styles** ([output styles](output-styles.md)) and **Hooks**
  ([hooks and project MCP servers](hooks-and-project-mcp.md)); the skill editor gains **Show in the slash menu**
  (`user-invocable`) and **Only when you run it** (`disable-model-invocation`), and project command rows with `!` lines
  show **Needs approval** with **Review…**.

## 5. Using them in the chat

- **Commands**: type `/`. The menu groups the commands: **App** (built-in, `/remember`, `/compact`; v1.7
  `/output-style`), **Project**, **Personal**, **Plugins** and (v1.7) **Skills**. A project command whose shell lines
  are not approved yet shows **Needs approval**. After you pick one, a faded hint shows its arguments. Project commands
  appear only in that project's chats; a command file saved on disk shows up when you open the menu again (it can take
  up to half a minute). The bubble's badge tells where the command came from and which model it asked for.
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
| other tool names (`Task`, `TodoWrite`, `NotebookEdit`, …) | match nothing, with a warning ("Unknown tool: Task; it matches nothing.") | there is no such tool, and a sub-agent never gets the agent tools |
| `Bash(git:*)`-style patterns | the tool (`shell`) is kept, the pattern is ignored with a warning; every shell call still asks unless your shell rules allow it | harness-forge has its own shell rules (Settings → Projects) |
| a `tools` value that is neither text nor a list | **no tools** at all, with a warning | a broken list must not grant everything |
| `allowed-tools` of a command | **narrows** the turn's tools; it does **not** pre-approve them | in Claude Code it pre-approves; a cloned repository must not be able to approve the shell for you |
| `model: sonnet` / `opus` / `haiku` | v1.8: the model you chose for that name in Settings → General → Agent → **Claude model names** (a full `claude-*` id uses the Anthropic provider); a name you did not set: an agent uses the default sub-agent model, a command the chat's model (a note says so) | harness-forge works with any provider, so you pick what each name means |
| `model: inherit` | the chat's model | same meaning |
| a header that is not valid YAML | read line by line when it has plain `key: value` lines (a warning; the definition stays usable), else **Invalid** | Claude Code is lenient with hand-written headers |
| `` !`git status` `` spans in a command | v1.7: **run** in the project folder before the model call, for personal and trusted plugin commands, and for a project's command files only after you approve them (section 2); v1.6 left them as text | a repository must not run programs without your consent |
| `@path` in a command (`@src/main.ts`) | v1.7: the project file is **inlined** (project chats only; secret-looking paths refused); v1.6 left it as text | the same guard as the agent's file tools |
| other header keys | v1.8 uses `disallowedTools`, `maxTurns`, `color`, `skills`, `when_to_use`, `arguments`, `disallowed-tools`, `context: fork` + `agent` and skill `allowed-tools` / `model`; `permissionMode`, `hooks`, `mcpServers`, `memory`, `background`, `effort`, `isolation`, `initialPrompt`, `paths`, `shell` and `metadata` are ignored (listed as "Ignored" in the editor) | not supported; a file can never change the permission mode |
| YAML anchors and aliases (`&x`, `*x`) | the header is read line by line instead, aliases are not expanded (a warning) | protects against oversized headers |
| `~/.claude/…` (your home folder) | not read by chats; v1.8: copied once into your personal definitions with **Import from Claude Code** ([guide](claude-code-import.md)) | your personal setup lives in harness-forge's database |
| sub-agents that start sub-agents | not supported (depth 1) | the same rule as for the built-in sub-agents |
| skills as `/skill-name` commands | v1.7: yes (`user-invocable`, default on; `disable-model-invocation` hides a skill from the agent); not in v1.6 | — |
| `.claude/settings.json` `hooks`, `.mcp.json` | v1.7: used after approval ([hooks and project MCP servers](hooks-and-project-mcp.md)); the other keys of `settings.json` are ignored | a repository must not grant permissions or environment variables |
| `.claude/output-styles/*.md` | v1.7: used ([output styles](output-styles.md)) | — |

## 7. Trust: what a definition can and cannot do

Definition files come with repositories you clone, so harness-forge treats them like `AGENTS.md`: their **text** can
steer the model (check what a repository ships), but they can **never give themselves rights**:

- a `tools` or `allowed-tools` list only removes tools; it never adds one, never approves a call, never changes the
  permission mode, never creates a tool override or a shell rule;
- `model` works only with providers you connected;
- command bodies never run programs by themselves: since v1.7 a project command's `` !`cmd` `` spans run only after you
  approve that file (pinned by hash; any change needs a new approval), and `@path` reads only project files through the
  agent's path guard (no secret-looking paths, no `.git`, no links, nothing outside the project; it needs no
  approval);
- the agent cannot quietly rewrite them: writing to `.harness/` or `.claude/` always asks, even in Accept edits (reading
  them does not); v1.8: you can edit them in Settings → Customize, and a save never approves what they run;
- symbolic links (and anything reached through one), hidden and secret-looking file names and the files past 200 per
  folder are skipped; files larger than 64 KB and binary files are listed as **Invalid** and never used; only
  `.harness/` and `.claude/` inside the project folder are read.

## 8. Background agents

The agent can start a sub-agent **in the background** (`task` with `background: true`): the call returns at once, the
reply goes on (or ends), and the **background agent** keeps working. When it is done, its report reaches the agent
**exactly once**:

- while the agent is still replying, at its next step (a dashed note "Background agent finished" appears in the reply);
- when the chat is idle, harness-forge starts a new turn by itself with the report (the note stands where your message
  would be, captioned "Sent to the agent"), and the agent continues from it;
- when an approval is pending, the turn that started it was itself started by a background agent, the agent was
  stopped, or the chat's model is an image model, the report waits for your next message.

**Above the composer**, the **Background agents** list shows what runs ("2 background agents · Find flaky tests ·
1m 12s") and finished agents whose report was not delivered yet ("1 background agent finished · report pending"); open
it for each agent's live steps, a **Stop** per agent and **Stop all**.

- **Stop in the composer (or Esc) does not stop background agents** (as in Claude Code). Use their own Stop. Deleting
  the chat or its project, Delete all data, a key rotation and stopping the server stop them too. A stopped agent still
  reports what it found, at the chat's next turn (deleting the chat drops it).
- **Limits**: 3 at a time per chat and 10 on the server, 30 minutes and **Sub-agent max steps** each. They never ask for
  approval.
- **While one runs, its project is busy**: Rewind, Revert, Undo, deleting the project, moving the chat and deleting a
  message version wait until it ends ("Wait for the responses in this project to finish…"). Switching versions works.
- **A server restart** ends running background agents; they are never resumed. Stopping the server ends them as stopped
  ("The background task was stopped."); after a crash they show as stopped with "The server restarted before the task
  finished.". Their reports, and every report not delivered yet, are delivered at the chat's next turn (no turn starts
  by itself after a restart).
- Their file edits are journaled under the reply that started them (Rewind covers them); their cost is in the chat's
  totals and in each agent's report line.
- Share links never include background results.

## 9. Plan files

Turn on **Settings → General → Agent → Save approved plans**. When you approve a plan in a project chat (plan mode,
see [agent features](agent-features.md#2-plan-mode-look-first-then-change)), harness-forge writes it to
`.harness/plans/<date>-<title>.md` (for example `.harness/plans/2026-10-04-move-auth-to-server-sessions.md`: the date in
UTC, the title from the plan's first heading, else its first line, in lower case, at most 48 characters; a name that
exists gets `-2`, `-3`, … up to `-99`; an existing file is never overwritten).

- **Plan folder** changes the folder: a path inside the project, such as `docs/plans` (no `..`, not `.git`, at most 200
  characters; a symbolic link anywhere on it is refused).
- The plan row shows "Saved to <path>" with **Copy path** and **Show changes**; the file is listed in the changes panel,
  and **Rewind files to here** removes it.
- When the file cannot be written, the row says why ("Couldn't save the plan file: …"); the approval goes on anyway.
- Off by default; chats without a project never save plans.

## 10. Remember

Type `/remember` (optionally followed by the note: `/remember Run pnpm check before every commit.`) and choose where to
save it:

| Target | Effect |
|---|---|
| **AGENTS.md in {project}** (or **CLAUDE.md in {project}**; "AGENTS.md in {project} (new file)" when there is neither) | adds the line `- <note>` at the end of the project's `AGENTS.md` (else `CLAUDE.md`; with neither, a new `AGENTS.md` is created), in the project folder itself. Listed in the changes panel; Rewind and Revert can remove it |
| **Instructions of {project}** | appends the line `- <note>` to the project's instructions (Settings → Projects → Edit instructions) |
| **Custom instructions** | appends the line `- <note>` to Settings → General → Custom instructions (every chat) |

The project targets work in saved chats of a project only; elsewhere they are disabled with "Open a chat in a project
to use this.". The dialog remembers the last target you saved to. Notes are up to 2,000 characters; the instructions can
hold 20,000 characters and `AGENTS.md` up to 1 MB. An `AGENTS.md` / `CLAUDE.md` that is a symbolic link, a folder or a
binary file is refused.

## 11. Limits

| What | Limit |
|---|---|
| A definition file | 64 KB, header 8 KB, description 1,024 characters, argument hint 100 characters, 64 tool names |
| Project folders | 200 definitions per folder, commands up to 3 subfolders deep (100 subfolders), skills with up to 50 listed supporting files |
| Personal definitions | 200 per kind |
| Listed to the model | 30 agent types and 50 skills, descriptions cut at 250 characters |
| A command's expanded prompt | 64 KB (v1.7: also checked with empty span outputs before any span runs) |
| A command's `!` spans (v1.7) | 10 per command, 30 s each, 60 s in total, 16 KB of output each (stdout then stderr, the start and end of each) |
| A command's `@path` files (v1.7) | 10 per command, 32 KB each |
| Background agents | 3 per chat and 10 per server at once, 30 minutes each, Sub-agent max steps; the latest 100 per chat are kept |
| `/remember` | 2,000 characters per note; `AGENTS.md` up to 1 MB; instructions up to 20,000 characters |
| Plan folder | a relative path inside the project, at most 200 characters |

Changes on disk show up within 10 seconds (Settings → Customize reads the folders again when it opens).

## 12. Troubleshooting

- **My project agent does not appear**: check Settings → Customize with the project selected. **Invalid** shows the
  reason; **Shadowed** names the winner; a note above the project's list names a skipped symbolic link or a folder over
  the limit; nothing at all means the file is not where it should be (`.harness/agents/x.md`, not deeper; `.md` only;
  not a hidden or secret-looking name such as `secrets.md`) or the project folder is unavailable.
- **A command shows in one chat but not another**: project commands exist only in that project's chats.
- **"/name runs shell lines you haven't approved. Review the project's files to run it."** (v1.7): the project's command
  file has `!` spans; press **Review…**, check the commands and approve the file (it is pending again after every change
  to it).
- **A command with `!` lines is refused** with "The /name command runs shell lines, which need a chat in a project.",
  "The /name command runs shell lines, but the project folder of this chat is not available." or "The /name command
  runs shell lines, but shell commands are turned off on this server (HF_WORKSPACE_SHELL=0).": spans need a project
  chat whose folder is available and `HF_WORKSPACE_SHELL` on.
- **An `@path` was not inlined**: the path must hold a `.` or `/`, exist in the project, and not be secret-looking, a
  `.git` path or a link; punctuation glued to it is part of the path (write `@"README.md",`).
- **The command ran on the chat's model**: the command's `model` is not available (no key for that provider, an unknown
  model, or an image model); the reply's notice says so.
- **The custom agent did not get a tool from its list**: a sub-agent only gets tools that run without approval in the
  chat's mode. In Ask that means read-only tools; switch to Accept edits for file edits (it gets `shell` there too, but
  only the commands your shell rules allow run; the others are denied).
- **A command's turn could not start a sub-agent or load a skill**: its `allowed-tools` leaves `task` / `skill` out; add
  them to the list.
- **"Loaded skill" never happens**: the agent loads a skill only when its description matches the task. Make the
  description say when to load it, or ask: "Use the release-notes skill."
- **A background agent keeps running after I pressed Stop**: by design. Stop it in the Background agents list above the
  composer.
- **Rewind says the project is busy**: a background agent of a chat in the project is still running; stop it or wait.
- **`/remember` cannot save to the project**: the chat has no project (or it has not been sent yet); choose Custom
  instructions, or move the chat into a project.
