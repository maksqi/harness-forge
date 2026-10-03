<script setup lang="ts">
// Add project dialog (docs/UI.md 2.13, 9.10, 14.1; ADR-031): FolderBrowser, then New folder (folder-browser-new, a
// toggle revealing the "Folder name" input folder-browser-new-input, checked like folderNameSchema), "Selected: {path}",
// the Name input (add-project-name, at most 80 characters: the selected folder's basename, or the new folder's name,
// until the user edits it) and Add project (add-project-submit), which submits `{ name, path, newFolder? }` through
// useFreshAuth().run(() => projects.create(body), { required: true }) with ConfirmPasswordDialog ("Adding a project
// needs your password."; cancelling it shows nothing). Add project is disabled without a project folder below a root
// (the open folder when it is not a root itself, or a new folder inside any open folder) or without a name. Inline
// errors by code (add-project-error, data-code = the HarnessError code); every root missing -> the "No workspace
// folders" alert. Success: toast "Project added", created(project), the dialog closes. Form-dialog rule at 390px
// (full width minus 1rem on each side, max-h-[90dvh], scrolls inside); opens with focus on the browser's first entry.
// Opened from Settings -> Projects (also `?add=1`) and from the project switcher.
// Contract (docs/UI.md 10.4): props / emits below (frozen from Gate P7-0b); root add-project-dialog (the dialog content).
import type { HarnessError, ProjectCreate, ProjectSummary } from '@harness-forge/shared'
import { LIMITS } from '@harness-forge/shared'
import { CircleAlertIcon, FolderPlusIcon, FolderXIcon } from '@lucide/vue'
import { computed, ref, shallowRef, useId, useTemplateRef, watch } from 'vue'
import { toast } from 'vue-sonner'
import { Alert, AlertDescription } from '@/components/ui/alert'
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
import ConfirmPasswordDialog from '~/components/common/ConfirmPasswordDialog.vue'
import { isFreshAuthCancelled, useFreshAuth } from '~/composables/useFreshAuth'
import { useProjectsStore } from '~/stores/projects'
import { toHarnessError } from '~/utils/errors'
import { testIds } from '~/utils/testids'
import { baseName, folderNameError, joinPath, samePath } from './folder-path'
import FolderBrowser from './FolderBrowser.vue'

const props = withDefaults(defineProps<{
  open: boolean
  /** The folder to open first; default: the roots. */
  initialPath?: string | null
}>(), {
  initialPath: null,
})

const emit = defineEmits<{
  'update:open': [value: boolean]
  'created': [project: ProjectSummary]
}>()

const projects = useProjectsStore()
const freshAuth = useFreshAuth()
const browser = useTemplateRef<InstanceType<typeof FolderBrowser>>('browser')
const uid = useId()

const folder = ref<string | null>(props.initialPath)
const newFolderOpen = ref(false)
const newFolderName = ref('')
const name = ref('')
/** The user typed a name: it no longer follows the selected folder. */
const nameEdited = ref(false)
const submitting = ref(false)
const failure = shallowRef<HarnessError | null>(null)
/** The failed request created a new folder (the 409 text differs). */
const failedWithNewFolder = ref(false)

const ids = {
  newFolder: `${uid}-new-folder`,
  newFolderError: `${uid}-new-folder-error`,
  name: `${uid}-name`,
  error: `${uid}-error`,
}

const roots = computed(() => browser.value?.roots ?? null)
const browserState = computed(() => browser.value?.state ?? 'loading')
/** Every root is missing (or none is configured): nothing can be added. */
const noRoots = computed(() => roots.value !== null && roots.value.every(root => !root.available))

const trimmedNewFolder = computed(() => newFolderName.value.trim())
const newFolderProblem = computed(() =>
  newFolderOpen.value && trimmedNewFolder.value !== '' ? folderNameError(trimmedNewFolder.value) : null)
/** The folder the project would use: the open folder, or the new folder inside it. */
const projectFolder = computed(() => {
  if (!folder.value)
    return null
  if (!newFolderOpen.value)
    return folder.value
  return trimmedNewFolder.value && !newFolderProblem.value ? joinPath(folder.value, trimmedNewFolder.value) : null
})
/** The open folder is one of the roots (a project needs a folder below it, or a new folder). */
const atRoot = computed(() => {
  const open = folder.value
  if (!open || !roots.value)
    return false
  return roots.value.some(root => samePath(root.path, open))
})
const defaultName = computed(() => {
  if (newFolderOpen.value && trimmedNewFolder.value && !newFolderProblem.value)
    return trimmedNewFolder.value
  return folder.value && !atRoot.value ? baseName(folder.value) : ''
})

const trimmedName = computed(() => name.value.trim())
const canSubmit = computed(() =>
  !submitting.value
  && !freshAuth.open.value
  && !noRoots.value
  && (browserState.value === 'ready' || browserState.value === 'empty')
  && projectFolder.value !== null
  && (newFolderOpen.value || !atRoot.value)
  && trimmedName.value !== ''
  && trimmedName.value.length <= LIMITS.projectNameMaxChars)

const errorText = computed(() => {
  const error = failure.value
  if (!error)
    return ''
  switch (error.code) {
    case 'conflict':
      return failedWithNewFolder.value ? 'A folder with this name already exists.' : 'A project for this folder already exists.'
    case 'forbidden':
      return 'Choose a folder inside the workspace folders.'
    case 'validation_error':
      return error.message || 'Choose a folder inside the workspace folders.'
    case 'not_found':
      return 'This folder no longer exists.'
    default:
      return error.message
  }
})

