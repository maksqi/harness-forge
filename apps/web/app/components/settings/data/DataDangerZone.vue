<script setup lang="ts">
// Danger zone of Settings -> Data (docs/UI.md 9.8, 8.4; docs/API.md 5.19): "Delete all data…" opens DataDeleteDialog and
// "Delete everything" sends `POST /api/data/delete`, a fresh-auth route (useFreshAuth with `required`): with a password
// set and a session that is not fresh, ConfirmPasswordDialog asks for the password first; a `403 forbidden` + `action:
// 'login'` answer asks for it and retries once. Afterwards the composer drafts and unread marks of the deleted chats are
// dropped, the chat list reloads and the app returns to `/`. The server emits `chat.deleted` per chat, so other tabs
// follow.
import type { DataDeleteResult, DataSummary } from '@harness-forge/shared'
import type { DeleteAllOptions } from './data'
import { Trash2Icon } from '@lucide/vue'
import { computed, nextTick, ref } from 'vue'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import ConfirmPasswordDialog from '~/components/common/ConfirmPasswordDialog.vue'
import { useApi } from '~/composables/useApi'
import { isFreshAuthCancelled, useFreshAuth } from '~/composables/useFreshAuth'
import { useChatsStore } from '~/stores/chats'
import { withHarnessErrors } from '~/utils/errors'
import { testIds } from '~/utils/testids'
import { toastError } from '../notify'
import { navigateTo } from '../nuxt-imports'
import SettingsSection from '../SettingsSection.vue'
import {
  BUSY_MESSAGE,
  clearStoredChatState,
  DELETE_CONFIRMATION,
  deletedMessage,
  isBusyConflict,
} from './data'
import DataDeleteDialog from './DataDeleteDialog.vue'

defineProps<{
  /** Counts for the dialog text; null while `GET /api/data` loads or after it failed. */
  summary: DataSummary | null
}>()

const api = useApi()
const chats = useChatsStore()
const freshAuth = useFreshAuth()

const deleteDialog = ref<InstanceType<typeof DataDeleteDialog> | null>(null)
const dialogOpen = ref(false)
const deleting = ref(false)

/** A delete runs or waits for the password: nothing else starts and the dialog stays open. */
const busy = computed(() => deleting.value || freshAuth.open.value)

function onDialogOpenChange(value: boolean): void {
  if (!value && busy.value)
    return
  dialogOpen.value = value
}

/** `POST /data/delete`; `deleting` covers the request only, not the password prompt. */
async function deleteAll(options: DeleteAllOptions): Promise<DataDeleteResult> {
  deleting.value = true
  try {
    return await withHarnessErrors(api.data.deleteAll({
      body: { confirm: DELETE_CONFIRMATION, files: options.files, usage: options.usage },
    }))
  }
  finally {
    deleting.value = false
  }
}

async function onConfirm(options: DeleteAllOptions): Promise<void> {
  if (busy.value)
    return
  let result: DataDeleteResult
  try {
    result = await freshAuth.run(() => deleteAll(options), { required: true })
  }
  catch (error) {
    if (isFreshAuthCancelled(error))
      return
    if (isBusyConflict(error))
      toast.error(BUSY_MESSAGE)
    else
      toastError(error)
    return
  }
  dialogOpen.value = false
  toast.success(deletedMessage(result))
  await forgetDeletedChats()
  chats.fetchPage({ reset: true }).catch(() => {})
  await navigateTo('/')
}

/** Drops the unread marks (store and `hf-unread`) and every composer draft (`hf-composer-draft:*`). */
async function forgetDeletedChats(): Promise<void> {
  for (const id of Object.keys(chats.unread))
    chats.markRead(id)
  // The chats store writes its unread marks to localStorage in a watcher: remove the key after that ran.
  await nextTick()
  clearStoredChatState()
}

function onPasswordCloseAutoFocus(event: Event): void {
  // The prompt has no trigger to return to: focus goes back into the delete dialog while it is open.
  if (!dialogOpen.value)
    return
  event.preventDefault()
  deleteDialog.value?.focusSubmit()
}
</script>

<template>
  <SettingsSection title="Danger zone">
    <div class="flex flex-col gap-4 rounded-xl border border-destructive/40 p-4 sm:flex-row sm:items-center">
      <p class="min-w-0 flex-1 text-sm text-muted-foreground">
        Delete every chat, including archived chats, every message version and every share link. API keys, plugins and
        settings are kept.
      </p>
      <DataDeleteDialog
        ref="deleteDialog"
        :open="dialogOpen"
        :summary="summary"
        :pending="deleting || freshAuth.pending.value"
        @update:open="onDialogOpenChange"
        @confirm="onConfirm"
      >
        <template #trigger>
          <Button
            type="button"
            variant="outline"
            class="w-full border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive sm:w-auto dark:border-destructive/40 dark:hover:bg-destructive/15"
            :data-testid="testIds.dataDelete"
          >
            <Trash2Icon aria-hidden="true" data-icon="inline-start" />
            Delete all data…
          </Button>
        </template>
      </DataDeleteDialog>
    </div>

    <ConfirmPasswordDialog
      :open="freshAuth.open.value"
      description="Deleting all data needs your password."
      :pending="freshAuth.pending.value"
      :error="freshAuth.error.value"
      @update:open="freshAuth.setOpen"
      @submit="freshAuth.submit"
      @close-auto-focus="onPasswordCloseAutoFocus"
    />
  </SettingsSection>
</template>
