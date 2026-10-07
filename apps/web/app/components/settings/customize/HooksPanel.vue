<script setup lang="ts">
// The Customize Hooks tab (Phase 11, ADR-048; docs/UI.md 2.18, 9.13, 10.8, 14, 15): the "Run hooks" switch
// (`hooks-enabled`, the setting `hooksEnabled`, optimistic, no password) with its help, which the server-switch alert
// replaces (`hooks-disabled`, `data-reason` safe-mode | shell-off; safe mode first); a HookSection per source from
// `useHooksStore().fetch(projectId)` (on mount, on every project change and quietly when the store marks the scope
// stale): Personal (editable), In {project} (the settings files read, "Review {n}…" → ProjectTrustDialog, the file
// problems as a warning Alert, an unavailable folder as an Alert instead of the rows) and From plugins (hidden when
// empty). Row actions: Edit… / Duplicate / Copy to personal (HookEditor in edit / new / copy mode), Turn off (no password,
// optimistic) / Turn on (fresh auth: "Saving a hook needs your password."), Copy as JSON (toast "Copied hook as JSON"),
// Delete… ("Delete this hook?", toast "Deleted hook", focus to the next row's menu, else the previous one, else New
// hook), Review… (the trust dialog focused on the item) and Open plugin. CustomizeSettings renders it for `?tab=hooks`;
// the page header's New hook / Import… reach it through the exposed `create()` / `import()`.
// Props, exposes and the root test id are frozen from Gate P11-0b (C39 stub); implementation W11.8.
// Phase 12 (ADR-056, ADR-057; C46, W12.12): with a project selected, project rows whose position is known offer Edit…
// (`HOOK_ROW_CONTEXT`: HookEditor in project mode, `target` = the settings file, the event and the handler's position) and
// Delete… ("Delete this hook?" / "It's removed from {path}." → `hooks.saveProjectHook(projectId, target, null)`, no
// password; a 409 `stale` toasts "{file} changed on disk after you opened it." and refetches); New hook offers Where
// (Personal or the project's settings files) while the project folder is available; Review plugin… of an untrusted
// plugin's hook opens the plugin's TrustDialog; the project section's file problems list `unknown-event` and
// `unsupported-type` too (`hookFileNotice`). `workspace.changed` (a settings file written by the agent or saved from
// the UI) reaches the hooks store while the panel is shown (it marks the project's scope stale).
import type { HookEntry, PersonalHook } from '@harness-forge/shared'
import type { HookAction, HookDraft, ProjectHookTarget } from './hooks'
import { FileUpIcon, InfoIcon, PlusIcon, TriangleAlertIcon } from '@lucide/vue'
import { computed, nextTick, onMounted, provide, ref, shallowRef, useId, useTemplateRef, watch } from 'vue'
import { toast } from 'vue-sonner'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { copyText } from '~/components/common/clipboard'
import ConfirmDialog from '~/components/common/ConfirmDialog.vue'
import ConfirmPasswordDialog from '~/components/common/ConfirmPasswordDialog.vue'
import TrustDialog from '~/components/plugins/install/TrustDialog.vue'
import ProjectTrustDialog from '~/components/projects/trust/ProjectTrustDialog.vue'
import { isFreshAuthCancelled, useFreshAuth } from '~/composables/useFreshAuth'
import { useServerEvents } from '~/composables/useServerEvents'
import { hookScopeKey, useHooksStore } from '~/stores/hooks'
import { usePluginsStore } from '~/stores/plugins'
import { useSettingsStore } from '~/stores/settings'
import { hasErrorCode, toHarnessError } from '~/utils/errors'
import { testIds } from '~/utils/testids'
import { toastError } from '../notify'
import { useRouter } from '../nuxt-imports'
import SettingsLoadError from '../SettingsLoadError.vue'
import { HOOK_ROW_CONTEXT } from './customize-context'
import HookEditor from './HookEditor.vue'
import HookImportDialog from './HookImportDialog.vue'
import { draftFromHook, HOOK_COPY, hookDeleteCopy, hookFileNotice, hookJson, staleFileText } from './hooks'
import HookSection from './HookSection.vue'

const props = defineProps<{ projectId: string | null, projectName: string | null }>()

const hooks = useHooksStore()
const settings = useSettingsStore()
const plugins = usePluginsStore()
const router = useRouter()
const freshAuth = useFreshAuth()
const root = useTemplateRef<HTMLElement>('root')
const ids = { enabled: useId(), help: useId() }

