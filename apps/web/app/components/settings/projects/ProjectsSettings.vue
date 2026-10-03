<script setup lang="ts">
// Settings -> Projects body (docs/UI.md 2.13, 9.10; ADR-031): the project rows sorted by name (project-row,
// data-project-id) with the path (mono, muted, truncated; the full path in its title), "{n} chats", "Folder not found"
// (project-missing; its tooltip is the server's `issue`) and "Uses AGENTS.md" / "Uses CLAUDE.md"; the row `⋯` menu
// (project-row-menu, "Actions for {name}"): Rename (project-rename -> InlineRename project-rename-input, at most 80
// characters, optimistic) · Edit instructions… (project-instructions -> ProjectInstructionsDialog) · Allowed
// commands… (Phase 8, project-allowlist, ShieldCheck -> AllowlistDialog, the project's shell rules) · Delete…
// (project-delete -> ConfirmDialog with project-delete-confirm; 409 run-active -> toast "Wait for the responses in this
// project to finish before deleting it."). Phase 8: the row meta adds "{n} allowed commands" ("1 allowed command", left
// out at 0; useShellRulesStore, which pages/settings/projects.vue loads). The empty state (projects-empty) has its own
// Add project (project-add).
// A skeleton shows while the projects load; a failure shows SettingsLoadError "Could not load the projects" with Retry.
// `?add=1` (the page's header action, the palette's "Add project…") opens the AddProjectDialog, and the query parameter
// is dropped at once, so the same link works again. The list reloads on every visit (chat counts and folder states).
// Contract (docs/UI.md 10.4): no props, no emits (frozen from Gate P7-0b); root projects-settings; rendered by
// pages/settings/projects.vue inside SettingsPage, which renders the PageHeader "Projects" with the Add project action.
import type { ProjectSummary } from '@harness-forge/shared'
import { createServerEvent, LIMITS } from '@harness-forge/shared'
import { FileTextIcon, FolderPlusIcon, FolderXIcon, MoreHorizontalIcon, PencilIcon, ShieldCheckIcon, Trash2Icon } from '@lucide/vue'
import { computed, nextTick, onMounted, ref, shallowRef, useTemplateRef, watch } from 'vue'
import { toast } from 'vue-sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import ConfirmDialog from '~/components/common/ConfirmDialog.vue'
import InlineRename from '~/components/common/InlineRename.vue'
import AddProjectDialog from '~/components/projects/AddProjectDialog.vue'
import ProjectInstructionsDialog from '~/components/projects/ProjectInstructionsDialog.vue'
import { allowedCommandsLabel } from '~/components/workspace/allowlist/allowlist'
import AllowlistDialog from '~/components/workspace/allowlist/AllowlistDialog.vue'
import { useChatsStore } from '~/stores/chats'
import { useProjectsStore } from '~/stores/projects'
import { useShellRulesStore } from '~/stores/shell-rules'
import { hasErrorCode } from '~/utils/errors'
import { testIds } from '~/utils/testids'
import { toastError } from '../notify'
import { useRoute, useRouter } from '../nuxt-imports'
import SettingsLoadError from '../SettingsLoadError.vue'

type RowAction = 'rename' | 'instructions' | 'allowlist' | 'delete'

const projects = useProjectsStore()
const chats = useChatsStore()
const shellRules = useShellRulesStore()
const route = useRoute()
const router = useRouter()
const list = useTemplateRef<HTMLElement>('list')

const loadError = shallowRef<unknown>(null)
const addOpen = ref(false)
const renamingId = ref<string | null>(null)
const instructionsProject = shallowRef<ProjectSummary | null>(null)
const instructionsOpen = ref(false)
const allowlistProject = shallowRef<ProjectSummary | null>(null)
const allowlistOpen = ref(false)
const deleteTarget = shallowRef<ProjectSummary | null>(null)
const deleteOpen = ref(false)
const deleting = ref(false)

/** The menu item chosen; it runs once the menu has closed (its focus return cannot steal focus from the rename). */
let pending: { project: ProjectSummary, action: RowAction } | null = null

const showError = computed(() => loadError.value !== null && !projects.loaded)

function chatsLabel(count: number): string {
  return `${count} ${count === 1 ? 'chat' : 'chats'}`
}

