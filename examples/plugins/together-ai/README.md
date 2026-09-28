# Together AI

A declarative provider plugin for [Together AI](https://www.together.ai) through its OpenAI-compatible API. It shows
an API key credential, model listing filters, a reasoning effort mapping and a model declared in the manifest.

| | |
|---|---|
| Kind | declarative, so no trust is needed |
| Contributes | provider `together-ai` (`https://api.together.xyz/v1`), plus the model `openai/gpt-oss-120b` |
| Needs | a Together AI API key |

## Try it

1. Install this folder: **Plugins** -> **Install…** -> **Local folder** -> Link or Copy
   (see [the examples README](../README.md#install-an-example)).
2. Open **Settings** -> **Providers** -> **Together AI**, paste your key (the dialog links to the key page), then
   press **Test** and **Save**. Keys are stored encrypted and never sent back to the browser.
3. Models appear in the picker as `together-ai:<model id>`, for example `together-ai:openai/gpt-oss-120b`. Pick
   gpt-oss 120B to use the effort menu (Low / Medium / High).

## How it works

| Field | Effect |
|---|---|
| `"auth": { "type": "bearer" }` + `credentials[apiKey]` | sends `Authorization: Bearer <key>` to `baseURL` only |
| `"helpUrl"` | the "Get a key" link of the key dialog |
| `"listModels": { "exclude": "embed\|rerank\|…" }` | hides non-chat models by id. Together also returns a `type` per model; embedding, image and audio models are hidden by type |
| `"reasoningStyle": "openai-effort"` | maps the effort menu to `reasoning_effort` (`low`, `medium`, `high`) |
| `"reasoningEfforts": ["low", "medium", "high"]` | the efforts offered for gpt-oss (besides Auto) |
| `"modelsDevId": "togetherai"` | limits, capabilities and prices from models.dev after its first network refresh |
| `"smallModelId"` | the cheap model used for chat titles |
| `"models"` | always listed, even before the live listing, with the metadata given here |

A declarative plugin cannot read environment variables (`envVar` is rejected), so the key is always entered in
Settings. A code plugin can offer an environment fallback.

## Adapt it

The same shape works for most hosted OpenAI-compatible APIs (Fireworks, DeepInfra, Groq-compatible gateways, …).
Change `id`, `name`, `icon`, the provider `id` (it must start with the plugin id), `baseURL`, `helpUrl`,
`modelsDevId` and `smallModelId`. The wizard (**Plugins** -> **New plugin** -> **Provider**) has templates for
Together AI and Fireworks.
