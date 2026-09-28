<script setup lang="ts">
// "New file" and "Rename" dialog of the Source tab (docs/UI.md 8.10): a relative path with a .js, .mjs, .ts, .json or
// .md extension, checked against the listing before it is sent. Presentational: the parent writes the file.
import type { ExistingPaths } from './source-files'
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { newFilePathProblem } from './source-files'

const props = withDefaults(defineProps<{
  open: boolean
  mode: 'create' | 'rename'
  /** Prefilled path: the folder of a new file, or the current path of a renamed one. */
  initialPath?: string
  existing: ExistingPaths
  pending?: boolean
  /** A server error of the last attempt. */
  error?: string | null
}>(), {
  initialPath: '',
  pending: false,
  error: null,
})

const emit = defineEmits<{
  'update:open': [value: boolean]
  'submit': [path: string]
}>()

const path = ref('')
const touched = ref(false)
const inputId = useId()
const errorId = useId()

watch(() => props.open, (open) => {
  if (open) {
    path.value = props.initialPath
    touched.value = false
  }
}, { immediate: true })

const unchanged = computed(() => props.mode === 'rename' && path.value.trim() === props.initialPath)
const problem = computed(() => (unchanged.value ? null : newFilePathProblem(path.value, props.existing)))
const shownError = computed(() => props.error ?? (touched.value ? problem.value : null))

function onOpenChange(value: boolean) {
  if (!value && props.pending)
    return
  emit('update:open', value)
}

function onSubmit() {
  touched.value = true
  if (props.pending || problem.value || unchanged.value)
    return
  emit('submit', path.value.trim())
}
</script>

<template>
  <Dialog :open="open" @update:open="onOpenChange">
    <DialogContent class="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md">
      <form class="grid gap-5" @submit.prevent="onSubmit">
        <DialogHeader>
          <DialogTitle>{{ mode === 'create' ? 'New file' : 'Rename file' }}</DialogTitle>
          <DialogDescription>
            A path inside the plugin, such as lib/util.mjs. Extensions: .js, .mjs, .ts, .json, .md.
          </DialogDescription>
        </DialogHeader>
        <div class="grid gap-2">
          <Label :for="inputId">Path</Label>
          <Input
            :id="inputId"
            v-model="path"
            autocomplete="off"
            spellcheck="false"
            autofocus
            class="font-mono"
            placeholder="lib/util.mjs"
            :disabled="pending"
            :aria-invalid="shownError ? true : undefined"
            :aria-describedby="shownError ? errorId : undefined"
            @blur="touched = true"
          />
          <p v-if="shownError" :id="errorId" role="alert" class="text-sm text-destructive">
            {{ shownError }}
          </p>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" :disabled="pending" @click="onOpenChange(false)">
            Cancel
          </Button>
          <Button type="submit" :disabled="pending || unchanged" :aria-busy="pending || undefined">
            <Spinner v-if="pending" data-icon="inline-start" />
            {{ mode === 'create' ? 'Create' : 'Rename' }}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
