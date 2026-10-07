# Output styles

harness-forge v1.7 (ADR-051) adds **output styles**, as in Claude Code: a style changes **how the agent writes its
replies** (explaining its choices, teaching, staying terse) without touching your custom instructions. Pick one per
chat in the composer, set a default per project and a global default, or write your own.

Reference: [ARCHITECTURE.md 6.31](../ARCHITECTURE.md) (how the style reaches the model), [UI.md 7.32, 9.13](../UI.md)
(the composer menu and the Output styles tab), [PLUGINS.md](../PLUGINS.md#declarative-output-styles-plugin-api-150)
(styles in plugins). Agents, commands and skills are in [customizing the agent](customizing-agents.md); hooks and
project MCP servers in [hooks and project MCP servers](hooks-and-project-mcp.md).

## 1. The built-in styles

| Style | What it does |
|---|---|
| **Default** | the agent's usual replies; adds nothing to the instructions |
| **Explanatory** | the agent explains its choices and the code it touches as it works ("why this approach", the trade-offs, what to watch for) |
| **Learning** | the agent teaches as it works and asks you to write some parts yourself (it leaves small, clearly marked tasks for you) |

`default`, `explanatory` and `learning` are reserved names: a personal, project or plugin style cannot use them.

## 2. Choosing a style

- **In a chat**: the style button in the composer (after the effort menu; hidden for image models) opens the **Output
  style** menu. **Automatic** follows the project's style, else your default, and says which one it uses ("Uses
  Learning, set for harness-forge"); any other choice is kept **for this chat** and applies from the next reply. The
  button shows the style's name when it is not Default (an icon with a dot on phones).
- **With a command**: `/output-style` opens the menu, `/output-style learning` sets a style (a name or a label, in any
  case), `/output-style auto` (or `automatic`) goes back to Automatic. An unknown name shows "Unknown output style
  "{name}". Use auto, default, explanatory, learning or a style from the menu."
  `/output-style` is a built-in client command (a plugin command of that name is refused).
- **For a project**: Settings → Customize → **Output styles**, with the project selected at the top: **Style in
  {project}** ("Same as your default" clears it).
- **Your default**: Settings → General → **Output style** (also the scope bar of the Output styles tab without a
  project), or **Use by default** in a style's menu (with a project selected at the top, it sets that project's style
  instead).

**Selection order**: the chat's choice, else the project's style, else your default, else Default. A new chat starts on
Automatic. A style that is no longer available (a deleted file, a disabled plugin, a turned-off personal style) falls
back to Default for that reply, and the reply starts with the notice "The output style "{name}" is not available, so
the default style was used." (shown once per chat and model, not on every reply). A style that is no longer available
stays in the menus, marked "Not available".

## 3. Writing a style

A style is a Markdown file with a YAML header, like an agent or a skill:

```markdown
---
name: terse
description: Short, direct answers without filler.
keep-coding-instructions: true
---
Answer in as few words as the task allows.

- No introductions, no summaries of what you are about to do.
- Code first, then at most two sentences of explanation.
```

| Key | Meaning |
|---|---|
| `name` | the style's name; written any way (`Terse Answers`), it becomes a slug (`terse-answers`: lower case, accents removed, every run of other characters becomes `-`; at most 64 characters) and the original is kept as the label the menu shows (at most 128 characters); without `name`, the file name is used |
| `description` | shown under the name in the composer menu and in Customize; optional: without it, the first line of the body is used |
| `keep-coding-instructions` | optional, default `false`; section 4 |
| body | the style's instructions (at most 64 KB for the whole file) |

Where styles live (a higher source wins a name; the others are listed as **Shadowed**):

| Source | Where |
|---|---|
| Built-in | Default, Explanatory, Learning |
| Plugins | `contributes.outputStyles` or `ctx.outputStyles.register` (plugin API 1.5.0 and later); a Claude Code plugin's `output-styles/*.md` (v1.8, named `<plugin>:<name>`: [Claude Code plugins](claude-code-plugins.md)) |
| Personal | Settings → Customize → **Output styles** → **New output style** (or **Import…** a `.md` file) |
| Project, `.claude/` | `.claude/output-styles/*.md` in the project folder |
| Project, `.harness/` | `.harness/output-styles/*.md` (wins over everything) |

Project style files are read like every project definition: only those two folders, no symbolic links, at most
200 files of 64 KB each; a broken file is listed as **Invalid** with the reason, never used. Personal styles are part
of every backup (with the personal agents, commands and skills); Delete all data keeps them.

## 4. Where the style goes, and `keep-coding-instructions`

The style's instructions go **first** in the main agent's instructions, after the line `Output style: <label>`, before
your custom instructions, the project's instructions and everything else. **Sub-agents never get a style**: they keep
reporting plainly to the main agent.

harness-forge's own instructions include **coding instructions**: the rules for the project's file and shell tools,
and the hints for the todo list and sub-agents. A style chooses whether they stay:

- `keep-coding-instructions: true` keeps them: use it for styles that only change the tone or the format of replies
  while the agent still works on code (all three built-ins keep them).
- `keep-coding-instructions: false` (the default, as in Claude Code) drops them while the style is used: the agent
  still has its tools, but it is no longer told how harness-forge wants them used. Use it for styles that turn the agent
  into something else than a coding assistant (a writing coach, a reviewer of prose).

The project line, the plan-mode block and the lists of agent types and skills stay either way.

## 5. Claude Code compatibility

Claude Code style files work as they are when you put them into `.claude/output-styles/` of a project (or import them
into Settings → Customize). Differences: harness-forge never reads `~/.claude/output-styles` by itself (copy your
personal styles, and the `outputStyle` of your `settings.json` as the global default, with
[Import from Claude Code](claude-code-import.md)), and a chat's choice is remembered per chat instead of per folder.

## 6. Troubleshooting

- **My project style is not in the menu**: check Settings → Customize → Output styles with the project selected:
  **Invalid** shows the reason (no description and an empty body, a reserved name, a file over 64 KB), **Shadowed**
  names the winner; the file must be directly in `.harness/output-styles/` or `.claude/output-styles/` and end in `.md`.
- **The style does not seem to apply**: it applies from the next reply after you choose it; Automatic may be using the
  project's style (the menu says which); a sub-agent's report never follows it.
- **The agent forgot how to use the tools**: the style has `keep-coding-instructions: false`; set it to `true`.
- **A notice says the style is not available** ("The output style "{name}" is not available, so the default style was
  used."): the chosen style is gone, turned off or unreadable, so Default answered; pick another one or switch back to
  Automatic.
