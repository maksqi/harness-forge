# Providers

Reference for the builtin BYOK providers of the `core-providers` builtin plugin, the dev-only `mock` provider, the
declarative provider templates of the provider wizard, provider icons, and (Phase 6) the image, transcription and speech
models of the builtin providers ([section 13](#13-image-and-voice-models)). The provider contract
(`ProviderDefinition`, `CredentialField`, `ModelInfo`, `ReasoningParams`) is defined in
[PLUGINS.md](./PLUGINS.md#9-api-reference); the model catalog merge rules are in
[ARCHITECTURE.md](./ARCHITECTURE.md#9-model-catalog). Ids follow [DECISIONS.md](./DECISIONS.md).

Verification: package facts (factories, default base URLs, environment variables, provider options, reasoning
mappings) were read from the published source of the versions installed in this repository on 2026-09-28
(`ai` 7.0.x, `@ai-sdk/anthropic` 4.0.65, `@ai-sdk/openai` 4.0.78, `@ai-sdk/google` 4.0.82, `@ai-sdk/xai` 5.0.10,
`@ai-sdk/deepseek` 3.0.54, `@ai-sdk/moonshotai` 3.0.58, `@ai-sdk/alibaba` 2.0.56, `@ai-sdk/zai` 3.0.19,
`@ai-sdk/minimax` 3.0.42, `@ai-sdk/mistral` 4.0.52, `@ai-sdk/groq` 4.0.50, `@ai-sdk/openai-compatible` 3.0.57,
`@openrouter/ai-sdk-provider` 3.1.0, `@lobehub/icons-static-svg` 1.95.1). Key URLs and listing endpoints were checked
against vendor docs and live HTTP responses. Anything not confirmed is marked **(unverified)**; re-check those items
when implementing ([section 11](#11-verification-log)). The opt-in live provider suite
([section 12](#12-live-provider-suite)) exercises every provider you have a key for.

## 1. Builtin providers

| id | UI name | Package · factory -> model | Default base URL | Key env var (also accepted) | Get a key | Icon color / mono |
|---|---|---|---|---|---|---|
| `anthropic` | Anthropic (Claude) | `@ai-sdk/anthropic` · `createAnthropic(o)(id)` | `https://api.anthropic.com/v1` | `ANTHROPIC_API_KEY` | https://platform.claude.com/settings/keys | `claude-color` / `claude` |
| `openai` | OpenAI (ChatGPT) | `@ai-sdk/openai` · `createOpenAI(o).responses(id)` | `https://api.openai.com/v1` | `OPENAI_API_KEY` | https://platform.openai.com/api-keys | — / `openai` |
| `google` | Google (Gemini) | `@ai-sdk/google` · `createGoogleGenerativeAI(o)(id)` (alias of `createGoogle`) | `https://generativelanguage.googleapis.com/v1beta` | `GOOGLE_GENERATIVE_AI_API_KEY` (`GEMINI_API_KEY`, `GOOGLE_API_KEY`) | https://aistudio.google.com/app/apikey | `gemini-color` / `gemini` |
| `xai` | xAI (Grok) | `@ai-sdk/xai` · `createXai(o)(id)` (Responses API) | `https://api.x.ai/v1` | `XAI_API_KEY` | https://console.x.ai/team/default/api-keys | — / `grok` |
| `deepseek` | DeepSeek | `@ai-sdk/deepseek` · `createDeepSeek(o)(id)` | `https://api.deepseek.com` | `DEEPSEEK_API_KEY` | https://platform.deepseek.com/api_keys | `deepseek-color` / `deepseek` |
| `moonshotai` | Moonshot AI (Kimi) | `@ai-sdk/moonshotai` · `createMoonshotAI(o)(id)` | `https://api.moonshot.ai/v1` | `MOONSHOT_API_KEY` | https://platform.kimi.ai/console/api-keys | `kimi-color` / `kimi` |
| `alibaba` | Alibaba (Qwen) | `@ai-sdk/alibaba` · `createAlibaba(o)(id)` | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | `ALIBABA_API_KEY` (`DASHSCOPE_API_KEY`) | https://modelstudio.console.alibabacloud.com/ap-southeast-1/settings/api-key | `qwen-color` / `qwen` |
| `zai` | Z.ai (GLM) | `@ai-sdk/zai` · `createZai(o)(id)` | `https://api.z.ai/api/paas/v4` | `ZAI_API_KEY` (`ZHIPU_API_KEY`) | https://z.ai/manage-apikey/apikey-list | `zhipu-color` / `zai` |
| `minimax` | MiniMax | `@ai-sdk/minimax` · `createMiniMax(o)(id)` (Anthropic-compatible API) | `https://api.minimax.io/anthropic/v1` | `MINIMAX_API_KEY` | https://platform.minimax.io/user-center/basic-information/interface-key | `minimax-color` / `minimax` |
| `mistral` | Mistral | `@ai-sdk/mistral` · `createMistral(o)(id)` | `https://api.mistral.ai/v1` | `MISTRAL_API_KEY` | https://console.mistral.ai/api-keys | `mistral-color` / `mistral` |
| `groq` | Groq | `@ai-sdk/groq` · `createGroq(o)(id)` | `https://api.groq.com/openai/v1` | `GROQ_API_KEY` | https://console.groq.com/keys | — / `groq` |
| `openrouter` | OpenRouter | `@openrouter/ai-sdk-provider` · `createOpenRouter(o)(id)` | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` | https://openrouter.ai/settings/keys | `openrouter-color` / `openrouter` |
| `ollama` | Ollama (local) | `@ai-sdk/openai-compatible` · `createOpenAICompatible({ name: 'ollama', ... }).chatModel(id)` | `http://localhost:11434/v1` | none (no key) | https://ollama.com/download | — / `ollama` |
| `mock` | Mock (dev only) | `MockLanguageModelV4` from `ai/test` (Phase 6 media models: `MockImageModelV4`, `MockTranscriptionModelV4`, `MockSpeechModelV4`) | — | — | — | monogram |

Notes:

- The first env var of each row is the one the official package reads (verified in its source); the names in
  parentheses are extra aliases accepted by harness-forge (`CredentialField.envVar` lists them in order, first
  non-empty wins). models.dev lists `DASHSCOPE_API_KEY` for Alibaba and `ZHIPU_API_KEY` for Z.ai; Google's own SDKs
  read `GEMINI_API_KEY` / `GOOGLE_API_KEY`.
- The old Anthropic console URL (`console.anthropic.com/settings/keys`) and the old Moonshot console URL
  (`platform.moonshot.ai/console/api-keys`) redirect to the URLs above. The MiniMax URL redirects to
  `https://platform.minimax.io/console/access`.
- `ollama` has no models.dev entry (models.dev has only `ollama-cloud`), so Ollama models get no catalog metadata
  beyond what Ollama reports.

## 2. Credentials and base URLs

Every provider except `ollama` and `mock` declares:

| key | type | required | envVar | default | advanced |
|---|---|---|---|---|---|
| `apiKey` | `secret` | yes | the env var column above | — | no |
| `baseURL` | `url` | no | — | the default base URL above | yes ("Advanced" section of the key dialog) |

`ollama` declares `baseURL` (`url`, required, default `http://localhost:11434/v1`, not advanced) and `apiKey`
(`secret`, optional, advanced; sent as `Authorization: Bearer` when set, for Ollama behind an authenticating proxy).
`mock` declares no credentials.

Rules for `createLanguageModel`:

- `core-providers` always passes `apiKey`, `baseURL` and `fetch: rt.fetch` explicitly. Package environment fallbacks
  (for example `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, or a package reading its key variable itself) are never
  relied on: the host resolves credentials (stored -> env -> default) and reports the source in the UI.
- A base URL override must keep the path shape the package expects (Anthropic and MiniMax: ending in `/v1`; the
  package appends `/messages`).
- Always-on options (not effort parameters, see [section 4](#4-reasoning)) are applied by wrapping the model:
  `wrapLanguageModel({ model, middleware: defaultSettingsMiddleware({ settings: { providerOptions } }) })` from `ai`
  (deep-merged with per-call options).

Known alternative base URLs (Advanced):

| Provider | Alternative | Use |
|---|---|---|
| `alibaba` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | China (Beijing) region keys |
| `moonshotai` | `https://api.moonshot.cn/v1` | China platform keys |
| `zai` | `https://api.z.ai/api/coding/paas/v4` | GLM Coding Plan keys (not interchangeable with general keys) |
| `zai` | `https://open.bigmodel.cn/api/paas/v4` | Zhipu (China) keys |
| `minimax` | `https://api.minimaxi.com/anthropic/v1` | China platform keys **(unverified)** |
| `openai`, `anthropic` | any compatible proxy | the proxy must implement the same API (OpenAI: the Responses API) |

## 3. Model listing

`listModels` results are cached 24 h in `model_cache`; a failed refresh keeps the last good list. Chat seeds are used
only when there is neither a listing nor a cached listing; seeds with an explicit media kind (`image`, `transcription`,
`speech`) are always listed, even next to a live listing (Phase 6). An explicit `kind` of any layer (custom model,
listing, plugin model, seed) wins; otherwise `classify()` decides (the image id pattern first, then models.dev
modalities, else the id; ARCHITECTURE.md 9). Chat models are visible, image models are visible when the provider can
generate images (`createImageModel`), and every other kind is hidden from the chat picker (Settings → Media lists the
transcription and speech models). Phase 6: a media model is listed only when its provider defines the matching factory
(`createImageModel`, `createTranscriptionModel`, `createSpeechModel`), whatever listed it; only a custom model id added
by the user stays listed without one (the resolver then explains the error, [section 13](#13-image-and-voice-models)).
The provider-specific filters below run first; since Phase 6 they keep the media ids a provider can run (the "Phase 6"
notes below and section 13). The v1.2 upgrade (migration `0003`) ages every listing cached by v1.1 by one day, so it is
stale and the new media ids and image-output flags appear at the next start; until that refresh succeeds (and after a
failed one) the catalog keeps serving the cached listing (ARCHITECTURE.md 8 and 9).

| id | Endpoint | Auth | Fields used / filtering | Status |
|---|---|---|---|---|
| `anthropic` | `GET {baseURL}/models?limit=1000` (follow `has_more` with `after_id`) | `x-api-key`, `anthropic-version: 2023-06-01` | `id`, `display_name` -> name, `max_input_tokens` -> contextWindow, `max_tokens` -> maxOutputTokens, `capabilities.image_input` / `pdf_input` / `structured_outputs` / `thinking.supported` -> capabilities, `capabilities.effort.{low,medium,high,xhigh,max}.supported` -> `reasoningEfforts` | verified (docs) |
| `openai` | `GET {baseURL}/models` | Bearer | ids only (`id`, `owned_by`); Phase 6: the media ids the package can run are kept first: `gpt-image*` / `chatgpt-image*` (kind `image`, `vision`), `*transcribe*` and `whisper-1` (`transcription`), `tts-*` and `*-tts*` (`speech`, with voices, section 13); realtime ids (`*realtime*`, including `gpt-realtime-whisper`) are never kept; then drop `embedding`, `tts`, `whisper`, `transcribe`, `dall-e` (so `dall-e-*` stays out), `gpt-image`, `moderation`, `realtime`, `audio`, `sora`, `babbage`, `davinci`, `computer-use`, `search`; metadata from models.dev | verified |
| `google` | `GET {baseURL}/models?pageSize=1000` (follow `nextPageToken`) | `x-goog-api-key` | id = `name` without `models/`; keep `supportedGenerationMethods` containing `generateContent`; Live API ids (`live`, `native-audio`) are never kept; Phase 6: `*-tts*` -> `speech` (with the Gemini voices), `gemini-*-image*` and `nano-banana*` -> chat models with `imageOutput` (explicit kind `chat`); then drop `embedding`, `aqa`, `imagen`, `veo`, `tts`, `-image`; `displayName`, `inputTokenLimit`, `outputTokenLimit`, `thinking` -> capabilities.reasoning | verified (docs) |
| `xai` | `GET {baseURL}/models` | Bearer | ids; Phase 6: `grok-imagine-image*` -> kind `image` (`vision`); other `grok-imagine-*` ids (video) are dropped; the speech-to-text and text-to-speech endpoints are the seeds `stt` / `tts` (section 13); metadata from models.dev (`GET {baseURL}/language-models` returns richer data **(unverified shape)**) | verified |
| `deepseek` | `GET {baseURL}/models` | Bearer | `id`, `name`, `context_window`, `max_output_tokens`, `input_modalities` (`image` -> vision), `effort.supported_levels` -> `reasoningEfforts` (plus `off`) | verified (docs) |
| `moonshotai` | `GET {baseURL}/models` | Bearer | ids; metadata from models.dev and seeds | verified (route) |
| `alibaba` | `GET {baseURL}/models` | Bearer | ids (OpenAI shape **(unverified)**); keep ids starting with `qwen` or `qwq`; drop `embed`, `tts`, `asr`, `image`, `wan`, `realtime`, `livetranslate`, `-mt-` (the provider has no media factory, so voice and image models such as `qwen3-asr-flash` stay out of the catalog) | verified (route) |
| `zai` | `GET {baseURL}/models` | Bearer | ids (OpenAI shape) | **(unverified)** on the general endpoint (documented for the Coding Plan endpoint); fall back to seeds + models.dev |
| `minimax` | `GET {baseURL}/models` | `x-api-key`, `anthropic-version` | parsed like the Anthropic listing (`id`, `display_name`); tools on; vision for M3; `reasoningEfforts` by model family ([section 6](#6-provider-notes)) | response shape **(unverified)**; fall back to seeds |
| `mistral` | `GET {baseURL}/models` | Bearer | keep `capabilities.completion_chat`; drop `archived` / deprecated; `max_context_length`; `capabilities.function_calling` -> tools, `capabilities.vision` -> vision; hide duplicate `aliases`; Phase 6: the Voxtral voice models are seeds with explicit kinds (section 13), listed whatever the listing returns | verified (docs) |
| `groq` | `GET {baseURL}/models` | Bearer | keep `active`; Phase 6: `whisper-*` -> kind `transcription` (kept first); then drop `whisper`, `orpheus`, `tts`, `prompt-guard`, `safeguard`; `context_window`, `max_completion_tokens` | verified (docs) |
| `openrouter` | `GET {baseURL}/models` (public, no key needed; send the key when set) | Bearer | `name`; `context_length`; `top_provider.max_completion_tokens`; keep `architecture.output_modalities` containing `text`; Phase 6: `output_modalities` containing `image` -> `imageOutput` and an explicit kind `chat` (no dedicated image, transcription or speech models); `architecture.input_modalities` (`image` -> vision, `file` -> pdf); `supported_parameters` (`tools` -> tools, `reasoning` -> reasoning, `structured_outputs` -> structuredOutput); `pricing` (below) | verified |
| `ollama` | `GET {origin}/api/tags` where origin = `baseURL` without a trailing `/v1`; fallback `GET {baseURL}/models` | none (Bearer when `apiKey` is set) | `models[].name` -> id; optional enrichment `POST {origin}/api/show` `{ "model": id }` (cheap, metadata only): `capabilities` (`tools`, `thinking`, `vision`, `embedding`), context length at `model_info["<general.architecture>.context_length"]` | verified (docs) |

OpenRouter pricing: `pricing.prompt`, `pricing.completion`, `pricing.input_cache_read`, `pricing.input_cache_write` are
USD **per token** as strings; multiply by 1,000,000 for `ModelInfo.cost` (`input`, `output`, `cacheRead`,
`cacheWrite`). `"-1"` (router models) means unknown. Price `overrides` for long prompts are ignored (the base price
is used).

## 4. Reasoning

### Rules

- `ReasoningEffort` = `auto | off | low | medium | high | max`. **`auto` sends nothing**: no reasoning parameter
  reaches the provider and the provider default applies.
- The host calls `provider.reasoning(effort, model)` only when the effort is not `auto`, `model.capabilities.reasoning`
  is true and the effort is offered for the model (`ModelInfo.reasoningEfforts`); otherwise it behaves as `auto`.
- `reasoning()` returns `ReasoningParams`: `reasoning` is the AI SDK v7 top-level call option
  (`none | minimal | low | medium | high | xhigh`) that each official package translates to its native parameters;
  `providerOptions` carries provider-specific options. Reasoning settings inside `providerOptions` take full
  precedence over the top-level value (never merged), so a mapping uses one or the other for the effort.
- **Always-on options** are not effort parameters and are applied on every request (model wrapper, section 2):
  - `groq`: `providerOptions.groq.reasoningFormat = 'parsed'` for reasoning models that are not `openai/gpt-oss-*`
    (Groq defaults to `raw`, which puts `<think>` text into the answer; gpt-oss models reject `reasoning_format`).
  - `openrouter`: `providerOptions.openrouter.usage = { include: true }` (cost reporting).

### Effort -> request mapping

`reasoning: x` = top-level AI SDK option; `po.k = {...}` = `providerOptions.k`. "Not offered" levels are omitted
from the model's `reasoningEfforts`.

| id | `off` | `low` | `medium` | `high` | `max` |
|---|---|---|---|---|---|
| `anthropic` | `reasoning: 'none'` -> `thinking: { type: 'disabled' }` (not offered on adaptive-only models `claude-opus-5-5`, `claude-fable-5*`) | `reasoning: 'low'` | `reasoning: 'medium'` | `reasoning: 'high'` | adaptive models: `po.anthropic = { thinking: { type: 'adaptive', display: 'summarized' }, effort: 'max' }`; budget models: `reasoning: 'xhigh'` |
| `openai` | `reasoning: 'none'` (not offered on `gpt-6-astra`) | `reasoning: 'low'` | `reasoning: 'medium'` | `reasoning: 'high'` | `po.openai = { reasoningEffort: 'max' }` (GPT-5.6 and GPT-6 only) |
| `google` | `reasoning: 'none'` (Gemini 2.5 only: budget 0; not offered on Gemini 3+, which cannot disable thinking) | `reasoning: 'low'` + `po.google = { thinkingConfig: { includeThoughts: true } }` | `reasoning: 'medium'` + same | `reasoning: 'high'` + same | `reasoning: 'xhigh'` + same (Gemini 3+: `high`; 2.5: 90 % budget) |
| `xai` | `reasoning: 'none'` (models that accept `none`, e.g. `grok-4.3`) | `reasoning: 'low'` | `reasoning: 'medium'` | `reasoning: 'high'` | `reasoning: 'xhigh'` (`grok-4.6`: `xhigh`, others: `high`) |
| `deepseek` | `reasoning: 'none'` -> `thinking: { type: 'disabled' }` | `reasoning: 'low'` -> `reasoning_effort: 'low'` | not offered (maps to `high`) | `reasoning: 'high'` | `reasoning: 'xhigh'` -> `reasoning_effort: 'max'` |
| `moonshotai` | `reasoning: 'none'` -> `thinking: { type: 'disabled' }` (K2.5 / K2.6 only) | `reasoning: 'low'` (K3: `reasoning_effort: 'low'`) | not offered on K3 | `reasoning: 'high'` (K3: `high`; K2.x: thinking enabled) | `reasoning: 'xhigh'` (K3: `max`) |
| `alibaba` | `reasoning: 'none'` -> `enable_thinking: false` | `reasoning: 'low'` -> `enable_thinking: true`, `thinking_budget: 1638` | `reasoning: 'medium'` -> budget 4915 | `reasoning: 'high'` -> budget 9830 | `reasoning: 'xhigh'` -> budget 14746 |
| `zai` | `po.zai = { thinking: { type: 'disabled' } }` | `po.zai = { thinking: { type: 'enabled' }, reasoningEffort: 'low' }` | same with `'medium'` | same with `'high'` | same with `'max'` |
| `minimax` | `po.minimax = { thinking: { type: 'disabled' } }` (MiniMax-M3 only) | not offered | not offered | `po.minimax = { thinking: { type: 'adaptive' } }` (MiniMax-M3 only) | not offered |
| `mistral` | `reasoning: 'none'` | not offered | not offered | `reasoning: 'high'` | not offered |
| `groq` | `po.groq = { reasoningEffort: 'none' }` (Qwen models only; gpt-oss cannot disable) | `reasoning: 'low'` | `reasoning: 'medium'` | `reasoning: 'high'` | not offered |
| `openrouter` | `po.openrouter = { reasoning: { effort: 'none' } }` | `po.openrouter = { reasoning: { effort: 'low' } }` | `{ effort: 'medium' }` | `{ effort: 'high' }` | `{ effort: 'xhigh' }` |
| `ollama` | `reasoning: 'none'` -> `reasoning_effort: 'none'` | `reasoning: 'low'` | `reasoning: 'medium'` | `reasoning: 'high'` | `po.ollama = { reasoningEffort: 'max' }` |
| `mock` | `reasoning: 'none'` | `reasoning: 'low'` | `reasoning: 'medium'` | `reasoning: 'high'` | `reasoning: 'xhigh'` |

Details:

- `anthropic`: with the top-level option, the package sends `thinking: { type: 'adaptive', display: 'summarized' }`
  plus `effort` on models with adaptive thinking (`claude-sonnet-4-6`, `claude-opus-4-6` and later), and
  `thinking: { type: 'enabled', budgetTokens }` with 10 / 30 / 60 / 90 % of the model's maximum output (minimum 1024)
  on older models (`claude-haiku-4-5`, `claude-sonnet-4-5`, `claude-opus-4-5`). `display: 'summarized'` matters:
  since `claude-opus-4-7`, thinking text is omitted unless requested. On adaptive-only models the package turns
  `none` into `effort: 'low'` with a warning, which is why `off` is not offered there.
- `openai`: the package sends `reasoning.effort` and requests a `detailed` reasoning summary whenever the effort is set
  and not `none`; with `auto` no summary is requested, so no reasoning text is shown.
- `google`: `includeThoughts: true` is required to receive thought summaries; the package merges it with the
  thinking level derived from the top-level option.
- `minimax`: the package builds on Anthropic internals, where the top-level option would produce budget-based
  thinking; MiniMax accepts only `adaptive` / `disabled`, so `core-providers` always uses `providerOptions`.
- `zai`: `reasoningEffort` applies to GLM-5.2 and later; for earlier GLM models send only `thinking` (their accepted
  efforts are `off` and `high`).
- `ollama`: the effort menu of a local model comes from `POST /api/show` `thinking.values`: `false` (or `"none"`)
  offers `off`; named levels (`low`, `medium`, `high`, `max`) are offered as reported; a boolean-only control
  (`[true, false]`) offers `off` and `high` (thinking on). A model whose values are all `false` is not a reasoning
  model; a model without `thinking` metadata but with the `thinking` capability gets the host defaults
  (`off, low, medium, high`). The field shape follows Ollama's API docs **(unverified against every model)**.

### Provider options reference

Reasoning-related options accepted by each package (options key in parentheses), verified in the installed source
unless marked.

| Package (key) | Options | Top-level `reasoning` support |
|---|---|---|
| `@ai-sdk/anthropic` (`anthropic`) | `thinking`: `{ type: 'adaptive', display?: 'omitted' \| 'summarized' \| 'updates' }` \| `{ type: 'enabled', budgetTokens?: number }` \| `{ type: 'disabled' }`; `effort`: `'low' \| 'medium' \| 'high' \| 'xhigh' \| 'max'` (`xhigh` on `claude-opus-4-7` and later, `claude-sonnet-5`, `claude-fable-5*`); `sendReasoning?: boolean` | yes (see details above) |
| `@ai-sdk/openai` (`openai`) | `reasoningEffort`: `'none' \| 'minimal' \| 'low' \| 'medium' \| 'high' \| 'xhigh' \| 'max'` (per model: GPT-6 Sol / Luna `none`-`max`, GPT-6 Astra `low`-`max`); `reasoningSummary`: `'auto' \| 'detailed'` (Responses; `null` omits); `reasoningMode`: `'standard' \| 'pro'` (GPT-5.6) | yes: passed through as `reasoningEffort`, checked against the model's supported list |
| `@ai-sdk/google` (`google`) | `thinkingConfig`: `{ thinkingLevel?: 'minimal' \| 'low' \| 'medium' \| 'high'; thinkingBudget?: number; includeThoughts?: boolean }` (`thinkingLevel` for Gemini 3+, `thinkingBudget` for Gemini 2.5) | yes: Gemini 3+ -> `thinkingLevel` (`none` / `minimal` -> the model minimum, `minimal` or `low` for Flash 3.7+; `xhigh` -> `high`); Gemini 2.5 -> `thinkingBudget` (`none` -> 0) |
| `@ai-sdk/xai` (`xai`) | `reasoningEffort`: `'none' \| 'low' \| 'medium' \| 'high' \| 'xhigh'` (per model: `grok-4.3` `none`-`high`, `grok-4.5` `low`-`high`, `grok-4.6` `low`-`xhigh`, `grok-4.20-*` none accepted; `grok-4.7` **(unverified)**); `reasoningSummary`: `'auto' \| 'concise' \| 'detailed'` (in the schema; not sent in 5.0.10) | yes: `minimal` / `low` -> `low`, `xhigh` -> `xhigh` on `grok-4.6` else `high` |
| `@ai-sdk/deepseek` (`deepseek`) | `thinking`: `{ type?: 'enabled' \| 'disabled' }` (V4 default: enabled); `reasoningEffort`: `'low' \| 'high' \| 'max'` | yes: `none` -> disabled, `minimal` / `low` -> `low`, `medium` / `high` -> `high`, `xhigh` -> `max` |
| `@ai-sdk/moonshotai` (`moonshotai`) | `reasoningEffort`: `'low' \| 'high' \| 'max'` (Kimi K3); `thinking`: `{ type?: 'enabled' \| 'disabled' }` (K2.5, K2.6; K2.7 always thinks); `reasoningHistory`: `'disabled' \| 'interleaved' \| 'preserved'` | yes: K3 as effort (`none` unsupported), K2.x as thinking on / off |
| `@ai-sdk/alibaba` (`alibaba`) | `enableThinking`: boolean; `thinkingBudget`: number | yes: `none` -> `enable_thinking: false`, else a budget of 2 / 10 / 30 / 60 / 90 % of 16384 |
| `@ai-sdk/zai` (`zai`) | `thinking`: `{ type?: 'enabled' \| 'disabled'; clearThinking?: boolean }`; `reasoningEffort`: `'none' \| 'minimal' \| 'low' \| 'medium' \| 'high' \| 'xhigh' \| 'max'` (GLM-5.2+) | passed through as `reasoning_effort` (inherited from the OpenAI-compatible chat model) |
| `@ai-sdk/minimax` (`minimax`, also `anthropic`) | `thinking`: `{ type: 'adaptive' \| 'disabled' }` | handled by Anthropic internals (budget thinking); not used |
| `@ai-sdk/mistral` (`mistral`) | `reasoningEffort`: `'none' \| 'high'` (only for the model ids in the package list: `magistral-*`, `mistral-medium-2604`, `mistral-medium-3*`, `mistral-medium-latest`, `mistral-small-2603`, `mistral-small-latest`, ...) | yes: `none` -> `none`, every other level -> `high` |
| `@ai-sdk/groq` (`groq`) | `reasoningEffort`: `'none' \| 'default' \| 'low' \| 'medium' \| 'high'`; `reasoningFormat`: `'parsed' \| 'raw' \| 'hidden'` (not for gpt-oss) | yes: `minimal` / `low` -> `low`, `xhigh` -> `high`; `none` only for `qwen/qwen3.6-27b` in the package list (Groq also accepts `none` on `qwen/qwen3.8-27b`, hence `providerOptions`) |
| `@openrouter/ai-sdk-provider` (`openrouter`) | `reasoning`: `{ enabled?: boolean; exclude?: boolean } & ({ effort: 'xhigh' \| 'high' \| 'medium' \| 'low' \| 'minimal' \| 'none' } \| { max_tokens: number })`; `usage`: `{ include: boolean }` | **no**: the top-level option is ignored |
| `@ai-sdk/openai-compatible` (`ollama`, `openaiCompatible`) | `reasoningEffort`: any string -> `reasoning_effort`; unknown keys under the provider key are sent as raw body fields | yes: passed through verbatim |

## 5. Seed models

Chat seeds are shown only when there is no live or cached listing (media seeds are always listed,
[section 13](#13-image-and-voice-models)), and they carry `reasoningEfforts` (models.dev does not). The live listing is
the source of truth; field precedence is user custom -> live -> models.dev -> seed. **Re-verify every seed id against
the provider docs and models.dev when implementing** (all chat seed ids below exist in the models.dev snapshot of
2026-09-28; `models-dev.test.ts` checks the chat seeds only).

`smallModelId` is used for chat titles (when `titleModelRef` is unset) and for the credential ping when the provider
has no listing; without `smallModelId` the ping takes the first chat seed, else the first visible chat model, never an
image, transcription or speech model (Phase 6).

| id | Seed models (`reasoningEfforts`) | `smallModelId` |
|---|---|---|
| `anthropic` | `claude-opus-5-5` (low, medium, high, max) · `claude-sonnet-5` (off, low, medium, high, max) · `claude-haiku-4-5` (off, low, medium, high) · `claude-fable-5-1` (low, medium, high, max) | `claude-haiku-4-5` |
| `openai` | `gpt-6-astra` (low, medium, high, max) · `gpt-6-sol` (off, low, medium, high, max) · `gpt-6-luna` (off, low, medium, high, max) | `gpt-6-luna` |
| `google` | `gemini-3.8-flash` (low, medium, high) · `gemini-3.1-pro-preview` (low, medium, high) | `gemini-3.5-flash-lite` |
| `xai` | `grok-4.7` (low, medium, high; **unverified**) | `grok-4.3` |
| `deepseek` | `deepseek-v4-pro` (off, low, high, max) · `deepseek-flash` (off, low, high, max) | `deepseek-flash` |
| `moonshotai` | `kimi-k3` (low, high, max) · `kimi-k2.6` (off, high) | `kimi-k2.6` |
| `alibaba` | `qwen3.8-max` (off, low, medium, high) · `qwen3.7-plus` (off, low, medium, high) | `qwen3.8-flash` |
| `zai` | `glm-5.3` (off, low, medium, high, max) · `glm-5.3-flash` (off, low, medium, high, max) | `glm-5.3-flash` |
| `minimax` | `MiniMax-M3` (off, high) | `MiniMax-M3` |
| `mistral` | `mistral-medium-2604` (off, high) · `mistral-large-2512` (not a reasoning model) | `mistral-small-latest` |
| `groq` | `openai/gpt-oss-120b` (low, medium, high) · `qwen/qwen3.8-27b` (off, low, medium, high) | `openai/gpt-oss-20b` |
| `openrouter` | none (the listing is public) | `openai/gpt-6-luna` |
| `ollama` | none (local models come from `/api/tags`) | none (titles use the chat model) |
| `mock` | `echo`, `reasoning` (off, low, medium, high, max), `tool-approval`, `error`; Phase 6: `image`, `image-chat`, `image-tool`, `transcribe`, `speech` ([section 8](#8-mock-provider)) | `echo` |

Phase 6: the image, transcription and speech seeds (with explicit kinds and voices) are listed in
[section 13](#13-image-and-voice-models); unlike chat seeds they are listed even next to a live listing.

Notes: `deepseek-chat` and `deepseek-reasoner` were retired on 2026-07-24 (`deepseek-v4-flash` is marked deprecated
in favor of the `deepseek-flash` alias). MiniMax ids are written as in models.dev (`MiniMax-M3`); the package type
lists lowercase ids (`minimax-m3`) **(unverified which casing the API requires)**.

`reasoningEfforts` for listed models (not in seeds): `anthropic` and `deepseek` derive them from their listing
(section 3); `openai` and `xai` from the model id with the same rules as their packages; `ollama` from `/api/show`;
`openrouter` offers `off, low, medium, high` for models whose `supported_parameters` include `reasoning`; other
providers use the defaults of [PLUGINS.md](./PLUGINS.md#providerdefinition) (`off, low, medium, high`) for models
with `capabilities.reasoning`.

## 6. Provider notes

- **Anthropic**: `x-api-key` auth, `anthropic-version: 2023-06-01` added by the package. Adaptive-only models
  (`claude-opus-5-5`, `claude-fable-5`, `claude-fable-5-1`) reject disabled or budget thinking. Thinking counts
  toward `max_tokens`.
- **OpenAI**: always the Responses API (`.responses(id)`, also the package default). A base URL override must
  implement `/responses`; for Chat Completions-only proxies create a declarative `openai-chat` provider instead.
  GPT-6 models reject `temperature` / `topP` (the package drops them with a warning).
- **Google**: invalid keys come back as HTTP 400 with reason `API_KEY_INVALID`; `mapError` maps that to
  `auth_invalid`. Model ids are listed as `models/<id>`; the prefix is stripped.
- **xAI**: `@ai-sdk/xai` 5.x uses only the Responses API (`/v1/responses`). `grok-4.20-*-reasoning` /
  `-non-reasoning` variants do not accept an effort. An invalid key is answered with HTTP **400** "Incorrect API key
  provided" (not 401); the common auth message rule maps it to `auth_invalid` (action `configure-provider`).
- **DeepSeek**: base URL without `/v1`. V4 models think by default (with `auto`); `temperature` / `topP` are ignored
  while thinking.
- **Moonshot AI (Kimi)**: the console moved to `platform.kimi.ai`; the API host stays `api.moonshot.ai`. Kimi K3
  always reasons.
- **Alibaba (Qwen)**: keys are regional; the default is the international (Singapore) endpoint. The listing returns
  many non-chat models (filtered, section 3).
- **Z.ai (GLM)**: general and Coding Plan keys use different base URLs (section 2) and are not interchangeable.
- **MiniMax**: the builtin uses the Anthropic-compatible endpoint; the OpenAI-compatible endpoint
  (`https://api.minimax.io/v1`) is not used. Default `max_tokens` (the MiniMax recommendation): **131072** for the
  M3 family (`MiniMax-M3`, `MiniMax-M3.x`) and **65536** for other models, applied through the model wrapper
  (section 2) because the package's Anthropic internals would cap unknown models at 4096 output tokens, thinking
  included; a call value still wins. Effort menu: MiniMax-M3 offers `off` / `high` (thinking disabled / adaptive);
  M3.1 and later and the M2 family always think (no effort menu; M3.1+ rejects `disabled` with HTTP 400). MiniMax
  `base_resp.status_code` errors are mapped (`1004` / `2049` -> `auth_invalid`, `1008` -> balance `provider_error`,
  `2056` and `1002` / `1039` / `1041` / `2045` -> `rate_limited`). Pay-as-you-go keys and Token Plan subscription keys
  are reportedly not interchangeable **(unverified)**.
- **Mistral**: only some models accept an effort, and only `none` / `high`.
- **Groq**: `reasoning_format` and `include_reasoning` are mutually exclusive; the always-on `reasoningFormat:
  'parsed'` is skipped for `openai/gpt-oss-*`.
- **OpenRouter**: created with `createOpenRouter({ apiKey, baseURL, fetch, compatibility: 'strict', appName:
  'harness-forge', appUrl: 'https://github.com/maksqi/harness-forge' })`. The package sends `appName` as
  `X-OpenRouter-Title` (the current name of the legacy `X-Title` header, which OpenRouter still accepts) and `appUrl`
  as `HTTP-Referer` (required for attribution). With `usage: { include: true }` the response carries the charged
  cost in `providerMetadata.openrouter.usage.cost`, which is used as `costUsd` (ARCHITECTURE.md, Model catalog).
  The model listing is public, so it cannot prove a key: `validate` (the **Test** button) calls `GET {baseURL}/key`,
  which fails without a valid key; when that endpoint is missing (a proxy base URL), it falls back to a 1-token call
  on `smallModelId`.
- **Ollama**: no key; the base URL is the main (not advanced) field so remote Ollama hosts work
  (`http://gpu-box:11434/v1`). `ECONNREFUSED` maps to `provider_unreachable` with the message "Cannot reach Ollama at
  <origin>. Is Ollama running?". The OpenAI-compatible API also accepts `reasoning_effort` (see mapping);
  `stream_options.include_usage` is supported, so `includeUsage: true` is set.

### Error mapping

Default mapping (after `provider.mapError`): 401 / 403 -> `auth_invalid` (action `configure-provider`); 429 ->
`rate_limited` (`retryAfterMs` from `retry-after`); 404 -> `model_not_found` (action `refresh-models`); context length
errors -> `context_overflow`; `ECONNREFUSED` / `ENOTFOUND` -> `provider_unreachable`; everything else ->
`provider_error`. Provider-specific `mapError` rules:

| id | Condition | Mapped to |
|---|---|---|
| `anthropic` | HTTP 529 `overloaded_error` | `provider_error`, action `retry` |
| `google` | HTTP 400 with `API_KEY_INVALID` | `auth_invalid`, action `configure-provider` |
| `xai` | HTTP 400 "Incorrect API key provided" (common auth message rule) | `auth_invalid`, action `configure-provider` |
| `minimax` | `base_resp.status_code` `1004` / `2049`; `1008`; `2056`, `1002`, `1039`, `1041`, `2045` | `auth_invalid`; `provider_error` (balance); `rate_limited` |
| `deepseek` | HTTP 402 (insufficient balance) | `provider_error` "DeepSeek account balance is insufficient" |
| `openrouter` | HTTP 402 (no credits) | `provider_error` "OpenRouter credits are exhausted" |
| `ollama` | connection refused | `provider_unreachable` with the hint above |

## 7. OpenRouter and Ollama at a glance

| | OpenRouter | Ollama |
|---|---|---|
| Key | required for chat, not for the listing; tested with `GET /key` | none (optional Bearer) |
| Listing | public `GET /api/v1/models` with pricing, context, capabilities | `GET /api/tags` (+ `POST /api/show`) |
| Model ids | `vendor/model` (`anthropic/claude-sonnet-5`, `~openai/gpt-luna-latest`) | `name:tag` (`llama3:8b`), refs like `ollama:llama3:8b` |
| Cost | provider-reported (`usage.include`) | none (local) |
| Reasoning | `providerOptions.openrouter.reasoning.effort` | `reasoning_effort` |
| Base URL | `https://openrouter.ai/api/v1` (Advanced) | `http://localhost:11434/v1` (main field) |

## 8. Mock provider

Dev and e2e only: the builtin plugin `mock` registers provider `mock` and tool `mock_approval_tool` when
`HF_MOCK_PROVIDER=1` (`pnpm start:e2e` sets it). Models are `MockLanguageModelV4` instances from `ai/test` streaming
through `simulateReadableStream`. The provider has no credentials (status `connected`), no icon (monogram),
`smallModelId: 'echo'`, `listModels` (and `seedModels`) return its seventeen models (the four chat models of v1, the five
models of Phase 6, `workspace` of Phase 7, `checkpoint` and `shell` of Phase 8, and `compact`, `plan`, `todo`, `subagent`
and `steer` of Phase 9), and `validate` always succeeds. Its
`reasoning()` maps `off` -> `none`, `low` / `medium` / `high` -> same, `max` -> `xhigh`. Since Phase 6 (manifest
`engines.harness` `^1.1.0`) it also defines `createImageModel`, `imageParams`, `createTranscriptionModel`,
`createSpeechModel` and a `transcriptionOptions` that returns nothing (the mock models ignore the language), with models
built on `MockImageModelV4`, `MockTranscriptionModelV4` and `MockSpeechModelV4` from `ai/test` (a small PNG encoder on
`zlib.deflateSync` + `zlib.crc32`, and a WAV writer exported as `createMockWav()` for tests). `imageParams` returns
`{ aspectRatio, providerOptions: { mock: { aspectRatio } } }` (nothing for Auto): `mock:image` sizes its PNGs from
`aspectRatio`, `mock:image-chat` from the provider option (a chat model gets only the provider options). A media model
id other than the three below rejects with a 404 `APICallError`.

Names: Mock Echo, Mock Reasoning, Mock Tool Approval, Mock Error, Mock Image, Mock Image Chat, Mock Image Tool, Mock
Transcribe, Mock Speech, Mock Workspace, Mock Checkpoint, Mock Shell, Mock Compact, Mock Plan, Mock Todo, Mock Sub-agent,
Mock Steer. `GET /api/models` shows fifteen of them (the four chat models, `image`, `image-chat`, `image-tool`,
`workspace`, `checkpoint`, `shell`, `compact`, `plan`, `todo`, `subagent`, `steer`); `transcribe` and `speech` are
hidden and chosen in Settings → Media. The provider's `modelCount` is 14 (visible chat models; the image model is not
counted). A data directory whose cached mock listing predates a model (the e2e server's `.tmp/e2e`: `workspace` in
Phase 7, `checkpoint` and `shell` in Phase 8, the five agent mocks in Phase 9) shows the new models only after a
refresh: move it aside before a gate.

Common behavior (deterministic):

- **User text**: the text parts of the last `user` message of the prompt (after slash-command expansion), joined with
  a space and trimmed.
- **Streaming**: text is streamed one word per chunk (each chunk is a word plus its following whitespace), first chunk
  after 50 ms, then every 25 ms. Reasoning chunks come every 100 ms. Streams end promptly when the call's
  `abortSignal` aborts.
- **Usage**: `inputTokens` = number of whitespace-separated words in all prompt text parts; `outputTokens` = number of
  streamed text and reasoning words; `reasoningTokens` = reasoning words.
- **Model info** (the four chat models and `image-chat`, `image-tool`, `workspace`, `checkpoint`, `shell`, `compact`,
  `plan`, `todo`, `subagent`, `steer`): `contextWindow: 32000` (`compact`: 2000, so a few turns pass 80 % of it),
  `maxOutputTokens: 4096`, `cost: { input: 1, output: 2 }` (USD per 1M tokens, so cost displays are non-zero);
  `image-chat`, `image-tool`, `workspace`, `checkpoint`, `shell` and the five Phase 9 models declare `kind: 'chat'`
  explicitly (an explicit kind wins over `classify()`); the Phase 9 models have the `tools` capability only. The media
  models have explicit kinds: `image` (`kind: 'image'`, `capabilities.vision: true`, the same cost, so image turns show
  an estimated cost), `transcribe` (`kind: 'transcription'`) and `speech` (`kind: 'speech'`,
  `voices: ['mock-voice-a', 'mock-voice-b']` so the Voice suggestions can be tested); the last two have no limits and
  no price.

| Model ref | Capabilities | Behavior |
|---|---|---|
| `mock:echo` | vision, pdf | Streams the user text back. Empty user text -> `(empty message)`. If the last user message has file parts, appends `\n\n[files: <n>]`. `finishReason: 'stop'`. Title generation with `echo` therefore yields the first words of the first message. |
| `mock:reasoning` | reasoning (`reasoningEfforts`: off, low, medium, high, max) | Received `reasoning` option = `none`: no reasoning part, text `Answer: <user text>`. Otherwise: a reasoning part `Thinking about "<first 8 words of the user text>" with effort <value>.` (value = the received option, `provider-default` for `auto`, `xhigh` for `max`), streamed at 100 ms per word (about 1 s, so the "Thinking" row is visible), then the text `Answer: <user text>`. |
| `mock:tool-approval` | tools | If `mock_approval_tool` is not in the call's tools (tool mode `off`, tool disabled): text `Tools are disabled.` Else, if the prompt does not end with a result of this tool: one tool call `mock_approval_tool` with input `{ "text": "<user text>" }` and id `mock_call_<n>` (n = number of assistant messages in the prompt + 1), `finishReason: 'tool-calls'`. If it ends with a result: text `Tool result: <JSON of the output>`, or `The tool call was denied.` for a denied result. |
| `mock:error` | — | `doStream` rejects before any chunk with `APICallError` (`statusCode: 401`, message `Mock authentication failure`, `url: 'mock://error'`, not retryable), mapped to `auth_invalid` with action `configure-provider` and delivered in the stream (the provider is configured, so there is no pre-flight 400). |
| `mock:image` (Phase 6) | image model, vision | Waits 300 ms (5 s when the prompt contains "slow", for Stop and placeholder tests) and honors the abort signal; a prompt containing "fail" then rejects with a 400 `APICallError` "Mock image generation failure" (not retryable, mapped to `provider_error`). Otherwise returns `n` solid-color PNGs (up to 4 per call) whose color comes from a sha256 of the prompt, the image index and the input images, so every image and every edit differs. Size: the long edge is 320 px and the aspect ratio sets the short edge exactly (16:9 -> 320×180, 3:2 -> 318×212, 9:16 -> 180×320); Auto (no aspect ratio) -> 320×320; an explicit `size` is scaled down to at most 1024 px. Usage: input tokens = the prompt's words, output tokens = 100 × `n`; `revisedPrompt` `Mock: <prompt>` in `providerMetadata.mock.images[i].revisedPrompt` (the key OpenAI uses). |
| `mock:image-chat` (Phase 6) | chat, `imageOutput` | Streams `Image for: <user text>` word by word, then one PNG `file` part with raw bytes (color from the user text; size from `providerOptions.mock.aspectRatio`, square without one): a model-side file, so the pipeline must store it and re-send it with an `/api/files/` URL. |
| `mock:image-tool` (Phase 6) | tools | Like `mock:tool-approval` for the builtin `generate_image` tool: without the tool in the call (tool mode `off`, tool disabled) text `Tools are disabled.`; else, when the prompt does not end with its result, one tool call `generate_image` with input `{ "prompt": "<user text>" }` (`(empty message)` for an empty text) and id `mock_call_<n>`; after the result, text `Image tool result: <n> image(s)` (n = the images of a JSON output, else the count in the tool's text for the model, "Generated 1 image with …"), or `The tool call was denied.`. Needs an image model in Settings → Media (`imageModelRef`, e.g. `mock:image`). |
| `mock:workspace` (Phase 7) | tools | Walks through the builtin workspace tools of `core-workspace` (ADR-032) in a project chat. The step is chosen by the number of workspace tool results that follow the last user message: (1) `write_file` with `{ "path": "mock-workspace.txt", "content": "Hello from the mock agent.\n" }`; (2) `edit_file` with `{ "path": "mock-workspace.txt", "old_string": "mock agent", "new_string": "workspace agent" }`; (3) `shell` with `{ "command": "cat mock-workspace.txt" }`, skipped when `shell` is not offered (`HF_WORKSPACE_SHELL=0`, Windows); then the text `Workspace done: <stdout of the shell call>` (so `Workspace done: Hello from the workspace agent.` after a full run), or `Workspace done.` without the shell. Ids `mock_call_<n>` as above, `finishReason: 'tool-calls'` for each call. The stdout is read from the shell tool's text for the model (the lines after `stdout:` up to a `stderr:` line, trimmed), or from `stdout` of a JSON output. A denied call (a denied result or approval response after the last user message) ends the plan with `The tool call was denied.`; a failed call (an error result as the last workspace result) with `The tool call failed: <error text>`; unless both `write_file` and `edit_file` are in the call (a chat without a project, tool mode `off`, the folder unavailable, either tool switched off) the text is `Workspace tools are not available.`. In tool mode `edits` the write and the edit run without a card and the shell asks; in `ask` all three ask; in `auto` none does. |
| `mock:checkpoint` (Phase 8) | tools | For rewind, the changes panel, the sticky working folder and shell rules in a project chat (ADR-036, ADR-038); the user text is ignored. The step is chosen by the number of workspace tool results that follow the last user message: (1) `write_file` with `{ "path": "checkpoint.txt", "content": "Turn <n>\n" }` (n = the number of user messages in the prompt, so every turn changes the file and each user message is a rewind point; the path is always relative to the project folder); (2) `shell` with `{ "command": "mkdir -p mock-dir && cd mock-dir" }`; (3) `shell` with `{ "command": "ls" }`, which runs in the folder the previous call ended in; then the text `Checkpoint done.` Steps 2 and 3 are skipped when `shell` is not offered (`HF_WORKSPACE_SHELL=0`, Windows). The shell calls follow the sticky working folder (ARCHITECTURE.md 6.13), so the folders nest on later turns: on turn 1 step 2 starts in the project folder and step 3 runs in `mock-dir` (its stored `cwd` and `endCwd` are `mock-dir`); on turn 2 step 2 starts in `mock-dir` and creates `mock-dir/mock-dir`, where step 3 runs; turn n ends n levels deep. The checks run in this order: without `write_file` in the call the text is `Workspace tools are not available.` (as `mock:workspace`); a denied call (a denied result or approval response after the last user message) ends with `The tool call was denied.`; a failed call (an error result as the last workspace result; a non-zero exit code is not a failure) with `The tool call failed: <error text>`. Ids `mock_call_<n>` and `finishReason: 'tool-calls'` as above. In `edits` the write runs without a card and both shell calls ask unless shell rules allow them: an `ls` rule lets step 3 run without a card; step 2 still asks with a `mkdir` rule, because a `cd` segment needs no rule only when its target already exists inside the project when the call is checked, and `mock-dir` (on later turns the next nested `mock-dir`) is created by the same command. In `ask` all three ask; in `auto` none does. |
| `mock:shell` (Phase 8) | tools | Runs the user text (trimmed) as one `shell` call `{ "command": "<user text>" }` (id `mock_call_<n>`, `finishReason: 'tool-calls'`); once the prompt holds a `shell` result after the last user message, the text `Shell done: <stdout>` (the stdout read as for `mock:workspace`, trimmed; with the real `shell` tool an empty stdout reads `Shell done: (empty)`, from the tool's text for the model). The checks run in this order: without `shell` in the call (a chat without a project, tool mode `off`, `HF_WORKSPACE_SHELL=0`, Windows): `Workspace tools are not available.`; an empty user text: `(empty message)` without a call; a denied call: `The tool call was denied.`; a failed call (an error result as the last workspace result; a non-zero exit code is a normal output): `The tool call failed: <error text>`. The call starts in the chat's sticky working folder, so `cd sub` in one turn and `pwd` in the next prints `<root>/sub`. Used by the sticky-folder and shell-rule tests and probes (`mkdir -p sub && cd sub`, then `pwd`; `ls && rm x`; `echo a > f`; `sleep 5` for the run-active 409). |
| `mock:transcribe` (Phase 6) | transcription | Returns the text `This is a mock transcription.` for any accepted recording (no segments, language or duration reported; the language setting is ignored); rejects when the call is aborted. |
| `mock:speech` (Phase 6) | speech | Returns a silent WAV (RIFF / WAVE, 8 kHz, mono, 16-bit PCM, the 44-byte canonical header) lasting 400 ms per word of the text, at least 1 s and at most 6 s, for any voice; `generateSpeech` reports `audio/wav` from the magic bytes. Rejects when the call is aborted. |

Tool `mock_approval_tool`: description "Echoes its input. Mock tool that requires approval.", input
`{ text: string }`, `policy: 'ask'`, `execute` returns `{ "echoed": "<text>" }`. In tool mode `ask` it shows the
approval card (Allow -> `Tool result: {"echoed":"..."}`, Deny -> `The tool call was denied.`); in `auto` it runs
without a card. Stop tests send a long message to `mock:echo` (400 words stream for about 10 s), or a "slow" prompt to
`mock:image`.

### Agent mocks (Phase 9)

Five chat models drive compaction, plan mode, todos, sub-agents and the steer queue (ADR-040 … ADR-043). They are
complete and frozen from Gate P9-0b; **this subsection is the contract of the gate probes and the e2e specs**. The
shared scheduler (`MockPlan`) gains `toolCalls` (several tool calls in one step, streamed in order and run in parallel
by the SDK) and `stepDelayMs` (an abortable wait before the step streams anything). Shared rules:

- **Tool call ids**: `mock_call_<n>` as above (n = the number of assistant messages in the prompt + 1); a step with one
  call keeps `mock_call_<n>`, and only a step with two or more calls (run in parallel by the SDK) uses
  `mock_call_<n>_<i>` (i from 1). Every step with calls ends with `finishReason: 'tool-calls'`.
- **Offered tools** = the function tools of the call (`options.tools`; the SDK passes only the active ones). A list of
  them is always the names sorted by code point and joined with `", "`, or `none`.
- **Turn**: the messages after the last user message that is not a steer. A steer is a user message right after a
  `tool` message (6.20 of ARCHITECTURE.md), or right after another steer (several steers delivered at one boundary).
  "Results" below count only the tool results of the current turn. A server-started turn whose extra queued messages
  were steered at step 0 ends the prompt with several user messages after an assistant message: none of them is a
  steer, so the turn opens at the last of them.
- **Markers**: the summarizer and sub-agent calls are recognized by their system text (the run's instructions)
  containing `COMPACT_INSTRUCTIONS_MARKER` (`[[hf:compact-summarizer:v1]]`) / `SUBAGENT_INSTRUCTIONS_MARKER`
  (`[[hf:subagent:v1]]`) (`apps/server/src/chat/markers.ts`).
- A denied result of the current turn (other than the plan cases below) ends with `The tool call was denied.`; an error
  result as the last result with `The tool call failed: <error text>` (except `mock:todo`'s planned `invalid` call).
  Without the tool a script needs: `Tools are disabled.`
- **Waits**: every step of a `mock:todo` turn and of a `steps <N>` turn of `mock:steer` waits 400 ms first (the final
  text and the end texts included), every step of a sub-agent child 300 ms; other answers (echo turns included) start
  at once.
- **Sentinels**: `OLD-<letters or digits>` tokens (regex `OLD-[A-Za-z0-9]+`) are plain words the probes put into
  messages to see what the model still receives.

| Model ref | Behavior |
|---|---|
| `mock:compact` | `contextWindow` 2000. Checked in this order. (1) **Summarizer** (the system text holds `COMPACT_INSTRUCTIONS_MARKER`): the text `MOCK-SUMMARY: <first words> \| steps-done=<K> \| focus=<focus> \| sentinels=<S>` on one line, where `<first words>` = the first 8 words of the last user message's text (the rendered transcript; `(empty message)` for none), `<K>` = the number of `Step <k> done.` texts in the transcript outside `MOCK-SUMMARY:` lines plus the `steps-done=` value of the latest `MOCK-SUMMARY:` line in it (0 without; an older summary's own `Step <k> done.` words are not counted again), `<focus>` = the text after `Focus: ` on its own line of the system text (`none` without one; the summarizer states the focus that way), `<S>` = the distinct sentinels of the transcript in first-seen order joined with `,` (`none`). (2) **Reporter**: the last text part of the last user message, trimmed, is `seen?` → the text `summary:<yes\|no> seen:<S>`, where `yes` means a `MOCK-SUMMARY:` line is anywhere in the prompt and `<S>` = the distinct sentinels of the prompt's text **outside** `MOCK-SUMMARY:` lines (first-seen order, `,`-joined, `none`). (3) **Loop**: the user text of the prompt (every user message, merged summaries included) contains `loop <N>` (the first match of `\bloop (\d+)\b`; an N outside 1–50 falls through to (4)) → with `done` = the `steps-done=` value of the latest `MOCK-SUMMARY:` line in the prompt plus the `Step <k> done.` texts after it: while `done < N`, one step that streams `Step <done+1> done.` and 120 filler words (`filler`, repeated) and calls `todo_write` with `{ "todos": [{ "id": "loop", "content": "Run <N> steps", "status": "in_progress", "activeForm": "Running step <done+1> of <N>" }] }`; then the text `Loop finished after <N> steps.` (`todo_write` not offered: `Tools are disabled.`; a denied or failed call of the turn ends it as in the shared rules). (4) Otherwise: the last text part of the last user message (`(empty message)` for none) followed by 150 filler words (`filler`), so every turn grows the context by about 160 words. "The transcript" and "the prompt's text" are the text parts of the call's user and assistant messages, read line by line (so a merged summary part never swallows the user's own text) |
| `mock:plan` | Every call first streams the line `tools: <offered tools>`, then: (0) the shared ends first: an error as the last result of the turn → `The tool call failed: <error text>`; a denied result of another tool than `exit_plan_mode` → `The tool call was denied.`. (1) the current turn holds an **approved** `exit_plan_mode` result (one that is neither denied nor an error) → `write_file` with `{ "path": "notes.txt", "content": "Planned and done.\n" }` when it is offered and has no result yet in the turn, then the text `Plan done in mode <mode>.` (`<mode>` = the result's `mode`, `edits` or `ask`; a text result maps "Accept edits" to `edits` and "Ask" to `ask`; `unknown` when it cannot tell). (2) `exit_plan_mode` is offered: the last result of the turn is a **denied** `exit_plan_mode` → the text `Revising: <reason>` (the denial reason, `no reason` without one) and a new `exit_plan_mode` call with `{ "plan": "# Plan (revised)\n1. Create notes.txt.\n2. Address: <reason>" }`; otherwise in order by the results of the turn: `todo_write` (when it is offered) with two items (`{ "id": "1", "content": "Explore the project", "status": "in_progress", "activeForm": "Exploring the project" }`, `{ "id": "2", "content": "Write the plan", "status": "pending", "activeForm": "Writing the plan" }`), then `list_directory` with `{ "path": "." }` when it is offered, then `exit_plan_mode` with `{ "plan": "# Plan\n1. Create notes.txt.\n2. Report back." }`. (3) Otherwise: `Plan mode is off.` |
| `mock:todo` | Waits 400 ms before each step, the final text included (so a test can see each state). The step is the number of `todo_write` results of the turn. Three `todo_write` calls, one per step, over the items `1` "Read the code" ("Reading the code"), `2` "Change the code" ("Changing the code"), `3` "Run the tests" ("Running the tests") (`content` and `activeForm`): call 1 all `pending`; call 2 item 1 `completed`, item 2 `in_progress`, item 3 `pending` (the strip reads "1/3 · Changing the code"); call 3 all `completed`; then the text `All 3 tasks done.` With the word `invalid` in the turn's user text (case-insensitive), the first call sends a list with duplicate ids (items 1 and 2 both `1`, all `pending`; the input schema refuses it, so the model gets an error result) and the script then continues with the three calls (that planned error does not end the turn). Without `todo_write`: `Tools are disabled.`; any other denied or failed result ends the turn as in the shared rules |
| `mock:subagent` | Checked first, **Child** (the system text holds `SUBAGENT_INSTRUCTIONS_MARKER`; each step waits 300 ms first, so parallel children overlap): `<prompt>` = the text of the last user message. (1) No result yet in the turn and a probe offered: one call to the first offered of `list_directory` (`{ "path": "." }`) and `current_time` (`{}`). (2) The prompt contains the word `write`, `write_file` is offered and has no result yet: `write_file` with `{ "path": "subagent.txt", "content": "Written by a sub-agent.\n" }`. (3) The prompt contains the word `loop` and `list_directory` or `current_time` is offered: the call of (1) again (every step, until the finalize step offers no tool). (4) Otherwise the report: `Report: <prompt> \| tools: <offered tools>` (`none` when the finalize step removed them). **Parent** (`task` offered): when the turn has no `task` result, one step with parallel `task` calls: by default two, `{ "description": "List the project files", "prompt": "List the project files.<extra>", "type": "explore" }` and `{ "description": "Check the time", "prompt": "Check the time.<extra>", "type": "general" }`; with `parallel <N>` in the user text (N 1–10; another N keeps the default two) N calls `{ "description": "Task <i>", "prompt": "Task <i>.<extra>", "type": <explore for odd i, general for even i> }`; `<extra>` = a space and the user text when it contains the word `write` or `loop` (case-insensitive), else empty. After the results: `Reports: <r1> \|\| <r2> …` (each the result's text for the model, in call order: the `task` tool's model text reads only `{ status, report, error? }`, so a completed child gives its report and a failed one `Sub-agent failed: <error>; partial report: …`). Without `task` (and not a child): `Sub-agents are not available.` Both sides end a turn with a denied or failed result as in the shared rules |
| `mock:steer` | A turn whose user text is exactly `steps <N>` (trimmed; N 1–20) runs N steps; every step of it (the final text included) waits 400 ms (`stepDelayMs`), then calls `current_time` with `{}`, until the turn holds N `current_time` results; then the text `Finished <N> steps. Steers: <list>` (`<list>` = the texts of every steer of the turn, in order, joined with `" \| "`, or `none`). When the prompt ends with steers (user messages after the turn's last tool message), the step first streams one line `Steered: <text>.` per steer, then goes on with the plan (the next call, or the final text). Any other turn: the text of the last user message (like `mock:echo`, no wait). A server-started turn whose extras were steered at step 0 reads its last queued message as the turn's user text (Turn above). Without `current_time`: `Tools are disabled.`; a denied or failed result ends the turn as in the shared rules |

How the probes use them (ARCHITECTURE.md 6.18 – 6.22): `mock:compact` turns with sentinels, then `/compact keep numbers`
and `seen?` (`summary:yes seen:none`), an edit above the marker (`summary:no seen:OLD-1`), `loop 30` for an in-run
compaction, `compactModelRef: mock:error` for the failure fallback; `mock:plan` in a project chat in plan mode (approve
with Accept edits → `notes.txt` and `Plan done in mode edits.`; Keep planning with feedback → `Revising: <feedback>`);
`mock:todo` in Ask (no card; `invalid please` for the error part; a `/compact` afterwards carries the todo snapshot);
`mock:subagent` as both the chat model and `subagentModelRef` (two parallel children in Ask, `write` in Accept edits,
`parallel 5` for the semaphore, `loop` with Stop, `loop` with `subagentMaxSteps: 2`); `mock:steer` with `steps 5` and a
message queued during step 1 (a `data-steer` between steps, `Steers: <text>` in the final text), `steps 2` with a
message queued during the last step (the next turn), `steps 4` with a cancelled message and `steps 6` with a queued
`/compact` dropped by Stop.

## 9. Declarative provider templates (wizard)

Step 2 of the provider wizard offers these templates; each fills a `DeclarativeProvider`
([PLUGINS.md](./PLUGINS.md#4-declarative-providers)). The suggested plugin id is shown in the first column.

| Template (plugin id) | `baseURL` | `apiFormat` | `auth` / credentials | `listModels` | `reasoningStyle` | `modelsDevId` | Icon | Get a key |
|---|---|---|---|---|---|---|---|---|
| Together AI (`together-ai`) | `https://api.together.xyz/v1` | `openai-chat` | `bearer`, `apiKey` required | `{ "exclude": "embed\|rerank\|whisper\|flux\|stable-diffusion\|tts\|guard" }` (bare-array listing with `type`) | `openai-effort` | `togetherai` | `lobe:together` (color + mono) | https://api.together.ai/settings/api-keys |
| Fireworks (`fireworks`) | `https://api.fireworks.ai/inference/v1` | `openai-chat` | `bearer`, `apiKey` required | `true` | `openai-effort` | `fireworks-ai` | `lobe:fireworks` (color + mono) | https://app.fireworks.ai/settings/users/api-keys |
| LM Studio (`lmstudio`) | `http://localhost:1234/v1` | `openai-chat` | `none` (no credentials) | `true` | `openai-effort` (LM Studio 0.4.8+ honors `reasoning_effort`) | `lmstudio` | `lobe:lmstudio` (mono only) | none (https://lmstudio.ai/download) |
| vLLM (`vllm`) | `http://localhost:8000/v1` | `openai-chat` | `bearer`, `apiKey` optional (`--api-key`) | `true` | `openai-effort` (model-dependent) | — | `lobe:vllm` (color + mono) | none |
| LiteLLM proxy (`litellm`) | `http://localhost:4000/v1` | `openai-chat` | `bearer`, `apiKey` optional (master or virtual key) | `true` (ids are the proxy's `model_name` aliases) | `openai-effort` (LiteLLM translates `reasoning_effort`) | — | monogram (no LobeHub icon) | none |

The wizard also offers "Anthropic-compatible" (`apiFormat: 'anthropic'`, `auth` header `x-api-key`, base URL ending
in `/v1`) without a template. Every template field stays editable; the Review step runs a 1-token test. Declarative
credentials cannot name an environment variable (`envVar` is rejected in manifests), so the wizard has no env-var
field: keys are entered in Settings -> Providers after the plugin is created. Runnable manifests of two templates:
[`examples/plugins/lmstudio`](../examples/plugins/lmstudio/) and [`examples/plugins/together-ai`](../examples/plugins/together-ai/);
walkthrough: [Writing a declarative provider](./guides/writing-a-declarative-provider.md).

## 10. Icons

- Brand icons come from `@lobehub/icons-static-svg` 1.95.1 (MIT) and are served **only by the server**:
  `GET /api/icons/lobe/<slug>` (SVG) and `GET /api/icons/lobe` (slug list for the wizard icon picker). Plugin file
  icons: `GET /api/plugins/<id>/icon`. The provider DTO carries `icon: { color?: string; mono?: string } | null`
  (URLs).
- **Color** variant (`<slug>-color.svg`, fixed brand colors and gradients): rendered with `<img>` on a `bg-muted`
  tile (settings rows, plugin cards, picker group headers).
- **Mono** variant (`<slug>.svg`, drawn with `currentColor`): rendered as a `<span>` with CSS `mask-image` over
  `background-color: currentColor`, so it follows the theme (picker rows, compact places).
- Fallbacks: no color -> mono tile; no mono -> the color `<img>`; neither -> a monogram (initials of the provider
  name) on `oklch(0.45 0.09 h)` in dark / `oklch(0.90 0.05 h)` in light, with `h` derived from a hash of the id.
- SVG markup is never inlined (`v-html` is forbidden); server icon responses use `image/svg+xml`, `nosniff` and a
  restrictive CSP.

Slugs used by builtins and templates (all verified to exist in 1.95.1):

| Provider / template | Color slug | Mono slug |
|---|---|---|
| Anthropic | `claude-color` | `claude` |
| OpenAI | — | `openai` |
| Google | `gemini-color` | `gemini` |
| xAI | — | `grok` |
| DeepSeek | `deepseek-color` | `deepseek` |
| Moonshot AI | `kimi-color` | `kimi` |
| Alibaba | `qwen-color` | `qwen` |
| Z.ai | `zhipu-color` | `zai` |
| MiniMax | `minimax-color` | `minimax` |
| Mistral | `mistral-color` | `mistral` |
| Groq | — | `groq` |
| OpenRouter | `openrouter-color` | `openrouter` |
| Ollama | — | `ollama` |
| Together AI | `together-color` | `together` |
| Fireworks | `fireworks-color` | `fireworks` |
| LM Studio | — | `lmstudio` |
| vLLM | `vllm-color` | `vllm` |
| LiteLLM | — | — (monogram) |

Other brand slugs that exist in the set (useful in the icon picker): `anthropic`, `xai`, `moonshot`, `alibaba` /
`alibaba-color`, `alibabacloud` / `alibabacloud-color`, `bailian` / `bailian-color`, `chatglm` / `chatglm-color`,
`google` / `google-color`. `*-text` files are wordmarks and are not used for provider icons.

## 11. Verification log

Verified on 2026-09-28:

- **Environment variables** read by each package (`loadApiKey` calls in the published source): `ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `XAI_API_KEY`, `DEEPSEEK_API_KEY`, `MOONSHOT_API_KEY`,
  `ALIBABA_API_KEY`, `ZAI_API_KEY`, `MINIMAX_API_KEY`, `MISTRAL_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`;
  `@ai-sdk/openai-compatible` reads none.
- **Default base URLs and factories**: package source and type exports.
- **Reasoning options and top-level mappings**: package source (`isCustomReasoning`, `mapReasoningToProviderEffort`,
  `mapReasoningToProviderBudget` call sites) and bundled provider docs; AI SDK v7 top-level `reasoning` from `ai`'s
  bundled docs.
- **Listing endpoints**: unauthenticated probes (401 on the endpoint, 404 on a nonexistent sibling path) for xAI,
  Moonshot, Alibaba and MiniMax; vendor API docs for Anthropic, Google, DeepSeek, Mistral, Groq, Ollama; OpenRouter
  fetched live.
- **Key URLs**: HTTP resolution (redirects followed) and vendor docs.
- **Icons**: file list of `@lobehub/icons-static-svg@1.95.1` on jsDelivr.
- **Seed ids**: models.dev `api.json` (chat seeds); the media seeds of [section 13](#13-image-and-voice-models) against
  the id unions of the installed packages.
- **Media factories and options** (Phase 6): `.image()`, `.transcription()` and `.speech()` and the provider option
  keys in the installed package source; the request bodies (OpenAI `size`, xAI `aspect_ratio`, Google
  `responseModalities` / `imageConfig`, OpenRouter `modalities` / `image_config`, each provider's transcription
  `language` field, no extra speech option) asserted with a fake `fetch` in
  `apps/server/src/builtin-plugins/core-providers/providers/media.test.ts`; which media seeds the bundled models.dev
  snapshot knows and prices (section 13).

Unverified (no live run recorded yet): the Phase 6 media behavior of [section 13](#13-image-and-voice-models) against
the real APIs (Gemini image output and thought signatures, the carry-forward of generated images, every voice list
(Mistral has none), the xAI speech and transcription endpoints and whether the xAI `language` option changes
recognition, the unit of xAI's image cost `costInUsdTicks`); `grok-4.7` accepted efforts and the `/v1/language-models`
response shape; Z.ai `/models` on the general endpoint and per-model effort support of GLM models; MiniMax listing shape
and model id casing; Alibaba listing shape and which Qwen models accept `enable_thinking`; Ollama `/api/show`
`thinking.values` on real models (the mapping of section 4 is implemented from Ollama's docs); the MiniMax China base
URL.

Live results: none yet (neither the chat checks nor the media checks of [section 12](#12-live-provider-suite) have
been run). To record results, run `pnpm test:live` with the provider keys (or the "Live providers" workflow; add
`HF_LIVE_MEDIA=1` for the image and voice checks), then copy each provider's row of the summary table (PASS / SKIP /
FAIL per check, the media columns included) into this section with the date and the package versions, and move the
items it confirms out of "Unverified".

## 12. Live provider suite

v1 was exercised only with the `mock` provider. The live suite (ADR-027) runs real requests against every builtin
provider you have a key for. It is **opt-in and paid**: `pnpm test` never runs it, even with keys exported.

### Running it

```sh
ANTHROPIC_API_KEY=sk-ant-... pnpm test:live                       # one provider
HF_LIVE_PROVIDERS=anthropic,openai pnpm test:live                  # only these (keys from the environment or .env)
HF_LIVE_MAX_COST_USD=0.20 pnpm test:live                           # a smaller budget
HF_LIVE_PROVIDERS=none pnpm test:live                              # dry run: no request, every provider SKIP
```

- `pnpm test:live` runs `vitest run --config apps/server/vitest.live.config.ts`: only
  `apps/server/src/**/*.live.test.ts`, one file at a time, with `HF_LIVE=1` set by the config and 60 s default
  timeouts (each provider test allows 8 minutes, each chat stream 2 minutes before the run is stopped). Every live file
  also guards itself with `describe.runIf(process.env.HF_LIVE === '1')`, and the normal server config excludes
  `*.live.test.ts`.
- Keys come from the environment; the repository `.env` is read as well (variables already set win), like the server
  does at start. `HF_LIVE_PROVIDERS` and `HF_LIVE_MAX_COST_USD` may live in `.env` too.
- A provider without a key is reported as SKIP. Ollama runs when `http://localhost:11434/api/tags` answers within 1 s,
  with the first chat model of that listing (embedding and other non-chat models are skipped); without a chat model it
  is SKIP.
- Each provider is one Vitest test: it fails when any of its checks is FAIL, and a skipped provider is a skipped test.

### Environment variables per provider

The suite reads the names from each provider's `credentials[].envVar` in `core-providers` (aliases included; the first
non-empty one wins), so they match section 1:

| Provider | Key variables | Model used (`smallModelId`) |
|---|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` | `claude-haiku-4-5` |
| `openai` | `OPENAI_API_KEY` | `gpt-6-luna` |
| `google` | `GOOGLE_GENERATIVE_AI_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY` | `gemini-3.5-flash-lite` |
| `xai` | `XAI_API_KEY` | `grok-4.3` |
| `deepseek` | `DEEPSEEK_API_KEY` | `deepseek-flash` |
| `moonshotai` | `MOONSHOT_API_KEY` | `kimi-k2.6` |
| `alibaba` | `ALIBABA_API_KEY`, `DASHSCOPE_API_KEY` | `qwen3.8-flash` |
| `zai` | `ZAI_API_KEY`, `ZHIPU_API_KEY` | `glm-5.3-flash` |
| `minimax` | `MINIMAX_API_KEY` | `MiniMax-M3` |
| `mistral` | `MISTRAL_API_KEY` | `mistral-small-latest` |
| `groq` | `GROQ_API_KEY` | `openai/gpt-oss-20b` |
| `openrouter` | `OPENROUTER_API_KEY` | `openai/gpt-6-luna` |
| `ollama` | none (a local server on `localhost:11434`) | the first chat model of its local listing (Ollama has no `smallModelId`) |

| Variable | Meaning |
|---|---|
| `HF_LIVE` | `1` enables the live files; set by `pnpm test:live` itself, never needed in `.env` |
| `HF_LIVE_PROVIDERS` | comma list of provider ids to run, case-insensitive (default: every provider with a key); `none` is a dry run that makes no request and prints the summary with every provider SKIP; an unknown id fails the run before any request and lists the valid ids |
| `HF_LIVE_MAX_COST_USD` | budget of one run in USD, a non-negative number (default 0.50); once the summed cost reaches it, the remaining paid checks (chat, reasoning, tools, and the media checks) are reported as SKIP |
| `HF_LIVE_MEDIA` | `1` adds the image and voice checks below (Phase 6); unset = chat checks only. Like the rest of the suite it runs only under `pnpm test:live` (`HF_LIVE=1`) with keys, never in `pnpm test` |

### What it checks

Providers run one after another. Each gets its own in-process server,
`createTestApp({ env: { HF_OFFLINE: '1', <its key only> } })`, with an in-memory database, so nothing is written to
`data/`. Per provider:

1. **Test**: `POST /api/providers/:id/test` returns `ok: true`.
2. **Models**: a model refresh succeeds and `GET /api/models` lists the chosen model from the live listing (not a seed
   model) and not hidden.
3. **Chat**: `POST /api/chat` on the model (effort `auto`, tools off) in a chat with a user-set title (no title call):
   text deltas stream, the finish `usage` reports input and output tokens above 0, and the reply is persisted.
4. **Reasoning**: a request with reasoning effort `low` answers with text and is persisted. A model that does not
   offer `low` gets its lowest offered effort instead: `high` for `kimi-k2.6`, `MiniMax-M3` and `mistral-small-latest`,
   which offer only Off / High. SKIP for models without reasoning or without effort control.
5. **Tools**: a round trip in permission mode `auto` with the builtin `current_time` tool (every other tool is
   disabled): the model calls it, its output streams, a text answer follows and the tool result is persisted. SKIP for
   models without tool support.
6. **Bad key**: a deliberately wrong key sent as `values.apiKey` to the provider test returns `ok: false` with an
   `auth_invalid` error (costs nothing; SKIP for Ollama, which has no key).
7. **Key not logged**: no log record captured while the provider's checks ran contains its key (SKIP for Ollama).

Checks 3 to 5 are the paid ones; each starts its own chat.

### Media checks (`HF_LIVE_MEDIA=1`, Phase 6)

Implemented in `apps/server/src/live/media.ts` (W6.14); no media check has run yet (section 11).

- **Opt-in on top of the opt-in suite**: `HF_LIVE_MEDIA=1 pnpm test:live` (the flag may also sit in `.env`; accepted
  values `1` / `true` / `yes` / `on`, and `0` / `false` / `no` / `off` / unset; any other value fails the run), so
  `HF_LIVE=1` and the provider keys are needed as well; paid, never run by `pnpm test`, by agents or on CI pushes.
- **Layout**: each media check is its own Vitest test with its own in-process app (like the chat checks); they run after
  every chat check, in the order speech, transcription, image.
- **Image**: OpenAI `gpt-image-1-mini` (one image, 1:1 sent as `size: '1024x1024'`, the returned size is checked) and
  xAI `grok-imagine-image` as image turns; Google `gemini-2.5-flash-image` and OpenRouter
  `google/gemini-2.5-flash-image` as chat models with image output (a free model refresh first, output capped at 4096
  tokens and one step). PASS = exactly one stored image for an image turn (at least one for image output) with an
  `/api/files/` URL, real raster bytes and no `data:` URL anywhere; whether the image-output reply also had text is
  reported, not required.
- **Speech**: `openai:gpt-4o-mini-tts`, `google:gemini-2.5-flash-preview-tts`, `xai:tts`,
  `mistral:voxtral-mini-tts-latest`, each with the provider's default voice (Mistral has no default voice, so its check
  may fail if the API requires one).
- **Transcription**: every transcription seed with a key (OpenAI 3, xAI `stt`, Mistral 1, Groq 2), language `en`. Each
  provider transcribes its own speech clip when it has one, else the first clip of the run; without any clip the check
  is SKIP. PASS = the transcript contains "quick brown fox" (case-insensitive).
- **Budget**: every media check counts against `HF_LIVE_MAX_COST_USD` with its recorded cost, else a fixed estimate
  ($0.05 per image, $0.01 per speech or transcription call) marked `~`; the estimate counts for every request that was
  sent, even a failed one. xAI image cost (`costInUsdTicks`) is not exposed by the server, so xAI images always count
  at the estimate. A rate limit (429) is SKIP.
- **Summary**: with the flag, the columns Image, Speech and Transcription appear before Cost ("-" = the provider has no
  such model); a media check whose logs contain the key fails. The media matrix and its caps are unit-tested in
  `support.test.ts` (part of `pnpm test`, no paid call).

Cost and safety:

- A `chat.params` hook registered by the suite caps output at 256 tokens and `maxSteps` at 3. A reasoning-capable
  model gets 2048 output tokens whenever its effort is not `off`, including `auto` (such a model may think by default,
  and thinking counts toward the output cap).
- `HF_LIVE_MAX_COST_USD`: the cost of every paid check (the recorded `costUsd` of its chat) is added up; once the
  budget is spent, the remaining paid checks are SKIP. A model without a catalog price is counted at $3 per 1M input
  and $15 per 1M output tokens, above every small model the suite uses, and its cost is marked `~` (estimated).
- A rate limit (`rate_limited`, HTTP 429) is reported as SKIP, not FAIL.
- Keys are never printed: the summary names the env var, never its value, the "Key not logged" check reads every log
  record, and every text is masked once more before it is written.
- The summary goes to stdout and, in GitHub Actions, to `$GITHUB_STEP_SUMMARY`: the totals and the spending, a table
  with the columns Provider, Key variable, Model, Test, Models, Chat, Reasoning, Tools, Bad key, Key not logged and
  Cost (USD), then one detail line per check (counts, the effort used, or why it failed or was skipped). The matrix,
  the caps and the table are unit-tested by `apps/server/src/live/support.test.ts` as part of `pnpm test`.

### In CI

Never on push or pull requests. `.github/workflows/live.yml` ("Live providers") runs it on manual dispatch only, with
three inputs: `providers` (becomes `HF_LIVE_PROVIDERS`; empty = every provider with a key, `none` = a dry run),
`max-cost-usd` (becomes `HF_LIVE_MAX_COST_USD`, default 0.50) and `media` (a checkbox, off by default; on sets
`HF_LIVE_MEDIA=1` for the image and voice checks). The job runs in the GitHub environment `live-providers`,
which requires a reviewer's approval before it starts and holds the provider keys as secrets. Ollama needs a local
server, so it is always SKIP there; the summary table is written to the job summary.

One-time setup by a repository admin (not done by the repository itself): Settings -> Environments -> New environment
`live-providers` -> Required reviewers (the maintainer) -> add the keys as environment secrets, named like the
variables of the table above (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, ...). A missing
secret is an empty variable, which the suite reports as SKIP.

Record the results of a run in [section 11](#11-verification-log).

## 13. Image and voice models

Phase 6 (ADR-028 images, ADR-029 voice). The provider members are optional parts of plugin API 1.1.0
([PLUGINS.md 9](./PLUGINS.md#providerdefinition)): `createImageModel`, `imageParams`, `createTranscriptionModel`,
`createSpeechModel`, `transcriptionOptions`. Factories and option keys were read from the installed packages on
2026-09-28 (`ai` 7.0.116, `@ai-sdk/openai` 4.0.78, `@ai-sdk/google` 4.0.82, `@ai-sdk/xai` 5.0.10, `@ai-sdk/mistral`
4.0.52, `@ai-sdk/groq` 4.0.50, `@openrouter/ai-sdk-provider` 3.1.0); seed ids exist in the packages' model id unions.
The builtin plugin `core-providers` (version 1.1.0) declares `engines.harness` `^1.1.0` because it uses these members.
The request bodies are covered by fake-fetch tests (`core-providers/providers/media.test.ts`), but nothing here has run
against the live APIs yet: the opt-in media checks of [section 12](#12-live-provider-suite) (`HF_LIVE_MEDIA=1`)
confirm it, and their results go to [section 11](#11-verification-log).

### Support by provider

| Provider | Images | Transcription | Speech | `transcriptionOptions({ language })` |
|---|---|---|---|---|
| `openai` | dedicated image models: `createImageModel` → `.image(id)`; `imageParams` maps the aspect ratio to `size`: 1:1 → `1024x1024`; 2:3, 3:4, 9:16 → `1024x1536`; 3:2, 4:3, 16:9 → `1536x1024`; Auto → nothing (the package ignores `aspectRatio` and `seed`); input images make it an edit; token usage reported | `.transcription(id)` | `.speech(id)`; default voice `alloy`, MP3 | `{ openai: { language } }` |
| `xai` | dedicated image models: `.image(id)`; `imageParams` passes the aspect ratio through as `aspectRatio` (the package ignores `size` and sends `aspect_ratio`); at most 3 images per call (`generateImage` splits a larger `n` into several calls); no token usage (the cost arrives in `providerMetadata.xai.costInUsdTicks`, unit unconfirmed, so `costUsd` is null) | `.transcription()` **without an id** (catalog key `stt`); the model instance reports an empty `modelId`, so logs use the model ref | `.speech()` **without an id** (catalog key `tts`); default voice `eve`, MP3; the package always sends `language: 'auto'` | `{ xai: { language } }` (see "Transcription languages" below) |
| `google` | chat models with image output (`gemini-*-image*` and `nano-banana*`, `capabilities.imageOutput`): `imageParams` → `providerOptions.google = { responseModalities: ['TEXT', 'IMAGE'] }`, plus `imageConfig: { aspectRatio }` when an aspect ratio is chosen; the package's `.image()` factory is not wired in v1.2 | `createTranscriptionModel` → `.transcription(id)` is defined, but no id is seeded: its only ids (`gemini-3.5-transcribe*`) exist in the type union alone **(unverified)** | `.speech(id)`; default voice `Kore`, WAV (about 4.5 MB per 1,500 characters) | `{ google: { languageCodes: [language] } }` |
| `openrouter` | chat models with image output (`architecture.output_modalities` contains `image` → `imageOutput`, explicit kind `chat`): `imageParams` → `providerOptions.openrouter = { modalities: ['image', 'text'] }`, plus `image_config: { aspect_ratio }` when an aspect ratio is chosen (the package spreads it into the request body; there is no typed option) | — | — | — |
| `mistral` | — | `.transcription(id)` | `.speech(id)`; no default voice and no voice list, MP3 | `{ mistral: { language } }` |
| `groq` | — | `.transcription(id)` | — | `{ groq: { language } }` |
| `anthropic`, `deepseek`, `moonshotai`, `alibaba`, `zai`, `minimax`, `ollama` | — | — | — | — |
| `mock` (dev) | `mock:image`; `mock:image-chat` (image output) | `mock:transcribe` | `mock:speech` | nothing ([section 8](#8-mock-provider)) |

- **Where images appear**: dedicated image models (`kind: 'image'`) are listed only for providers that define
  `createImageModel` (`openai`, `xai`, `mock`), and then visible by default: the composer's "Image models" group and
  Settings → Media → Image model (the model of the `generate_image` tool). An image model that a listing or a plugin
  names for another provider is left out of the catalog. Chat models with image output stay in their provider's group
  with the image-output badge; the composer offers them the aspect ratio only (their `imageParams` request has `n: 1`).
- **`imageParams(request, model)`** gets `{ n, aspectRatio?, inputs }` and the model's `ModelInfo`, and returns `{ size?,
  aspectRatio?, providerOptions? }` or `undefined`. The image service passes `size` / `aspectRatio` / `providerOptions`
  to `generateImage` (a provider without `imageParams` gets the aspect ratio as is); the chat pipeline deep-merges only
  `providerOptions` into image-output chat calls (called with `n: 1`, `inputs: 0`; the reasoning provider options win on
  a conflict). The result is plugin data: `size` must look like `1536x1024`, `aspectRatio` like `16:9`,
  `providerOptions` must be an object of objects; anything else is dropped, and a throw is logged and ignored.
- **Model name** (Phase 7, plugin API 1.2.0): the image service reports `modelName` with every generation (the catalog
  display name, the user's alias first, else the model id; at most 200 characters); `ctx.images.generate()` returns it, the `generate_image` output stores it and the
  tool's text for the model names it ("Generated 2 images with GPT Image 1; …"; outputs saved before v1.3 name the
  model ref).
- **Cost** (image turns and `generate_image`): `(input tokens × input price + output tokens × output price) /
  1,000,000` with the catalog prices (USD per 1M tokens), rounded to 1e-10, shown as "estimated". `costUsd` is null
  when the model has no price, when the provider reports no token counts (xAI) or when a used token kind has no price.
  models.dev prices none of the image seeds (`gpt-image-1`, `gpt-image-1-mini`, `gpt-image-1.5`, `grok-imagine-image`),
  so they record `costUsd: null`; of the OpenAI image models only `gpt-image-2` (listed once a key is set) is priced.
  Chat models with image output are priced like any chat turn. Transcription and speech calls write a usage row with 0
  tokens and no cost.
- **History**: of the provider converters only Google's reads images in assistant messages (Anthropic, OpenAI Responses
  and OpenRouter drop them), so the chat pipeline carries the latest generated images into the next user message for
  vision models (ARCHITECTURE.md 6.1, 6.11). Gemini thought signatures (`providerMetadata`) are kept on stored image
  parts **(unverified that they round-trip)**.
- **Speech options**: `generateSpeech` gets the text and the voice only; never `outputFormat`, `speed`,
  `instructions` or `language` (unsupported options print SDK warnings). The speed setting is the browser's
  `playbackRate`. A package may still send its own defaults: the xAI package always sends `language: 'auto'` and the
  voice `eve` when no voice is chosen.
- **Transcription languages**: `auto` sends nothing and never calls `transcriptionOptions` (the provider detects the
  language); an ISO 639 code goes through `transcriptionOptions` (a throw or an invalid result sends no language). xAI
  documents its `language` option as the language of inverse text normalization (spoken numbers written as digits,
  for example); whether it also steers recognition is **(unverified)**.
- **Errors**: media calls use the provider's `mapError` and the default mapping of [section 6](#6-provider-notes); a
  removed model id answers `model_not_found`; since Phase 7 a model ref whose provider does not exist (an uninstalled
  plugin's provider) answers `400 provider_not_configured` with action `configure-provider` (`The provider "<id>" is not
  available. Pick another model or install the provider.`) on the transcription and speech routes, in `ctx.images`,
  the `generate_image` tool and `ctx.models.resolve`, as on chat (v1.2 answered `404 not_found`); routes that address a
  provider by its id instead of resolving a model ref (`GET /api/models?providerId=`, `POST
  /api/providers/:id/models/refresh`, the provider, credential and custom model routes) still answer `404 not_found`. The resolvers answer `validation_error` on `modelRef` for a model of
  another kind (`modelRef: The model "openai:gpt-6-luna" is not a speech-to-text model.`), `model_not_found` for an
  image model whose provider has no `createImageModel`, `validation_error` for a transcription or speech model whose
  provider lacks the factory (`modelRef: The provider "<name>" cannot transcribe speech, so the model "<ref>" cannot be
  used.`), and `plugin_error` when a factory throws, times out (5 s) or returns no model instance. Factory-less media
  models exist only as custom model ids: the catalog leaves them out otherwise. `alibaba:qwen3-asr-flash`, which
  models.dev lists as a transcription model, is therefore not offered (Alibaba has no transcription factory, and its
  listing drops `asr` ids).
- Declarative providers cannot contribute image or voice models (backlog): they have no media factories, so the
  catalog leaves out the image, transcription and speech models of their listings.

### Seeds (explicit kinds, always listed)

Seed names in parentheses.

| Provider | Image (`kind: 'image'`, `vision: true`) | Transcription (`kind: 'transcription'`) | Speech (`kind: 'speech'`) |
|---|---|---|---|
| `openai` | `gpt-image-1` (GPT Image 1), `gpt-image-1-mini` (GPT Image 1 Mini), `gpt-image-1.5` (GPT Image 1.5) | `gpt-4o-mini-transcribe` (GPT-4o mini Transcribe), `gpt-4o-transcribe` (GPT-4o Transcribe), `whisper-1` (Whisper) | `gpt-4o-mini-tts` (GPT-4o mini TTS), `tts-1` (TTS-1), `tts-1-hd` (TTS-1 HD) |
| `xai` | `grok-imagine-image` (Grok Imagine Image) | `stt` (xAI Speech to Text; a catalog key, the factory takes no id) | `tts` (xAI Text to Speech; a catalog key, the factory takes no id) |
| `google` | — (image output comes from the listed chat models `gemini-*-image*` / `nano-banana*`) | — (`gemini-3.5-transcribe` left out) | `gemini-3.1-flash-tts-preview` (Gemini 3.1 Flash TTS Preview), `gemini-2.5-flash-preview-tts` (Gemini 2.5 Flash Preview TTS), `gemini-2.5-pro-preview-tts` (Gemini 2.5 Pro Preview TTS) |
| `mistral` | — | `voxtral-mini-latest` (Voxtral Mini (latest)) | `voxtral-mini-tts-latest` (Voxtral Mini TTS (latest)) |
| `groq` | — | `whisper-large-v3-turbo` (Whisper Large V3 Turbo), `whisper-large-v3` (Whisper Large V3) | — |

- **models.dev**: none of the six OpenAI voice seeds (`gpt-4o-mini-transcribe`, `gpt-4o-transcribe`, `whisper-1`,
  `gpt-4o-mini-tts`, `tts-1`, `tts-1-hd`) is in the bundled models.dev snapshot, and neither are the xAI keys `stt` /
  `tts`: these entries carry only the seed's fields (no price, no limits). The other seeds are in models.dev, whose
  name wins over the seed name when the listing gives none (field precedence), so `gpt-image-1` shows as
  "gpt-image-1" and Groq's `whisper-large-v3` as "Whisper".
- **Prices**: models.dev has no price for any image seed, so image turns with them record `costUsd: null` (see "Cost"
  above).
- **Newer models**: the live listings keep the media ids a provider can run ([section 3](#3-model-listing)), so newer
  models (for example `gpt-image-2`, `gemini-3.8-flash-tts`) appear once a key is set.
- **Left out on purpose**: `gemini-3.5-transcribe` (in the package's type union only) and `alibaba:qwen3-asr-flash`
  (models.dev lists it, but the Alibaba provider has no transcription factory).

### Voices (`ModelInfo.voices`, from vendor docs, all **(unverified)**)

| Model | Voices (suggestions in Settings → Media; the field also accepts any other name) |
|---|---|
| `openai:tts-1`, `openai:tts-1-hd` (and every listed `tts-*` model) | `alloy`, `ash`, `coral`, `echo`, `fable`, `nova`, `onyx`, `sage`, `shimmer` |
| `openai:gpt-4o-mini-tts` (and every other listed `*-tts*` model) | the voices above plus `ballad`, `verse`, `marin`, `cedar` |
| `google:*-tts*` (seeds and listed models) | `Zephyr`, `Puck`, `Charon`, `Kore`, `Fenrir`, `Leda`, `Orus`, `Aoede`, `Callirrhoe`, `Autonoe`, `Enceladus`, `Iapetus`, `Umbriel`, `Algieba`, `Despina`, `Erinome`, `Algenib`, `Rasalgethi`, `Laomedeia`, `Achernar`, `Alnilam`, `Schedar`, `Gacrux`, `Pulcherrima`, `Achird`, `Zubenelgenubi`, `Vindemiatrix`, `Sadachbia`, `Sadaltager`, `Sulafat` |
| `xai:tts` | `eve` (the package default), `ara`, `leo`, `rex`, `sal` |
| `mistral:voxtral-mini-tts-latest` | none known: the model has no `voices` (type a voice id from the Mistral console) |
| `mock:speech` (dev) | `mock-voice-a`, `mock-voice-b` |

`speechVoice` null means the provider default; the web clears the voice whenever the speech model changes. The catalog
serves at most 100 unique voice names of 1-64 characters per model (a listing's list is cleaned, a seed or plugin model
with an invalid list fails validation).

### Classification (ARCHITECTURE.md 9)

| Example id | Source | Kind |
|---|---|---|
| `gpt-image-1-mini`, `gpt-image-1.5`, `chatgpt-image-latest` | the image id regex, before modalities (models.dev lists `[text, image]` output) | `image` |
| `grok-imagine-image`, `dall-e-3`, `imagen-4` | the image id regex | `image` |
| `gemini-2.5-flash-image`, `openai/gpt-5-image` (OpenRouter) | text + image output (models.dev modalities; the Google and OpenRouter listings also set the kind `chat` and `imageOutput` explicitly, as Google does for `nano-banana*`) | `chat` with `imageOutput` |
| `gpt-4o-mini-tts`, `gemini-2.5-flash-preview-tts` | audio output with a text input (or the `tts` id fallback) | `speech` |
| `whisper-large-v3`, `gpt-4o-transcribe` | audio input without a text input and a text output (or the `whisper` / `transcri` id fallback) | `transcription` |
| `stt`, `tts` (xAI), `voxtral-mini-latest` (Mistral) | the seed's explicit kind (an explicit `kind` of any layer wins over `classify()`) | `transcription` / `speech`, `transcription` |
