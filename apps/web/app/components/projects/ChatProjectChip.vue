<script setup lang="ts">
// Project chip of a saved chat (docs/UI.md 2.12, 7.20; ADR-031): between the title and `⋯` in ChatHeader, only when
// the chat has a project: ghost h-7 (40px on coarse pointers), Folder (FolderX in text-warning when the folder is
// missing) + the name truncated at 14rem; below sm icon-only, always named "Project: {name}" (", folder not found" when
// missing). Its menu: ProjectMenuItems with No project (moves through useMoveChat) and "Project settings"
// (-> /settings/projects). The menu returns focus to the chip when it closes.
// Contract (docs/UI.md 10.4): props below (frozen from Gate P7-0b), no emits; renders nothing for a null or unknown
// project; root chat-project-chip (data-value = the id, data-state = ok | missing); mounted by ChatHeader (W7.10).
import { FolderIcon, FolderXIcon, Settings2Icon } from '@lucide/vue'
import { computed, onMounted } from 'vue'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useProjectsStore } from '~/stores/projects'
import { testIds } from '~/utils/testids'
import { useMoveChat } from './move-chat'
import ProjectMenuItems from './ProjectMenuItems.vue'
import { loadProjectsOnce } from './projects-load'

const props = defineProps<{
  chatId: string
  /** The chat's project; null = none. */
  projectId: string | null
}>()

const projects = useProjectsStore()
const move = useMoveChat()

const project = computed(() => (props.projectId ? projects.byId(props.projectId) : undefined))
const label = computed(() => {
  const current = project.value
  if (!current)
    return ''
  return `Project: ${current.name}${current.available ? '' : ', folder not found'}`
})

onMounted(loadProjectsOnce)

function onSelect(projectId: string | null) {
  void move(props.chatId, projectId)
}
</script>

<template>
  <DropdownMenu v-if="project">
    <DropdownMenuTrigger as-child>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        :data-testid="testIds.chatProjectChip"
        :data-value="project.id"
        :data-state="project.available ? 'ok' : 'missing'"
        :aria-label="label"
        class="h-7 max-w-56 min-w-0 gap-1.5 px-2 font-normal text-muted-foreground max-sm:w-7 max-sm:px-0 pointer-coarse:h-10 pointer-coarse:max-sm:w-10"
      >
        <FolderIcon v-if="project.available" aria-hidden="true" class="size-4" />
        <FolderXIcon v-else aria-hidden="true" class="size-4 text-warning" />
        <span class="truncate max-sm:sr-only">{{ project.name }}</span>
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" class="max-h-80 w-72 max-w-[calc(100vw-2rem)]">
      <DropdownMenuLabel class="text-xs font-normal text-muted-foreground">
        Move to project
      </DropdownMenuLabel>
      <ProjectMenuItems :model-value="project.id" @select="onSelect" />
      <DropdownMenuSeparator />
      <DropdownMenuItem as-child class="min-h-8 pointer-coarse:min-h-10">
        <NuxtLink to="/settings/projects">
          <Settings2Icon aria-hidden="true" />
          Project settings
        </NuxtLink>
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
