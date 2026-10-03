<script setup lang="ts">
// Project radio items (docs/UI.md 7.20; ADR-031) inside the caller's DropdownMenu content: the new-chat picker, the
// header chip and both "Move to project" submenus. A first "No project" item (unless includeNone is false), then the
// projects sorted by name with the path (mono, muted) on a second line; a project whose folder is missing shows
// FolderX in text-warning (and says so to screen readers).
// Contract (docs/UI.md 10.4): props / emits below (frozen from Gate P7-0b); items project-option (data-value = none |
// <project id>). Picking the selected item again emits nothing.
import { FolderXIcon } from '@lucide/vue'
import { computed } from 'vue'
import { DropdownMenuRadioGroup, DropdownMenuRadioItem } from '@/components/ui/dropdown-menu'
import { useProjectsStore } from '~/stores/projects'
import { testIds } from '~/utils/testids'

const props = withDefaults(defineProps<{
  /** The selected project id; null = No project. */
  modelValue: string | null
  /** A first "No project" item; default true. */
  includeNone?: boolean
}>(), {
  includeNone: true,
})

const emit = defineEmits<{ select: [projectId: string | null] }>()

/** The radio value of "No project" (project ids start with `prj_`, so it never names a project). */
const NONE = 'none'

const ITEM_CLASS = 'min-h-8 pointer-coarse:min-h-10'

const projects = useProjectsStore()
const selected = computed(() => props.modelValue ?? NONE)

function onSelect(value: unknown) {
  if (typeof value !== 'string' || value === selected.value)
    return
  emit('select', value === NONE ? null : value)
}
</script>

<template>
  <DropdownMenuRadioGroup :model-value="selected" @update:model-value="onSelect">
    <DropdownMenuRadioItem
      v-if="includeNone"
      :value="NONE"
      :data-testid="testIds.projectOption"
      :data-value="NONE"
      :class="ITEM_CLASS"
    >
      No project
    </DropdownMenuRadioItem>
    <DropdownMenuRadioItem
      v-for="project in projects.sorted"
      :key="project.id"
      :value="project.id"
      :data-testid="testIds.projectOption"
      :data-value="project.id"
      :class="ITEM_CLASS"
    >
      <span class="flex min-w-0 flex-1 flex-col">
        <span class="flex min-w-0 items-center gap-1.5">
          <span class="truncate">{{ project.name }}</span>
          <template v-if="!project.available">
            <FolderXIcon aria-hidden="true" class="size-3.5! shrink-0 text-warning" />
            <span class="sr-only">, folder not found</span>
          </template>
        </span>
        <span class="truncate font-mono text-xs text-muted-foreground" :title="project.path">{{ project.path }}</span>
      </span>
    </DropdownMenuRadioItem>
  </DropdownMenuRadioGroup>
</template>
