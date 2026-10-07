<script setup lang="ts">
// The project trust review (Phase 11, ADR-049; docs/UI.md 2.18, 7.33, 8.4, 10.8, 14, 15): a form dialog "Review
// {project}" (`sm:max-w-3xl`, full width minus 1rem at 390px, `max-h-[90dvh]`; the body scrolls under the header, the
// footer stays visible) with the intro, the warning (`project-trust-warning`), the orphaned note, the filter Needs review
// · {n} / All · {n} (`project-trust-filter`; it opens on Needs review when anything is pending, else on All), the groups
// Hooks · MCP servers · Commands with shell lines (`project-trust-group`, `role="group"` named by its heading, with
// "Select all {n}" above the items it selects, for the group's pending items in the current filter), one
// ProjectTrustItem per item, Revoke (no fresh auth; focus moves to the item's checkbox), and "Approve {n} items"
// (`project-trust-approve`) → `useFreshAuth().run(…, { required: true })` ("Approving project commands needs your
// password."). There is no "Approve all": items are approved only after they were selected one by one or per group.
// Approve is never the dialog's default button and Enter never approves (it is not a submit button, and Enter on it is
// ignored; Space and clicks work). A 409 `stale` refetches the list (the store) and shows the alert "{n} items changed
// while you were reviewing. Check them again." (`project-trust-error`, `role="alert"`, focused); changed items lose their
// selection. `project-trust.changed` refetches the open list quietly (the store) and the selection keeps the items that
// are still pending. The dialog opens on `focusKey`'s item (a TrustItem.sha256), else on the first pending item's
// checkbox, else on the filter; closing (or Esc) never approves and returns focus to the opener.
// Data from `useProjectTrustStore()` (a fresh scan on every open) and the variables of MCP items from
// `useProjectMcpStore()`. Mounted by ChatView, Settings -> Projects, the Customize Hooks tab and ProjectMcpDialog.
// Props, emits and the root test id are frozen from Gate P11-0b (C39); W11.9.
// Phase 12 (docs/UI.md 7.34; W12.13): a group's "Select all {n}" is mixed while some but not all of its pending items in
// the filter are selected (`selectAllState`): it draws its own `Minus` through the frozen Checkbox's default slot (reka
// sets `aria-checked="mixed"` and `data-state="indeterminate"`), filled like a checked box; a click on a mixed box
// selects every pending item of the group, a second click clears them. W12.19: the fill names the dark variant too
// (`dark:data-[state=indeterminate]:bg-primary`, like the Checkbox's own `dark:data-checked:bg-primary`), else the
// Checkbox's `dark:bg-input/30` wins in the dark theme and the mixed box looks empty.
import type { ProjectTrustList, TrustItem, TrustItemKind } from '@harness-forge/shared'
import { LIMITS } from '@harness-forge/shared'
import { CheckIcon, CircleAlertIcon, MinusIcon, ShieldAlertIcon } from '@lucide/vue'
import { computed, nextTick, ref, shallowRef, useId, useTemplateRef, watch } from 'vue'
import { toast } from 'vue-sonner'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import ConfirmPasswordDialog from '~/components/common/ConfirmPasswordDialog.vue'
import { isFreshAuthCancelled, useFreshAuth } from '~/composables/useFreshAuth'
import { useProjectMcpStore } from '~/stores/project-mcp'
import { isStaleTrustError, useProjectTrustStore } from '~/stores/project-trust'
import { useProjectsStore } from '~/stores/projects'
import { toHarnessError } from '~/utils/errors'
import { testIds } from '~/utils/testids'
import {
  approvalBatches,
  approvalsOf,
  approvedText,
  approveLabel,
  changedCount,
  keepSelection,
  orphanedText,
  pendingItems,
  revokedText,
  selectAllState,
  selectedText,
  showOrphaned,
  staleText,
  TRUST_GROUP_LABELS,
  trustGroups,
} from './project-trust'
import ProjectTrustItem from './ProjectTrustItem.vue'

