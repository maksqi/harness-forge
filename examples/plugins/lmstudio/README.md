# LM Studio

A declarative provider plugin for [LM Studio](https://lmstudio.ai). Every model you downloaded in LM Studio
shows up in the model picker as `lmstudio:<model id>`. The plugin is a single `plugin.json` file: no code runs and
no API key is needed.

| | |
|---|---|
| Kind | declarative, so no trust is needed |
| Contributes | provider `lmstudio`: OpenAI-compatible, `http://localhost:1234/v1` |
| Needs | LM Studio's local server running on the machine that runs harness-forge |

## Try it

1. In LM Studio, download a model and start the local server. Use the **Developer** tab or run
   `lms server start`. The server listens on port 1234.
2. Install this folder: **Plugins** -> **Install…** -> **Local folder** -> Link or Copy
   (see [the examples README](../README.md#install-an-example)).
3. Open **Settings** -> **Providers** -> **LM Studio** and press **Test**. The test lists the models.
4. Pick an `LM Studio` model in the composer and chat.

The provider wizard can build a similar plugin without JSON: **Plugins** -> **New plugin** -> **Provider**, then
choose the **LM Studio** template.

## How it works

| Field | Effect |
|---|---|
| `"apiFormat": "openai-chat"` | chat requests go to `POST {baseURL}/chat/completions` |
| `"auth": { "type": "none" }` | no credentials and no key dialog. The provider is marked "Local — no key" and connected. |
| `"listModels": { "exclude": "embed" }` | `GET {baseURL}/models`, without embedding models (matched by id, case-insensitive) |
| `"reasoningStyle": "openai-effort"` | reasoning models get an effort menu, sent as `reasoning_effort` |
| `"modelsDevId": "lmstudio"` | limits and capabilities come from the `lmstudio` entry of models.dev when it knows the model |

Reasoning models such as Qwen 3, DeepSeek R1 or gpt-oss stream their thinking when LM Studio returns it as
`reasoning_content`, which LM Studio's reasoning setting controls.

## Adapt it

- **Another host or port:** change `baseURL`. When harness-forge runs in Docker and LM Studio runs on the host, use
  `http://host.docker.internal:1234/v1`. LM Studio must accept network connections ("Serve on local network").
  A copied or linked plugin can be edited in its **Source** tab. Saving `plugin.json` reloads the plugin.
- **Other local OpenAI-compatible servers** (llama.cpp `llama-server`, vLLM, Jan, LocalAI): copy the folder, rename it,
  then change `id`, `name`, `icon`, the provider `id` (it must start with the plugin id) and `baseURL`.
- **A server that wants a key:** use `"auth": { "type": "bearer" }` with an optional `apiKey` credential
  (see [together-ai](../together-ai/)). An empty optional key sends no header.