/** "{n} allowed commands" of a row; null without rules. */
function rulesLabel(id: string): string | null {
  return allowedCommandsLabel(shellRules.countForProject(id))
}

const deleteDescription = computed(() => {
  const count = deleteTarget.value?.chatCount ?? 0
  if (count === 0)
    return 'It has no chats. The folder and its files are not touched.'
  if (count === 1)
    return 'Its 1 chat stays and moves to No project. The folder and its files are not touched.'
  return `Its ${count} chats stay and move to No project. The folder and its files are not touched.`
})

async function load(): Promise<void> {
  loadError.value = null
  try {
    await projects.fetchAll()
  }
  catch (error) {
    loadError.value = error
  }
}

onMounted(() => void load())

// `?add=1` opens the dialog; the parameter goes away so the header button (and the palette) can set it again.
watch(() => route.query.add, (value) => {
  const flag = Array.isArray(value) ? value[0] : value
  if (flag !== '1')
    return
  addOpen.value = true
  const { add: _add, ...query } = route.query
  router.replace({ query }).catch(() => {})
}, { immediate: true })

function rowElement(id: string): HTMLElement | null {
  return list.value?.querySelector<HTMLElement>(`[data-testid="${testIds.projectRow}"][data-project-id="${id}"]`) ?? null
}

function focusMenuTrigger(id: string | undefined): void {
  if (id)
    rowElement(id)?.querySelector<HTMLElement>(`[data-testid="${testIds.projectRowMenu}"]`)?.focus()
}

function choose(project: ProjectSummary, action: RowAction): void {
  pending = { project, action }
}

function onMenuCloseAutoFocus(event: Event): void {
  const chosen = pending
  pending = null
  if (!chosen)
    return
  if (chosen.action === 'rename') {
    event.preventDefault()
    void nextTick(() => {
      renamingId.value = chosen.project.id
    })
    return
  }
  // The trigger keeps focus: the dialogs give it back there when they close.
  void nextTick(() => {
    if (chosen.action === 'instructions') {
      instructionsProject.value = chosen.project
      instructionsOpen.value = true
    }
    else if (chosen.action === 'allowlist') {
      allowlistProject.value = chosen.project
      allowlistOpen.value = true
    }
    else {
      deleteTarget.value = chosen.project
      deleteOpen.value = true
    }
  })
}

async function rename(project: ProjectSummary, name: string): Promise<void> {
  try {
    await projects.update(project.id, { name })
  }
  catch (error) {
    toastError(error)
  }
}

async function onRenameEditing(project: ProjectSummary, editing: boolean): Promise<void> {
  if (editing)
    return
  renamingId.value = null
  await nextTick()
  focusMenuTrigger(project.id)
}

function onDeleteOpenChange(value: boolean): void {
  if (!value && deleting.value)
    return
  deleteOpen.value = value
}

async function confirmDelete(): Promise<void> {
  const project = deleteTarget.value
  if (!project || deleting.value)
    return
  deleting.value = true
  try {
    await projects.remove(project.id)
    // The server detaches the chats, deletes the project's shell rules and announces it with `project.changed`; do it
    // locally too, in case the event stream is reconnecting.
    const deletedEvent = createServerEvent('project.changed', { id: project.id, project: null })
    chats.applyEvent(deletedEvent)
    shellRules.applyEvent(deletedEvent)
    toast.success('Project deleted')
  }
  catch (error) {
    if (hasErrorCode(error, 'conflict'))
      toast.error('Wait for the responses in this project to finish before deleting it.')
    else
      toastError(error)
  }
  finally {
    deleting.value = false
    deleteOpen.value = false
  }
}

function openAdd(): void {
  addOpen.value = true
}
</script>

