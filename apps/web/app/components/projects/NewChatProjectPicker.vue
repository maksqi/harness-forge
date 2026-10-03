<script setup lang="ts">
// New-chat project picker (docs/UI.md 2.12, 7.20; ADR-031): a ghost pill (h-8, rounded-full, 40px on coarse pointers)
// right under ChatGreeting on `/`: "No project ▾" or "{name} ▾" with a Folder icon (FolderX in text-warning when the
// folder is missing); its menu lists ProjectMenuItems. Default (the caller's v-model): the switcher's project when the
// filter names one, else No project. When the filter is not 'all', a pick also sets the chats store filter (No project
// -> 'none'), so the new chat appears in the visible list. Hidden while no project exists. A v-model that names an
// unknown project shows (and checks) No project.
// Contract (docs/UI.md 10.4): props / emits below (frozen from Gate P7-0b; v-model: the new chat's project, null =
// none); root new-chat-project (data-value = none | <project id>); mounted by pages/index.vue (W7.10).
import { ChevronDownIcon, FolderIcon, FolderXIcon } from '@lucide/vue'
import { computed, onMounted } from 'vue'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useChatsStore } from '~/stores/chats'
import { useProjectsStore } from '~/stores/projects'
import { testIds } from '~/utils/testids'
import ProjectMenuItems from './ProjectMenuItems.vue'
import { loadProjectsOnce } from './projects-load'

const props = withDefaults(defineProps<{
  /** v-model: the new chat's project; null = No project. */
  modelValue: string | null
  disabled?: boolean
}>(), {
  disabled: false,
})

const emit = defineEmits<{ 'update:modelValue': [projectId: string | null] }>()

const chats = useChatsStore()
const projects = useProjectsStore()

const project = computed(() => (props.modelValue ? projects.byId(props.modelValue) : undefined))
const value = computed(() => project.value?.id ?? null)
const label = computed(() => project.value?.name ?? 'No project')
const missing = computed(() => project.value !== undefined && !project.value.available)

onMounted(loadProjectsOnce)

function pick(projectId: string | null) {
  emit('update:modelValue', projectId)
  if (chats.projectFilter !== 'all')
    chats.setProjectFilter(projectId ?? 'none').catch(() => {})
}
</script>

<template>
  <DropdownMenu v-if="projects.items.length > 0">
    <DropdownMenuTrigger as-child :disabled="disabled">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        :disabled="disabled"
        :data-testid="testIds.newChatProject"
        :data-value="value ?? 'none'"
        :aria-label="`Project: ${label}${missing ? ', folder not found' : ''}`"
        class="h-8 max-w-full gap-1.5 rounded-full px-3 font-normal text-muted-foreground pointer-coarse:h-10"
      >
        <FolderXIcon v-if="missing" aria-hidden="true" class="size-4 text-warning" />
        <FolderIcon v-else aria-hidden="true" class="size-4" />
        <span class="truncate">{{ label }}</span>
        <ChevronDownIcon aria-hidden="true" class="size-3.5 opacity-60" />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="center" class="max-h-80 w-72 max-w-[calc(100vw-2rem)]">
      <ProjectMenuItems :model-value="value" @select="pick" />
    </DropdownMenuContent>
  </DropdownMenu>
</template>
