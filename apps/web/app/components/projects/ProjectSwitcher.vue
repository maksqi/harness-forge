<script setup lang="ts">
// Project switcher (docs/UI.md 2.12, 5.3, 7.20; ADR-031): the first row of ChatNav, above New chat. Row: Folders +
// "All chats", Folder + "No project" or the project name, or FolderX in text-warning when its folder is missing, then
// ChevronsUpDown. Menu (radio group, max-h-80, scrolls): All chats · No project · the projects sorted by name with the
// path and the chat count (project-switcher-option, data-value) · Add project… (project-add; this component mounts its
// own AddProjectDialog, and the filter then switches to the new project) · Manage projects (project-manage ->
// /settings/projects). Without any project the menu holds All chats, Add project… and Manage projects. A pick calls
// chats.setProjectFilter() (a failed page shows the list's Retry). Icon mode: an icon button with the tooltip
// "Project: {name}". Inside the mobile sheet picking a filter does not close it (only a navigation does).
// The projects load when the switcher mounts and refresh whenever its menu opens (chat counts and folder states change
// on the server without an event).
// Contract (docs/UI.md 10.4): no props, no emits (frozen from Gate P7-0b); trigger project-switcher (data-value = all |
// none | <project id>, accessible name "Project filter: {name}"). Renders inside a SidebarMenuItem of ChatNav.
import type { ProjectSummary } from '@harness-forge/shared'
import type { ChatProjectFilter } from '~/stores/chats'
import {
  ChevronsUpDownIcon,
  FolderIcon,
  FolderPlusIcon,
  FoldersIcon,
  FolderXIcon,
  Settings2Icon,
} from '@lucide/vue'
import { computed, nextTick, onMounted, ref } from 'vue'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { SidebarMenuButton, useSidebar } from '@/components/ui/sidebar'
import { cn } from '@/lib/utils'
import { SIDEBAR_ROW_CLASS } from '~/components/app-shell/sidebar-classes'
import { useChatsStore } from '~/stores/chats'
import { useProjectsStore } from '~/stores/projects'
import { testIds } from '~/utils/testids'
import AddProjectDialog from './AddProjectDialog.vue'
import { loadProjectsOnce, refreshProjects } from './projects-load'

const chats = useChatsStore()
const projects = useProjectsStore()
const { isMobile, state } = useSidebar()

const menuOpen = ref(false)
const addOpen = ref(false)
/** "Add project…" was chosen: the dialog opens once the menu has closed and focus is back on the trigger. */
let addPending = false

const iconMode = computed(() => state.value === 'collapsed' && !isMobile.value)
const filter = computed(() => chats.projectFilter)
/** The project the list is filtered by (undefined for all / none, and while the projects load). */
const project = computed<ProjectSummary | undefined>(() =>
  filter.value === 'all' || filter.value === 'none' ? undefined : projects.byId(filter.value))

const label = computed(() => {
  if (filter.value === 'all')
    return 'All chats'
  if (filter.value === 'none')
    return 'No project'
  return project.value?.name ?? 'Project'
})
const missing = computed(() => project.value !== undefined && !project.value.available)
const icon = computed(() => {
  if (filter.value === 'all')
    return FoldersIcon
  return missing.value ? FolderXIcon : FolderIcon
})

const ITEM_CLASS = 'min-h-8 pointer-coarse:min-h-10'

onMounted(loadProjectsOnce)

function onOpenChange(open: boolean) {
  menuOpen.value = open
  if (open)
    refreshProjects()
}

function pick(value: unknown) {
  if (typeof value !== 'string' || value === filter.value)
    return
  chats.setProjectFilter(value as ChatProjectFilter).catch(() => {})
}

function chooseAdd() {
  addPending = true
}

function onCloseAutoFocus() {
  if (!addPending)
    return
  addPending = false
  // Focus returns to the trigger first, so the dialog gives it back there when it closes.
  void nextTick(() => {
    addOpen.value = true
  })
}

function onCreated(created: ProjectSummary) {
  chats.setProjectFilter(created.id).catch(() => {})
}
</script>

<template>
  <DropdownMenu :open="menuOpen" @update:open="onOpenChange">
    <DropdownMenuTrigger as-child>
      <SidebarMenuButton
        :tooltip="`Project: ${label}`"
        :data-testid="testIds.projectSwitcher"
        :data-value="filter"
        :aria-label="`Project filter: ${label}`"
        :class="SIDEBAR_ROW_CLASS"
      >
        <component :is="icon" aria-hidden="true" :class="cn(missing && 'text-warning!')" />
        <span class="min-w-0 flex-1 truncate">{{ label }}</span>
        <ChevronsUpDownIcon aria-hidden="true" class="ml-auto size-3.5! opacity-60 group-data-[collapsible=icon]:hidden" />
      </SidebarMenuButton>
    </DropdownMenuTrigger>
    <DropdownMenuContent
      :side="iconMode ? 'right' : 'bottom'"
      align="start"
      class="max-h-80 min-w-64"
      @close-auto-focus="onCloseAutoFocus"
    >
      <DropdownMenuRadioGroup :model-value="filter" @update:model-value="pick">
        <DropdownMenuRadioItem
          value="all"
          :data-testid="testIds.projectSwitcherOption"
          data-value="all"
          :class="ITEM_CLASS"
        >
          <FoldersIcon aria-hidden="true" class="text-muted-foreground" />
          All chats
        </DropdownMenuRadioItem>
        <template v-if="projects.sorted.length > 0">
          <DropdownMenuRadioItem
            value="none"
            :data-testid="testIds.projectSwitcherOption"
            data-value="none"
            :class="ITEM_CLASS"
          >
            <FolderIcon aria-hidden="true" class="text-muted-foreground" />
            No project
          </DropdownMenuRadioItem>
          <DropdownMenuSeparator />
          <DropdownMenuRadioItem
            v-for="item in projects.sorted"
            :key="item.id"
            :value="item.id"
            :data-testid="testIds.projectSwitcherOption"
            :data-value="item.id"
            :class="cn(ITEM_CLASS, 'items-start')"
          >
            <FolderIcon v-if="item.available" aria-hidden="true" class="mt-0.5 text-muted-foreground" />
            <FolderXIcon v-else aria-hidden="true" class="mt-0.5 text-warning" />
            <span class="flex min-w-0 flex-1 flex-col">
              <span class="truncate">
                {{ item.name }}<span v-if="!item.available" class="sr-only">, folder not found</span>
              </span>
              <span class="truncate font-mono text-xs text-muted-foreground" :title="item.path">{{ item.path }}</span>
            </span>
            <span class="ml-2 shrink-0 text-xs text-muted-foreground tabular-nums">
              {{ item.chatCount }}<span class="sr-only"> {{ item.chatCount === 1 ? 'chat' : 'chats' }}</span>
            </span>
          </DropdownMenuRadioItem>
        </template>
      </DropdownMenuRadioGroup>
      <DropdownMenuSeparator />
      <DropdownMenuItem :data-testid="testIds.projectAdd" :class="ITEM_CLASS" @select="chooseAdd">
        <FolderPlusIcon aria-hidden="true" />
        Add project…
      </DropdownMenuItem>
      <DropdownMenuItem as-child :data-testid="testIds.projectManage" :class="ITEM_CLASS">
        <NuxtLink to="/settings/projects">
          <Settings2Icon aria-hidden="true" />
          Manage projects
        </NuxtLink>
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
  <AddProjectDialog v-model:open="addOpen" @created="onCreated" />
</template>
