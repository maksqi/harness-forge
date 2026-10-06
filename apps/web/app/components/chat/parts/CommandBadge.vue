<script setup lang="ts">
// Slash command marker above a user bubble (docs/UI.md 7.1): the text of the message stays as typed.
// Phase 10 (W10.11; ADR-045; docs/UI.md 7.28): with the message's `metadata.command` (the optional `command` prop) a
// command that ran on its own model shows a muted "· {model name}"; a tooltip (on hover and keyboard focus) lists the
// source ("Project command", "Personal command", "From {plugin}", "Built-in command"; `data-slot="command-badge-source"`;
// none on messages before v1.6), "Runs on {model name}" and "Tools limited to {names}", and the badge's screen reader
// text carries the same lines. Model names come from the injected MODEL_LABEL_RESOLVER (the model id without one);
// only a plugin command reads the plugins store, for the plugin's name (the share page never passes a source, so it
// stays store-free).
// Phase 11 (ADR-052; C39 declares the prop, W11.12 implements it; frozen from Gate P11-0b): `kind` (else the invocation's
// `kind`) names a skill invocation: `BookOpen` instead of `SquareTerminal`, the screen reader text "Skill" instead of
// "Command" and the source "Project skill" / "Personal skill" / "From {plugin}" / "Built-in skill" (a plugin skill's
// plugin from the plugins store); the tooltip (and the screen reader text) adds "Ran {n} shell commands" / "Included
// {paths}" from `metadata.command.inlined` (`data-slot="command-badge-inlined"`).
import type { CommandInvocation } from '@harness-forge/shared'
import { safeParseModelRef } from '@harness-forge/shared'
import { BookOpenIcon, SquareTerminalIcon } from '@lucide/vue'
import { getActivePinia } from 'pinia'
import { computed, inject } from 'vue'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { MODEL_LABEL_RESOLVER } from '~/components/providers/model-label'
import { usePluginsStore } from '~/stores/plugins'
import { commandBadgeLines } from './command-badge'

// Attributes (class) go to the badge, not to the renderless tooltip root.
defineOptions({ inheritAttrs: false })

const props = withDefaults(defineProps<{
  name: string
  /** + Phase 10: the message's command (`metadata.command`): its source, model and tool limit. */
  command?: CommandInvocation | null
  /** + Phase 11: what the name invoked (default: the invocation's `kind`, else a command). */
  kind?: 'command' | 'skill'
}>(), {
  command: null,
  kind: undefined,
})

const resolveModel = inject(MODEL_LABEL_RESOLVER, null)
/** + Phase 11: what the name invoked (the prop, else the invocation's kind, else a command). */
const invocationKind = computed<'command' | 'skill'>(() => props.kind ?? props.command?.kind ?? 'command')
/** + Phase 11: "Skill" for a skill invocation, else "Command". */
const kindLabel = computed(() => (invocationKind.value === 'skill' ? 'Skill' : 'Command'))
const kindIcon = computed(() => (invocationKind.value === 'skill' ? BookOpenIcon : SquareTerminalIcon))
// Only a plugin command needs the plugins store (the plugin's name); the source is absent on share pages.
const plugins = props.command?.source === 'plugin' && getActivePinia() ? usePluginsStore() : null

const pluginName = computed(() => {
  if (!plugins || props.command?.source !== 'plugin')
    return null
  const listed = plugins.commands.find(command => command.name === props.name && command.source === 'plugin')
  const contributed = (item: (typeof plugins.items)[number]): boolean => (invocationKind.value === 'skill'
    ? item.contributions.skills.includes(props.name)
    : item.contributions.commands.includes(props.name))
  const plugin = listed?.pluginId ? plugins.byId(listed.pluginId) : plugins.items.find(contributed)
  return plugin?.name ?? listed?.pluginId ?? null
})

const modelName = computed(() => {
  const ref = props.command?.modelRef
  if (!ref)
    return null
  return resolveModel?.(ref)?.name || (safeParseModelRef(ref)?.modelId ?? ref)
})

const lines = computed(() => (props.command
  ? commandBadgeLines(props.command, { plugin: pluginName.value, model: modelName.value }, invocationKind.value)
  : { source: null, model: null, tools: null, inlined: [] as string[] }))
const hasDetails = computed(() => lines.value.source !== null || lines.value.model !== null || lines.value.tools !== null
  || lines.value.inlined.length > 0)
const srDetails = computed(() => [lines.value.source, lines.value.model, lines.value.tools, ...lines.value.inlined].filter(Boolean).join(', '))
</script>

<template>
  <Tooltip v-if="hasDetails">
    <TooltipTrigger as-child>
      <span
        data-slot="command-badge"
        tabindex="0"
        role="note"
        :aria-label="srDetails ? `${kindLabel} /${name}, ${srDetails}` : `${kindLabel} /${name}`"
        v-bind="$attrs"
        class="inline-flex h-6 max-w-full min-w-0 items-center gap-1.5 rounded-md border bg-card px-2 font-mono text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <component :is="kindIcon" aria-hidden="true" class="size-3.5 shrink-0" />
        <span class="sr-only">{{ kindLabel }}</span>
        <span class="truncate">/{{ name }}</span>
        <span v-if="modelName" data-slot="command-badge-model" class="min-w-0 truncate font-sans" aria-hidden="true">· {{ modelName }}</span>
        <span class="sr-only">, {{ srDetails }}</span>
      </span>
    </TooltipTrigger>
    <TooltipContent class="flex max-w-xs flex-col gap-0.5 text-left">
      <span v-if="lines.source" data-slot="command-badge-source">{{ lines.source }}</span>
      <span v-if="lines.model" data-slot="command-badge-runs-on">{{ lines.model }}</span>
      <span v-if="lines.tools" data-slot="command-badge-tools" class="break-words">{{ lines.tools }}</span>
      <span v-for="line in lines.inlined" :key="line" data-slot="command-badge-inlined" class="break-words">{{ line }}</span>
    </TooltipContent>
  </Tooltip>
  <span
    v-else
    data-slot="command-badge"
    v-bind="$attrs"
    class="inline-flex h-6 items-center gap-1.5 rounded-md border bg-card px-2 font-mono text-xs text-muted-foreground"
  >
    <component :is="kindIcon" aria-hidden="true" class="size-3.5" />
    <span class="sr-only">{{ kindLabel }}</span>/{{ name }}
  </span>
</template>
