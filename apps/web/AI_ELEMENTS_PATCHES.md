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
| `ui/sidebar/Sidebar.vue` | mobile `SheetContent` class: added `data-[side=left]:w-(--sidebar-width) data-[side=right]:w-(--sidebar-width)` after `w-(--sidebar-width)` | `SheetContent`'s `data-[side=*]:w-3/4` has a higher specificity than a plain `w-*` and tailwind-merge keeps both (different variants), so the sheet was 75% of the screen (292.5px at 390px) instead of 18rem (W5.13) |
| `ui/sidebar/SidebarProvider.vue` | Mod+B check `event.key === 'b'` → `isToggleShortcut()`: case-insensitive key, physical `KeyB` for non-Latin layouts, no Shift (Mod+Shift+B stays the browser's bookmarks-bar shortcut), no Alt, skips IME composition and `defaultPrevented` events | Caps Lock did not toggle; matches keys like the shortcut registry (`composables/useShortcuts.ts`) (W5.13) |
| `ui/sidebar/index.ts` | `sidebarMenuButtonVariants` base: added `pointer-coarse:group-data-[collapsible=icon]:size-10! pointer-coarse:group-data-[collapsible=icon]:p-3!` after `group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:p-2!`; size `lg`: added `pointer-coarse:group-data-[collapsible=icon]:p-0!` after `group-data-[collapsible=icon]:p-0!` | 40px icon-rail buttons on touch tablets (`pointer: coarse`, docs/UI.md 14.5, S9); `lg` keeps its zero icon-mode padding on touch (tailwind-merge drops the base `p-3!` for it) (W6.11) |
| `ui/sidebar/SidebarProvider.vue` | `--sidebar-width-icon` moved from the wrapper's inline `style` to its classes `[--sidebar-width-icon:3rem] pointer-coarse:[--sidebar-width-icon:3.5rem]`; the `SIDEBAR_WIDTH_ICON` import is gone (the constant stays in `utils.ts`, same 3rem) | An inline custom property outranks every class: touch tablets need a 3.5rem (56px) rail around the 40px buttons (40px + 2 × 8px padding) (docs/UI.md 14.5, 14.7, S9) (W6.11) |
