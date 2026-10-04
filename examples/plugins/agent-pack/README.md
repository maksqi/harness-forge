# Agent pack

A plugin that adds two sub-agent types and two skills (plugin API 1.4.0). It shows both ways to contribute them: one
agent and one skill are declared in `plugin.json`, and the other two are registered from code in `index.mjs`.

| | |
|---|---|
| Kind | code: `index.mjs` runs on the server, so it needs trust |
| Contributes | agents `code-reviewer` (manifest) and `docs-writer` (code); skills `commit-message` (manifest) and `changelog-entry` (code) |
| Permissions | none |
| Needs | a harness with plugin API 1.4.0 (`"engines": { "harness": "^1.4.0" }`) |

## Try it

1. Install this folder: **Plugins** -> **Install…** -> **Local folder** -> **Link**, then check **I trust …**
   (see [the examples README](../README.md#install-an-example)).
2. The plugin card reads "2 agents · 2 skills". Settings -> Customize lists the four entries under **From plugins**.
3. In a project chat with a tool-capable model, ask "Review my last changes with the code-reviewer agent". The main
   agent starts it with `task { type: 'code-reviewer', … }`. Ask "Write a commit message for these changes" and the
   agent loads the `commit-message` skill with the `skill` tool first.

## How it works

- `contributes.agents` and `contributes.skills` in `plugin.json` are declarative: the host validates and registers them
  when the plugin loads, and runs no code for them.
- `index.mjs` default-exports `{ setup(ctx) }`. `setup` calls `ctx.agents.register()` and `ctx.skills.register()` with
  the same fields. Both return a `Disposable`; the host removes everything when the plugin is disabled, reloaded or
  uninstalled.
- An agent's `instructions` follow the sub-agent preamble. Its `tools` list only **narrows** what the sub-agent may use
  in the chat's mode: `docs-writer` lists `write_file` and `edit_file`, but in the default **Ask** mode it still gets
  neither, because a sub-agent never gets a tool that would ask. `model: 'inherit'` runs it on the chat's model.
- A skill's `content` is returned by the `skill` tool when the agent loads it. Until then the model sees only the name
  and the description, so say **when** to load it.
- `harness-forge.d.ts` holds the plugin API types for your editor (`// @ts-check` + JSDoc). The host ignores it.

## Adapt it

- Names use `a-z`, `0-9` and `-` (up to 64 characters) and are global: an agent or skill name that another plugin
  already registered is skipped and logged in this plugin's **Logs** tab. The built-in agents `explore` and `general`
  (and `general-purpose`) are reserved.
- A personal agent (Settings -> Customize) or a project file such as `.harness/agents/code-reviewer.md` with the same
  name wins over the plugin's entry, which is then listed as shadowed.
- Remove `main` and the code entry to get a declarative plugin that runs no code and needs no trust.
- See [PLUGINS.md](../../../docs/PLUGINS.md#agents-and-skills) for every field and limit.
