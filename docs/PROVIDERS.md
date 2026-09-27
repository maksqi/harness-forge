# Providers

Reference for the builtin BYOK providers of the `core-providers` builtin plugin, the dev-only `mock` provider, the
declarative provider templates of the provider wizard, and provider icons. The provider contract
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
when implementing ([section 11](#11-verification-log)).

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
| `mock` | Mock (dev only) | `MockLanguageModelV4` from `ai/test` | — | — | — | monogram |

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

`listModels` results are cached 24 h in `model_cache`; a failed refresh keeps the last good list; seeds are used only
when there is neither a listing nor a cached listing. `classify()` hides non-chat models (models.dev modalities, else
the id regex `embed|tts|whisper|transcri|image|moderation|rerank|audio`); the provider-specific filters below run
first.

| id | Endpoint | Auth | Fields used / filtering | Status |
|---|---|---|---|---|
| `anthropic` | `GET {baseURL}/models?limit=1000` (follow `has_more` with `after_id`) | `x-api-key`, `anthropic-version: 2023-06-01` | `id`, `display_name` -> name, `max_input_tokens` -> contextWindow, `max_tokens` -> maxOutputTokens, `capabilities.image_input` / `pdf_input` / `structured_outputs` / `thinking.supported` -> capabilities, `capabilities.effort.{low,medium,high,xhigh,max}.supported` -> `reasoningEfforts` | verified (docs) |
| `openai` | `GET {baseURL}/models` | Bearer | ids only (`id`, `owned_by`); drop `embedding`, `tts`, `whisper`, `transcribe`, `dall-e`, `gpt-image`, `moderation`, `realtime`, `audio`, `sora`, `babbage`, `davinci`, `computer-use`, `search`; metadata from models.dev | verified |
| `google` | `GET {baseURL}/models?pageSize=1000` (follow `nextPageToken`) | `x-goog-api-key` | id = `name` without `models/`; keep `supportedGenerationMethods` containing `generateContent`; drop `embedding`, `aqa`, `imagen`, `veo`, `tts`, `live`, `native-audio`, `-image`; `displayName`, `inputTokenLimit`, `outputTokenLimit`, `thinking` -> capabilities.reasoning | verified (docs) |
| `xai` | `GET {baseURL}/models` | Bearer | ids; drop `grok-imagine-*`; metadata from models.dev (`GET {baseURL}/language-models` returns richer data **(unverified shape)**) | verified |
| `deepseek` | `GET {baseURL}/models` | Bearer | `id`, `name`, `context_window`, `max_output_tokens`, `input_modalities` (`image` -> vision), `effort.supported_levels` -> `reasoningEfforts` (plus `off`) | verified (docs) |
| `moonshotai` | `GET {baseURL}/models` | Bearer | ids; metadata from models.dev and seeds | verified (route) |
| `alibaba` | `GET {baseURL}/models` | Bearer | ids (OpenAI shape **(unverified)**); keep ids starting with `qwen` or `qwq`; drop `embed`, `tts`, `asr`, `image`, `wan`, `realtime`, `livetranslate`, `-mt-` | verified (route) |
| `zai` | `GET {baseURL}/models` | Bearer | ids (OpenAI shape) | **(unverified)** on the general endpoint (documented for the Coding Plan endpoint); fall back to seeds + models.dev |
| `minimax` | `GET {baseURL}/models` | `x-api-key` | ids | route exists, response shape **(unverified)**; fall back to seeds |
| `mistral` | `GET {baseURL}/models` | Bearer | keep `capabilities.completion_chat`; drop `archived` / deprecated; `max_context_length`; `capabilities.function_calling` -> tools, `capabilities.vision` -> vision; hide duplicate `aliases` | verified (docs) |
| `groq` | `GET {baseURL}/models` | Bearer | keep `active`; `context_window`, `max_completion_tokens`; drop `whisper`, `orpheus`, `tts`, `prompt-guard`, `safeguard` | verified (docs) |
| `openrouter` | `GET {baseURL}/models` (public, no key needed; send the key when set) | Bearer | `name`; `context_length`; `top_provider.max_completion_tokens`; keep `architecture.output_modalities` containing `text`; `architecture.input_modalities` (`image` -> vision, `file` -> pdf); `supported_parameters` (`tools` -> tools, `reasoning` -> reasoning, `structured_outputs` -> structuredOutput); `pricing` (below) | verified |
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
| `minimax` | `po.minimax = { thinking: { type: 'disabled' } }` | not offered | not offered | `po.minimax = { thinking: { type: 'adaptive' } }` | not offered |
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
- `ollama`: accepted values are model-specific; `POST /api/show` reports them for thinking models
  (`thinking.values` **(unverified)**); boolean-only models map any non-`none` value to thinking on
  **(unverified)**.

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

Seeds are shown only when there is no live or cached listing, and they carry `reasoningEfforts` (models.dev does
not). The live listing is the source of truth; field precedence is user custom -> live -> models.dev -> seed.
**Re-verify every seed id against the provider docs and models.dev when implementing** (all ids below exist in the
models.dev snapshot of 2026-09-28).

`smallModelId` is used for chat titles (when `titleModelRef` is unset) and for the credential ping when the provider
has no listing.

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
| `mock` | `echo`, `reasoning` (off, low, medium, high, max), `tool-approval`, `error` ([section 8](#8-mock-provider)) | `echo` |

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
  `-non-reasoning` variants do not accept an effort.
- **DeepSeek**: base URL without `/v1`. V4 models think by default (with `auto`); `temperature` / `topP` are ignored
  while thinking.
- **Moonshot AI (Kimi)**: the console moved to `platform.kimi.ai`; the API host stays `api.moonshot.ai`. Kimi K3
  always reasons.
- **Alibaba (Qwen)**: keys are regional; the default is the international (Singapore) endpoint. The listing returns
  many non-chat models (filtered, section 3).
- **Z.ai (GLM)**: general and Coding Plan keys use different base URLs (section 2) and are not interchangeable.
- **MiniMax**: the builtin uses the Anthropic-compatible endpoint; the OpenAI-compatible endpoint
  (`https://api.minimax.io/v1`) is not used. Pay-as-you-go keys and Token Plan subscription keys are reportedly not
  interchangeable **(unverified)**.
- **Mistral**: only some models accept an effort, and only `none` / `high`.
- **Groq**: `reasoning_format` and `include_reasoning` are mutually exclusive; the always-on `reasoningFormat:
  'parsed'` is skipped for `openai/gpt-oss-*`.
- **OpenRouter**: created with `createOpenRouter({ apiKey, baseURL, fetch, compatibility: 'strict', appName:
  'harness-forge', appUrl: 'https://github.com/maksqi/harness-forge' })`. The package sends `appName` as
  `X-OpenRouter-Title` (the current name of the legacy `X-Title` header, which OpenRouter still accepts) and `appUrl`
  as `HTTP-Referer` (required for attribution). With `usage: { include: true }` the response carries the charged
  cost in `providerMetadata.openrouter.usage.cost`, which is used as `costUsd` (ARCHITECTURE.md, Model catalog).
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
| `deepseek` | HTTP 402 (insufficient balance) | `provider_error` "DeepSeek account balance is insufficient" |
| `openrouter` | HTTP 402 (no credits) | `provider_error` "OpenRouter credits are exhausted" |
| `ollama` | connection refused | `provider_unreachable` with the hint above |

## 7. OpenRouter and Ollama at a glance

| | OpenRouter | Ollama |
|---|---|---|
| Key | required for chat, not for the listing | none (optional Bearer) |
| Listing | public `GET /api/v1/models` with pricing, context, capabilities | `GET /api/tags` (+ `POST /api/show`) |
| Model ids | `vendor/model` (`anthropic/claude-sonnet-5`, `~openai/gpt-luna-latest`) | `name:tag` (`llama3:8b`), refs like `ollama:llama3:8b` |
| Cost | provider-reported (`usage.include`) | none (local) |
| Reasoning | `providerOptions.openrouter.reasoning.effort` | `reasoning_effort` |
| Base URL | `https://openrouter.ai/api/v1` (Advanced) | `http://localhost:11434/v1` (main field) |

## 8. Mock provider

Dev and e2e only: the builtin plugin `mock` registers provider `mock` and tool `mock_approval_tool` when
`HF_MOCK_PROVIDER=1` (`pnpm start:e2e` sets it). Models are `MockLanguageModelV4` instances from `ai/test` streaming
through `simulateReadableStream`. The provider has no credentials (status `connected`), no icon (monogram),
`smallModelId: 'echo'`, `listModels` returns the four models, and `validate` always succeeds. Its `reasoning()`
maps `off` -> `none`, `low` / `medium` / `high` -> same, `max` -> `xhigh`.

Common behavior (deterministic):

- **User text**: the text parts of the last `user` message of the prompt (after slash-command expansion), joined with
  a space and trimmed.
- **Streaming**: text is streamed one word per chunk (each chunk is a word plus its following whitespace), first chunk
  after 50 ms, then every 25 ms. Reasoning chunks come every 100 ms. Streams end promptly when the call's
  `abortSignal` aborts.
- **Usage**: `inputTokens` = number of whitespace-separated words in all prompt text parts; `outputTokens` = number of
  streamed text and reasoning words; `reasoningTokens` = reasoning words.
- **Model info** (all four): `contextWindow: 32000`, `maxOutputTokens: 4096`,
  `cost: { input: 1, output: 2 }` (USD per 1M tokens, so cost displays are non-zero).

| Model ref | Capabilities | Behavior |
|---|---|---|
| `mock:echo` | vision, pdf | Streams the user text back. Empty user text -> `(empty message)`. If the last user message has file parts, appends `\n\n[files: <n>]`. `finishReason: 'stop'`. Title generation with `echo` therefore yields the first words of the first message. |
| `mock:reasoning` | reasoning (`reasoningEfforts`: off, low, medium, high, max) | Received `reasoning` option = `none`: no reasoning part, text `Answer: <user text>`. Otherwise: a reasoning part `Thinking about "<first 8 words of the user text>" with effort <value>.` (value = the received option, `provider-default` for `auto`, `xhigh` for `max`), streamed at 100 ms per word (about 1 s, so the "Thinking" row is visible), then the text `Answer: <user text>`. |
| `mock:tool-approval` | tools | If `mock_approval_tool` is not in the call's tools (tool mode `off`, tool disabled): text `Tools are disabled.` Else, if the prompt does not end with a result of this tool: one tool call `mock_approval_tool` with input `{ "text": "<user text>" }` and id `mock_call_<n>` (n = number of assistant messages in the prompt + 1), `finishReason: 'tool-calls'`. If it ends with a result: text `Tool result: <JSON of the output>`, or `The tool call was denied.` for a denied result. |
| `mock:error` | — | `doStream` rejects before any chunk with `APICallError` (`statusCode: 401`, message `Mock authentication failure`, `url: 'mock://error'`, not retryable), mapped to `auth_invalid` with action `configure-provider` and delivered in the stream (the provider is configured, so there is no pre-flight 400). |

Tool `mock_approval_tool`: description "Echoes its input. Mock tool that requires approval.", input
`{ text: string }`, `policy: 'ask'`, `execute` returns `{ "echoed": "<text>" }`. In tool mode `ask` it shows the
approval card (Allow -> `Tool result: {"echoed":"..."}`, Deny -> `The tool call was denied.`); in `auto` it runs
without a card. Stop tests send a long message to `mock:echo` (400 words stream for about 10 s).

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
in `/v1`) without a template. Every template field stays editable; the Review step runs a 1-token test.

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
- **Seed ids**: models.dev `api.json`.

Unverified (re-check during implementation): `grok-4.7` accepted efforts and the `/v1/language-models` response shape;
Z.ai `/models` on the general endpoint and per-model effort support of GLM models; MiniMax listing shape and model id
casing; Alibaba listing shape and which Qwen models accept `enable_thinking`; Ollama `/api/show` `thinking.values` and
boolean-only thinking models; the MiniMax China base URL.