type Filter = 'pending' | 'all'

const props = defineProps<{ open: boolean, projectId: string | null, focusKey?: string | null }>()

const emit = defineEmits<{ 'update:open': [open: boolean] }>()

/** How long the variables of the project's MCP servers stay fresh enough for the item details. */
const MCP_MAX_AGE_MS = 30_000

const trust = useProjectTrustStore()
const mcp = useProjectMcpStore()
const projects = useProjectsStore()
const freshAuth = useFreshAuth()
const baseId = useId()
const root = useTemplateRef<HTMLElement>('root')

const filter = ref<Filter>('all')
const selected = shallowRef<Set<string>>(new Set())
const loading = ref(false)
const loadError = shallowRef<{ code: string, message: string } | null>(null)
const actionError = shallowRef<{ code: string, message: string } | null>(null)
const approving = ref(false)
const revoking = ref<string | null>(null)

// Bumped on every open and close, so an answer that outlives its dialog session cannot touch the next one.
let session = 0

const projectName = computed(() => (props.projectId ? projects.byId(props.projectId)?.name ?? 'this project' : 'this project'))
const list = computed<ProjectTrustList | null>(() => (props.projectId ? trust.trust(props.projectId) : null))
const pendingCount = computed(() => pendingItems(list.value).length)
const allCount = computed(() => list.value?.items.length ?? 0)
const groups = computed(() => (list.value ? trustGroups(list.value, filter.value) : []))
const approvals = computed(() => approvalsOf(selected.value, list.value))
const variables = computed(() => (props.projectId && mcp.byProject[props.projectId] ? mcp.variables(props.projectId) : undefined))
const hasMcpItems = computed(() => list.value?.items.some(item => item.kind === 'mcp') ?? false)
const busy = computed(() => approving.value || revoking.value !== null)
const error = computed(() => actionError.value ?? (list.value ? null : loadError.value))

function headingId(kind: TrustItemKind): string {
  return `${baseId}-${kind}`
}

/** The group's pending items (the ones "Select all" selects). */
function selectable(items: readonly TrustItem[]): TrustItem[] {
  return items.filter(item => item.state === 'pending')
}

function setSelected(next: Set<string>): void {
  selected.value = next
}

function toggle(item: TrustItem): void {
  const next = new Set(selected.value)
  if (next.has(item.sha256))
    next.delete(item.sha256)
  else
    next.add(item.sha256)
  setSelected(next)
}

function selectAll(items: readonly TrustItem[], value: boolean | 'indeterminate'): void {
  const next = new Set(selected.value)
  for (const item of selectable(items)) {
    if (value === true)
      next.add(item.sha256)
    else
      next.delete(item.sha256)
  }
  setSelected(next)
}

function onFilter(value: unknown): void {
  // A single ToggleGroup emits an empty value when the active item is clicked again: keep the filter.
  if (value === 'pending' || value === 'all')
    filter.value = value
}

// ---------- focus ----------

function itemElement(sha256: string): HTMLElement | null {
  const items = root.value?.querySelectorAll<HTMLElement>(`[data-testid="${testIds.projectTrustItem}"]`) ?? []
  return [...items].find(element => element.dataset.key === sha256) ?? null
}

function focusItem(sha256: string): boolean {
  const element = itemElement(sha256)
  const target = element?.querySelector<HTMLElement>(`[data-testid="${testIds.projectTrustSelect}"], [data-testid="${testIds.projectTrustRevoke}"]`)
  if (!target)
    return false
  target.focus()
  target.scrollIntoView?.({ block: 'nearest' })
  return true
}

function focusFilter(): boolean {
  const group = root.value?.querySelector<HTMLElement>(`[data-testid="${testIds.projectTrustFilter}"]`)
  const target = group?.querySelector<HTMLElement>('[data-state="on"]') ?? group?.querySelector<HTMLElement>('button')
  target?.focus()
  return !!target
}

