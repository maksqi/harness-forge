# Dice roller

A code plugin in plain JavaScript (`index.mjs` with JSDoc types) that adds one tool, `roll_dice`. The model calls it
to roll dice in standard notation such as `1d20` or `2d6+3`.

| | |
|---|---|
| Kind | code: runs on the server, so it needs trust |
| Contributes | tool `roll_dice`, policy `safe` |
| Permissions | none |

## Try it

1. Install this folder: **Plugins** -> **Install…** -> **Local folder** -> **Link**, then check **I trust …**
   (see [the examples README](../README.md#install-an-example)).
2. In a chat with a tool-capable model, ask "Roll 2d6+3 for me". The tool row shows the input and the result. Because
   the policy is `safe`, the tool runs without an approval card in the default **Ask** mode.

## How it works

- `plugin.json` names the entry in `"main": "index.mjs"`, which makes this a code plugin.
- `index.mjs` default-exports `{ setup(ctx) }`. `setup` registers the tool with `ctx.tools.register()`.
- The input schema uses the host's zod (`ctx.ai.z`). Code plugins cannot install or import packages, only Node
  built-ins such as `node:crypto`.
- `execute()` returns a JSON-serializable object; the model receives it as the tool output. A thrown error becomes an
  error result for the model and a failed tool row.
- `ctx.logger.debug()` entries appear in the plugin's **Logs** tab.
- `harness-forge.d.ts` holds the plugin API types for your editor (`// @ts-check` + JSDoc). The host ignores it.

## Adapt it

- A tool that changes something should keep the default policy `ask`, or use `always`, which asks even in **Auto** mode.
  A policy can also be a function of the input:
  `policy: input => input.count > 10 ? 'ask' : 'safe'`.
- Tool names are global, so prefix yours (`myplugin_do_thing`).
- With a linked folder, every save reloads the plugin. See
  [Writing a code plugin](../../../docs/guides/writing-a-code-plugin.md).
