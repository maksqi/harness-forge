<script setup lang="ts">
// One hook record in the transcript (Phase 11, ADR-048; docs/UI.md 7.31, 10.8, 14.2): `role="note"` named "Hook {event}:
// {summary}". One line (the outcome's icon, the text of `hookOutcomeText`, the source: "Personal hook", "Project hook",
// "From {plugin}" or "{n} hooks"), each hook's `systemMessage` as "Hook: {message}" under it (always visible,
// `data-slot="hook-output"`), and a details toggle (`hook-note-toggle`, `aria-expanded` / `aria-controls`, `data-state`;
// closed by default, not persisted): "Show context" (outcome `context`), "Show output" (`error`), else "Show details". The
// details (`hook-note-details`): the context (`context`, and the feedback of a `blocked` record) in a `pre`
// (`data-slot="hook-context"`), each hook's error text (`error`, `data-slot="hook-output"`), "Input the tool ran with"
// (`rewritten`: `updatedInput` as JSON), then one source line per hook ("{source} · {label} · exit {n} · {duration}").
// Variants: `inline` and `tool` are muted lines without a border; `turn` (a hook carrier) is a card whose body is the
// reason and whose details are always open (no toggle). Hook texts are plain text (never HTML). Store-free: ChatMessage
// renders it for block kind `hook` (variant inline), under a user message's bubble (inline), for a hook carrier (turn)
// and ToolPart inside a tool row (tool); `pluginName` names the plugin of the record's first plugin hook. Props and the
// root test id are frozen from Gate P11-0b (C39).
import type { HookData } from '@harness-forge/shared'
import type { Component } from 'vue'
import { ChevronRightIcon, ShieldBanIcon, TriangleAlertIcon, WebhookIcon } from '@lucide/vue'
import { computed, ref, useId } from 'vue'
import { cn } from '@/lib/utils'
import { testIds } from '~/utils/testids'
import { formatDuration, formatToolValue } from '../chat-format'
import { hookDetailsKind, hookOutcomeText, hookPluginId, hookSourceText } from './hook-notes'

const props = defineProps<{ data: HookData, variant: 'inline' | 'turn' | 'tool', pluginName?: string | null }>()

type HookResult = HookData['hooks'][number]

const open = ref(false)
const detailsId = useId()

const line = computed(() => hookOutcomeText(props.data))
const icon = computed<Component>(() => {
  if (props.data.outcome === 'denied' || props.data.outcome === 'stopped')
    return ShieldBanIcon
  return props.data.outcome === 'error' ? TriangleAlertIcon : WebhookIcon
})
const iconClass = computed(() => {
  if (props.data.outcome === 'denied')
    return 'text-destructive'
  return props.data.outcome === 'error' ? 'text-warning' : 'text-muted-foreground'
})

/** The plugin named by `pluginName`: the record's first plugin hook (other plugins read as their ids). */
const namedPlugin = computed(() => hookPluginId(props.data))
function sourceOf(hook: HookResult): string {
  return hookSourceText(hook, hook.pluginId && hook.pluginId === namedPlugin.value ? props.pluginName ?? null : null)
}
/** The source on the note's line: the only hook's, else how many hooks ran. */
const lineSource = computed(() => {
  const hooks = props.data.hooks
  if (hooks.length === 0)
    return null
  return hooks.length === 1 ? sourceOf(hooks[0]!) : `${hooks.length} hooks`
})
/** "exit 2 · 0.1s" (the duration alone without an exit code: a timeout, a kill, a code hook). */
function runMeta(hook: HookResult): string {
  const duration = formatDuration(hook.durationMs)
  return hook.exitCode === null ? duration : `exit ${hook.exitCode} · ${duration}`
}

const systemMessages = computed(() => props.data.hooks.flatMap((hook) => {
  const message = hook.systemMessage?.trim()
  return message ? [message] : []
}))
/** The model-visible context: shown for `context` records and as the feedback of a `blocked` one. */
const context = computed(() => {
  const outcome = props.data.outcome
  const text = props.data.context?.trim()
  return text && (outcome === 'context' || outcome === 'blocked') ? text : null
})
const errors = computed(() => props.data.hooks.flatMap((hook) => {
  const text = hook.error?.trim()
  return text ? [text] : []
}))
/** `rewritten`: the input the tool ran with (the tool part keeps the model's input). */
const updatedInput = computed(() => (props.data.outcome === 'rewritten' && props.data.updatedInput !== undefined
  ? formatToolValue(props.data.updatedInput) || '{}'
  : null))
/** The reason as the body of a turn note (a carrier: what the agent was asked to do). */
const turnReason = computed(() => (props.variant === 'turn' ? props.data.reason?.trim() || null : null))