// ---------- the listing ----------

const scope = computed(() => hookScopeKey(props.projectId))
const list = computed(() => hooks.list(props.projectId))
const entries = computed(() => list.value?.items ?? [])
const personalEntries = computed(() => entries.value.filter(entry => entry.source === 'personal'))
const projectEntries = computed(() => entries.value.filter(entry => entry.source === 'project'))
const pluginEntries = computed(() => entries.value.filter(entry => entry.source === 'plugin'))
const project = computed(() => (props.projectId ? list.value?.project ?? null : null))

/** The server-switch alert: safe mode first, then `HF_WORKSPACE_SHELL=0`. */
const disabledReason = computed<'safe-mode' | 'shell-off' | null>(() => {
  const switches = list.value?.switches
  if (!switches)
    return null
  if (switches.safeMode)
    return 'safe-mode'
  return switches.shell ? null : 'shell-off'
})

const projectIssue = computed(() => {
  const scan = project.value
  if (!scan || scan.available)
    return null
  const issue = scan.issue?.trim()
  if (!issue)
    return 'The project folder is unavailable.'
  if (/^the project folder is unavailable/i.test(issue))
    return issue
  const lead = issue.length > 1 && issue[1] === issue[1]!.toLowerCase() ? issue[0]!.toLowerCase() + issue.slice(1) : issue
  return `The project folder is unavailable: ${lead}`
})

/**
 * Problems of the settings files ("{file}: {message}"; + Phase 12: unknown events and unsupported handler types too);
 * ignored fields stay quiet.
 */
const fileNotices = computed(() => (list.value?.diagnostics ?? [])
  .map(diagnostic => hookFileNotice(diagnostic))
  .filter((notice): notice is string => notice !== null))

const loading = ref(false)
const loadError = shallowRef<unknown>(null)
let loadSeq = 0

async function load(): Promise<void> {
  const projectId = props.projectId
  const seq = ++loadSeq
  loading.value = true
  loadError.value = null
  try {
    await hooks.fetch(projectId)
  }
  catch (error) {
    // A deleted project: the page drops it from the query and shows the global scope.
    if (seq === loadSeq && !(projectId !== null && hasErrorCode(error, 'not_found')))
      loadError.value = error
  }
  finally {
    if (seq === loadSeq)
      loading.value = false
  }
}

watch(() => props.projectId, () => void load(), { immediate: true })

// A mutation or an event marked the shown scope stale: refetch it quietly.
watch(() => hooks.stale[scope.value], (isStale) => {
  if (isStale)
    hooks.fetch(props.projectId).catch(() => {})
})

// + Phase 12: a settings file written on disk (by the agent, a project file editor or this tab) makes the project's rows
// stale; the event stream sends `workspace.changed` only to the workspace store, so the panel forwards it.
useServerEvents().on('workspace.changed', event => hooks.applyEvent(event))

onMounted(() => {
  if (!settings.loaded)
    settings.fetch().catch(() => {})
  if (!plugins.loaded)
    plugins.fetchAll().catch(() => {})
})

function refresh(): void {
  hooks.fetch(props.projectId).catch(() => {})
}

// ---------- Run hooks ----------

const runHooks = computed(() => settings.resolved.hooksEnabled)

async function onRunHooks(value: boolean | 'indeterminate'): Promise<void> {
  if (typeof value !== 'boolean' || value === runHooks.value)
    return
  try {
    await settings.update({ hooksEnabled: value })
  }
  catch (error) {
    toastError(error)
  }
}

// ---------- focus helpers ----------

function rowMenu(id: string): HTMLElement | null {
  return root.value?.querySelector<HTMLElement>(`[data-testid="${testIds.hookRow}"][data-hook-id="${CSS.escape(id)}"] [data-testid="${testIds.hookRowMenu}"]`) ?? null
}

function focusNew(): void {
  document.querySelector<HTMLElement>(`[data-testid="${testIds.customizeNew}"]`)?.focus()
}

/** The personal row whose menu takes focus after `id` is gone: the next row, else the previous one. */
function neighborOf(id: string): string | null {
  const row = root.value?.querySelector(`[data-testid="${testIds.hookRow}"][data-hook-id="${CSS.escape(id)}"]`)
  const next = row?.nextElementSibling ?? row?.previousElementSibling
  return next instanceof HTMLElement ? next.dataset.hookId ?? null : null
}