function reset() {
  folder.value = props.initialPath
  newFolderOpen.value = false
  newFolderName.value = ''
  nameEdited.value = false
  name.value = defaultName.value
  failure.value = null
  failedWithNewFolder.value = false
}

watch(() => props.open, (open) => {
  if (open)
    reset()
  else
    freshAuth.cancel()
})

watch(defaultName, (value) => {
  if (!nameEdited.value)
    name.value = value
}, { immediate: true })

watch([folder, newFolderOpen, newFolderName], () => {
  failure.value = null
})

function onNameInput(value: string | number) {
  name.value = String(value)
  nameEdited.value = name.value.trim() !== ''
  failure.value = null
}

function toggleNewFolder() {
  newFolderOpen.value = !newFolderOpen.value
  if (!newFolderOpen.value)
    newFolderName.value = ''
}

function onOpenChange(value: boolean) {
  if (!value && submitting.value && !freshAuth.open.value)
    return
  emit('update:open', value)
}

function onOpenAutoFocus(event: Event) {
  event.preventDefault()
  browser.value?.focus()
}

async function submit() {
  if (!canSubmit.value || !folder.value)
    return
  const withNewFolder = newFolderOpen.value
  const body: ProjectCreate = {
    name: trimmedName.value,
    path: folder.value,
    ...(withNewFolder ? { newFolder: trimmedNewFolder.value } : {}),
  }
  submitting.value = true
  failure.value = null
  try {
    const project = await freshAuth.run(() => projects.create(body), { required: true })
    toast.success('Project added')
    emit('created', project)
    emit('update:open', false)
  }
  catch (error) {
    if (isFreshAuthCancelled(error))
      return
    failure.value = toHarnessError(error)
    failedWithNewFolder.value = withNewFolder
  }
  finally {
    submitting.value = false
  }
}
</script>

<template>
  <Dialog :open="open" @update:open="onOpenChange">
    <DialogContent
      :data-testid="testIds.addProjectDialog"
      class="max-h-[90dvh] overflow-y-auto sm:max-w-lg"
      @open-auto-focus="onOpenAutoFocus"
    >
      <form class="grid min-w-0 gap-4" novalidate @submit.prevent="submit">
        <DialogHeader>
          <DialogTitle>Add project</DialogTitle>
          <DialogDescription>Choose a folder on the server that chats can read and edit.</DialogDescription>
        </DialogHeader>

        <Alert v-if="noRoots" class="border-warning/40 bg-warning/5 dark:bg-warning/10 *:[svg]:text-warning">
          <FolderXIcon aria-hidden="true" />
          <AlertDescription class="text-foreground">
            No workspace folders. Set HF_WORKSPACE_ROOTS on the server.
          </AlertDescription>
        </Alert>

        <FolderBrowser ref="browser" v-model="folder" :disabled="submitting" />

        <div v-if="folder" class="grid gap-2">
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              :data-testid="testIds.folderBrowserNew"
              :aria-expanded="newFolderOpen"
              :aria-controls="newFolderOpen ? ids.newFolder : undefined"
              :disabled="submitting"
              class="pointer-coarse:h-10"
              @click="toggleNewFolder"
            >
              <FolderPlusIcon aria-hidden="true" data-icon="inline-start" />
              New folder
            </Button>
          </div>
          <div v-if="newFolderOpen" class="grid gap-1.5">
            <Label :for="ids.newFolder">Folder name</Label>
            <Input
              :id="ids.newFolder"
              v-model="newFolderName"
              type="text"
              autocomplete="off"
              spellcheck="false"
              maxlength="300"
              :disabled="submitting"
              :aria-invalid="newFolderProblem ? true : undefined"
              :aria-describedby="newFolderProblem ? ids.newFolderError : undefined"
              :data-testid="testIds.folderBrowserNewInput"
            />
            <p v-if="newFolderProblem" :id="ids.newFolderError" class="text-sm text-destructive">
              {{ newFolderProblem }}
            </p>
          </div>
        </div>

        <p v-if="projectFolder" class="min-w-0 text-sm text-muted-foreground">
          Selected: <span class="font-mono text-xs break-all text-foreground">{{ projectFolder }}</span>
        </p>

        <div class="grid gap-1.5">
          <Label :for="ids.name">Name</Label>
          <Input
            :id="ids.name"
            :model-value="name"
            type="text"
            autocomplete="off"
            :maxlength="LIMITS.projectNameMaxChars"
            :disabled="submitting"
            :data-testid="testIds.addProjectName"
            @update:model-value="onNameInput"
          />
        </div>

        <p
          v-if="failure"
          :id="ids.error"
          role="alert"
          :data-testid="testIds.addProjectError"
          :data-code="failure.code"
          class="flex items-start gap-2 text-sm text-destructive"
        >
          <CircleAlertIcon aria-hidden="true" class="mt-0.5 size-4 shrink-0" />
          <span>{{ errorText }}</span>
        </p>

        <DialogFooter>
          <Button type="button" variant="outline" :disabled="submitting && !freshAuth.open.value" @click="onOpenChange(false)">
            Cancel
          </Button>
          <Button
            type="submit"
            :disabled="!canSubmit"
            :aria-busy="(submitting && !freshAuth.open.value) || undefined"
            :aria-describedby="failure ? ids.error : undefined"
            :data-testid="testIds.addProjectSubmit"
          >
            <Spinner v-if="submitting && !freshAuth.open.value" data-icon="inline-start" />
            Add project
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>

  <ConfirmPasswordDialog
    :open="freshAuth.open.value"
    description="Adding a project needs your password."
    :pending="freshAuth.pending.value"
    :error="freshAuth.error.value"
    @update:open="freshAuth.setOpen"
    @submit="freshAuth.submit"
  />
</template>
