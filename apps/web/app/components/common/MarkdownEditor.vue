<script setup lang="ts">
// A markdown field (docs/UI.md 9.12, 10.7, 12, 14): CodeMirror with markdown highlighting through `createMarkdownEditor`
// (`components/plugins/code/editor-setup.ts`, loaded with a dynamic import, so CodeMirror only downloads when a field
// shows), lint markers from the diagnostics that have a line, Mod+Enter emits `submit`, and Tab is never captured (it
// moves focus: no keyboard trap). The editable area is named by `label` (`aria-multiline`, `aria-readonly` when
// read-only; an `aria-describedby` passed by the parent also describes it). The theme follows the `dark` class of the
// document. At least `minHeight` tall, at most 50dvh on phones
// (70dvh above), scrolling inside. A test id passed by the parent lands on the root (attribute fallthrough). If
// CodeMirror cannot load, a plain textarea with the same contract takes its place. Props and emits are frozen from
// Gate P10-0b (C33).
import type { DefinitionDiagnostic } from '@harness-forge/shared'
import type { MarkdownEditorController } from '~/components/plugins/code/editor-setup'
import { onBeforeUnmount, onMounted, ref, shallowRef, useAttrs, useTemplateRef, watch } from 'vue'
import { Spinner } from '@/components/ui/spinner'

const props = withDefaults(defineProps<{
  modelValue: string
  /** The aria-label of the editable area. */
  label: string
  readonly?: boolean
  /** Lint markers (those with a line). */
  diagnostics?: readonly DefinitionDiagnostic[]
  minHeight?: string
}>(), {
  readonly: false,
  diagnostics: () => [],
  minHeight: '16rem',
})

const emit = defineEmits<{ 'update:modelValue': [value: string], 'submit': [] }>()

const attrs = useAttrs()
const host = useTemplateRef<HTMLDivElement>('host')
const fallback = useTemplateRef<HTMLTextAreaElement>('fallback')
const editor = shallowRef<MarkdownEditorController | null>(null)
const failed = ref(false)
let unmounted = false
let observer: MutationObserver | null = null

function describedBy(): string | undefined {
  const value = attrs['aria-describedby']
  return typeof value === 'string' && value !== '' ? value : undefined
}

function isDark(): boolean {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
}

onMounted(async () => {
  try {
    const { createMarkdownEditor } = await import('~/components/plugins/code/editor-setup')
    if (unmounted || !host.value)
      return
    const controller = createMarkdownEditor(host.value, {
      dark: isDark(),
      readonly: props.readonly,
      label: props.label,
      describedBy: describedBy(),
      onChange: value => emit('update:modelValue', value),
      onSubmit: () => emit('submit'),
    })
    controller.setValue(props.modelValue)
    controller.setDiagnostics(props.diagnostics)
    editor.value = controller
    observer = new MutationObserver(() => controller.setDark(isDark()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  }
  catch (error) {
    console.error('[markdown editor] CodeMirror failed to load', error)
    failed.value = true
  }
})

onBeforeUnmount(() => {
  unmounted = true
  observer?.disconnect()
  observer = null
  editor.value?.destroy()
  editor.value = null
})

watch(() => props.modelValue, (value) => {
  const current = editor.value
  if (!current || current.view.state.doc.toString() === value)
    return
  current.setValue(value)
  current.setDiagnostics(props.diagnostics)
})
watch(() => props.diagnostics, diagnostics => editor.value?.setDiagnostics(diagnostics))
watch(() => props.readonly, readonly => editor.value?.setReadOnly(readonly))
watch(() => props.label, label => editor.value?.setLabel(label, describedBy()))

function onFallbackInput(event: Event): void {
  emit('update:modelValue', (event.target as HTMLTextAreaElement).value)
}

function onFallbackKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.isComposing) {
    event.preventDefault()
    emit('submit')
  }
}

defineExpose({
  /** Moves focus into the editable area. */
  focus: (): void => {
    if (editor.value)
      editor.value.focus()
    else
      fallback.value?.focus()
  },
})
</script>

<template>
  <div
    data-slot="markdown-editor"
    :data-ready="editor || failed ? 'true' : 'false'"
    :data-readonly="readonly ? 'true' : undefined"
    class="relative overflow-hidden rounded-md border border-input bg-background focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30"
  >
    <textarea
      v-if="failed"
      ref="fallback"
      :value="modelValue"
      :aria-label="label"
      :aria-describedby="describedBy()"
      :readonly="readonly"
      aria-multiline="true"
      spellcheck="false"
      class="block max-h-[50dvh] w-full resize-y bg-transparent p-3 font-mono text-[13px] outline-none sm:max-h-[70dvh]"
      :style="{ minHeight: props.minHeight }"
      @input="onFallbackInput"
      @keydown="onFallbackKeydown"
    />
    <div
      v-else
      ref="host"
      class="max-h-[50dvh] sm:max-h-[70dvh]"
      :style="{ minHeight: props.minHeight }"
    />
    <div v-if="!editor && !failed" class="pointer-events-none absolute inset-0 grid place-items-center">
      <Spinner class="text-muted-foreground" />
    </div>
  </div>
</template>
