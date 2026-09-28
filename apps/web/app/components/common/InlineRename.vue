<script setup lang="ts">
// Inline title editor (docs/UI.md 5.3). Shows the text; while `editing`, an input with the text selected.
// Enter or blur saves, Esc cancels, an empty value cancels. update:modelValue fires only when the trimmed
// value changed and is not empty. Attributes (data-testid, aria-label, class) go to the input.
import { computed, nextTick, ref, useAttrs, watch } from 'vue'
import { cn } from '@/lib/utils'

defineOptions({ inheritAttrs: false })

const props = withDefaults(defineProps<{
  modelValue: string
  editing: boolean
  maxLength?: number
  placeholder?: string
}>(), {
  maxLength: 200,
  placeholder: '',
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
  'update:editing': [value: boolean]
  'cancel': []
}>()

const attrs = useAttrs()
const input = ref<HTMLInputElement | null>(null)
const draft = ref(props.modelValue)
// Guards against a second commit from the blur that follows Enter or Esc.
let settled = true

const inputAttrs = computed(() => {
  const { class: className, ...rest } = attrs
  return {
    'aria-label': 'Name',
    ...rest,
    'class': cn(
      'h-7 w-full min-w-0 rounded-md border border-ring/60 bg-background px-1.5 outline-none ring-3 ring-ring/20',
      className as string | undefined,
    ),
  }
})

watch(() => props.editing, async (editing) => {
  if (!editing)
    return
  settled = false
  draft.value = props.modelValue
  await nextTick()
  input.value?.focus()
  input.value?.select()
}, { immediate: true })

function commit() {
  if (settled)
    return
  settled = true
  const value = draft.value.trim()
  if (!value) {
    emit('cancel')
  }
  else if (value !== props.modelValue.trim()) {
    emit('update:modelValue', value)
  }
  emit('update:editing', false)
}

function onEnter(event: KeyboardEvent) {
  // Enter that confirms an IME composition must not save.
  if (event.isComposing)
    return
  event.preventDefault()
  commit()
}

function cancel() {
  if (settled)
    return
  settled = true
  emit('cancel')
  emit('update:editing', false)
}
</script>

<template>
  <input
    v-if="editing"
    ref="input"
    v-model="draft"
    type="text"
    autocomplete="off"
    spellcheck="false"
    :maxlength="maxLength"
    :placeholder="placeholder"
    v-bind="inputAttrs"
    @keydown.enter="onEnter"
    @keydown.esc.prevent.stop="cancel"
    @blur="commit"
  >
  <span v-else data-slot="inline-rename-text" class="min-w-0 truncate">{{ modelValue || placeholder }}</span>
</template>
