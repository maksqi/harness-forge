<script setup lang="ts">
// The MCP servers of a project's `.mcp.json` (Phase 11, ADR-050; docs/UI.md 2.18, 7.33, 8.4, 10.8, 14, 15): a form
// dialog "MCP servers in {project}" (the frame of ProjectTrustDialog: `sm:max-w-3xl`, full width minus 1rem at 390px,
// `max-h-[90dvh]`, the body scrolls, the footer stays visible) with the intro, one ProjectMcpServerRow per server
// (status, transport, the exact command or URL from the server's trust item, "Replaces your server {id} in this
// project's chats.", Reconnect, Review… while pending, which opens ProjectTrustDialog on the server's item), the
// per-project variables panel (`project-mcp-variables`, "Variables · {n}": one write-only password input per variable,
// always empty, with the placeholder "•••• · stored" (and Clear, which marks the value for removal), "Default: {value}"
// or nothing; the note "Values are encrypted on this server …"; "Save variables" (`project-mcp-variables-save`, disabled
// until something changed, it keeps focus) → `useFreshAuth().run(…, { required: true })` ("Saving the variables of this
// project's MCP servers needs your password.") → toast "Variables saved"), the empty state "This project has no
// .mcp.json." and the errors (`project-mcp-error`, `data-code`). Values live only in the inputs until they are sent: they
// are never stored in the page, read back or logged. `project-mcp.changed` updates the rows through the store. The
// dialog opens on the focused server's toggle (`focusServerId`), else the first row's, and returns focus to its opener.
// Data from `useProjectMcpStore()` (fetched on every open) and the trust items from `useProjectTrustStore()`. Mounted
// like ProjectTrustDialog. Props, emits and the root test id are frozen from Gate P11-0b (C39); W11.9.
// Phase 12 (ADR-056; C46, W12.13 owns it in P12-A): Edit .mcp.json… (`data-action="edit-mcp-json"`, in the footer and
// in the empty state, where it creates the file) opens the project file editor (ProjectFileEditor, mounted here) with
// kind `mcp`; its `review` opens ProjectTrustDialog. A saved server stays pending until it is approved here: after a
// save (`saved`) the dialog refetches its rows and their trust items quietly (W12.13), so a new or changed server shows
// "Needs approval" with Review… at once (`project-mcp.changed` / `project-trust.changed` update them too).
import type { ProjectMcpList, ProjectMcpServer, TrustItem } from '@harness-forge/shared'
import type { ProjectFileTarget } from '~/components/settings/customize/customize'
import { LIMITS, PROJECT_MCP_JSON_PATH } from '@harness-forge/shared'
import { ChevronRightIcon, CircleAlertIcon, FileJsonIcon, VariableIcon } from '@lucide/vue'
import { computed, nextTick, ref, shallowRef, useId, useTemplateRef, watch } from 'vue'
import { toast } from 'vue-sonner'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import ConfirmPasswordDialog from '~/components/common/ConfirmPasswordDialog.vue'
import ProjectFileEditor from '~/components/settings/customize/ProjectFileEditor.vue'
import { isFreshAuthCancelled, useFreshAuth } from '~/composables/useFreshAuth'
import { useProjectMcpStore } from '~/stores/project-mcp'
import { useProjectTrustStore } from '~/stores/project-trust'
import { useProjectsStore } from '~/stores/projects'
import { toHarnessError } from '~/utils/errors'
import { testIds } from '~/utils/testids'
import { variablePlaceholder, variableState } from '../trust/project-trust'
import ProjectTrustDialog from '../trust/ProjectTrustDialog.vue'
import ProjectMcpServerRow from './ProjectMcpServerRow.vue'

type ProjectMcpVariable = ProjectMcpList['variables'][number]

const props = defineProps<{ open: boolean, projectId: string | null, focusServerId?: string | null }>()

const emit = defineEmits<{ 'update:open': [open: boolean] }>()

/** The trust items (the exact commands and URLs of the rows) are reused when this fresh. */
const TRUST_MAX_AGE_MS = 30_000

