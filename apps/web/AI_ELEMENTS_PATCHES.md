# AI Elements Vue: local patches

Source: registry `https://registry.ai-elements-vue.com/<name>.json` (ai-elements-vue 1.5.2), added on 2026-09-28
with `shadcn-vue@2.8.2 add` for: conversation, message, prompt-input, reasoning, tool, confirmation, context,
sources, shimmer, loader, code-block. Components are registered with the `Ai` prefix (`<AiConversation>`).

Every change to the copied files must be listed here so the components can be re-synced with upstream.

| File | Change | Reason |
|---|---|---|
| `context/ContextCacheUsage.vue` | `usage.value?.cachedInputTokens` -> `usage.value?.inputTokenDetails?.cacheReadTokens` | AI SDK v7 `LanguageModelUsage` moved cache reads into `inputTokenDetails` |
| `context/ContextReasoningUsage.vue` | `usage.value?.reasoningTokens` -> `usage.value?.outputTokenDetails?.reasoningTokens` | AI SDK v7 `LanguageModelUsage` moved reasoning tokens into `outputTokenDetails` |
| `prompt-input/PromptInputSpeechButton.vue` | `result.isFinal` -> `result?.isFinal` | `noUncheckedIndexedAccess`: `event.results[i]` may be `undefined` |

Known follow-ups (not patched yet):

- `message/MessageResponse.vue` and `reasoning/ReasoningContent.vue` render markdown with `vue-stream-markdown` 1.x
  (pinned `^1` through `overrides` in `pnpm-workspace.yaml`). The plan replaces them with the `Markdown.vue`
  wrapper around markstream-vue (W2.2); drop `vue-stream-markdown` once nothing imports it.

## shadcn-vue `ui/` patches (coordinator)

| File | Change | Reason |
|---|---|---|
| `ui/command/CommandGroup.vue` | heading styles moved from `[cmdk-group-heading]` selectors onto `ListboxGroupLabel` | reka-ui never sets `cmdk-group-heading`, so headings were unstyled |
| `ui/sonner/Sonner.vue` | `--gray2` uses `color-mix(in oklch, var(--popover) 90%, transparent)` | `hsl(var(--popover))` is invalid with oklch tokens |