// ---------- the editor and the import ----------

const editorOpen = ref(false)
const editorMode = ref<'new' | 'edit' | 'copy' | 'project'>('new')
const editorHook = shallowRef<PersonalHook | null>(null)
const editorDraft = shallowRef<HookDraft | null>(null)
const editorTarget = shallowRef<ProjectHookTarget | null>(null)
const importOpen = ref(false)

function openEditor(mode: 'new' | 'edit' | 'copy' | 'project', options: { hook?: PersonalHook | null, draft?: HookDraft | null, target?: ProjectHookTarget | null } = {}): void {
  editorMode.value = mode
  editorHook.value = options.hook ?? null
  editorDraft.value = options.draft ?? null
  editorTarget.value = options.target ?? null
  editorOpen.value = true
}

// + Phase 12: project command rows can be edited while a project is selected.
provide(HOOK_ROW_CONTEXT, { editProjectHooks: computed(() => props.projectId !== null) })

/** + Phase 12: the plugin whose trust Review plugin… reviews (TrustDialog). */
const trustPluginId = ref<string | null>(null)

function create(): void {
  // + Phase 12: with an available project folder, Where offers the project's settings files (the editor reads only the
  // project id of this target).
  const scan = project.value
  const target: ProjectHookTarget | null = props.projectId && scan?.available
    ? { projectId: props.projectId, path: '', event: 'PreToolUse', groupIndex: null, handlerIndex: null }
    : null
  openEditor('new', { target })
}

function importHooks(): void {
  importOpen.value = true
}

/** The personal hook of a row (there is no `GET /hooks/:id`: the editor reads the listing's entry). */
function hookOf(entry: HookEntry): PersonalHook | null {
  if (entry.kind !== 'command' || entry.source !== 'personal' || !entry.id)
    return null
  const base = {
    id: entry.id,
    event: entry.event,
    matcher: entry.matcher,
    timeout: entry.timeout,
    enabled: entry.state !== 'off',
    createdAt: 0,
    updatedAt: 0,
    ...(entry.statusMessage === undefined ? {} : { statusMessage: entry.statusMessage }),
    ...(entry.if === undefined ? {} : { if: entry.if }),
  }
  // Phase 12 (ADR-057): a prompt hook is listed with its prompt, model and continueOnBlock; a command hook with its
  // exec-form arguments and `async`.
  if (entry.type === 'prompt')
    return { ...base, type: 'prompt', prompt: entry.prompt ?? '', model: entry.model ?? null, ...(entry.continueOnBlock === undefined ? {} : { continueOnBlock: entry.continueOnBlock }) }
  return { ...base, type: 'command', command: entry.command, ...(entry.args === undefined ? {} : { args: entry.args }), ...(entry.async === undefined ? {} : { async: entry.async }) }
}

/** + Phase 12: where a project row's handler is in its settings file (null without a known position). */
function projectTargetOf(entry: HookEntry): ProjectHookTarget | null {
  if (!props.projectId || entry.source !== 'project' || entry.kind !== 'command' || !entry.path || !entry.position)
    return null
  return { projectId: props.projectId, path: entry.path, event: entry.event, groupIndex: entry.position[0], handlerIndex: entry.position[1] }
}

// ---------- row actions ----------

const busyIds = ref<string[]>([])

function setBusy(id: string, busy: boolean): void {
  busyIds.value = busy ? [...new Set([...busyIds.value, id])] : busyIds.value.filter(entry => entry !== id)
}

async function toggle(entry: HookEntry): Promise<void> {
  if (!entry.id || busyIds.value.includes(entry.id))
    return
  const id = entry.id
  setBusy(id, true)
  try {
    if (entry.state === 'off')
      await freshAuth.run(() => hooks.update(id, { enabled: true }), { required: true })
    else
      await hooks.update(id, { enabled: false })
  }
  catch (error) {
    if (!isFreshAuthCancelled(error))
      toastError(error)
  }
  finally {
    setBusy(id, false)
  }
}

async function copyJson(entry: HookEntry): Promise<void> {
  if (await copyText(hookJson([entry])))
    toast.success(HOOK_COPY.copied!)
}

