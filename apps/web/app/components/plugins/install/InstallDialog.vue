<script setup lang="ts">
// Install dialog (docs/UI.md 8.3; docs/PLUGINS.md 12-13; docs/API.md 5.16), mounted once by pages/plugins.vue.
// 1. Source: tabs Zip / npm / URL / GitHub (Phase 12) / Local folder -> Inspect (`POST /api/plugins/inspect`, nothing is
//    installed).
// 2.-4. Preview, trust and install: InstallReview (Phase 12, C46: extracted unchanged, shared with
//    MarketplaceInstallDialog so the fresh-auth flow exists once). When the package changed since the preview (409
//    `conflict`, reason `stale`), the review emits `stale`: the dialog inspects again and the review shows what changed
//    and asks for a new review. Success: toast, `installed(id)`, close.
// "I trust {source}" names the source the server resolved (`sourceRef`, e.g. `name@1.2.3`) when it sent one.
// "Back" returns to the source step keeping the inputs; closing discards everything.
import type { PluginDetail, PluginInspection } from '@harness-forge/shared'
import type { DraftField, FieldErrors, InstallDraft, InstallRequest, InstallTab } from './install'
import type { HarnessErrorUiAction } from '~/components/common/harness-error'
import { FileArchiveIcon } from '@lucide/vue'
import { computed, reactive, ref, useId, useTemplateRef, watch } from 'vue'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import ConfirmPasswordDialog from '~/components/common/ConfirmPasswordDialog.vue'
import { formatBytes } from '~/components/common/format'
import HarnessErrorAlert from '~/components/common/HarnessErrorAlert.vue'
import { useApi } from '~/composables/useApi'
import { useFreshAuth } from '~/composables/useFreshAuth'
import { useAuthStore } from '~/stores/auth'
import { usePluginsStore } from '~/stores/plugins'
import { toHarnessError, withHarnessErrors } from '~/utils/errors'
import { testIds } from '~/utils/testids'
import {
  buildRequest,
  emptyDraft,
  GITHUB_HINT,
  inspectionSourceLabel,
  INSTALL_TABS,
  serverFieldErrors,
  TAB_LABELS,
  zipForm,
} from './install'
import InstallReview from './InstallReview.vue'

// Attributes go to the dialog content, not to the renderless dialog root.
defineOptions({ inheritAttrs: false })

const props = withDefaults(defineProps<{
  open: boolean
  initialSource?: InstallTab
}>(), {
  initialSource: 'zip',
})

const emit = defineEmits<{
  'update:open': [value: boolean]
  'installed': [id: string]
}>()

// URL literals stay out of template props: vue-tsc 3.3.12 breaks on `//` inside a component prop value
// (vuejs/language-tools#6240).
const URL_PLACEHOLDER = 'https://example.com/my-plugin.zip'

type Step = 'source' | 'preview'
type Phase = 'idle' | 'inspecting'

const api = useApi()
const auth = useAuthStore()
const plugins = usePluginsStore()
const freshAuth = useFreshAuth()

const TAB_TEST_IDS: Record<InstallTab, string> = {
  zip: testIds.installTabZip,
  npm: testIds.installTabNpm,
  url: testIds.installTabUrl,
  github: testIds.installTabGithub,
  folder: testIds.installTabFolder,
}

const formId = useId()
const ids = {
  npmName: useId(),
  npmVersion: useId(),
  url: useId(),
  integrity: useId(),
  folder: useId(),
  zipError: useId(),
  githubRepo: useId(),
  githubRef: useId(),
  githubPath: useId(),
}

const step = ref<Step>('source')
const tab = ref<InstallTab>(props.initialSource)
const draft = reactive<InstallDraft>(emptyDraft())
const fieldErrors = ref<FieldErrors>({})
const error = ref<unknown>(null)
const phase = ref<Phase>('idle')
const inspection = ref<PluginInspection | null>(null)
const inspected = ref<InstallRequest | null>(null)
const dragging = ref(false)
const review = useTemplateRef<InstanceType<typeof InstallReview>>('review')
const fileInput = ref<HTMLInputElement | null>(null)
// Bumped on every open and close, so a request that outlives its dialog session cannot touch the next one.
let session = 0