const mcp = useProjectMcpStore()
const trust = useProjectTrustStore()
const projects = useProjectsStore()
const freshAuth = useFreshAuth()
const ids = { variables: useId(), note: useId() }
const root = useTemplateRef<HTMLElement>('root')

const loading = ref(false)
const loadError = shallowRef<{ code: string, message: string } | null>(null)
const actionError = shallowRef<{ code: string, message: string } | null>(null)
const expanded = shallowRef<Set<string>>(new Set())
const reconnecting = ref<string | null>(null)
const variablesOpen = ref(true)
/** The typed values (write-only: sent once, then dropped). */
const drafts = ref<Record<string, string>>({})
/** The stored values marked for removal. */
const cleared = shallowRef<Set<string>>(new Set())
const saving = ref(false)
const review = ref<{ open: boolean, focusKey: string | null }>({ open: false, focusKey: null })

// Bumped on every open and close, so an answer that outlives its dialog session cannot touch the next one.
let session = 0

const projectName = computed(() => (props.projectId ? projects.byId(props.projectId)?.name ?? 'this project' : 'this project'))
const list = computed<ProjectMcpList | null>(() => (props.projectId ? mcp.byProject[props.projectId] ?? null : null))
const servers = computed<readonly ProjectMcpServer[]>(() => list.value?.items ?? [])
const variables = computed<readonly ProjectMcpVariable[]>(() => list.value?.variables ?? [])
const error = computed(() => actionError.value ?? (list.value ? null : loadError.value))
/** + Phase 12: the project file editor on `.mcp.json`. */
const fileOpen = ref(false)
const fileTarget = computed<ProjectFileTarget>(() => ({ path: PROJECT_MCP_JSON_PATH, kind: 'mcp', name: null, create: servers.value.length === 0 }))

/** The request body of Save variables: typed values set, cleared ones without a new value are removed. */
const changes = computed<Record<string, string | null>>(() => {
  const values: Record<string, string | null> = {}
  for (const variable of variables.value) {
    const typed = drafts.value[variable.name] ?? ''
    if (typed.length > 0)
      values[variable.name] = typed
    else if (cleared.value.has(variable.name) && variable.set)
      values[variable.name] = null
  }
  return values
})
const dirty = computed(() => Object.keys(changes.value).length > 0)

function trustOf(server: ProjectMcpServer): TrustItem | null {
  if (!props.projectId)
    return null
  return trust.trust(props.projectId)?.items.find(item => item.kind === 'mcp' && item.sha256 === server.sha256) ?? null
}

function shownState(variable: ProjectMcpVariable): 'set' | 'default' | 'missing' {
  return variableState(variable)
}

function toggleRow(serverId: string): void {
  const next = new Set(expanded.value)
  if (next.has(serverId))
    next.delete(serverId)
  else
    next.add(serverId)
  expanded.value = next
}

function setDraft(name: string, value: string | number): void {
  drafts.value = { ...drafts.value, [name]: String(value) }
}

function toggleCleared(name: string): void {
  const next = new Set(cleared.value)
  if (next.has(name))
    next.delete(name)
  else
    next.add(name)
  cleared.value = next
}

function resetDrafts(): void {
  drafts.value = {}
  cleared.value = new Set()
}

// ---------- focus ----------

function rowToggle(serverId: string | null | undefined): HTMLElement | null {
  const rows = root.value?.querySelectorAll<HTMLElement>(`[data-testid="${testIds.projectMcpServer}"]`) ?? []
  const row = serverId ? [...rows].find(element => element.dataset.serverId === serverId) : rows[0]
  return row?.querySelector<HTMLElement>('[data-action="toggle"]') ?? null
}

/** The focused server's toggle, else the first row's, else Close. */
function focusInitial(): void {
  const target = rowToggle(props.focusServerId) ?? rowToggle(null) ?? root.value?.querySelector<HTMLElement>('[data-action="close"]')
  target?.focus()
  target?.scrollIntoView?.({ block: 'nearest' })
}

