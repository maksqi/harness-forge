<script setup lang="ts">
// Write-only secret field of the settings form (docs/UI.md 8.9, docs/PLUGINS.md section 7). The stored value is
// never read back: once set, the field shows "Stored" with the masked hint and offers Replace / Clear. Replace opens
// an empty password input with a reveal toggle; Clear marks the value for removal on save (Undo restores it).
// Value: undefined keeps the stored secret, a string replaces it, '' clears it.
import { EyeIcon, EyeOffIcon, KeyRoundIcon, Undo2Icon } from '@lucide/vue'
import { computed, nextTick, ref, useTemplateRef, watch } from 'vue'
import { Button } from '@/components/ui/button'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group'
import { cn } from '@/lib/utils'

const props = withDefaults(defineProps<{
  modelValue?: string
  /** A value is stored on the server. */
  stored?: boolean
  /** Masked hint of the stored value ("sk-…9fQ2"). */
  hint?: string | null
  /** Clearing is not offered for required secrets. */
  required?: boolean
  disabled?: boolean
  invalid?: boolean
  id?: string
  describedBy?: string
  label: string
}>(), {
  modelValue: undefined,
  stored: false,
  hint: null,
  required: false,
  disabled: false,
  invalid: false,
  id: undefined,
  describedBy: undefined,
})

const emit = defineEmits<{
  'update:modelValue': [value: string | undefined]
  'blur': []
}>()

const revealed = ref(false)
const replacing = ref(false)
const input = useTemplateRef<{ $el: HTMLInputElement }>('input')

const clearing = computed(() => props.stored && props.modelValue === '')
const editing = computed(() => !props.stored || replacing.value || (typeof props.modelValue === 'string' && props.modelValue !== ''))

// The last value this field emitted: when it comes back through v-model it is our own change. Anything else is a
// reset of the form, which closes Replace and hides the value again.
let lastEmitted: string | undefined | null = null

function update(value: string | undefined) {
  lastEmitted = value
  emit('update:modelValue', value)
}

watch(() => props.modelValue, (value) => {
  if (value === lastEmitted)
    return
  lastEmitted = null
  if (value === undefined) {
    replacing.value = false
    revealed.value = false
  }
})

/** An empty input keeps the stored value (or leaves it unset); typing replaces it. */
function onInput(value: string | number) {
  const text = String(value)
  update(text === '' ? undefined : text)
}

async function startReplace() {
  replacing.value = true
  await nextTick()
  input.value?.$el.focus()
}

function cancelReplace() {
  replacing.value = false
  revealed.value = false
  update(undefined)
}
</script>

<template>
  <div data-slot="schema-secret-input" :data-state="clearing ? 'clearing' : editing ? 'editing' : 'stored'" class="flex flex-col gap-2">
    <div
      v-if="stored && !editing"
      class="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-dashed border-input px-3 py-1.5 dark:bg-input/15"
    >
      <span :class="cn('flex min-w-0 flex-1 items-center gap-2 text-sm', clearing && 'text-muted-foreground line-through decoration-muted-foreground/60')">
        <KeyRoundIcon aria-hidden="true" class="size-3.5 shrink-0 text-muted-foreground" />
        <span class="font-medium">Stored</span>
        <span v-if="hint" class="truncate font-mono text-xs text-muted-foreground">{{ hint }}</span>
      </span>
      <span v-if="clearing" class="text-xs text-muted-foreground">Removed when you save</span>
      <div class="flex items-center gap-1">
        <Button
          v-if="clearing"
          type="button"
          variant="ghost"
          size="xs"
          :disabled="disabled"
          @click="update(undefined)"
        >
          <Undo2Icon aria-hidden="true" data-icon="inline-start" />
          Undo
        </Button>
        <template v-else>
          <Button type="button" variant="outline" size="xs" :disabled="disabled" :aria-label="`Replace ${label}`" @click="startReplace">
            Replace
          </Button>
          <Button
            v-if="!required"
            type="button"
            variant="ghost"
            size="xs"
            :disabled="disabled"
            :aria-label="`Clear ${label}`"
            class="text-muted-foreground hover:text-destructive"
            @click="update('')"
          >
            Clear
          </Button>
        </template>
      </div>
    </div>

    <div v-else class="flex items-center gap-2">
      <InputGroup :data-disabled="disabled || undefined" class="flex-1">
        <InputGroupInput
          :id="id"
          ref="input"
          :model-value="modelValue ?? ''"
          :type="revealed ? 'text' : 'password'"
          :placeholder="stored ? 'New value…' : 'Not set'"
          autocomplete="new-password"
          autocapitalize="off"
          spellcheck="false"
          data-1p-ignore="true"
          data-lpignore="true"
          :disabled="disabled"
          :aria-invalid="invalid || undefined"
          :aria-describedby="describedBy"
          class="font-mono text-[13px] placeholder:font-sans placeholder:text-sm"
          @update:model-value="onInput"
          @blur="emit('blur')"
        />
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            size="icon-xs"
            :aria-label="revealed ? `Hide ${label}` : `Show ${label}`"
            :title="revealed ? 'Hide value' : 'Show value'"
            :aria-pressed="revealed"
            :disabled="disabled"
            @click="revealed = !revealed"
          >
            <EyeOffIcon v-if="revealed" aria-hidden="true" />
            <EyeIcon v-else aria-hidden="true" />
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
      <Button v-if="stored" type="button" variant="ghost" size="sm" :disabled="disabled" @click="cancelReplace">
        Cancel
      </Button>
    </div>
    <p v-if="stored && editing" class="text-xs text-muted-foreground">
      The stored value<template v-if="hint">
        (<span class="font-mono">{{ hint }}</span>)
      </template> stays until you save a new one.
    </p>
  </div>
</template>
