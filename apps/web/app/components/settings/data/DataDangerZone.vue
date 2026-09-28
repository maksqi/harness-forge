<script setup lang="ts">
// Danger zone of Settings -> Data (docs/UI.md 9.8, 8.4; docs/API.md 5.19): "Delete all data…" opens DataDeleteDialog and
// "Delete everything" sends `POST /api/data/delete`, a fresh-auth route. With a password set and a session that is not
// fresh, ConfirmPasswordDialog asks for the password first; a `403 forbidden` + `action: 'login'` answer asks for it and
// retries once. Afterwards the composer drafts and unread marks of the deleted chats are dropped, the chat list reloads
// and the app returns to `/`. The server emits `chat.deleted` per chat, so other tabs follow.
import type { DataDeleteResult, DataSummary } from '@harness-forge/shared'
import type { DeleteAllOptions } from './data'
import { Trash2Icon } from '@lucide/vue'
import { computed, nextTick, ref } from 'vue'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import ConfirmPasswordDialog from '~/components/common/ConfirmPasswordDialog.vue'
import { useApi } from '~/composables/useApi'
import { useAuthStore } from '~/stores/auth'
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
  loginErrorText,
  needsFreshAuth,
} from './data'
import DataDeleteDialog from './DataDeleteDialog.vue'

defineProps<{
  /** Counts for the dialog text; null while `GET /api/data` loads or after it failed. */
  summary: DataSummary | null
}>()

const api = useApi()
const auth = useAuthStore()
const chats = useChatsStore()

const deleteDialog = ref<InstanceType<typeof DataDeleteDialog> | null>(null)
const dialogOpen = ref(false)
const deleting = ref(false)
const passwordOpen = ref(false)
const passwordPending = ref(false)
const passwordError = ref<string | null>(null)
/** The choices of a delete waiting for the password prompt. */
let waiting: DeleteAllOptions | null = null

/** A delete runs or waits for the password: nothing else starts and the dialog stays open. */
const busy = computed(() => deleting.value || passwordOpen.value)

function onDialogOpenChange(value: boolean): void {
  if (!value && busy.value)
    return
  dialogOpen.value = value
}

function askPassword(options: DeleteAllOptions): void {
  waiting = options
  passwordError.value = null
  passwordOpen.value = true
}

async function onConfirm(options: DeleteAllOptions): Promise<void> {
  if (busy.value)
    return
  if (auth.status?.enabled === true && !auth.fresh) {
    askPassword(options)
    return
  }
  await send(options, true)
}

/** `POST /data/delete`; `promptOnFreshAuth` = a fresh-auth refusal may still ask for the password (once). */
async function send(options: DeleteAllOptions, promptOnFreshAuth: boolean): Promise<void> {
  deleting.value = true
  let result: DataDeleteResult
  try {
    result = await withHarnessErrors(api.data.deleteAll({
      body: { confirm: DELETE_CONFIRMATION, files: options.files, usage: options.usage },
    }))
  }
  catch (error) {
    deleting.value = false
    if (promptOnFreshAuth && needsFreshAuth(error))
      askPassword(options)
    else if (isBusyConflict(error))
      toast.error(BUSY_MESSAGE)
    else
      toastError(error)
    return
  }
  deleting.value = false
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

async function onPasswordSubmit(password: string): Promise<void> {
  if (passwordPending.value)
    return
  passwordPending.value = true
  passwordError.value = null
  try {
    await auth.login(password)
  }
  catch (error) {
    passwordError.value = loginErrorText(error)
    return
  }
  finally {
    passwordPending.value = false
  }
  passwordOpen.value = false
  const options = waiting
  waiting = null
  if (options)
    await send(options, false)
}

function onPasswordOpenChange(value: boolean): void {
  if (value || passwordPending.value)
    return
  passwordOpen.value = false
  passwordError.value = null
  waiting = null
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
        :pending="deleting || passwordPending"
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
      :open="passwordOpen"
      description="Deleting all data needs your password."
      :pending="passwordPending"
      :error="passwordError"
      @update:open="onPasswordOpenChange"
      @submit="onPasswordSubmit"
      @close-auto-focus="onPasswordCloseAutoFocus"
    />
  </SettingsSection>
</template>
