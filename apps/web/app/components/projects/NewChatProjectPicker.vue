<script setup lang="ts">
// New-chat project picker (docs/UI.md 2.12, 7.20; ADR-031): a ghost pill (h-8, rounded-full, 40px on coarse pointers)
// right under ChatGreeting on `/`: "No project ▾" or "{name} ▾" with a Folder icon; its menu lists ProjectMenuItems.
// Default (the caller's v-model): the switcher's project when the filter names one, else No project. When the filter
// is not 'all', a pick also sets the chats store filter. Hidden while no project exists.
// Contract (docs/UI.md 10.4): props / emits below (v-model: the new chat's project, null = none); root
// new-chat-project (data-value = none | <project id>); mounted by pages/index.vue (W7.10).
// Stub (C15, P7-0b): implemented by W7.9 in P7-A; props and emits are frozen. The stub renders the pill without its
// menu.
import { FolderIcon } from '@lucide/vue'
import { computed } from 'vue'
import { Button } from '@/components/ui/button'
import { useProjectsStore } from '~/stores/projects'
import { testIds } from '~/utils/testids'

const props = withDefaults(defineProps<{
  /** v-model: the new chat's project; null = No project. */
  modelValue: string | null
  disabled?: boolean
}>(), {
  disabled: false,
})

defineEmits<{ 'update:modelValue': [projectId: string | null] }>()

const projects = useProjectsStore()
const label = computed(() => (props.modelValue ? projects.byId(props.modelValue)?.name : undefined) ?? 'No project')
</script>

<template>
  <Button
    v-if="projects.items.length > 0"
    type="button"
    variant="ghost"
    size="sm"
    :disabled="disabled"
    :data-testid="testIds.newChatProject"
    :data-value="modelValue ?? 'none'"
    class="h-8 gap-1.5 rounded-full font-normal text-muted-foreground pointer-coarse:h-10"
  >
    <FolderIcon aria-hidden="true" class="size-4" />
    <span class="truncate">{{ label }}</span>
  </Button>
</template>
