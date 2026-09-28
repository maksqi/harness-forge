<script setup lang="ts">
// Tag input for a list of strings (docs/UI.md 8.9): Enter or comma adds the typed value (trimmed, no duplicates),
// Backspace in an empty input removes the last tag, pasting "a, b, c" adds each value, and leaving the field keeps
// what was typed. Tags render as chips with a remove button.
import { XIcon } from '@lucide/vue'
import { computed, ref, useTemplateRef } from 'vue'
import { cn } from '@/lib/utils'

const props = withDefaults(defineProps<{
  modelValue?: readonly string[]
  disabled?: boolean
  invalid?: boolean
  id?: string
  describedBy?: string
  placeholder?: string
  label: string
}>(), {
  modelValue: () => [],
  disabled: false,
  invalid: false,
  id: undefined,
  describedBy: undefined,
  placeholder: 'Add a value…',
})

const emit = defineEmits<{
  'update:modelValue': [value: string[]]
  'blur': []
}>()

const draft = ref('')
const input = useTemplateRef<HTMLInputElement>('input')
const tags = computed(() => props.modelValue ?? [])

/** Adds every non-empty, new value of `text` split on commas and line breaks. */
function add(text: string): boolean {
  const next = [...tags.value]
  for (const part of text.split(/[,\n]/)) {
    const value = part.trim()
    if (value && !next.includes(value))
      next.push(value)
  }
  if (next.length === tags.value.length)
    return false
  emit('update:modelValue', next)
  return true
}

function commitDraft() {
  if (draft.value.trim())
    add(draft.value)
  draft.value = ''
}

function remove(index: number) {
  emit('update:modelValue', tags.value.filter((_, position) => position !== index))
  input.value?.focus()
}

function onKeydown(event: KeyboardEvent) {
  if (event.isComposing)
    return
  if (event.key === 'Enter' || event.key === ',') {
    event.preventDefault()
    commitDraft()
  }
  else if (event.key === 'Backspace' && draft.value === '' && tags.value.length > 0) {
    event.preventDefault()
    emit('update:modelValue', tags.value.slice(0, -1))
  }
}

function onPaste(event: ClipboardEvent) {
  const text = event.clipboardData?.getData('text') ?? ''
  if (!/[,\n]/.test(text))
    return
  event.preventDefault()
  add(`${draft.value}${text}`)
  draft.value = ''
}

function onBlur() {
  commitDraft()
  emit('blur')
}
</script>

<template>
  <div
    data-slot="schema-tag-input"
    :data-disabled="disabled || undefined"
    :class="cn(
      'flex min-h-9 w-full cursor-text flex-wrap items-center gap-1.5 rounded-md border border-input bg-transparent px-2 py-1.5 shadow-xs transition-[color,box-shadow] dark:bg-input/30',
      'focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50',
      invalid && 'border-destructive ring-destructive/20 dark:ring-destructive/40',
      disabled && 'pointer-events-none cursor-not-allowed opacity-50',
    )"
    @click="input?.focus()"
  >
    <ul v-if="tags.length" class="contents" :aria-label="label">
      <li
        v-for="(tag, index) in tags"
        :key="tag"
        data-slot="schema-tag"
        :data-value="tag"
        class="inline-flex h-6 max-w-full items-center gap-1 rounded-md bg-muted pr-0.5 pl-2 text-xs font-medium"
      >
        <span class="truncate">{{ tag }}</span>
        <button
          type="button"
          :disabled="disabled"
          :aria-label="`Remove ${tag}`"
          :title="`Remove ${tag}`"
          class="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-foreground/10 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          @click.stop="remove(index)"
        >
          <XIcon aria-hidden="true" class="size-3" />
        </button>
      </li>
    </ul>
    <input
      :id="id"
      ref="input"
      v-model="draft"
      type="text"
      :disabled="disabled"
      :placeholder="tags.length ? '' : placeholder"
      :aria-invalid="invalid || undefined"
      :aria-describedby="describedBy"
      autocomplete="off"
      class="h-6 min-w-24 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground md:text-sm"
      @keydown="onKeydown"
      @paste="onPaste"
      @blur="onBlur"
    >
  </div>
</template>
