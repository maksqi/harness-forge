<script setup lang="ts">
// A markdown field (docs/UI.md 9.12, 10.7): CodeMirror with markdown highlighting through `createMarkdownEditor`
// (`components/plugins/code/editor-setup.ts`), lint markers from the diagnostics that have a line, Mod+Enter emits
// `submit`, and Tab is never captured (it moves focus: no keyboard trap). A test id passed by the parent lands on the
// root (attribute fallthrough). Props and emits are frozen from Gate P10-0b (C33 stub); W10.8 implements the CodeMirror
// field in P10-A. The stub is a plain textarea with the same contract.
import type { DefinitionDiagnostic } from '@harness-forge/shared'

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

function onInput(event: Event) {
  emit('update:modelValue', (event.target as HTMLTextAreaElement).value)
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.isComposing) {
    event.preventDefault()
    emit('submit')
  }
}
</script>

<template>
  <div data-slot="markdown-editor" class="overflow-hidden rounded-md border bg-background" :style="{ minHeight: props.minHeight }">
    <textarea
      :value="modelValue"
      :aria-label="label"
      :readonly="readonly"
      spellcheck="false"
      class="block size-full resize-y bg-transparent p-3 font-mono text-sm outline-none"
      :style="{ minHeight: props.minHeight }"
      @input="onInput"
      @keydown="onKeydown"
    />
  </div>
</template>
