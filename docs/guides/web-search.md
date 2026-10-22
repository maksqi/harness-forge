# Web search

harness-forge v1.9 (ADR-062, ADR-063) lets a chat search the web. You turn search on per chat with the **Search**
toggle in the composer, and each reply searches in one of two ways:

- **Native**: the model's own provider runs the search (Anthropic, OpenAI, Google, xAI, OpenRouter, and Groq for its
  gpt-oss models). No key besides the provider's is needed; the provider bills the searches.
- **Builtin**: the model calls harness-forge's `search_web` tool (the builtin plugin `core-search`), which asks
  **Brave Search**, **Tavily** or **Exa** with your own key. It works with every model that can call tools.

Either way the pages the answer used show as **sources** under the reply, and they are saved with the chat.

Reference: [PROVIDERS.md](../PROVIDERS.md) (the native web search matrix and the builtin backends),
[ARCHITECTURE.md](../ARCHITECTURE.md) (how a turn decides, approvals and history), [UI.md 2.20, 7.35, 9.15](../UI.md)
(the toggle, the search rows and sources, the settings page), [PLUGINS.md](../PLUGINS.md)
(`ProviderDefinition.webSearch`, plugin API 1.7.0).

## 1. Turn it on

- The **Search** toggle (a globe) sits in the composer's toolbar after the output style menu; below the `sm` width it
  is an icon with a dot while it is on. **Alt+W** toggles it (when Alt shortcuts are on in Settings → General). Image
  models have no toggle.
- The choice belongs to the chat: it is saved with the chat (`webSearch: 'auto'` when on, `'off'` when off), and a new
  chat starts with your default from Settings → Web search ("Turn on web search in new chats", off by default). A chat
  from before v1.9 has search off.
- While it is on, the toggle's tooltip says how this chat searches: "Web search on · {provider}" for native search, or
  "Web search on · Brave Search" (or Tavily, Exa) for the builtin tool.
- When the chat cannot search, the toggle is dimmed but still focusable, and a click opens a popover with the reason and
  **Set up web search** (section 6).

## 2. Native or builtin: which one a reply uses

harness-forge decides once per reply, with one rule that the composer and the server share:

1. Search off → no search.
2. Permission mode **Off** (no tools) → unavailable: "Tools are off in this chat."
3. The model has native search and "Use the model's own web search when it has one" is on (the default) → native.
4. Otherwise, when a search API key is saved and the model can call tools → the builtin `search_web` tool.
5. Otherwise unavailable, with the reason the popover shows.

Native and builtin search are never offered in the same request. Turn "Use the model's own web search when it has one"
off to always use your search API (for example to keep one search vendor for every model).

Native search per provider (details and caveats: [PROVIDERS.md](../PROVIDERS.md)):

| Provider | Native search | Notes |
|---|---|---|
| Anthropic | Claude's web search tool (at most 5 searches per reply) | sources from its results and citations |
| OpenAI | the Responses API web search | not for older models (for example `gpt-3.5`, `o1`) |
| Google | Google Search grounding | Gemini 3 and later combine it with tools; **Gemini 2.x** can search only in a reply that sends no other tools (see below) |
| xAI | Grok's web search | not for `grok-2` / `grok-3` models |
| OpenRouter | OpenRouter's web search (5 results) | models without tool support use OpenRouter's `web` plugin instead |
| Groq | browser search | only the `gpt-oss` models; no sources |
| Mistral, DeepSeek, Z.ai, MiniMax, Moonshot, Alibaba, Ollama, plugin providers | none | use the builtin tool |

**Gemini 2.x**: Google drops a request's other tools when its search tool is present, so harness-forge uses Gemini 2.x
native search only when the reply sends no other tool. When tools are on and you have a search key, the builtin tool is
used instead; without a key the toggle says "This model can't search while tools are on."

## 3. Set up a search API (builtin search)

Open **Settings → Web search** (after Media):

- **Use the model's own web search when it has one** (on by default) and **Turn on web search in new chats** (off by
  default): the two global settings `webSearchNative` and `webSearchDefault`.
- **Search API**: Brave Search (the default), Tavily or Exa. There is no "None": the builtin tool is simply off while
  the selected API has no key.