<template>
  <div :data-testid="testIds.projectsSettings" class="flex flex-col gap-4 py-4">
    <SettingsLoadError
      v-if="showError"
      :error="loadError"
      title="Could not load the projects"
      :pending="projects.loading"
      @retry="load"
    />

    <div v-else-if="!projects.loaded" aria-busy="true" class="flex flex-col gap-2">
      <span class="sr-only">Loading projects…</span>
      <Skeleton v-for="n in 2" :key="n" class="h-16 rounded-lg" />
    </div>

    <div
      v-else-if="projects.sorted.length === 0"
      :data-testid="testIds.projectsEmpty"
      class="flex flex-col items-start gap-3 rounded-lg border border-dashed p-5 sm:items-center sm:text-center"
    >
      <p class="text-sm text-muted-foreground">
        No projects yet. A project is a folder on the server that chats can read and edit.
      </p>
      <Button type="button" :data-testid="testIds.projectAdd" class="pointer-coarse:h-10" @click="openAdd">
        <FolderPlusIcon aria-hidden="true" data-icon="inline-start" />
        Add project
      </Button>
    </div>

    <ul v-else ref="list" class="flex flex-col divide-y rounded-lg border">
      <li
        v-for="project in projects.sorted"
        :key="project.id"
        :data-testid="testIds.projectRow"
        :data-project-id="project.id"
        class="flex min-w-0 items-center gap-3 px-3 py-2.5"
      >
        <div class="flex min-w-0 flex-1 flex-col gap-0.5">
          <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <InlineRename
              v-if="renamingId === project.id"
              :model-value="project.name"
              :editing="true"
              :max-length="LIMITS.projectNameMaxChars"
              aria-label="Project name"
              :data-testid="testIds.projectRenameInput"
              class="max-w-80 text-sm font-medium"
              @update:model-value="rename(project, $event)"
              @update:editing="onRenameEditing(project, $event)"
            />
            <span v-else class="min-w-0 truncate text-sm font-medium">{{ project.name }}</span>
            <Tooltip v-if="!project.available">
              <TooltipTrigger as-child>
                <Badge
                  variant="outline"
                  tabindex="0"
                  :data-testid="testIds.projectMissing"
                  :aria-description="project.issue ?? undefined"
                  class="gap-1 border-warning/40 bg-warning/10 text-foreground"
                >
                  <FolderXIcon aria-hidden="true" class="text-warning" />
                  Folder not found
                </Badge>
              </TooltipTrigger>
              <TooltipContent v-if="project.issue">
                {{ project.issue }}
              </TooltipContent>
            </Tooltip>
          </div>
          <p class="min-w-0 truncate font-mono text-xs text-muted-foreground" :title="project.path">
            {{ project.path }}
          </p>
          <p v-if="project.instructionsFile" class="text-xs text-muted-foreground">
            Uses {{ project.instructionsFile }}
          </p>
        </div>
        <span
          class="flex shrink-0 flex-col items-end text-right text-sm text-muted-foreground tabular-nums sm:flex-row sm:items-center sm:gap-1"
        >
          <span>{{ chatsLabel(project.chatCount) }}</span>
          <template v-if="rulesLabel(project.id)">
            <span aria-hidden="true" class="hidden sm:inline">·</span>
            <span>{{ rulesLabel(project.id) }}</span>
          </template>
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              :data-testid="testIds.projectRowMenu"
              :aria-label="`Actions for ${project.name}`"
              class="shrink-0 text-muted-foreground pointer-coarse:size-10"
            >
              <MoreHorizontalIcon aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" class="w-52" @close-auto-focus="onMenuCloseAutoFocus">
            <DropdownMenuItem :data-testid="testIds.projectRename" @select="choose(project, 'rename')">
              <PencilIcon aria-hidden="true" />
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem :data-testid="testIds.projectInstructions" @select="choose(project, 'instructions')">
              <FileTextIcon aria-hidden="true" />
              Edit instructions…
            </DropdownMenuItem>
            <DropdownMenuItem :data-testid="testIds.projectAllowlist" @select="choose(project, 'allowlist')">
              <ShieldCheckIcon aria-hidden="true" />
              Allowed commands…
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" :data-testid="testIds.projectDelete" @select="choose(project, 'delete')">
              <Trash2Icon aria-hidden="true" />
              Delete…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </li>
    </ul>

    <AddProjectDialog v-model:open="addOpen" />
    <ProjectInstructionsDialog v-model:open="instructionsOpen" :project="instructionsProject" />
    <AllowlistDialog v-model:open="allowlistOpen" :project="allowlistProject" />
    <ConfirmDialog
      :open="deleteOpen"
      :title="`Delete ${deleteTarget?.name ?? 'project'}?`"
      :description="deleteDescription"
      confirm-label="Delete project"
      :pending="deleting"
      :data-testid="testIds.projectDeleteConfirm"
      @update:open="onDeleteOpenChange"
      @confirm="confirmDelete"
    />
  </div>
</template>
