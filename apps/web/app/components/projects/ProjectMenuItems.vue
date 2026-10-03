<script setup lang="ts">
// Project radio items (docs/UI.md 7.20; ADR-031) inside the caller's DropdownMenu content: the new-chat picker, the
// header chip and both "Move to project" submenus. A first "No project" item (unless includeNone is false), then the
// projects sorted by name with the path (mono, muted) on a second line; a project whose folder is missing shows
// FolderX in text-warning.
// Contract (docs/UI.md 10.4): props / emits below; items project-option (data-value = none | <project id>).
// Stub (C15, P7-0b): implemented by W7.9 in P7-A; props and emits are frozen. The stub lists the names only.
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
    >
      No project
    </DropdownMenuRadioItem>
    <DropdownMenuRadioItem
      v-for="project in projects.sorted"
      :key="project.id"
      :value="project.id"
      :data-testid="testIds.projectOption"
      :data-value="project.id"
    >
      <span class="truncate">{{ project.name }}</span>
    </DropdownMenuRadioItem>
  </DropdownMenuRadioGroup>
</template>
