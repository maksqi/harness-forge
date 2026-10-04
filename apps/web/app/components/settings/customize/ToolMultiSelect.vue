<script setup lang="ts">
// The tool picker of the definition editor (docs/UI.md 9.12, 10.7, 14.2, 14.5): a trigger ("Choose tools…", the count
// of chosen tools) that opens a Popover with a searchable `Command` list of the tools grouped by plugin (MCP tools under
// their server); each option (`customization-tool-option`, `data-tool-name`, `data-state` checked / unchecked) has a
// checkbox. The chosen tools show as chips (`customization-tool-chip`, `data-state` known / unknown) with a remove
// button "Remove {tool}"; a name the tool list does not know (an imported Claude Code name, a tool of a disabled
// plugin) stays as a warning chip "Not available now" ("{tool}, not available now" for screen readers). At most 64
// tools (`DEFINITION_LIMITS.toolsMax`). null = no restriction; the editor shows this picker only with "Only these
// tools", so null counts as no tool chosen yet. Attributes (the editor's `customization-tools`) land on the trigger.
// Props and emits are frozen from Gate P10-0b (C33).
import type { ToolSummary } from '@harness-forge/shared'
import { DEFINITION_LIMITS } from '@harness-forge/shared'
import { ChevronsUpDownIcon, TriangleAlertIcon, XIcon } from '@lucide/vue'
import { computed, ref } from 'vue'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { usePluginsStore } from '~/stores/plugins'
import { testIds } from '~/utils/testids'

defineOptions({ inheritAttrs: false })

const props = defineProps<{ modelValue: string[] | null, tools: readonly ToolSummary[], label: string, disabled?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: string[] | null] }>()

const plugins = usePluginsStore()
const open = ref(false)

const selected = computed(() => props.modelValue ?? [])
const known = computed(() => new Set(props.tools.map(tool => tool.name)))
const full = computed(() => selected.value.length >= DEFINITION_LIMITS.toolsMax)

/** The tools grouped by plugin (MCP tools by server), groups and tools sorted by name. */
const groups = computed(() => {
  const byKey = new Map<string, { key: string, label: string, tools: ToolSummary[] }>()
  for (const tool of props.tools) {
    const key = tool.mcpServerId ? `mcp:${tool.mcpServerId}` : tool.pluginId ?? ''
    let group = byKey.get(key)
    if (!group) {
      const label = tool.mcpServerId
        ? `MCP: ${plugins.mcp.find(server => server.id === tool.mcpServerId)?.name ?? tool.mcpServerId}`
        : tool.pluginId ? plugins.byId(tool.pluginId)?.name ?? tool.pluginId : 'Other tools'
      group = { key, label, tools: [] }
      byKey.set(key, group)
    }
    group.tools.push(tool)
  }
  return [...byKey.values()]
    .sort((a, b) => a.label.localeCompare(b.label))
    .map(group => ({ ...group, tools: [...group.tools].sort((a, b) => a.name.localeCompare(b.name)) }))
})

function onSelection(value: unknown): void {
  if (!Array.isArray(value))
    return
  const next = value.filter((name): name is string => typeof name === 'string').slice(0, DEFINITION_LIMITS.toolsMax)
  emit('update:modelValue', next)
}

function remove(name: string): void {
  emit('update:modelValue', selected.value.filter(entry => entry !== name))
}
</script>

<template>
  <div class="flex min-w-0 flex-col gap-2">
    <Popover v-model:open="open">
      <PopoverTrigger as-child>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          :aria-expanded="open"
          :aria-label="`${label}, ${selected.length === 1 ? '1 tool' : `${selected.length} tools`} chosen`"
          :disabled="disabled"
          :data-count="selected.length"
          class="h-9 w-full justify-between gap-2 px-2.5 font-normal pointer-coarse:h-10"
          v-bind="$attrs"
        >
          <span class="min-w-0 truncate" :class="selected.length === 0 ? 'text-muted-foreground' : undefined">
            {{ selected.length === 0 ? 'Choose tools…' : selected.length === 1 ? '1 tool chosen' : `${selected.length} tools chosen` }}
          </span>
          <ChevronsUpDownIcon aria-hidden="true" class="size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" class="w-(--reka-popover-trigger-width) p-0 sm:min-w-80">
        <Command multiple :model-value="selected" class="max-h-[min(22rem,var(--reka-popover-content-available-height))]" @update:model-value="onSelection">
          <CommandInput placeholder="Search tools…" aria-label="Search tools" />
          <CommandList :aria-label="label">
            <CommandEmpty class="py-6 text-center text-sm text-muted-foreground">
              {{ tools.length === 0 ? 'No tools are available.' : 'No tools found.' }}
            </CommandEmpty>
            <CommandGroup v-for="group in groups" :key="group.key" :heading="group.label">
              <CommandItem
                v-for="tool in group.tools"
                :key="tool.name"
                :value="tool.name"
                :disabled="full && !selected.includes(tool.name)"
                :data-testid="testIds.customizationToolOption"
                :data-tool-name="tool.name"
                class="pointer-coarse:min-h-10 [&>svg:last-child]:hidden"
              >
                <span
                  aria-hidden="true"
                  class="grid size-4 shrink-0 place-items-center rounded-[4px] border border-input"
                  :class="selected.includes(tool.name) ? 'border-primary bg-primary text-primary-foreground' : undefined"
                >
                  <svg v-if="selected.includes(tool.name)" viewBox="0 0 16 16" class="size-3" fill="none" stroke="currentColor" stroke-width="2.5">
                    <path d="M3.5 8.5l3 3 6-7" />
                  </svg>
                </span>
                <span class="min-w-0 flex-1 truncate font-mono text-[13px]">{{ tool.name }}</span>
                <span v-if="tool.title" class="hidden min-w-0 truncate text-xs text-muted-foreground sm:inline">{{ tool.title }}</span>
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>

    <ul v-if="selected.length > 0" :aria-label="label" class="flex flex-wrap gap-1.5">
      <li
        v-for="name in selected"
        :key="name"
        :data-testid="testIds.customizationToolChip"
        :data-tool-name="name"
        :data-state="known.has(name) ? 'known' : 'unknown'"
        class="inline-flex h-6 items-center gap-1 rounded-md border pr-0.5 pl-2 font-mono text-xs pointer-coarse:h-10"
        :class="known.has(name) ? 'bg-muted/50' : 'border-warning/50 bg-warning/10'"
      >
        <Tooltip v-if="!known.has(name)">
          <TooltipTrigger as-child>
            <span tabindex="0" class="inline-flex items-center gap-1 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
              <TriangleAlertIcon aria-hidden="true" class="size-3 text-warning" />
              {{ name }}<span class="sr-only">, not available now</span>
            </span>
          </TooltipTrigger>
          <TooltipContent>Not available now</TooltipContent>
        </Tooltip>
        <span v-else>{{ name }}</span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          :aria-label="`Remove ${name}`"
          :disabled="disabled"
          class="size-5 text-muted-foreground pointer-coarse:size-10"
          @click="remove(name)"
        >
          <XIcon aria-hidden="true" />
        </Button>
      </li>
    </ul>
  </div>
</template>
