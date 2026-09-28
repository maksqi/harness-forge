<script setup lang="ts">
// Inline editor of a user message (docs/UI.md 7.5): a textarea at the bubble's width with Cancel / Send. The send
// key follows the `sendKey` setting (Enter, or Mod+Enter); Esc cancels; IME composition never sends.
import { computed, nextTick, onMounted, ref, useTemplateRef } from 'vue'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { isApplePlatform } from '~/components/common/keys'
import { useSettingsStore } from '~/stores/settings'
import { testIds } from '~/utils/testids'

const props = defineProps<{ text: string }>()
const emit = defineEmits<{ save: [text: string], cancel: [] }>()

const settings = useSettingsStore()
const draft = ref(props.text)
const container = useTemplateRef<HTMLElement>('container')
const canSave = computed(() => draft.value.trim().length > 0)

onMounted(async () => {
  await nextTick()
  const area = container.value?.querySelector('textarea')
  area?.focus()
  area?.setSelectionRange(area.value.length, area.value.length)
})

function save() {
  if (canSave.value)
    emit('save', draft.value)
}

function onKeydown(event: KeyboardEvent) {
  if (event.isComposing)
    return
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    emit('cancel')
    return
  }
  if (event.key !== 'Enter')
    return
  const mod = isApplePlatform() ? event.metaKey : event.ctrlKey
  const sends = settings.resolved.sendKey === 'mod-enter' ? mod : !event.shiftKey && !mod
  if (sends) {
    event.preventDefault()
    save()
  }
}
</script>

<template>
  <div ref="container" data-slot="message-editor" class="flex w-full max-w-[85%] flex-col gap-2 self-end">
    <Textarea
      v-model="draft"
      aria-label="Edit message"
      :data-testid="testIds.messageEditInput"
      class="max-h-[40vh] min-h-11 resize-none rounded-2xl bg-card px-4 py-2.5 text-[length:var(--transcript-font-size)] md:text-[length:var(--transcript-font-size)]"
      @keydown="onKeydown"
    />
    <div class="flex justify-end gap-2">
      <Button type="button" variant="ghost" size="sm" :data-testid="testIds.messageEditCancel" @click="emit('cancel')">
        Cancel
      </Button>
      <Button type="button" size="sm" :disabled="!canSave" :data-testid="testIds.messageEditSave" @click="save">
        Send
      </Button>
    </div>
  </div>
</template>