const busy = computed(() => phase.value !== 'idle' || freshAuth.pending.value)
const sourceLabel = computed(() => (inspection.value && inspected.value ? inspectionSourceLabel(inspection.value, inspected.value) : ''))

function reset() {
  step.value = 'source'
  tab.value = props.initialSource
  Object.assign(draft, emptyDraft())
  fieldErrors.value = {}
  error.value = null
  phase.value = 'idle'
  inspection.value = null
  inspected.value = null
  // A waiting password prompt belongs to the dialog session that ends here.
  freshAuth.cancel()
  dragging.value = false
  if (fileInput.value)
    fileInput.value.value = ''
}

watch(() => props.open, (open) => {
  session += 1
  reset()
  if (open && !auth.loaded)
    void auth.fetchStatus().catch(() => {})
}, { immediate: true })

// Editing a field clears its error.
const FIELD_OF_DRAFT: Partial<Record<keyof InstallDraft, DraftField>> = {
  file: 'file',
  npmName: 'npmName',
  npmVersion: 'npmVersion',
  url: 'url',
  integrity: 'integrity',
  folderPath: 'folderPath',
  githubRepo: 'githubRepo',
  githubRef: 'githubRef',
  githubPath: 'githubPath',
}
for (const key of Object.keys(FIELD_OF_DRAFT) as Array<keyof InstallDraft>) {
  watch(() => draft[key], () => {
    const field = FIELD_OF_DRAFT[key]
    if (field && fieldErrors.value[field] !== undefined) {
      const next = { ...fieldErrors.value }
      delete next[field]
      fieldErrors.value = next
    }
  })
}
watch(tab, () => {
  error.value = null
})

function onOpenChange(value: boolean) {
  if (!value && review.value?.installing)
    return
  emit('update:open', value)
}

function onTabChange(value: string | number) {
  if ((INSTALL_TABS as readonly string[]).includes(String(value)))
    tab.value = value as InstallTab
}

function onFolderMode(value: unknown) {
  if (value === 'link' || value === 'copy')
    draft.folderMode = value
}

// ---------- zip file ----------

function takeFile(file: File | null | undefined) {
  if (file)
    draft.file = file
}

function onFileChange(event: Event) {
  takeFile((event.target as HTMLInputElement).files?.[0])
}

function onDrop(event: DragEvent) {
  dragging.value = false
  takeFile(event.dataTransfer?.files?.[0])
}

function chooseFile() {
  fileInput.value?.click()
}

// ---------- requests ----------

function showError(failure: unknown) {
  const fields = serverFieldErrors(tab.value, failure)
  if (fields && step.value === 'source') {
    fieldErrors.value = { ...fieldErrors.value, ...fields }
    return
  }
  error.value = toHarnessError(failure)
}

async function inspect() {
  if (busy.value)
    return
  const check = buildRequest(tab.value, draft)
  fieldErrors.value = check.errors
  error.value = null
  const request = check.request
  if (!request)
    return
  const current = session
  phase.value = 'inspecting'
  try {
    const result = await withHarnessErrors(request.kind === 'zip'
      ? api.pluginInstall.inspect({ form: zipForm(request.file) })
      : api.pluginInstall.inspect({ body: request.source }))
    if (current !== session)
      return
    inspection.value = result
    inspected.value = request
    step.value = 'preview'
  }
  catch (failure) {
    if (current === session)
      showError(failure)
  }
  finally {
    if (current === session)
      phase.value = 'idle'
  }
}

function onInstalled(detail: PluginDetail) {
  toast.success(`Installed ${detail.name}`)
  void plugins.fetchOne(detail.id).catch(() => {})
  emit('installed', detail.id)
  emit('update:open', false)
}

