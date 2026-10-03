<script setup lang="ts">
// Project instructions dialog (docs/UI.md 9.10; ADR-031): title "Instructions for {name}", a Textarea
// (project-instructions-input, at most 20,000 characters with the counter "{n} / 20,000"), the note about AGENTS.md /
// CLAUDE.md ("This folder has {file}; it is added first." when the folder has one), Cancel and Save
// (project-instructions-save) -> projects.update(id, { instructions }) (an empty text saves null), then saved(project)
// and the dialog closes; a failure shows inline. The text resets to the project's instructions whenever it opens.
// Contract (docs/UI.md 10.4): props / emits below (frozen from Gate P7-0b); root project-instructions-dialog (the
// dialog content).
import type { ProjectSummary } from '@harness-forge/shared'
import { LIMITS } from '@harness-forge/shared'
import { computed, ref, useId, watch } from 'vue'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { useProjectsStore } from '~/stores/projects'
import { toHarnessError } from '~/utils/errors'
import { testIds } from '~/utils/testids'

const props = defineProps<{
  open: boolean
  project: ProjectSummary | null
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  'saved': [project: ProjectSummary]
}>()

const projects = useProjectsStore()
const uid = useId()

const text = ref('')
const saving = ref(false)
const error = ref<string | null>(null)

const MAX = LIMITS.instructionsMaxChars
const formatter = new Intl.NumberFormat('en-US')

const counter = computed(() => `${formatter.format(text.value.length)} / ${formatter.format(MAX)}`)
const tooLong = computed(() => text.value.length > MAX)

watch(() => [props.open, props.project?.id] as const, ([open]) => {
  if (!open)
    return
  text.value = props.project?.instructions ?? ''
  error.value = null
}, { immediate: true })

function onOpenChange(value: boolean) {
  if (!value && saving.value)
    return
  emit('update:open', value)
}

async function save() {
  const project = props.project
  if (!project || saving.value || tooLong.value)
    return
  saving.value = true
  error.value = null
  try {
    const saved = await projects.update(project.id, { instructions: text.value.trim() === '' ? null : text.value })
    emit('saved', saved)
    emit('update:open', false)
  }
  catch (failure) {
    error.value = toHarnessError(failure).message
  }
  finally {
    saving.value = false
  }
}
</script>

<template>
  <Dialog :open="open" @update:open="onOpenChange">
    <DialogContent :data-testid="testIds.projectInstructionsDialog" class="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
      <form class="grid min-w-0 gap-4" novalidate @submit.prevent="save">
        <DialogHeader>
          <DialogTitle>Instructions for {{ project?.name ?? 'this project' }}</DialogTitle>
          <DialogDescription>
            Sent with every chat in this project, after AGENTS.md / CLAUDE.md from the folder.
            <template v-if="project?.instructionsFile">
              This folder has {{ project.instructionsFile }}; it is added first.
            </template>
          </DialogDescription>
        </DialogHeader>

        <div class="grid gap-1.5">
          <Label :for="`${uid}-instructions`" class="sr-only">Instructions</Label>
          <Textarea
            :id="`${uid}-instructions`"
            v-model="text"
            :maxlength="MAX"
            rows="8"
            :disabled="saving"
            :aria-invalid="tooLong || undefined"
            :aria-describedby="`${uid}-counter`"
            :data-testid="testIds.projectInstructionsInput"
            class="max-h-[50dvh] min-h-40 overflow-y-auto"
          />
          <p :id="`${uid}-counter`" class="text-right text-xs text-muted-foreground tabular-nums">
            {{ counter }}
          </p>
          <p v-if="error" role="alert" class="text-sm text-destructive">
            {{ error }}
          </p>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" :disabled="saving" @click="onOpenChange(false)">
            Cancel
          </Button>
          <Button
            type="submit"
            :disabled="saving || !project || tooLong"
            :aria-busy="saving || undefined"
            :data-testid="testIds.projectInstructionsSave"
          >
            <Spinner v-if="saving" data-icon="inline-start" />
            Save
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