function focusClose(): void {
  root.value?.querySelector<HTMLElement>('[data-action="close"]')?.focus()
}

/** The focus key's item, else the first pending item's checkbox, else the filter, else Close. */
function focusInitial(): void {
  if (props.focusKey && focusItem(props.focusKey))
    return
  const first = root.value?.querySelector<HTMLElement>(`[data-testid="${testIds.projectTrustSelect}"]`)
  if (first) {
    first.focus()
    return
  }
  if (!focusFilter())
    focusClose()
}

/** After an approval: the first pending item's checkbox, else the filter (Approve turns disabled). */
function focusAfterApprove(): void {
  const first = root.value?.querySelector<HTMLElement>(`[data-testid="${testIds.projectTrustSelect}"]`)
  if (first)
    first.focus()
  else if (!focusFilter())
    focusClose()
}

async function focusError(): Promise<void> {
  await nextTick()
  root.value?.querySelector<HTMLElement>(`[data-testid="${testIds.projectTrustError}"]`)?.focus()
}

// ---------- loading ----------

/** Needs review when anything is pending, else All; the focused item's filter when it would be hidden. */
function chooseFilter(current: ProjectTrustList | null): void {
  const focused = props.focusKey ? current?.items.find(item => item.sha256 === props.focusKey) : undefined
  if (focused)
    filter.value = focused.state === 'pending' ? 'pending' : 'all'
  else
    filter.value = pendingItems(current).length > 0 ? 'pending' : 'all'
}

async function start(projectId: string): Promise<void> {
  const current = ++session
  setSelected(new Set())
  actionError.value = null
  loadError.value = null
  const cached = trust.trust(projectId)
  chooseFilter(cached)
  loading.value = cached === null
  try {
    const fresh = await trust.fetch(projectId)
    if (current !== session)
      return
    if (cached === null)
      chooseFilter(trust.trust(projectId) ?? fresh)
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
    // Focus waited on Close while the list loaded: move it to the first item now, unless the user moved it.
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
  }
}, { immediate: true })

// The variables of MCP items ("Variables: {name} (set)"): fetched quietly once the list shows MCP servers.
watch([() => props.open, () => props.projectId, hasMcpItems], ([open, projectId, has]) => {
  if (open && projectId && has)
    void mcp.fetch(projectId, { maxAgeMs: MCP_MAX_AGE_MS }).catch(() => {})
}, { immediate: true })

// A refetch (an event, an approval, a revoke) keeps the selection of the items that are still pending.
watch(list, (current) => {
  const kept = keepSelection(selected.value, current)
  if (kept.size !== selected.value.size)
    setSelected(kept)
})

// ---------- actions ----------

async function approve(): Promise<void> {
  const projectId = props.projectId
  const items = approvals.value
  if (!projectId || items.length === 0 || busy.value)
    return
  const current = session
  const reviewed = new Set(selected.value)
  const name = projectName.value
  approving.value = true
  actionError.value = null
  try {
    await freshAuth.run(async () => {
      for (const batch of approvalBatches(items, LIMITS.trustApproveItemsMax))
        await trust.approve(projectId, batch)
    }, { required: true })
    toast.success(approvedText(items.length, name))
    if (current !== session)
      return
    setSelected(new Set())
    // The controls are enabled again before focus moves (a disabled checkbox cannot take it).
    approving.value = false
    await nextTick()
    focusAfterApprove()
  }
  catch (failure) {
    if (isFreshAuthCancelled(failure) || current !== session)
      return
    if (isStaleTrustError(failure)) {
      // The store refetched the list: the changed items lose their selection.
      const changed = changedCount(reviewed, trust.trust(projectId))
      setSelected(keepSelection(reviewed, trust.trust(projectId)))
      actionError.value = { code: 'conflict', message: staleText(changed > 0 ? changed : items.length) }
    }
    else {
      const harnessError = toHarnessError(failure)
      actionError.value = { code: harnessError.code, message: harnessError.message }
    }
    approving.value = false
    await focusError()
  }
  finally {
    approving.value = false
  }
}