async function focusError(): Promise<void> {
  await nextTick()
  root.value?.querySelector<HTMLElement>(`[data-testid="${testIds.projectMcpError}"]`)?.focus()
}

// ---------- loading ----------

async function start(projectId: string): Promise<void> {
  const current = ++session
  actionError.value = null
  loadError.value = null
  resetDrafts()
  variablesOpen.value = true
  expanded.value = props.focusServerId ? new Set([props.focusServerId]) : new Set()
  const cached = mcp.byProject[projectId] ?? null
  loading.value = cached === null
  void trust.fetch(projectId, { maxAgeMs: TRUST_MAX_AGE_MS }).catch(() => {})
  try {
    await mcp.fetch(projectId)
  }
  catch (failure) {
    if (current !== session)
      return
    const harnessError = toHarnessError(failure)
    loadError.value = { code: harnessError.code, message: harnessError.message }
  }
  finally {
    if (current === session)
      loading.value = false
  }
  if (cached === null) {
    await nextTick()
    // Focus waited on Close while the list loaded: move it to the rows now, unless the user moved it.
    const active = document.activeElement as HTMLElement | null
    if (current === session && (!active || active.dataset.action === 'close' || !root.value?.contains(active)))
      focusInitial()
  }
}

watch(() => [props.open, props.projectId] as const, ([open, projectId]) => {
  if (open && projectId) {
    void start(projectId)
  }
  else {
    session += 1
    loading.value = false
    resetDrafts()
    review.value = { open: false, focusKey: null }
  }
}, { immediate: true })

// ---------- actions ----------

async function reconnect(server: ProjectMcpServer): Promise<void> {
  const projectId = props.projectId
  if (!projectId || reconnecting.value)
    return
  const current = session
  reconnecting.value = server.id
  actionError.value = null
  try {
    await mcp.reconnect(projectId, server.id)
  }
  catch (failure) {
    if (current !== session)
      return
    const harnessError = toHarnessError(failure)
    actionError.value = { code: harnessError.code, message: harnessError.message }
    await focusError()
  }
  finally {
    reconnecting.value = null
  }
}

function openReview(server: ProjectMcpServer): void {
  review.value = { open: true, focusKey: server.sha256 }
}

/** + Phase 12: Edit .mcp.json… (creates the file from the empty state). */
function editMcpJson(): void {
  fileOpen.value = true
}

function onFileReview(sha256?: string): void {
  review.value = { open: true, focusKey: sha256 ?? null }
}

/** + Phase 12: the saved file's servers (a new or changed one is pending until it is approved here). */
function onFileSaved(): void {
  const projectId = props.projectId
  if (!projectId)
    return
  void mcp.fetch(projectId).catch(() => {})
  void trust.fetch(projectId).catch(() => {})
}

async function saveVariables(): Promise<void> {
  const projectId = props.projectId
  const values = changes.value
  if (!projectId || !dirty.value || saving.value)
    return
  const current = session
  saving.value = true
  actionError.value = null
  try {
    await freshAuth.run(() => mcp.saveVariables(projectId, values), { required: true })
    toast.success('Variables saved')
    if (current === session)
      resetDrafts()
  }
  catch (failure) {
    if (isFreshAuthCancelled(failure) || current !== session)
      return
    const harnessError = toHarnessError(failure)
    actionError.value = { code: harnessError.code, message: harnessError.message }
  }
  finally {
    saving.value = false
  }
}

function retry(): void {
  if (props.projectId)
    void start(props.projectId)
}

function onOpenAutoFocus(event: Event): void {
  event.preventDefault()
  void nextTick(() => {
    if (list.value)
      focusInitial()
    else
      root.value?.querySelector<HTMLElement>('[data-action="close"]')?.focus()
  })
}

function onOpenChange(value: boolean): void {
  emit('update:open', value)
}
</script>

