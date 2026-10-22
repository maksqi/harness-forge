<script setup lang="ts">
// The composer's web search toggle (Phase 14, ADR-062, ADR-063; docs/UI.md 2.20, 7.35, 10.10, 12): a ghost h-8 toggle
// with `Globe` (the label "Search" from `sm`, icon-only with a dot below `sm` when on), named "Web search", right after
// OutputStyleMenu (ChatComposer hides it for image models and while the model is unknown). `modelValue` = the session's
// `webSearch` is `auto`; `availability` = what turning it on would do (`resolveWebSearch` with `mode: 'auto'`, the rule
// the server applies to the turn); `via` = who searches (the provider's name for native search, the search API's name for
// the builtin). Unavailable: `aria-disabled` (still focusable), described by the reason (a sr-only copy), and a click
// opens a popover (`web-search-unavailable`, `data-reason`) with the reason and "Set up web search" (`web-search-setup`,
// a link to Settings → Web search); a pressed toggle stays pressed (`data-state="unavailable"`) and its popover also
// offers "Turn off web search". `activate()` = what a click does (Alt+W): a popover opened that way gives the focus back
// to `returnFocusTo` (the textarea) when it closes, one opened by a click to the toggle. The tooltip reads "Web search on
// · {via}" / "Web search off" with the Alt+W hint while `altShortcuts` is on. Opening the popover re-reads the search API
// configuration (`useWebSearchStore().fetch`, 15 s max age), so a key saved in another tab turns the toggle on.
// Props, emits, the exposed `activate` and the root test id are frozen from Gate P14-0b (C54 stub); W14.8 implements the
// tooltip, the unavailable popover and Alt+W (the composer registers the shortcut and announces the changes).
import type { WebSearchResolution } from '@harness-forge/shared'
import { ArrowRightIcon, GlobeIcon } from '@lucide/vue'
import { computed, ref, useId, useTemplateRef, watch } from 'vue'
import { Button } from '@/components/ui/button'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import KbdCombo from '~/components/common/KbdCombo.vue'
import { useSettingsStore } from '~/stores/settings'
import { useWebSearchStore } from '~/stores/web-search'
import { testIds } from '~/utils/testids'
import {
  WEB_SEARCH_REASON_TEXT,
  WEB_SEARCH_SETUP_PATH,
  WEB_SEARCH_SHORTCUT_KEYS,
  webSearchToggleMode,
  webSearchToggleState,
  webSearchTooltip,
  webSearchUnavailableReason,
} from './web-search'

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

const settings = useSettingsStore()
const webSearch = useWebSearchStore()
const altShortcuts = computed(() => settings.resolved.altShortcuts)
/** The search API configuration is re-read (15 s max age) when the reason's popover opens: a key saved meanwhile counts. */
const CONFIG_MAX_AGE_MS = 15_000

const button = useTemplateRef<InstanceType<typeof Button>>('button')
const popoverOpen = ref(false)
const reasonId = `web-search-reason-${useId()}`

const reason = computed(() => webSearchUnavailableReason(props.availability))
const unavailable = computed(() => reason.value !== null)
const state = computed(() => webSearchToggleState(props.modelValue, props.availability))
const mode = computed(() => webSearchToggleMode(props.availability))
const reasonText = computed(() => (reason.value ? WEB_SEARCH_REASON_TEXT[reason.value] : ''))
const tooltip = computed(() => webSearchTooltip(props.modelValue, unavailable.value ? null : props.via, false))

/** The popover was opened by Alt+W (its close gives the focus to `returnFocusTo`). */
let openedByShortcut = false
/** The popover closed because the user went elsewhere (the focus stays there). */
let interactedOutside = false

function buttonElement(): HTMLElement | null {
  return (button.value?.$el as HTMLElement | undefined) ?? null
}

/** A click or Alt+W: toggles while search is available, else opens (or closes) the reason's popover. */
function run(fromShortcut: boolean): void {
  if (props.disabled)
    return
  if (unavailable.value) {
    popoverOpen.value = !popoverOpen.value
    if (popoverOpen.value) {
      openedByShortcut = fromShortcut
      interactedOutside = false
      webSearch.fetch({ maxAgeMs: CONFIG_MAX_AGE_MS }).catch(() => {})
    }
    return
  }
  emit('update:modelValue', !props.modelValue)
}