const hasDetails = computed(() => props.data.hooks.length > 0 || context.value !== null || updatedInput.value !== null
  || (props.data.outcome === 'error' && errors.value.length > 0))
/** A turn note keeps its details open (it has no toggle). */
const alwaysOpen = computed(() => props.variant === 'turn')
const detailsOpen = computed(() => hasDetails.value && (alwaysOpen.value || open.value))
const toggleLabel = computed(() => `${open.value ? 'Hide' : 'Show'} ${hookDetailsKind(props.data)}`)
</script>

<template>
  <div
    :data-testid="testIds.hookNote"
    :data-event="data.event"
    :data-outcome="data.outcome"
    :data-source="data.hooks[0]?.source"
    :data-variant="variant"
    role="note"
    :aria-label="`Hook ${data.event}: ${line}`"
    :class="cn(
      'flex min-w-0 flex-col gap-0.5 text-sm',
      variant === 'turn' ? 'w-full rounded-lg border bg-muted/30 px-3 py-2' : 'text-muted-foreground',
    )"
  >
    <div class="flex min-w-0 items-start gap-2">
      <component :is="icon" aria-hidden="true" :class="cn('mt-[3px] size-3.5 shrink-0', iconClass)" />
      <p :class="cn('min-w-0 flex-1 break-words', variant === 'turn' && 'font-medium text-foreground')">
        <span data-slot="hook-note-line">{{ line }}</span>
        <span v-if="lineSource" data-slot="hook-note-source" class="font-normal text-muted-foreground"> · {{ lineSource }}</span>
      </p>
      <button
        v-if="hasDetails && !alwaysOpen"
        type="button"
        :data-testid="testIds.hookNoteToggle"
        :data-state="open ? 'open' : 'closed'"
        :aria-expanded="open"
        :aria-controls="open ? detailsId : undefined"
        class="-my-1 -mr-1 flex h-7 shrink-0 items-center gap-1 rounded-sm px-1 text-xs font-medium text-muted-foreground outline-none transition-colors duration-(--duration-fast) hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:h-10"
        @click="open = !open"
      >
        {{ toggleLabel }}
        <ChevronRightIcon
          aria-hidden="true"
          :class="cn('size-3 transition-transform duration-(--duration-base)', open && 'rotate-90')"
        />
      </button>
    </div>
    <p
      v-for="(message, index) in systemMessages"
      :key="`message-${index}`"
      data-slot="hook-output"
      class="min-w-0 pl-5.5 break-words whitespace-pre-wrap"
    >
      Hook: {{ message }}
    </p>
    <p v-if="turnReason" data-slot="hook-note-reason" class="min-w-0 pl-5.5 break-words whitespace-pre-wrap text-foreground">
      {{ turnReason }}
    </p>
    <div
      v-if="detailsOpen"
      :id="detailsId"
      :data-testid="testIds.hookNoteDetails"
      class="mt-1 flex min-w-0 flex-col gap-2 pl-5.5 text-xs"
    >
      <pre
        v-if="context"
        data-slot="hook-context"
        class="max-h-[50dvh] min-w-0 overflow-auto rounded-md bg-muted/60 p-2.5 font-mono text-xs break-words whitespace-pre-wrap text-foreground"
      >{{ context }}</pre>
      <template v-if="data.outcome === 'error'">
        <pre
          v-for="(error, index) in errors"
          :key="`error-${index}`"
          data-slot="hook-output"
          class="max-h-[50dvh] min-w-0 overflow-auto rounded-md bg-muted/60 p-2.5 font-mono text-xs break-words whitespace-pre-wrap text-foreground"
        >{{ error }}</pre>
      </template>
      <section v-if="updatedInput !== null" class="min-w-0">
        <h4 class="mb-1 font-sans text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          Input the tool ran with
        </h4>
        <pre
          data-slot="hook-updated-input"
          class="max-h-[50dvh] min-w-0 overflow-auto rounded-md bg-muted/60 p-2.5 font-mono text-xs break-words whitespace-pre-wrap text-foreground"
        >{{ updatedInput }}</pre>
      </section>
      <ul v-if="data.hooks.length > 0" class="flex min-w-0 flex-col gap-0.5 text-muted-foreground">
        <li
          v-for="(hook, index) in data.hooks"
          :key="`hook-${index}`"
          data-slot="hook-source"
          :data-source="hook.source"
          class="min-w-0 break-words"
        >
          <span>{{ sourceOf(hook) }}</span>
          <template v-if="hook.label">
            <span aria-hidden="true"> · </span>
            <span class="font-mono break-all text-foreground">{{ hook.label }}</span>
          </template>
          <span aria-hidden="true"> · </span>
          <span class="tabular-nums">{{ runMeta(hook) }}</span>
        </li>
      </ul>
    </div>
  </div>
</template>
