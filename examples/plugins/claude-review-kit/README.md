# Claude review kit

A Claude Code plugin in **Claude Code's own layout** (plugin API 1.6.0): the same folder installs unchanged in Claude
Code and in harness-forge. Its `plugin.json` names the plugin `review-kit`, so every entry is qualified with that
namespace.

| | |
|---|---|
| Format | Claude Code plugin (`.claude-plugin/plugin.json`; no harness `plugin.json`) |
| Contributes | the commands `/review-kit:review` and `/review-kit:db:migrate`, the agent `review-kit:code-reviewer`, the skill `review-kit:checklist` (with a supporting file), the output style `review-kit:terse`, a `PostToolUse` command hook and the http MCP server `docs` (MCP id `review-kit`) |
| Settings | `Docs token` (a secret) and `Review focus` (from its `userConfig`) |
| Needs | trust (its hook runs a shell command), POSIX `sh` on the server, a harness with plugin API 1.6.0 |

## Try it

1. Install this folder: **Plugins** -> **Install…** -> **Local folder** (or zip it and use the **Zip** tab). The
   preview says **Claude Code plugin**, lists the hook command under the commands it runs and asks for the two settings.
   Check **I trust …**: the pin covers every file of the folder, `scripts/after-edit.sh` included.
2. Type `/review-kit:review src/app.ts` (or `/review` while no other command ends in `:review`). The body uses the
   **Review focus** setting (`${user_config.FOCUS}`).
3. Ask for a review with `task { type: 'review-kit:code-reviewer', … }`: the agent runs on the model chosen for `sonnet`
   under Settings -> General -> Agent ("Claude model names"), without `Bash`.
4. The `skill` tool loads `review-kit:checklist`; `skill { name: 'review-kit:checklist', file: 'reference.md' }` reads
   its supporting file.
5. In a project chat, after `write_file` or `edit_file`, the hook adds a reminder to review the change.

## How it works

- `commands/db/migrate.md` becomes `/review-kit:db:migrate` (a subfolder adds a segment); command bodies are Claude Code
  command files (`$ARGUMENTS`, `$0`, `$1`, …).
- `hooks/hooks.json` has the `"hooks"` wrapper of a hooks file. The handler is a shell-form command: the shell expands
  `${CLAUDE_PLUGIN_ROOT}` from the hook environment (the plugin folder).
- The MCP server is declared inline in `plugin.json` (there is no `.mcp.json`); `${user_config.DOCS_TOKEN}` reaches it
  as the setting `{{settings.DOCS_TOKEN}}`, never through a prompt or a log.
- Editing any file of the folder changes its trust hash, so the plugin needs trust again before it loads.