function onClick(): void {
  run(false)
}

/** What a click does (Alt+W through the composer). */
function activate(): void {
  run(true)
}

/** "Turn off web search" of a pressed toggle that cannot search. */
function turnOff(): void {
  popoverOpen.value = false
  emit('update:modelValue', false)
}

// Search became available (another model, a key was saved): the reason's popover goes away.
watch(unavailable, (value) => {
  if (!value)
    popoverOpen.value = false
})

/** The toggle's own click toggles the popover, so a press on it is not an outside interaction. */
function onInteractOutside(event: Event): void {
  const target = event.target instanceof Node ? event.target : null
  if (target && buttonElement()?.contains(target)) {
    event.preventDefault()
    return
  }
  interactedOutside = true
}

/**
 * Focus goes back to the toggle (or, for a popover Alt+W opened, to `returnFocusTo`), unless the user went elsewhere. The
 * flags belong to the popover that is closing (set when it opened; the event may come more than once).
 */
function onCloseAutoFocus(event: Event): void {
  event.preventDefault()
  if (interactedOutside)
    return
  const target = openedByShortcut ? props.returnFocusTo ?? buttonElement() : buttonElement()
  target?.focus({ preventScroll: true })
}

defineExpose({ activate })
</script>

<template>
  <!-- The popover root sits inside the tooltip trigger (see MicButton and EffortMenu). -->
  <Tooltip :disabled="popoverOpen">
    <TooltipTrigger as-child>
      <span class="inline-flex shrink-0">
        <Popover v-model:open="popoverOpen">
          <PopoverAnchor as-child>
            <Button
              ref="button"
              type="button"
              variant="ghost"
              size="sm"
              aria-label="Web search"
              :aria-pressed="modelValue ? 'true' : 'false'"
              :aria-disabled="unavailable || disabled ? 'true' : undefined"
              :aria-describedby="unavailable ? reasonId : undefined"
              :aria-haspopup="unavailable ? 'dialog' : undefined"
              :aria-expanded="unavailable ? popoverOpen : undefined"
              :aria-keyshortcuts="altShortcuts ? 'Alt+W' : undefined"
              :data-testid="testIds.composerWebSearch"
              :data-state="state"
              :data-mode="mode"
              class="relative h-8 shrink-0 gap-1.5 px-2 font-normal text-muted-foreground hover:text-foreground aria-pressed:bg-accent aria-pressed:text-accent-foreground aria-disabled:opacity-60 pointer-coarse:h-10 pointer-coarse:min-w-10"
              @click="onClick"
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
          </PopoverAnchor>
          <PopoverContent
            v-if="reason"
            :data-testid="testIds.webSearchUnavailable"
            :data-reason="reason"
            side="top"
            align="start"
            :side-offset="8"
            :collision-padding="8"
            class="w-72 max-w-[calc(100vw-1rem)] gap-3 rounded-xl"
            @interact-outside="onInteractOutside"
            @close-auto-focus="onCloseAutoFocus"
          >
            <p class="text-sm font-medium">
              Web search
            </p>
            <p class="text-sm text-muted-foreground">
              {{ reasonText }}
            </p>
            <div class="flex flex-wrap items-center justify-end gap-2">
              <Button
                v-if="modelValue"
                type="button"
                size="sm"
                variant="ghost"
                data-slot="web-search-turn-off"
                class="pointer-coarse:h-10"
                @click="turnOff"
              >
                Turn off web search
              </Button>
              <Button as-child size="sm" class="pointer-coarse:h-10">
                <NuxtLink :to="WEB_SEARCH_SETUP_PATH" :data-testid="testIds.webSearchSetup" @click="popoverOpen = false">
                  Set up web search
                  <ArrowRightIcon aria-hidden="true" />
                </NuxtLink>
              </Button>
            </div>
          </PopoverContent>
        </Popover>
        <span v-if="reason" :id="reasonId" class="sr-only">{{ reasonText }}</span>
      </span>
    </TooltipTrigger>
    <TooltipContent side="top">
      {{ tooltip }}
      <KbdCombo v-if="altShortcuts" :keys="WEB_SEARCH_SHORTCUT_KEYS" class="max-lg:hidden pointer-coarse:hidden" />
    </TooltipContent>
  </Tooltip>
</template>