async function revoke(item: TrustItem): Promise<void> {
  const projectId = props.projectId
  if (!projectId || busy.value)
    return
  const current = session
  revoking.value = item.sha256
  actionError.value = null
  try {
    await trust.revoke(projectId, item.sha256)
    toast.success(revokedText(item.label))
    if (current !== session)
      return
    // The item is pending again: it shows in Needs review too, with its checkbox (enabled before it takes focus).
    revoking.value = null
    await nextTick()
    if (!focusItem(item.sha256))
      focusInitial()
  }
  catch (failure) {
    if (current !== session)
      return
    const harnessError = toHarnessError(failure)
    actionError.value = { code: harnessError.code, message: harnessError.message }
    revoking.value = null
    await focusError()
  }
  finally {
    revoking.value = null
  }
}

function retry(): void {
  if (props.projectId)
    void start(props.projectId)
}

function onApproveKeydown(event: KeyboardEvent): void {
  // Enter never approves (docs/UI.md 7.33, 14.1): Space and clicks do.
  if (event.key === 'Enter')
    event.preventDefault()
}

function onOpenAutoFocus(event: Event): void {
  event.preventDefault()
  void nextTick(() => {
    if (list.value)
      focusInitial()
    else
      focusClose()
  })
}

function onOpenChange(value: boolean): void {
  emit('update:open', value)
}
</script>