const deleteOpen = ref(false)
const deleteTarget = shallowRef<HookEntry | null>(null)
const deleting = ref(false)
const deleteTexts = computed(() => (deleteTarget.value ? hookDeleteCopy(deleteTarget.value) : null))

function onDeleteOpenChange(value: boolean): void {
  if (!value && deleting.value)
    return
  deleteOpen.value = value
}

/** + Phase 12: removes a project row's handler from its settings file (no password; saving never approves). */
async function deleteProjectHook(target: ProjectHookTarget): Promise<void> {
  deleting.value = true
  try {
    await hooks.saveProjectHook(target.projectId, target, null)
    deleteOpen.value = false
    toast.success(HOOK_COPY.deleted!)
    await hooks.fetch(props.projectId).catch(() => {})
    await nextTick()
    focusNew()
  }
  catch (error) {
    deleteOpen.value = false
    const failure = toHarnessError(error)
    if (failure.code === 'conflict' && (failure.details as { reason?: unknown } | undefined)?.reason === 'stale') {
      toast.error(staleFileText(target.path))
      refresh()
    }
    else {
      toastError(error)
    }
  }
  finally {
    deleting.value = false
  }
}

async function confirmDelete(): Promise<void> {
  const entry = deleteTarget.value
  if (!entry || deleting.value)
    return
  const projectTarget = entry.source === 'project' ? projectTargetOf(entry) : null
  if (projectTarget) {
    await deleteProjectHook(projectTarget)
    return
  }
  if (!entry.id)
    return
  const id = entry.id
  deleting.value = true
  setBusy(id, true)
  const neighbor = neighborOf(id)
  try {
    await hooks.remove(id)
    await hooks.fetch(props.projectId).catch(() => {})
    deleteOpen.value = false
    toast.success(HOOK_COPY.deleted!)
    await nextTick()
    const trigger = neighbor ? rowMenu(neighbor) : null
    if (trigger)
      trigger.focus()
    else
      focusNew()
  }
  catch (error) {
    deleteOpen.value = false
    toastError(error)
  }
  finally {
    deleting.value = false
    setBusy(id, false)
  }
}

// ---------- project trust (ADR-049) ----------

const trustOpen = ref(false)
const trustFocus = ref<string | null>(null)

function openTrust(focusKey: string | null): void {
  trustFocus.value = focusKey
  trustOpen.value = true
}

function onTrustOpenChange(value: boolean): void {
  trustOpen.value = value
  if (!value)
    refresh()
}

// ---------- dispatch ----------

function onAction(action: HookAction, entry: HookEntry): void {
  switch (action) {
    case 'edit': {
      if (entry.source === 'project') {
        const target = projectTargetOf(entry)
        if (target)
          openEditor('project', { draft: draftFromHook(entry), target })
        break
      }
      const hook = hookOf(entry)
      if (hook)
        openEditor('edit', { hook })
      break
    }
    case 'trust-plugin':
      if (entry.pluginId)
        trustPluginId.value = entry.pluginId
      break
    case 'duplicate':
      openEditor(entry.source === 'personal' ? 'new' : 'copy', { draft: draftFromHook(entry) })
      break
    case 'toggle':
      void toggle(entry)
      break
    case 'copy-json':
      void copyJson(entry)
      break
    case 'delete':
      if (entry.id || projectTargetOf(entry)) {
        deleteTarget.value = entry
        deleteOpen.value = true
      }
      break
    case 'review':
      openTrust(entry.kind === 'command' ? entry.sha256 ?? null : null)
      break
    case 'open-plugin':
      if (entry.pluginId)
        router.push(`/plugins/${encodeURIComponent(entry.pluginId)}`).catch(() => {})
      break
  }
}

defineExpose<{ create: () => void, import: () => void }>({ create, import: importHooks })
</script>

