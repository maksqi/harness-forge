# Echo provider

A code plugin in TypeScript (`index.ts`) that adds the provider `echo-provider` with two models:

- `echo-provider:echo` repeats your message.
- `echo-provider:reverse` repeats it backwards.

The models stream word by word, report usage and stop when you press Stop. They need no key and no network. The
point of the example is the model itself: a hand-written AI SDK `LanguageModelV4`, the pattern you use for an API that
has no AI SDK provider.

| | |
|---|---|
| Kind | code: runs on the server, so it needs trust |
| Contributes | provider `echo-provider` (keyless), models `echo` and `reverse` |
| Permissions | none |

## Try it

1. Install this folder: **Plugins** -> **Install…** -> **Local folder** -> **Link**, then check **I trust …**
   (see [the examples README](../README.md#install-an-example)).
2. Pick **Echo** in the composer's model picker and send a message.

## How it works

- `"main": "index.ts"`: the host compiles the entry with esbuild when the plugin loads and on **Build & reload**.
  The build strips types and does not type-check. From `@harness-forge/plugin-sdk`, only `definePlugin` and
  `PLUGIN_API_VERSION` can be imported as values; everything else is `import type`.
- `ctx.providers.register()` adds the provider. `credentials: []` means no key dialog, so the provider is connected as
  soon as the plugin is active.
- `createLanguageModel(modelId)` returns an object that implements the spec:
  - `specificationVersion: 'v4'`, `provider`, `modelId` and `supportedUrls`.
  - `doGenerate()` for single calls, such as chat titles. It returns `content`, `finishReason`, `usage` and
    `warnings`.
  - `doStream()` for the chat. Its stream sends `stream-start`, `text-start`, one `text-delta` per word,
    `text-end`, then `finish` with usage.
- The word delay uses `setTimeout` from `node:timers/promises` with the call's `abortSignal`, so Stop ends the stream
  at once.
- `listModels()` returns the two models. It is also the **Test** button of Settings -> Providers.

The local types in `index.ts` spell out the part of the spec this model uses. The full spec is `LanguageModelV4` in
`@ai-sdk/provider`. `import type` from that package also compiles, because esbuild removes type imports, but your
editor then needs the package installed.

## Adapt it

To wrap a real API, replace `reply()` with requests through `rt.fetch`, the second argument of
`createLanguageModel`. `rt.fetch` is aborted with the run and follows only same-origin redirects. Declare credential
fields for the API key, and map API errors in `mapError()`. For an OpenAI-compatible API you need no custom model:
return `ctx.ai.createOpenAICompatible({ ... }).chatModel(modelId)`. The **Provider** template of **New plugin** ->
**Code plugin** does exactly that. See [Writing a code plugin](../../../docs/guides/writing-a-code-plugin.md).
