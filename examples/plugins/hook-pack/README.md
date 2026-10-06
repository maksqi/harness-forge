# Hook pack

A declarative plugin that adds one command hook and one output style (plugin API 1.5.0). After the agent writes or
edits a file, the hook reminds it to run the project tests; the `reviewer` style makes the agent answer like a careful
code reviewer.

| | |
|---|---|
| Kind | declarative, but its hook runs a shell command, so it **needs trust** (like a plugin with a stdio MCP server) |
| Contributes | a `PostToolUse` command hook (matcher `Write\|Edit\|MultiEdit`), the output style `reviewer` |
| Permissions | none |
| Needs | a harness with plugin API 1.5.0 (`"engines": { "harness": "^1.5.0" }`), POSIX `sh` on the server |

## Try it

1. Install this folder: **Plugins** -> **Install…** -> **Local folder** -> Link or Copy, then check **I trust …**
   (see [the examples README](../README.md#install-an-example)). The trust warning lists the command it runs:
   `sh "$HARNESS_PLUGIN_ROOT/scripts/remind-tests.sh"`.
2. The plugin card reads "1 hook · 1 output style". Settings -> Customize lists the hook under **Hooks -> From plugins**
   and the style under **Output styles -> From plugins**.
3. In a project chat with a tool-capable model, ask the agent to change a file. After `write_file` or `edit_file`
   succeeds, the reply shows the note "Hook added context · PostToolUse" and the agent reads the reminder at its next
   step.
4. Pick **reviewer** in the composer's style menu (or type `/output-style reviewer`) and ask for a review.

## How it works

- `contributes.hooks` is the `hooks` object of a Claude Code `settings.json`. The matcher uses Claude Code names:
  `Write` and `Edit` / `MultiEdit` match the harness tools `write_file` and `edit_file`.
- The hook runs like your own hooks: in the chat's project folder (else a private folder), with the event as JSON on
  stdin, through the server's shell runner (its own process group, a minimal environment, a 10 second timeout here).
  `HARNESS_PLUGIN_ROOT` and `CLAUDE_PLUGIN_ROOT` hold this plugin's folder, `HARNESS_PROJECT_DIR` and
  `CLAUDE_PROJECT_DIR` the working folder.
- `scripts/remind-tests.sh` reads the event from stdin (and ignores it) and prints a `PostToolUse` answer whose
  `additionalContext` the agent reads at its next step. It needs nothing but POSIX `sh` (no `jq`).
- `contributes.outputStyles` adds `reviewer`. Its `content` goes first in the main agent's instructions while the style
  is used (never into a sub-agent's); `keepCodingInstructions: true` keeps the harness's coding instructions (the
  workspace tool rules and the todo / task hints).

## Trust and kill switches

- The trust pin covers `plugin.json` only. Editing `plugin.json` makes the plugin untrusted until you trust it again;
  editing `scripts/remind-tests.sh` does **not**. Ship scripts you are ready to vouch for.
- The hook runs only while the plugin is active and trusted. Turning **Run hooks** off (Settings -> Customize -> Hooks),
  `HF_WORKSPACE_SHELL=0` or `HF_SAFE_MODE=1` stops it. Disabling the plugin also removes the style: a chat that used it
  falls back to Default with a notice.

## Adapt it

- Any of the eight events works the same way: `PreToolUse` can deny or rewrite a tool call, `UserPromptSubmit` can add
  context to a prompt or refuse it, `Stop` can ask the agent to go on. At most 50 handlers per plugin.
- A matcher is a name list (`Bash|Write`), `*` or `mcp__<server>__*`; regular expressions are not supported.
- Style names use `a-z`, `0-9` and `-` (up to 64 characters); `default`, `explanatory` and `learning` are the built-ins.
  A personal or project style with the same name wins over the plugin's.
- See [PLUGINS.md](../../../docs/PLUGINS.md#declarative-hooks-plugin-api-150) and
  [Hooks and project MCP servers](../../../docs/guides/hooks-and-project-mcp.md) for the full contract.
