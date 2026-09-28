<script setup lang="ts">
// Inline editor of a user message (docs/UI.md 7.5, S8): the message's attachments as removable chips, a textarea at the
// bubble's width, a paperclip "Attach files" (a hidden input with the composer's accept list; pasted files are added
// too), and Cancel / Send. New files upload at once through a private useComposerAttachments() instance (the chips show
// the upload state, rejected files the composer's toasts). Send waits for the uploads, is disabled while one runs or
// failed, and is allowed with attachments and no text; it emits the chips left plus the new uploads (the full new set).
// Cancel discards the editor and aborts its uploads (unmounting disposes the instance as well). The send key follows
// the `sendKey` setting (Enter, or Mod+Enter); Esc cancels; IME composition never sends.
import type { FileUIPart } from 'ai'
import { PaperclipIcon } from '@lucide/vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, useTemplateRef } from 'vue'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { COMPOSER_ACCEPT } from '~/components/chat/composer/attachments'
import FileChip from '~/components/common/FileChip.vue'
import { safeAssetUrl } from '~/components/common/format'
import { isApplePlatform } from '~/components/common/keys'
import { fileRefToPart } from '~/composables/useChatSession'
import { useComposerAttachments } from '~/composables/useComposerAttachments'
import { useSettingsStore } from '~/stores/settings'
import { testIds } from '~/utils/testids'
import { toastAttachmentRejection } from './attachment-toasts'

const props = defineProps<{
  /** The message text. */
  text: string
  /** The message's file parts (removable chips). */
  files: readonly FileUIPart[]
}>()

const emit = defineEmits<{
  /** The new text and the full new set of files: the chips left, then the new uploads. */
  save: [text: string, files: FileUIPart[]]
  /** Discarded (its uploads are aborted). */
  cancel: []
}>()

interface KeptFile {
  key: string
  part: FileUIPart
}

const settings = useSettingsStore()
const draft = ref(props.text)
// Shallow: the parts go out as they came in (no reactive proxies in the new message).
const kept = shallowRef<KeptFile[]>(props.files.map((part, index) => ({ key: `kept-${index}`, part })))
const attachments = useComposerAttachments({ onReject: toastAttachmentRejection })
const uploads = attachments.items
const container = useTemplateRef<HTMLElement>('container')
const fileInput = useTemplateRef<HTMLInputElement>('fileInput')
/** Send was pressed while uploads ran: it goes out once they settle. */
const waiting = ref(false)
/** Canceled or unmounted: a pending Send is dropped. */
let closed = false

const hasContent = computed(() => draft.value.trim().length > 0 || kept.value.length > 0 || uploads.value.length > 0)
const canSave = computed(() => hasContent.value && !waiting.value && !attachments.uploading.value && !attachments.failed.value)

function textarea(): HTMLTextAreaElement | null {
  return container.value?.querySelector('textarea') ?? null
}

onMounted(async () => {
  await nextTick()
  const area = textarea()
  area?.focus()
  area?.setSelectionRange(area.value.length, area.value.length)
})

onBeforeUnmount(() => {
  closed = true
})

function nameOf(part: FileUIPart): string {
  return part.filename || 'Attachment'
}

function removeKept(key: string) {
  kept.value = kept.value.filter(item => item.key !== key)
  textarea()?.focus()
}

function removeUpload(id: string) {
  attachments.remove(id)
  textarea()?.focus()
}

function addFiles(files: File[]) {
  if (files.length > 0)
    attachments.add(files)
}

function openFilePicker() {
  fileInput.value?.click()
}

function onFilesPicked(event: Event) {
  const input = event.target as HTMLInputElement
  addFiles(Array.from(input.files ?? []))
  input.value = ''
}

/** Pasted files are attached; rich text (plain text + HTML, e.g. from office apps) is pasted as text. */
function onPaste(event: ClipboardEvent) {
  const types = Array.from(event.clipboardData?.types ?? [])
  if (types.includes('text/plain') && types.includes('text/html'))
    return
  const files = Array.from(event.clipboardData?.items ?? [])
    .filter(item => item.kind === 'file')
    .map(item => item.getAsFile())
    .filter((file): file is File => file !== null)
  if (files.length === 0)
    return
  event.preventDefault()
  addFiles(files)
}

async function save() {
  if (waiting.value || !hasContent.value || attachments.failed.value)
    return
  waiting.value = true
  try {
    await attachments.settled()
  }
  finally {
    waiting.value = false
  }
  // Canceled meanwhile, or an upload failed or was removed.
  if (closed || attachments.failed.value || !hasContent.value)
    return
  const files = [...kept.value.map(item => item.part), ...attachments.fileRefs.value.map(fileRefToPart)]
  emit('save', draft.value, files)
}

function cancel() {
  closed = true
  attachments.clear()
  emit('cancel')
}

function onKeydown(event: KeyboardEvent) {
  if (event.isComposing)
    return
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    cancel()
    return
  }
  if (event.key !== 'Enter')
    return
  const mod = isApplePlatform() ? event.metaKey : event.ctrlKey
  const sends = settings.resolved.sendKey === 'mod-enter' ? mod : !event.shiftKey && !mod
  if (sends) {
    event.preventDefault()
    void save()
  }
}
</script>

<template>
  <div ref="container" data-slot="message-editor" class="flex w-full max-w-[85%] flex-col gap-2 self-end">
    <input
      ref="fileInput"
      type="file"
      multiple
      class="hidden"
      tabindex="-1"
      aria-hidden="true"
      data-slot="message-edit-file-input"
      :accept="COMPOSER_ACCEPT"
      @change="onFilesPicked"
    >
    <div v-if="kept.length > 0 || uploads.length > 0" class="flex flex-wrap items-end justify-end gap-1.5">
      <FileChip
        v-for="item in kept"
        :key="item.key"
        :data-testid="testIds.messageEditAttachment"
        :name="nameOf(item.part)"
        :mime="item.part.mediaType"
        :url="safeAssetUrl(item.part.url) ?? undefined"
        removable
        @remove="removeKept(item.key)"
      />
      <FileChip
        v-for="item in uploads"
        :key="item.id"
        :data-testid="testIds.messageEditAttachment"
        :name="item.name"
        :size="item.size"
        :mime="item.mime"
        :url="item.previewUrl"
        :state="item.state"
        removable
        @remove="removeUpload(item.id)"
        @retry="attachments.retry(item.id)"
      />
    </div>
    <Textarea
      v-model="draft"
      aria-label="Edit message"
      :data-testid="testIds.messageEditInput"
      class="max-h-[40vh] min-h-11 resize-none rounded-2xl bg-card px-4 py-2.5 text-[length:var(--transcript-font-size)] md:text-[length:var(--transcript-font-size)]"
      @keydown="onKeydown"
      @paste="onPaste"
    />
    <div class="flex items-center justify-between gap-2">
      <Tooltip>
        <TooltipTrigger as-child>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Attach files"
            :data-testid="testIds.messageEditAttach"
            class="text-muted-foreground hover:text-foreground pointer-coarse:size-10"
            @click="openFilePicker"
          >
            <PaperclipIcon class="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Attach files</TooltipContent>
      </Tooltip>
      <div class="flex gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          :data-testid="testIds.messageEditCancel"
          class="pointer-coarse:h-10"
          @click="cancel"
        >
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          :disabled="!canSave"
          :aria-busy="waiting || attachments.uploading.value || undefined"
          :data-testid="testIds.messageEditSave"
          class="pointer-coarse:h-10"
          @click="save"
        >
          Send
        </Button>
      </div>
    </div>
  </div>
</template>