- A key row per API: paste the key and save it. Keys are write-only: afterwards the row reads "Key saved · Replace ·
  Remove", and the key is never shown again. They are stored encrypted as secret settings of the builtin plugin
  `core-search` (the page writes the plugin's settings for you).
- **Max results** (1–10, default 5): how many results one search returns.
- **Test search** runs one search with the selected API and shows the result count and time, or the error.

Where to get a key:

| API | Sign up | What harness-forge sends |
|---|---|---|
| Brave Search | [brave.com/search/api](https://brave.com/search/api/) | the query, the result count and the freshness (past day, week, month or year) as a GET request with the key in the `X-Subscription-Token` header |
| Tavily | [tavily.com](https://tavily.com) | the query, the result count and the time range as a JSON POST, with the key as a Bearer token |
| Exa | [exa.ai](https://exa.ai) | the query, the result count and the start date as a JSON POST, with the key in the `x-api-key` header |

Only HTTPS requests to the vendor's API host are made, with a 10 s timeout, at most 1 MB per answer and no redirects. A
rejected key reads "key rejected" (the key is never repeated in an error), a 429 means the vendor's rate limit, and a
network failure means the vendor could not be reached.

## 4. In the chat

- A native search shows a compact row "Searched the web" with the query; the builtin tool's row shows the query, "{n}
  results", and each result's title (a link), its domain and its snippet as plain text.
- The answer's sources show as "{n} sources" with up to three domain chips and a letter for each source (no favicons:
  the page never loads images from other sites). They are saved with the message, kept in share links (http and https
  links only) and written as "Source:" lines in a Markdown export.
- Native searches never show an approval card and run no hooks (`PreToolUse`, `PostToolUse` and `PermissionRequest` do
  not see them): the provider has already run them when harness-forge hears of them. Turning the toggle on is the
  consent.
- `search_web` is a `safe` tool: it runs without asking in **Ask** mode too. In the tools table of the plugin's page you
  can still set it to **Ask** or **Deny**, and hooks match it as `search_web` (or Claude Code's `WebSearch`).

## 5. Modes, sub-agents and history

- **Plan**, **Ask**, **Accept edits** and **Auto** all allow search (it only reads); **Off** turns every tool off,
  search included.
- Sub-agents and background agents inherit the chat's search setting; each one decides native or builtin for its own
  model.
- A provider's search results stay in the chat's history only for that provider: when you switch the chat to a model
  of another provider, earlier native search steps are left out of what the new model reads (the answers' text stays).

## 6. Costs and privacy

- **Native search** is billed by the provider per search, on top of the tokens. harness-forge's cost estimate does not
  include those fees; OpenRouter's reported cost does (it is read from OpenRouter's answer).
- **Builtin search** uses your search API's plan; each `search_web` call is one search. Sub-agents search too, so a
  task with several sub-agents can search several times.
- Only the search query (and the count and time filters) goes to the search vendor, or to the provider for native
  search. Queries and keys are never written to the server log at `info` level.
- `HF_OFFLINE=1` does not turn search off (it is a set of switches for downloads and listings, not "no network"); turn
  the toggle off, or leave the key empty and the setting for new chats off.

## 7. Troubleshooting

| The toggle or the chat says | What to do |
|---|---|
| "Add a search key in Settings → Web search." | the model has no native search (or native search is turned off): save a key for the selected **Search API** |
| "This model can't use tools." | the model has no tool support, so it cannot call `search_web`; pick a model with tools or with native search |
| "Tools are off in this chat." | the permission mode is **Off**: choose Ask, Plan, Accept edits or Auto |
| "This model can't search while tools are on." | Gemini 2.x with tools on and no search key: save a key, or turn tools off for that chat |
| A note in the chat that web search was not available | the reply ran without search (shown once per chat, model and reason): the reason is the same as above |
| **Test search** fails with "key rejected" | the key is wrong or has no access to that API |
| Rate limited | the vendor's limit for your plan; wait, or switch the **Search API** |
| No sources under a native answer | Groq's browser search returns none; other providers return sources only when the answer used the search |
| A long Anthropic search reply stops early | Claude can pause a long run of server-side searches; ask it to continue |