<template>
  <Dialog :open="open" @update:open="onOpenChange">
    <DialogContent
      :data-testid="testIds.projectTrustDialog"
      :aria-busy="loading || busy || undefined"
      class="flex max-h-[90dvh] max-w-[calc(100%-1rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl"
      @open-auto-focus="onOpenAutoFocus"
    >
      <div ref="root" class="flex min-h-0 flex-1 flex-col">
        <DialogHeader class="shrink-0 px-4 pt-5 pr-12 pb-3 sm:px-6 sm:pt-6">
          <DialogTitle class="break-words">
            Review {{ projectName }}
          </DialogTitle>
          <DialogDescription>
            Files in this project can run commands on your server. Nothing below runs until you approve it. Any change
            needs a new approval.
          </DialogDescription>
        </DialogHeader>

        <div class="grid min-h-0 flex-1 content-start gap-4 overflow-y-auto overscroll-contain px-4 pb-4 sm:px-6">
          <Alert
            role="note"
            :data-testid="testIds.projectTrustWarning"
            class="border-warning/40 bg-warning/5 dark:bg-warning/10 *:[svg]:text-warning"
          >
            <ShieldAlertIcon aria-hidden="true" />
            <AlertDescription class="text-foreground">
              Approve only what you would run yourself. These commands run with harness-forge's permissions: they can
              read files and keys on this server and make network requests.
            </AlertDescription>
          </Alert>

          <Alert
            v-if="error"
            variant="destructive"
            tabindex="-1"
            :data-testid="testIds.projectTrustError"
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

          <div v-if="loading && !list" aria-hidden="true" class="grid gap-3" data-slot="project-trust-loading">
            <Skeleton class="h-8 w-56" />
            <Skeleton class="h-24 w-full" />
            <Skeleton class="h-24 w-full" />
          </div>

          <template v-else-if="list">
            <p
              v-if="!list.available || list.items.length === 0"
              :data-testid="testIds.projectTrustEmpty"
              class="text-sm text-muted-foreground"
            >
              {{ !list.available && list.issue ? list.issue : 'This project has no hooks, MCP servers or commands that run shell commands.' }}
            </p>

            <template v-else>
              <p v-if="showOrphaned(list)" data-slot="project-trust-orphaned" class="text-sm text-muted-foreground">
                {{ orphanedText(list.orphaned) }}
              </p>

              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                :model-value="filter"
                :data-testid="testIds.projectTrustFilter"
                :data-value="filter"
                aria-label="Filter items"
                class="justify-self-start"
                @update:model-value="onFilter"
              >
                <ToggleGroupItem value="pending" data-value="pending" class="px-3 pointer-coarse:h-10">
                  Needs review · {{ pendingCount }}
                </ToggleGroupItem>
                <ToggleGroupItem value="all" data-value="all" class="px-3 pointer-coarse:h-10">
                  All · {{ allCount }}
                </ToggleGroupItem>
              </ToggleGroup>

              <p v-if="pendingCount === 0" data-slot="project-trust-done" class="text-sm text-muted-foreground">
                Everything in {{ projectName }} is approved.
              </p>

              <section
                v-for="group in groups"
                :key="group.kind"
                role="group"
                :aria-labelledby="headingId(group.kind)"
                :data-testid="testIds.projectTrustGroup"
                :data-kind="group.kind"
                :data-count="group.items.length"
                class="grid min-w-0 gap-1"
              >
                <div class="flex min-h-8 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b pb-1">
                  <h3 :id="headingId(group.kind)" class="text-sm font-medium">
                    {{ TRUST_GROUP_LABELS[group.kind] }} · {{ group.items.length }}
                  </h3>
                  <div v-if="selectable(group.items).length > 0" class="flex items-center gap-2">
                    <Checkbox
                      :id="`${headingId(group.kind)}-all`"
                      :model-value="selectAllState(group.items, selected)"
                      :disabled="busy"
                      :data-testid="testIds.projectTrustSelectAll"
                      class="data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-primary-foreground dark:data-[state=indeterminate]:bg-primary pointer-coarse:after:-inset-[13px]"
                      @update:model-value="value => selectAll(group.items, value)"
                    >
                      <template #default="{ state }">
                        <MinusIcon v-if="state === 'indeterminate'" aria-hidden="true" data-slot="project-trust-select-all-mixed" />
                        <CheckIcon v-else aria-hidden="true" />
                      </template>
                    </Checkbox>
                    <label :for="`${headingId(group.kind)}-all`" class="text-sm select-none">
                      Select all {{ selectable(group.items).length }}
                    </label>
                  </div>
                </div>
                <div class="grid min-w-0 divide-y">
                  <ProjectTrustItem
                    v-for="item in group.items"
                    :key="item.sha256"
                    :item="item"
                    :selected="selected.has(item.sha256)"
                    :busy="busy"
                    :variables="variables"
                    @toggle="toggle(item)"
                    @revoke="revoke(item)"
                  />
                </div>
              </section>
            </template>
          </template>
        </div>

        <div class="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t bg-popover px-4 py-3 sm:px-6">
          <p aria-live="polite" class="mr-auto text-sm text-muted-foreground tabular-nums">
            <template v-if="approvals.length > 0">
              {{ selectedText(approvals.length) }}
            </template>
          </p>
          <Button
            type="button"
            variant="outline"
            data-action="close"
            class="pointer-coarse:h-10"
            @click="onOpenChange(false)"
          >
            Close
          </Button>
          <Button
            type="button"
            :disabled="approvals.length === 0 || busy"
            :aria-busy="approving || undefined"
            :data-testid="testIds.projectTrustApprove"
            :data-count="approvals.length"
            class="pointer-coarse:h-10"
            @keydown="onApproveKeydown"
            @click="approve"
          >
            <Spinner v-if="approving && !freshAuth.open.value" data-icon="inline-start" />
            {{ approveLabel(approvals.length) }}
          </Button>
        </div>
      </div>
    </DialogContent>
  </Dialog>

  <ConfirmPasswordDialog
    :open="freshAuth.open.value"
    description="Approving project commands needs your password."
    :pending="freshAuth.pending.value"
    :error="freshAuth.error.value"
    @update:open="freshAuth.setOpen"
    @submit="freshAuth.submit"
  />
</template>
