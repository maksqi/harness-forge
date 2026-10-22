<script setup lang="ts">
// The composer's web search toggle (Phase 14, ADR-062, ADR-063; docs/UI.md 2.20, 7.35, 10.10, 12): a ghost h-8 toggle
// with `Globe` (the label "Search" from `sm`, icon-only with a dot below `sm` when on), named "Web search", right after
// OutputStyleMenu (ChatComposer hides it for image models and while the model is unknown). `modelValue` = the session's
// `webSearch` is `auto`; `availability` = what turning it on would do (`resolveWebSearch` with `mode: 'auto'`, the rule
// the server applies to the turn); `via` = who searches (the provider's name for native search, the search API's name for
// the builtin). Unavailable: `aria-disabled` (still focusable) and, on a click, a popover with the reason and "Set up web
// search" (W14.8). `activate()` = what a click does (Alt+W).
// Props, emits, the exposed `activate` and the root test id are frozen from Gate P14-0b (C54 stub); W14.8 implements the
// tooltip, the unavailable popover, the announcements and Alt+W in P14-A.
import type { WebSearchResolution } from '@harness-forge/shared'
import { GlobeIcon } from '@lucide/vue'
import { computed } from 'vue'
import { Button } from '@/components/ui/button'
import { testIds } from '~/utils/testids'

const props = withDefaults(defineProps<{
  /** On = the session's `webSearch` is `auto`. */
  modelValue: boolean
  /** `resolveWebSearch({ …, mode: 'auto' })`: never `off`. */
  availability: WebSearchResolution
  /** The provider's name (native search) or the search API's name (builtin); null when unavailable. */
  via: string | null
  /** The composer is disabled. */
  disabled?: boolean
  /** Receives focus after a pick on desktop (the textarea). */
  returnFocusTo?: HTMLElement | null
}>(), {
  disabled: false,
  returnFocusTo: null,
})

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
}>()

const unavailable = computed(() => props.availability.kind === 'unavailable' || props.availability.kind === 'off')
const state = computed(() => (unavailable.value ? 'unavailable' : props.modelValue ? 'on' : 'off'))
const mode = computed(() => {
  if (props.availability.kind === 'native')
    return 'native'
  return props.availability.kind === 'builtin' ? 'builtin' : undefined
})

/** What a click (or Alt+W) does: toggles while available (the unavailable popover is W14.8's). */
function activate(): void {
  if (props.disabled || unavailable.value)
    return
  emit('update:modelValue', !props.modelValue)
}

defineExpose({ activate })
</script>

<template>
  <Button
    type="button"
    variant="ghost"
    size="sm"
    aria-label="Web search"
    :aria-pressed="modelValue ? 'true' : 'false'"
    :aria-disabled="unavailable || disabled ? 'true' : undefined"
    :data-testid="testIds.composerWebSearch"
    :data-state="state"
    :data-mode="mode"
    class="relative h-8 shrink-0 gap-1.5 px-2 font-normal text-muted-foreground hover:text-foreground aria-pressed:text-foreground aria-disabled:opacity-60 pointer-coarse:h-10 pointer-coarse:min-w-10"
    @click="activate"
  >
    <GlobeIcon aria-hidden="true" class="size-4" />
    <span class="hidden sm:inline">Search</span>
    <span
      v-if="modelValue"
      data-slot="web-search-dot"
      aria-hidden="true"
      class="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-primary sm:hidden pointer-coarse:top-2 pointer-coarse:right-2"
    />
  </Button>
</template>
