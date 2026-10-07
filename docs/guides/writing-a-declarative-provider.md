# Writing a declarative provider

A **declarative provider** connects an HTTP model API to harness-forge with a `plugin.json` file and no code. Its
models then appear in the model picker like the builtin ones. Use it for any API that speaks one of four wire
formats:

| `apiFormat` | Wire format | Typical APIs |
|---|---|---|
| `openai-chat` | OpenAI Chat Completions (`POST /chat/completions`) | most gateways and local servers: LM Studio, vLLM, llama.cpp, LiteLLM, Together, Fireworks, DeepInfra |
| `openai-responses` | OpenAI Responses (`POST /responses`) | OpenAI-compatible proxies of the Responses API |
| `anthropic` | Anthropic Messages (`POST /messages`) | Anthropic-compatible endpoints (base URL includes the version, for example `.../anthropic/v1`) |
| `google` | Gemini `generateContent` | Gemini-compatible endpoints (`.../v1beta`) |

When the API needs something a manifest cannot express (a login flow, a custom request format, capability flags in
its model listing), write a [code provider](./writing-a-code-plugin.md#providers) instead.

Reference: [PLUGINS.md section 4](../PLUGINS.md#4-declarative-providers) · Runnable examples:
[`lmstudio`](../../examples/plugins/lmstudio/), [`together-ai`](../../examples/plugins/together-ai/).

## Option 1: the provider wizard

**Plugins** -> **New plugin** -> **Provider** opens a five-step wizard that writes the manifest for you:

1. **Basics**: the name, the id (it becomes the plugin id and the provider id, so model refs look like
   `<id>:<model id>`), an icon (upload, LobeHub brand icon, or monogram) and a description.
2. **API**: pick a template (Together, Fireworks, LM Studio, vLLM, LiteLLM) or an API format, then the base URL. A
   plain `http:` URL to a non-local host shows a warning.
3. **Credentials**: the auth style (Bearer, custom header or none), the key dialog fields and extra headers. Values
   you type here are only for testing, and they are saved as the provider's credentials when you create it.
4. **Models**: **Fetch models** lists the API's models so you can pick some, or you add rows by hand (context window,
   capabilities, reasoning efforts, prices). The switch "Fetch the model list at runtime" controls `listModels`.
5. **Review**: the generated `plugin.json`, **Test connection** (a 1-token request), then **Create provider**.

The plugin is created with source `created`. To change it later, choose **Edit in wizard** in the menu of its
detail page, or edit `plugin.json` in its **Source** tab. Saving reloads it either way.

## Option 2: write `plugin.json`

A plugin is a folder whose name is the plugin id. A local server without a key needs very little:

```json
{
  "manifestVersion": 1,
  "id": "llama-box",
  "name": "Llama box",
  "version": "1.0.0",
  "description": "llama.cpp server on the GPU box.",
  "engines": { "harness": "^1.0.0" },
  "contributes": {
    "providers": [
      {
        "id": "llama-box",
        "name": "Llama box",
        "baseURL": "http://gpu-box.lan:8080/v1",
        "apiFormat": "openai-chat",
        "auth": { "type": "none" }
      }
    ]
  }
}
```

Install the folder with **Plugins** -> **Install…** -> **Local folder**, using its absolute path on the server, then
**Link** or **Copy**. Then open **Settings** -> **Providers**, find the provider and press **Test**. Declarative plugins
run no code, so they need no trust (unless they declare a stdio MCP server).

### The fields that matter

| Field | Default | Notes |
|---|---|---|
| `id` | required | `<pluginId>` or `<pluginId>-<suffix>`; one plugin can declare several providers |
| `name` | required | shown in the picker and in Settings -> Providers |
| `baseURL` | required | the API root without the endpoint path; no credentials, query or fragment in it |
| `apiFormat` | required | see the table above |
| `auth` | Bearer for OpenAI formats, `x-api-key` for `anthropic`, `x-goog-api-key` for `google` | `{ "type": "bearer" }`, `{ "type": "header", "header": "api-key" }` or `{ "type": "none" }` |
| `credentials` | one required secret `apiKey` (none with `auth: none`) | fields of the key dialog; `envVar` is not allowed in manifests |
| `headers` | `{}` | extra headers; values may contain `{{credentials.<key>}}` |
| `listModels` | `true` | live listing of `GET {baseURL}/models`; see below |
| `models` | `[]` | models that are always listed, with their metadata |
| `reasoningStyle` | `none` | maps the effort menu to the request (see below) |
| `modelsDevId` | the provider id | models.dev key for limits, capabilities and prices |
| `smallModelId` | none | a cheap model for chat titles; v1.8: also answers the prompt hooks of a chat on this provider when neither the hook's own model nor the Hook model setting resolves ([hooks](hooks-and-project-mcp.md)) |
| `icon` | the plugin icon | `lobe:<slug>` of the bundled LobeHub icons |

## Credentials and headers

The key dialog shows one row per credential field. Secret values are stored encrypted and never sent back to the
browser. Keys are sent only to the provider's own base URL.

```json
"auth": { "type": "bearer" },
"credentials": [
  { "key": "apiKey", "label": "API key", "type": "secret", "required": true, "helpUrl": "https://example.com/keys" },
  { "key": "team", "label": "Team", "type": "text", "required": true },
  { "key": "region", "label": "Region", "type": "select", "options": ["eu", "us"], "default": "eu", "advanced": true }
],
"headers": { "X-Team": "{{credentials.team}}", "X-Region": "{{credentials.region}}" }
```

- Credential types: `secret` (password input, encrypted), `text`, `url` and `select` (with `options`). `advanced: true`
  moves a field into the "Advanced" section. `helpUrl` becomes the "Get a key" link.
- A header whose placeholder resolves to an empty value is left out. A header cannot override the auth header or
  `Host`, `Content-Length`, `Connection`, `Transfer-Encoding` and `Cookie`.
- An optional `apiKey` (`"required": false`) that is left empty sends no auth header. This suits local servers that
  accept a key only when one was configured, such as vLLM with `--api-key`.
- For other schemes, such as `Authorization: Token <key>`, use `"auth": { "type": "none" }` plus
  `"headers": { "Authorization": "Token {{credentials.apiKey}}" }` and declare the `apiKey` field yourself.

## Models

Three sources feed the model picker. User custom ids from Settings -> Models are added on top.

1. **The live listing** (`listModels`), cached for 24 hours. A failed refresh keeps the last good list.
2. **`models`**: always listed. Use it for models the listing lacks, or to add metadata.
3. **models.dev** metadata through `modelsDevId`: context window, capabilities and prices of known models.

```json
"listModels": { "include": "^(llama|qwen|mistral)", "exclude": "embed|rerank|guard" },
"models": [
  {
    "id": "qwen3-32b",
    "name": "Qwen3 32B",
    "contextWindow": 131072,
    "maxOutputTokens": 32768,
    "capabilities": { "tools": true, "reasoning": true },
    "reasoningEfforts": ["off", "low", "medium", "high"],
    "cost": { "input": 0.2, "output": 0.6 }
  }
]
```

- `listModels`: `true` lists `GET {baseURL}/models`; `false` disables the live listing; an object sets `path` (a path
  appended to the base URL, or an absolute URL on the same origin) and `include` / `exclude` (case-insensitive
  regular expressions on model ids; `exclude` wins).
- Listing responses are understood in three shapes: `{ "data": [...] }` (OpenAI, Anthropic), `{ "models": [...] }`
  (Gemini, Ollama) and a bare array (Together). Known fields such as `context_length` or `display_name` are picked up. A
  `type` of `embedding` or `audio` (also `tts`, `stt`, `transcribe`) hides the model from the picker. A declarative
  provider cannot generate images or speech, so image, transcription and speech models of its listing (a `type` of
  `image`, or ids such as `dall-e-3` or `whisper-1`) are left out; image and voice providers need a code plugin
  ([PLUGINS.md 15 (e)](../PLUGINS.md#e-code-provider-plugin-dictation-through-a-local-whisper-server-plugin-api-110)).
- `capabilities.tools: false` stops tools from being sent to that model. `vision` and `pdf` let attachments through
  as file parts. `reasoning` shows the effort menu.
- `contributes.models` (next to `providers`) adds models to **any** provider, builtins included:
  `{ "providerId": "openrouter", "models": [{ "id": "vendor/new-model" }] }`.

## Reasoning effort

The effort menu (Auto / Off / Low / Medium / High / Max) is shown for models with `capabilities.reasoning: true` when
`reasoningStyle` is not `none`. **Auto** never sends anything.

| `reasoningStyle` | Use with | Sent for Low / Medium / High |
|---|---|---|
| `openai-effort` | `openai-chat`, `openai-responses` | `reasoning_effort` (Chat) or `reasoning.effort` (Responses) |
| `anthropic-thinking` | `anthropic` | `thinking` with a 2048 / 8192 / 16384 token budget |
| `google-thinking` | `google` | the thinking level with thought summaries |

Many OpenAI-compatible servers accept only `low`, `medium` and `high`. Put the levels a model supports in its
`reasoningEfforts` (**Max** is offered only when it is listed there). Full mapping:
[PLUGINS.md section 4](../PLUGINS.md#reasoningstyle).

## An Anthropic-compatible gateway

A complete example with a custom auth header, an extra header, a fixed model list and thinking:

```json
{
  "manifestVersion": 1,
  "id": "acme-claude",
  "name": "Acme Claude gateway",
  "version": "1.0.0",
  "description": "Claude models through the Acme gateway.",
  "icon": "lobe:claude-color",
  "engines": { "harness": "^1.0.0" },
  "contributes": {
    "providers": [
      {
        "id": "acme-claude",
        "name": "Acme Claude",
        "baseURL": "https://llm.acme.example/anthropic/v1",
        "apiFormat": "anthropic",
        "auth": { "type": "header", "header": "x-api-key" },
        "credentials": [
          { "key": "apiKey", "label": "Gateway key", "type": "secret", "required": true },
          { "key": "project", "label": "Project", "type": "text", "required": true }
        ],
        "headers": { "X-Acme-Project": "{{credentials.project}}" },
        "listModels": false,
        "reasoningStyle": "anthropic-thinking",
        "modelsDevId": "anthropic",
        "smallModelId": "claude-haiku-4-5",
        "models": [
          { "id": "claude-sonnet-5", "capabilities": { "tools": true, "vision": true, "pdf": true, "reasoning": true } },
          { "id": "claude-haiku-4-5", "capabilities": { "tools": true, "vision": true } }
        ]
      }
    ]
  }
}
```

`modelsDevId: "anthropic"` borrows the metadata of the real models (limits and prices) because the gateway serves the
same ids.

## Testing and editing

- **Settings** -> **Providers** -> the provider -> **Test** checks the credentials. It lists the models when
  `listModels` is on, and otherwise sends a 1-token request to `smallModelId` (else the first model of the catalog).
- The status badge reads **Not configured** until the required fields are set and **Connected** after that.
  Providers without a required secret are connected at once; their row says "Local — no key". An authentication or
  connection failure turns the badge into **Error**.
- Edit a linked folder in place: saving `plugin.json` reloads the plugin. For a copied or created plugin, use its
  **Source** tab (or **Edit in wizard** for `created` ones); saving `plugin.json` reloads it.
- The plugin's **Logs** tab and the server log show listing and validation failures.

| Symptom | Likely cause |
|---|---|
| `validation_error` on install | a manifest rule: provider id not prefixed by the plugin id, `envVar` in a credential, a header that repeats the auth header, an unknown key (the manifest is strict) |
| Test fails with `auth_invalid` | wrong key, or the wrong `auth` style (`bearer` vs `header`) |
| Test fails with `model_not_found` / 404 on listing | the API has no `/models`: set `listModels: false` and list `models`, or set `listModels.path` |
| `provider_unreachable` | wrong host or port, the model server is not running, or harness-forge cannot reach it: inside Docker, `localhost` is the container, so use `host.docker.internal` (Docker Desktop; on Linux add `--add-host=host.docker.internal:host-gateway`) |
| Models missing from the picker | filtered by `include` / `exclude`, a non-chat `type`, hidden in Settings -> Models, or the provider is disabled |
| The effort menu is missing | `reasoningStyle` is `none` or the model lacks `capabilities.reasoning` |

## Share it

- **Zip**: zip the folder (`plugin.json` at the root of the archive or inside one top-level folder) and install it
  with the **Zip** tab.
- **npm**: publish a package with `plugin.json` at the package root. Dependencies and lifecycle scripts are ignored.
  Users install it with the **npm** tab (`name`, `name@version` or `@scope/name`).
- **URL**: host the `.zip` or `.tgz` on `https:` and give users its integrity hash:
  `echo "sha256-$(openssl dgst -sha256 -binary plugin.zip | openssl base64 -A)"`.
- **Export**: an installed plugin's export action downloads it as a zip without settings or secrets.
