<script setup lang="ts">
// The agent's Skills picker of the definition editor (Phase 12, ADR-058; docs/UI.md 9.14, 14.2): a trigger ("Choose
// skills…", "{n} skills chosen"; attributes such as the editor's `customization-skills` land on it, with `data-count`)
// that opens a Popover with a searchable `Command` list of the catalog's skills (name in mono, the description muted);
// each option has a checkbox look (`data-skill-name`, `data-state` checked / unchecked). At most `max` skills (5): the
// other options are disabled once it is reached. The chosen skills show as chips with a remove button "Remove {skill}";
// a name the catalog does not know stays as a warning chip "Not available now". Same pattern as ToolMultiSelect.
import { ChevronsUpDownIcon, TriangleAlertIcon, XIcon } from '@lucide/vue'
import { computed, ref } from 'vue'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

defineOptions({ inheritAttrs: false })

const props = withDefaults(defineProps<{
  modelValue: readonly string[]
  /** The skills that can be chosen (the catalog's). */
  options: readonly { name: string, description: string }[]
  label: string
  max?: number
  disabled?: boolean
}>(), { max: 5, disabled: false })

const emit = defineEmits<{ 'update:modelValue': [value: string[]] }>()

const open = ref(false)
const known = computed(() => new Set(props.options.map(option => option.name)))
const full = computed(() => props.modelValue.length >= props.max)
const sorted = computed(() => [...props.options].sort((a, b) => a.name.localeCompare(b.name)))

function chosenText(count: number): string {
  if (count === 0)
    return 'Choose skills…'
  return count === 1 ? '1 skill chosen' : `${count} skills chosen`
}

function onSelection(value: unknown): void {
  if (!Array.isArray(value))
    return
  const next = value.filter((name): name is string => typeof name === 'string')
  // Keep the order of choice; never more than `max`.
  emit('update:modelValue', next.slice(0, Math.max(props.max, props.modelValue.length)))
}

function remove(name: string): void {
  emit('update:modelValue', props.modelValue.filter(entry => entry !== name))
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
          :aria-label="`${label}, ${modelValue.length === 1 ? '1 skill' : `${modelValue.length} skills`} chosen`"
          :disabled="disabled"
          :data-count="modelValue.length"
          class="h-9 w-full justify-between gap-2 px-2.5 font-normal pointer-coarse:h-10"
          v-bind="$attrs"
        >
          <span class="min-w-0 truncate" :class="modelValue.length === 0 ? 'text-muted-foreground' : undefined">
            {{ chosenText(modelValue.length) }}
          </span>
          <ChevronsUpDownIcon aria-hidden="true" class="size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" class="w-(--reka-popover-trigger-width) p-0 sm:min-w-80">
        <Command multiple :model-value="[...modelValue]" class="max-h-[min(22rem,var(--reka-popover-content-available-height))]" @update:model-value="onSelection">
          <CommandInput placeholder="Search skills…" aria-label="Search skills" />
          <CommandList :aria-label="label">
            <CommandEmpty class="py-6 text-center text-sm text-muted-foreground">
              {{ options.length === 0 ? 'No skills yet.' : 'No skills found.' }}
            </CommandEmpty>
            <CommandGroup>
              <CommandItem
                v-for="option in sorted"
                :key="option.name"
                :value="option.name"
                :disabled="full && !modelValue.includes(option.name)"
                data-slot="customization-skill-option"
                :data-skill-name="option.name"
                :data-state="modelValue.includes(option.name) ? 'checked' : 'unchecked'"
                class="pointer-coarse:min-h-10 [&>svg:last-child]:hidden"
              >
                <span
                  aria-hidden="true"
                  class="grid size-4 shrink-0 place-items-center rounded-[4px] border border-input"
                  :class="modelValue.includes(option.name) ? 'border-primary bg-primary text-primary-foreground' : undefined"
                >
                  <svg v-if="modelValue.includes(option.name)" viewBox="0 0 16 16" class="size-3" fill="none" stroke="currentColor" stroke-width="2.5">
                    <path d="M3.5 8.5l3 3 6-7" />
                  </svg>
                </span>
                <span class="min-w-0 shrink-0 truncate font-mono text-[13px]">{{ option.name }}</span>
                <span v-if="option.description" class="hidden min-w-0 truncate text-xs text-muted-foreground sm:inline">{{ option.description }}</span>
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>

    <ul v-if="modelValue.length > 0" :aria-label="label" class="flex flex-wrap gap-1.5">
      <li
        v-for="name in modelValue"
        :key="name"
        data-slot="customization-skill-chip"
        :data-skill-name="name"
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
