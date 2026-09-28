<script setup lang="ts">
// CodeMirror 6 editor of the Source tab (docs/UI.md 8.10). Controlled: shows `content` of `path` and emits `change`
// on edits; each path keeps its own editor state (undo history, selection) while the component lives. CodeMirror is
// imported on mount (editor-setup.ts), so it only loads with the Source tab. Build diagnostics of the shown file are
// lint markers (gutter, underline, hover tooltip).
import type { BuildDiagnostic } from '@harness-forge/shared'
import type { SourceEditorController } from './editor-setup'
import { onBeforeUnmount, onMounted, ref, shallowRef, useTemplateRef, watch } from 'vue'
import { Spinner } from '@/components/ui/spinner'
import { testIds } from '~/utils/testids'

const props = withDefaults(defineProps<{
  /** The shown file; null shows nothing. */
  path: string | null
  content: string
  readonly?: boolean
  dark?: boolean
  /** Diagnostics of the shown file. */
  diagnostics?: readonly BuildDiagnostic[]
}>(), {
  readonly: false,
  dark: true,
  diagnostics: () => [],
})

const emit = defineEmits<{
  change: [path: string, content: string]
}>()

const host = useTemplateRef<HTMLDivElement>('host')
const editor = shallowRef<SourceEditorController | null>(null)
const failed = ref(false)
let unmounted = false

function sync(): void {
  const current = editor.value
  if (!current || props.path === null)
    return
  current.show(props.path, props.content)
  current.setDiagnostics(props.diagnostics)
}

onMounted(async () => {
  try {
    const { createSourceEditor } = await import('./editor-setup')
    if (unmounted || !host.value)
      return
    editor.value = createSourceEditor(host.value, {
      dark: props.dark,
      readonly: props.readonly,
      onChange: (path, content) => emit('change', path, content),
    })
    sync()
  }
  catch (error) {
    console.error('[source editor] CodeMirror failed to load', error)
    failed.value = true
  }
})

onBeforeUnmount(() => {
  unmounted = true
  editor.value?.destroy()
  editor.value = null
})

watch(() => [props.path, props.content] as const, ([path], [previousPath]) => {
  const current = editor.value
  if (!current || path === null)
    return
  if (path !== previousPath)
    sync()
  else if (current.content() !== props.content)
    current.replace(props.content)
})
watch(() => props.diagnostics, diagnostics => editor.value?.setDiagnostics(diagnostics))
watch(() => props.dark, dark => editor.value?.setDark(dark))
watch(() => props.readonly, readonly => editor.value?.setReadOnly(readonly))

defineExpose({
  focus: (): void => editor.value?.focus(),
  /** Moves the cursor to a 1-based line and byte column. */
  goTo: (line: number, column?: number | null): void => editor.value?.goTo(line, column),
  /** Drops the stored state of a closed or renamed file. */
  forget: (path: string): void => editor.value?.forget(path),
})
</script>

<template>
  <div
    :data-testid="testIds.codeEditor"
    :data-path="path ?? undefined"
    :data-ready="editor ? 'true' : 'false'"
    class="relative h-full min-h-0 overflow-hidden focus-within:ring-1 focus-within:ring-ring/40 focus-within:ring-inset"
  >
    <div ref="host" class="h-full" :class="path === null ? 'invisible' : undefined" />
    <div v-if="!editor && !failed" class="absolute inset-0 grid place-items-center">
      <Spinner class="text-muted-foreground" />
    </div>
    <p v-if="failed" role="alert" class="absolute inset-0 grid place-items-center p-6 text-center text-sm text-destructive">
      The editor could not be loaded. Reload the page to try again.
    </p>
  </div>
</template>