/**
 * The review's install was refused as stale (409 `stale`: a moved npm tag, a changed folder): inspect the same request
 * again; the review shows the new inspection with a notice and a fresh consent. When this fails too, the review keeps the
 * error, which already tells the user to inspect again.
 */
async function reinspect() {
  const request = inspected.value
  if (!request)
    return
  const current = session
  try {
    const result = await withHarnessErrors(request.kind === 'zip'
      ? api.pluginInstall.inspect({ form: zipForm(request.file) })
      : api.pluginInstall.inspect({ body: request.source }))
    if (current === session)
      inspection.value = result
  }
  catch {
    // The review's error stays.
  }
}

function back() {
  if (busy.value)
    return
  step.value = 'source'
  inspection.value = null
  inspected.value = null
  error.value = null
}

function onSubmit() {
  if (step.value === 'source')
    void inspect()
}

/** "Log in" of the error alert: the password prompt now, then the step is submitted again. */
async function logIn() {
  const current = session
  try {
    await freshAuth.confirm()
  }
  catch {
    // Closed: nothing else happens.
    return
  }
  if (current === session)
    onSubmit()
}

function onErrorAction(action: HarnessErrorUiAction) {
  if (action === 'login')
    void logIn()
  else if (action === 'retry')
    onSubmit()
}
</script>

