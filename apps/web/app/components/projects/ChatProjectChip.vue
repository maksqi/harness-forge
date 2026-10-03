<script setup lang="ts">
// Project chip of a saved chat (docs/UI.md 2.12, 7.20; ADR-031): between the title and `⋯` in ChatHeader, only when
// the chat has a project: ghost h-7, Folder (FolderX in text-warning when the folder is missing) + the name truncated
// at 14rem; below sm icon-only with aria-label "Project: {name}". Its menu: ProjectMenuItems with No project (moves
// through useMoveChat) and "Project settings" (-> /settings/projects).
// Contract (docs/UI.md 10.4): props below, no emits; renders nothing for a null or unknown project; root
// chat-project-chip (data-value = the id, data-state = ok | missing); mounted by ChatHeader (W7.10).
// Stub (C15, P7-0b): implemented by W7.9 in P7-A; props are frozen. The stub renders the chip without its menu.
import { FolderIcon, FolderXIcon } from '@lucide/vue'
import { computed } from 'vue'
import { Button } from '@/components/ui/button'
import { useProjectsStore } from '~/stores/projects'
import { testIds } from '~/utils/testids'

const props = defineProps<{
  chatId: string
  /** The chat's project; null = none. */
  projectId: string | null
}>()

const projects = useProjectsStore()
const project = computed(() => (props.projectId ? projects.byId(props.projectId) : undefined))
</script>

<template>
  <Button
    v-if="project"
    type="button"
    variant="ghost"
    size="sm"
    :data-testid="testIds.chatProjectChip"
    :data-value="project.id"
    :data-state="project.available ? 'ok' : 'missing'"
    :aria-label="`Project: ${project.name}`"
    class="h-7 max-w-56 gap-1.5 px-2 font-normal text-muted-foreground"
  >
    <FolderIcon v-if="project.available" aria-hidden="true" class="size-4" />
    <FolderXIcon v-else aria-hidden="true" class="size-4 text-warning" />
    <span class="truncate max-sm:sr-only">{{ project.name }}</span>
  </Button>
</template>
