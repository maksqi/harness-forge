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

Removed files (Phase 5):

- `message/MessageResponse.vue` and `reasoning/ReasoningContent.vue` (and their barrel exports): they rendered
  markdown with `vue-stream-markdown` 1.x and were never used — the chat renders markdown through the `Markdown.vue`
  wrapper around markstream-vue (W2.2). The `vue-stream-markdown` dependency and its `pnpm-workspace.yaml` override
  were dropped with them (ADR-007). Do not re-add them when re-syncing with upstream.

## shadcn-vue `ui/` patches (coordinator)

| File | Change | Reason |
|---|---|---|
| `ui/command/CommandGroup.vue` | heading styles moved from `[cmdk-group-heading]` selectors onto `ListboxGroupLabel` | reka-ui never sets `cmdk-group-heading`, so headings were unstyled |
| `ui/sonner/Sonner.vue` | `--gray2` uses `color-mix(in oklch, var(--popover) 90%, transparent)` | `hsl(var(--popover))` is invalid with oklch tokens |
| `ui/tabs/TabsTrigger.vue` | inactive text `text-foreground/60` → `text-muted-foreground` | 4.5:1 contrast for inactive tabs in light mode (W4.2 a11y audit) |
