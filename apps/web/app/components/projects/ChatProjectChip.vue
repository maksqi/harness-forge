<script setup lang="ts">
// Project chip of a saved chat (docs/UI.md 2.12, 7.20; ADR-031): between the title and `⋯` in ChatHeader, only when
// the chat has a project: ghost h-7 (40px on coarse pointers), Folder (FolderX in text-warning when the folder is
// missing) + the name truncated at 14rem; below sm icon-only, always named "Project: {name}" (", folder not found" when
// missing). Its menu: ProjectMenuItems with No project (moves through useMoveChat) and "Project settings"
// (-> /settings/projects). The menu returns focus to the chip when it closes.
// Contract (docs/UI.md 10.4): props below (frozen from Gate P7-0b), no emits; renders nothing for a null or unknown
// project; root chat-project-chip (data-value = the id, data-state = ok | missing); mounted by ChatHeader (W7.10).
// Phase 11 (ADR-049, ADR-050; C39 adds the items, W11.9 owns them): the menu gains "Review commands and hooks…"
// (`chat-project-trust`, ShieldCheck) and "MCP servers…" (`chat-project-mcp`, ServerCog), which open the project trust
// and project MCP dialogs through CHAT_VIEW_ACTIONS (absent outside a chat view: the items are left out).
import { FolderIcon, FolderXIcon, ServerCogIcon, Settings2Icon, ShieldCheckIcon } from '@lucide/vue'
import { computed, inject, onMounted } from 'vue'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { CHAT_VIEW_ACTIONS } from '~/components/chat/chat-context'
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
/** + Phase 11: the chat view's dialogs (the trust review and the project MCP servers). */
const chatView = inject(CHAT_VIEW_ACTIONS, null)

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
      <template v-if="chatView">
        <DropdownMenuItem :data-testid="testIds.chatProjectTrust" class="min-h-8 pointer-coarse:min-h-10" @select="chatView.openProjectTrust()">
          <ShieldCheckIcon aria-hidden="true" />
          Review commands and hooks…
        </DropdownMenuItem>
        <DropdownMenuItem :data-testid="testIds.chatProjectMcp" class="min-h-8 pointer-coarse:min-h-10" @select="chatView.openProjectMcp()">
          <ServerCogIcon aria-hidden="true" />
          MCP servers…
        </DropdownMenuItem>
      </template>
      <DropdownMenuItem as-child class="min-h-8 pointer-coarse:min-h-10">
        <NuxtLink to="/settings/projects">
          <Settings2Icon aria-hidden="true" />
          Project settings
        </NuxtLink>
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