<template>
  <div ref="root" :data-testid="testIds.hooksPanel" class="flex min-w-0 flex-col">
    <div class="flex min-w-0 items-start justify-between gap-4 rounded-lg border px-3 py-3">
      <div class="flex min-w-0 flex-1 flex-col gap-1.5">
        <Label :for="ids.enabled" class="text-sm font-medium">{{ HOOK_COPY.runHooks }}</Label>
        <Alert
          v-if="disabledReason"
          :id="ids.help"
          :data-testid="testIds.hooksDisabled"
          :data-reason="disabledReason"
          class="border-info/40 bg-info/5 dark:bg-info/10 *:[svg]:text-info"
        >
          <InfoIcon aria-hidden="true" />
          <AlertDescription class="text-foreground">
            {{ disabledReason === 'safe-mode' ? HOOK_COPY.safeMode : HOOK_COPY.shellOff }}
          </AlertDescription>
        </Alert>
        <p v-else :id="ids.help" class="text-sm text-muted-foreground">
          {{ HOOK_COPY.runHooksHelp }}
        </p>
      </div>
      <Switch
        :id="ids.enabled"
        :model-value="runHooks"
        :aria-describedby="ids.help"
        :data-testid="testIds.hooksEnabled"
        class="mt-0.5 pointer-coarse:after:-inset-y-3"
        @update:model-value="onRunHooks"
      />
    </div>

    <SettingsLoadError
      v-if="loadError"
      :error="loadError"
      title="Could not load your hooks"
      :pending="loading"
      class="mt-3"
      @retry="load"
    />

    <div v-if="!list && !loadError" aria-busy="true" class="flex flex-col gap-6 py-3">
      <span class="sr-only">Loading your hooks…</span>
      <div v-for="n in 2" :key="n" class="flex flex-col gap-2">
        <Skeleton class="h-4 w-32" />
        <Skeleton v-for="row in 2" :key="row" class="h-12 rounded-lg" />
      </div>
    </div>
    <template v-else-if="list">
      <HookSection
        source="personal"
        :entries="personalEntries"
        :busy-ids="busyIds"
        @action="onAction"
      >
        <template #empty-actions>
          <Button type="button" size="sm" data-action="new" class="pointer-coarse:h-10" @click="create">
            <PlusIcon aria-hidden="true" data-icon="inline-start" />
            New hook
          </Button>
          <Button type="button" size="sm" variant="outline" data-action="import" class="pointer-coarse:h-10" @click="importHooks">
            <FileUpIcon aria-hidden="true" data-icon="inline-start" />
            Import…
          </Button>
        </template>
      </HookSection>
      <HookSection
        v-if="projectId"
        source="project"
        :entries="projectEntries"
        :project-name="projectName"
        :files="project?.files"
        :pending="project?.pending ?? null"
        :issue="projectIssue"
        @action="onAction"
        @review="openTrust(null)"
      >
        <template v-if="fileNotices.length > 0 && !projectIssue" #notices>
          <Alert class="border-warning/40 bg-warning/5 dark:bg-warning/10 *:[svg]:text-warning">
            <TriangleAlertIcon aria-hidden="true" />
            <AlertDescription class="text-foreground">
              <ul class="flex flex-col gap-0.5">
                <li v-for="(notice, index) in fileNotices" :key="index">
                  {{ notice }}
                </li>
              </ul>
            </AlertDescription>
          </Alert>
        </template>
      </HookSection>
      <HookSection
        v-if="pluginEntries.length > 0"
        source="plugin"
        :entries="pluginEntries"
        @action="onAction"
      />
    </template>

    <HookEditor
      v-model:open="editorOpen"
      :mode="editorMode"
      :hook="editorHook"
      :draft="editorDraft"
      :target="editorTarget"
      @saved="refresh"
    />
    <TrustDialog
      v-if="trustPluginId"
      :open="trustPluginId !== null"
      :plugin-id="trustPluginId"
      @update:open="value => { if (!value) trustPluginId = null }"
      @trusted="refresh"
    />
    <HookImportDialog v-model:open="importOpen" @imported="refresh" />
    <ProjectTrustDialog :open="trustOpen" :project-id="projectId" :focus-key="trustFocus" @update:open="onTrustOpenChange" />
    <ConfirmDialog
      :open="deleteOpen"
      :title="deleteTexts?.title ?? 'Delete this hook?'"
      :description="deleteTexts?.description"
      :confirm-label="deleteTexts?.confirm ?? 'Delete hook'"
      :pending="deleting"
      :data-testid="testIds.hookDeleteConfirm"
      @update:open="onDeleteOpenChange"
      @confirm="confirmDelete"
    />
    <ConfirmPasswordDialog
      :open="freshAuth.open.value"
      :description="HOOK_COPY.passwordPrompt"
      :pending="freshAuth.pending.value"
      :error="freshAuth.error.value"
      @update:open="freshAuth.setOpen"
      @submit="freshAuth.submit"
    />
  </div>
</template>