<template>
  <Dialog :open="open" @update:open="onOpenChange">
    <DialogContent
      :data-testid="testIds.installDialog"
      :data-step="step"
      class="max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-xl"
      v-bind="$attrs"
    >
      <DialogHeader>
        <DialogTitle>Install plugin</DialogTitle>
        <DialogDescription>
          {{ step === 'source'
            ? 'Install a plugin from a zip file, npm, a URL or a folder on this server.'
            : 'Review what this plugin adds before you install it.' }}
        </DialogDescription>
      </DialogHeader>

      <form v-if="step === 'source'" :id="formId" class="-mx-1 grid min-h-0 gap-4 overflow-y-auto px-1" novalidate @submit.prevent="onSubmit">
        <Tabs :model-value="tab" class="gap-4" @update:model-value="onTabChange">
          <TabsList class="w-full">
            <TabsTrigger
              v-for="value in INSTALL_TABS"
              :key="value"
              :value="value"
              :data-testid="TAB_TEST_IDS[value]"
              :disabled="busy"
            >
              {{ TAB_LABELS[value] }}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="zip" class="grid gap-2">
            <div
              class="flex flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-6 text-center transition-colors"
              :class="dragging ? 'border-primary bg-primary/5' : 'border-input'"
              :data-dragging="dragging || undefined"
              @dragover.prevent="dragging = true"
              @dragleave="dragging = false"
              @drop.prevent="onDrop"
            >
              <FileArchiveIcon class="size-6 text-muted-foreground" aria-hidden="true" />
              <p class="text-sm">
                Drop a .zip here or
                <Button type="button" variant="link" class="h-auto p-0" :disabled="busy" @click="chooseFile">
                  choose a file
                </Button>
              </p>
              <p class="text-xs text-muted-foreground">
                Up to {{ formatBytes(20 * 1024 * 1024) }}. plugin.json at the root or in one top-level folder.
              </p>
              <p v-if="draft.file" class="max-w-full text-sm font-medium break-all" data-slot="install-zip-file">
                {{ draft.file.name }} · {{ formatBytes(draft.file.size) }}
              </p>
              <input
                ref="fileInput"
                type="file"
                accept=".zip,application/zip,application/x-zip-compressed"
                class="sr-only"
                tabindex="-1"
                aria-label="Plugin zip file"
                :aria-describedby="fieldErrors.file ? ids.zipError : undefined"
                :data-testid="testIds.installZipInput"
                @change="onFileChange"
              >
            </div>
            <p v-if="fieldErrors.file" :id="ids.zipError" role="alert" class="text-sm text-destructive">
              {{ fieldErrors.file }}
            </p>
          </TabsContent>

          <TabsContent value="npm" class="grid gap-3">
            <div class="grid gap-1.5">
              <Label :for="ids.npmName">Package</Label>
              <Input
                :id="ids.npmName"
                v-model="draft.npmName"
                placeholder="@scope/harness-plugin-name"
                autocomplete="off"
                spellcheck="false"
                :disabled="busy"
                :aria-invalid="fieldErrors.npmName ? true : undefined"
                :data-testid="testIds.installNpmInput"
              />
              <p v-if="fieldErrors.npmName" role="alert" class="text-sm text-destructive">
                {{ fieldErrors.npmName }}
              </p>
            </div>
            <div class="grid gap-1.5">
              <Label :for="ids.npmVersion">Version <span class="font-normal text-muted-foreground">(optional)</span></Label>
              <Input
                :id="ids.npmVersion"
                v-model="draft.npmVersion"
                placeholder="latest"
                autocomplete="off"
                spellcheck="false"
                :disabled="busy"
                :aria-invalid="fieldErrors.npmVersion ? true : undefined"
              />
              <p v-if="fieldErrors.npmVersion" role="alert" class="text-sm text-destructive">
                {{ fieldErrors.npmVersion }}
              </p>
            </div>
            <p class="text-xs text-muted-foreground">
              Downloaded from registry.npmjs.org and checked against its published sha512. Install scripts never run.
            </p>
          </TabsContent>

          <TabsContent value="url" class="grid gap-3">
            <div class="grid gap-1.5">
              <Label :for="ids.url">URL</Label>
              <Input
                :id="ids.url"
                v-model="draft.url"
                type="url"
                :placeholder="URL_PLACEHOLDER"
                autocomplete="off"
                spellcheck="false"
                :disabled="busy"
                :aria-invalid="fieldErrors.url ? true : undefined"
                :data-testid="testIds.installUrlInput"
              />
              <p v-if="fieldErrors.url" role="alert" class="text-sm text-destructive">
                {{ fieldErrors.url }}
              </p>
            </div>
            <div class="grid gap-1.5">
              <Label :for="ids.integrity">Integrity</Label>
              <Input
                :id="ids.integrity"
                v-model="draft.integrity"
                placeholder="sha256-…"
                autocomplete="off"
                spellcheck="false"
                class="font-mono"
                :disabled="busy"
                :aria-invalid="fieldErrors.integrity ? true : undefined"
                :data-testid="testIds.installIntegrityInput"
              />
              <p v-if="fieldErrors.integrity" role="alert" class="text-sm text-destructive">
                {{ fieldErrors.integrity }}
              </p>
            </div>
            <p class="text-xs text-muted-foreground">
              An https link to a .zip or .tgz and its required SRI hash (sha256-… or sha512-…), for example from
              <code class="font-mono">openssl dgst -sha256 -binary FILE | openssl base64 -A</code>.
            </p>
          </TabsContent>

          <TabsContent value="github" class="grid gap-3">
            <div class="grid gap-1.5">
              <Label :for="ids.githubRepo">Repository</Label>
              <Input
                :id="ids.githubRepo"
                v-model="draft.githubRepo"
                placeholder="owner/repo"
                autocomplete="off"
                spellcheck="false"
                class="font-mono"
                :disabled="busy"
                :aria-invalid="fieldErrors.githubRepo ? true : undefined"
                :data-testid="testIds.installGithubRepo"
              />
              <p v-if="fieldErrors.githubRepo" role="alert" class="text-sm text-destructive">
                {{ fieldErrors.githubRepo }}
              </p>
            </div>
            <div class="grid gap-3 sm:grid-cols-2">
              <div class="grid gap-1.5">
                <Label :for="ids.githubRef">Branch, tag or commit <span class="font-normal text-muted-foreground">(optional)</span></Label>
                <Input
                  :id="ids.githubRef"
                  v-model="draft.githubRef"
                  placeholder="main"
                  autocomplete="off"
                  spellcheck="false"
                  class="font-mono"
                  :disabled="busy"
                  :aria-invalid="fieldErrors.githubRef ? true : undefined"
                  :data-testid="testIds.installGithubRef"
                />
                <p v-if="fieldErrors.githubRef" role="alert" class="text-sm text-destructive">
                  {{ fieldErrors.githubRef }}
                </p>
              </div>
              <div class="grid gap-1.5">
                <Label :for="ids.githubPath">Folder in the repository <span class="font-normal text-muted-foreground">(optional)</span></Label>
                <Input
                  :id="ids.githubPath"
                  v-model="draft.githubPath"
                  placeholder="plugins/my-plugin"
                  autocomplete="off"
                  spellcheck="false"
                  class="font-mono"
                  :disabled="busy"
                  :aria-invalid="fieldErrors.githubPath ? true : undefined"
                  :data-testid="testIds.installGithubPath"
                />
                <p v-if="fieldErrors.githubPath" role="alert" class="text-sm text-destructive">
                  {{ fieldErrors.githubPath }}
                </p>
              </div>
            </div>
            <p class="text-xs text-muted-foreground">
              {{ GITHUB_HINT }}
            </p>
          </TabsContent>

          <TabsContent value="folder" class="grid gap-3">
            <div class="grid gap-1.5">
              <Label :for="ids.folder">Folder on the server</Label>
              <Input
                :id="ids.folder"
                v-model="draft.folderPath"
                placeholder="/home/me/plugins/my-plugin"
                autocomplete="off"
                spellcheck="false"
                class="font-mono"
                :disabled="busy"
                :aria-invalid="fieldErrors.folderPath ? true : undefined"
                :data-testid="testIds.installFolderInput"
              />
              <p v-if="fieldErrors.folderPath" role="alert" class="text-sm text-destructive">
                {{ fieldErrors.folderPath }}
              </p>
            </div>
            <div class="flex flex-wrap items-center gap-3">
              <ToggleGroup
                type="single"
                variant="outline"
                :model-value="draft.folderMode"
                :disabled="busy"
                :data-testid="testIds.installFolderMode"
                :data-value="draft.folderMode"
                aria-label="Folder install mode"
                @update:model-value="onFolderMode"
              >
                <ToggleGroupItem value="link" data-value="link">
                  Link
                </ToggleGroupItem>
                <ToggleGroupItem value="copy" data-value="copy">
                  Copy
                </ToggleGroupItem>
              </ToggleGroup>
              <p class="text-xs text-muted-foreground">
                {{ draft.folderMode === 'link'
                  ? 'Link watches the folder and reloads on change.'
                  : 'Copy installs a snapshot of the folder.' }}
              </p>
            </div>
          </TabsContent>
        </Tabs>

        <HarnessErrorAlert
          v-if="error"
          :error="error"
          :data-testid="testIds.installError"
          @action="onErrorAction"
        />
      </form>

      <DialogFooter v-if="step === 'source'">
        <Button type="button" variant="outline" :disabled="busy" @click="onOpenChange(false)">
          Cancel
        </Button>
        <Button
          type="submit"
          :form="formId"
          :disabled="busy"
          :aria-busy="phase === 'inspecting' || undefined"
          :data-testid="testIds.installInspect"
        >
          <Spinner v-if="phase === 'inspecting'" data-icon="inline-start" />
          Inspect
        </Button>
      </DialogFooter>

      <InstallReview
        v-else-if="inspection && inspected"
        ref="review"
        :inspection="inspection"
        :request="inspected"
        :source-label="sourceLabel"
        @back="back"
        @installed="onInstalled"
        @stale="reinspect"
      />
    </DialogContent>

    <ConfirmPasswordDialog
      :open="freshAuth.open.value"
      description="Confirm your password to install a plugin that runs code on this server."
      :pending="freshAuth.pending.value"
      :error="freshAuth.error.value"
      @update:open="freshAuth.setOpen"
      @submit="freshAuth.submit"
    />
  </Dialog>
</template>