<template>
  <Dialog :open="open" @update:open="onOpenChange">
    <DialogContent
      :data-testid="testIds.projectMcpDialog"
      :aria-busy="loading || saving || undefined"
      class="flex max-h-[90dvh] max-w-[calc(100%-1rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl"
      @open-auto-focus="onOpenAutoFocus"
    >
      <div ref="root" class="flex min-h-0 flex-1 flex-col">
        <DialogHeader class="shrink-0 px-4 pt-5 pr-12 pb-3 sm:px-6 sm:pt-6">
          <DialogTitle class="break-words">
            MCP servers in {{ projectName }}
          </DialogTitle>
          <DialogDescription>
            From .mcp.json in the project folder. They run only in this project's chats, after you approve them.
          </DialogDescription>
        </DialogHeader>

        <div class="grid min-h-0 flex-1 content-start gap-4 overflow-y-auto overscroll-contain px-4 pb-4 sm:px-6">
          <Alert
            v-if="error"
            variant="destructive"
            tabindex="-1"
            :data-testid="testIds.projectMcpError"
            :data-code="error.code"
            class="outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <CircleAlertIcon aria-hidden="true" />
            <AlertDescription class="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span>{{ error.message }}</span>
              <Button
                v-if="!list && !loading"
                type="button"
                variant="outline"
                size="xs"
                class="pointer-coarse:h-10"
                @click="retry"
              >
                Retry
              </Button>
            </AlertDescription>
          </Alert>

          <div v-if="loading && !list" aria-hidden="true" class="grid gap-3" data-slot="project-mcp-loading">
            <Skeleton class="h-12 w-full" />
            <Skeleton class="h-12 w-full" />
          </div>

          <template v-else-if="list">
            <div v-if="servers.length === 0" class="flex flex-wrap items-center gap-x-3 gap-y-1">
              <p :data-testid="testIds.projectMcpEmpty" class="text-sm text-muted-foreground">
                This project has no .mcp.json.
              </p>
              <Button type="button" variant="outline" size="sm" data-action="edit-mcp-json" class="pointer-coarse:h-10" @click="editMcpJson">
                <FileJsonIcon aria-hidden="true" data-icon="inline-start" />
                Edit .mcp.json…
              </Button>
            </div>

            <div v-else class="grid min-w-0 divide-y" role="list" aria-label="Servers">
              <div v-for="server in servers" :key="server.id" role="listitem" class="min-w-0">
                <ProjectMcpServerRow
                  :server="server"
                  :trust="trustOf(server)"
                  :expanded="expanded.has(server.id)"
                  :busy="reconnecting === server.id"
                  @toggle="toggleRow(server.id)"
                  @reconnect="reconnect(server)"
                  @review="openReview(server)"
                />
              </div>
            </div>

            <section
              v-if="variables.length > 0"
              :data-testid="testIds.projectMcpVariables"
              :data-count="variables.length"
              class="grid min-w-0 gap-3 border-t pt-3"
            >
              <button
                type="button"
                :aria-expanded="variablesOpen ? 'true' : 'false'"
                :aria-controls="variablesOpen ? ids.variables : undefined"
                class="-ml-1.5 flex min-h-8 items-center gap-1.5 justify-self-start rounded-md px-1.5 text-sm font-medium outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:min-h-10"
                @click="variablesOpen = !variablesOpen"
              >
                <ChevronRightIcon aria-hidden="true" :class="cn('size-3.5 text-muted-foreground transition-transform', variablesOpen && 'rotate-90')" />
                Variables · {{ variables.length }}
              </button>

              <div v-if="variablesOpen" :id="ids.variables" class="grid min-w-0 gap-3">
                <div
                  v-for="variable in variables"
                  :key="variable.name"
                  :data-testid="testIds.projectMcpVariable"
                  :data-name="variable.name"
                  :data-state="shownState(variable)"
                  class="grid min-w-0 items-center gap-x-3 gap-y-1.5 sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)_auto]"
                >
                  <div class="flex min-w-0 flex-wrap items-baseline gap-x-2">
                    <span class="flex min-w-0 items-center gap-1 font-mono text-[13px]">
                      <VariableIcon aria-hidden="true" class="size-3.5 shrink-0 self-center text-muted-foreground" />
                      <span class="min-w-0 break-all"><span aria-hidden="true">$</span>{{ variable.name }}</span>
                    </span>
                    <span v-if="variable.usedBy.length > 0" class="min-w-0 truncate text-xs text-muted-foreground">
                      {{ variable.usedBy.join(', ') }}
                    </span>
                  </div>
                  <Input
                    :model-value="drafts[variable.name] ?? ''"
                    type="password"
                    :maxlength="LIMITS.projectMcpVariableValueMaxChars"
                    :disabled="saving"
                    :aria-label="`${variable.name} value`"
                    :aria-describedby="ids.note"
                    :placeholder="variablePlaceholder(variable, cleared.has(variable.name))"
                    data-field="variable-value"
                    autocomplete="off"
                    autocapitalize="off"
                    spellcheck="false"
                    data-1p-ignore
                    data-lpignore="true"
                    class="min-w-0 font-mono text-[13px] placeholder:font-sans placeholder:text-sm pointer-coarse:h-10"
                    @update:model-value="value => setDraft(variable.name, value)"
                  />
                  <Button
                    v-if="variable.set"
                    type="button"
                    variant="ghost"
                    size="sm"
                    :disabled="saving"
                    :aria-pressed="cleared.has(variable.name) ? 'true' : 'false'"
                    :aria-label="`Clear ${variable.name}`"
                    data-action="clear-variable"
                    class="justify-self-start pointer-coarse:h-10"
                    @click="toggleCleared(variable.name)"
                  >
                    Clear
                  </Button>
                  <span v-else aria-hidden="true" class="hidden sm:block" />
                </div>

                <p :id="ids.note" class="text-xs text-muted-foreground">
                  Values are encrypted on this server and used only for this project's servers. harness-forge never reads
                  them from the server's environment.
                </p>
                <div class="flex justify-end">
                  <Button
                    type="button"
                    :aria-disabled="!dirty || saving ? 'true' : undefined"
                    :aria-busy="saving || undefined"
                    :data-testid="testIds.projectMcpVariablesSave"
                    :class="cn('pointer-coarse:h-10', (!dirty || saving) && 'cursor-not-allowed opacity-50')"
                    @click="saveVariables"
                  >
                    <Spinner v-if="saving && !freshAuth.open.value" data-icon="inline-start" />
                    Save variables
                  </Button>
                </div>
              </div>
            </section>
          </template>
        </div>

        <div class="flex shrink-0 items-center justify-end gap-2 border-t bg-popover px-4 py-3 sm:px-6">
          <Button
            v-if="list && servers.length > 0"
            type="button"
            variant="ghost"
            data-action="edit-mcp-json"
            class="mr-auto pointer-coarse:h-10"
            @click="editMcpJson"
          >
            <FileJsonIcon aria-hidden="true" data-icon="inline-start" />
            Edit .mcp.json…
          </Button>
          <Button
            type="button"
            variant="outline"
            data-action="close"
            class="pointer-coarse:h-10"
            @click="onOpenChange(false)"
          >
            Close
          </Button>
        </div>
      </div>
    </DialogContent>
  </Dialog>

  <ProjectTrustDialog
    v-model:open="review.open"
    :project-id="projectId"
    :focus-key="review.focusKey"
  />

  <ProjectFileEditor
    v-model:open="fileOpen"
    :project-id="projectId"
    :entry="fileTarget"
    @saved="onFileSaved"
    @review="onFileReview"
  />

  <ConfirmPasswordDialog
    :open="freshAuth.open.value"
    description="Saving the variables of this project's MCP servers needs your password."
    :pending="freshAuth.pending.value"
    :error="freshAuth.error.value"
    @update:open="freshAuth.setOpen"
    @submit="freshAuth.submit"
  />
</template>
