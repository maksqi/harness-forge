<script setup lang="ts">
// Settings -> Data "Shared links" (docs/UI.md 2.7, 9.8, ADR-025): every share link of every chat, newest first. A row
// shows the chat title (a link to the chat), "{n} messages · snapshot {time}", the expiry when set, the Outdated /
// Expired badges, Copy link, Manage… (opens the Share dialog of that chat) and Revoke… (after a confirmation). The
// list reloads after a revoke and whenever the Share dialog closes (it may have created, changed or revoked links).
// Contract (docs/UI.md 10.4): no props, no emits; rendered by DataSettings; lists the shares with shares.list().
import type { ShareSummary } from '@harness-forge/shared'
import type { ShareErrorView } from './share-links'
import { CircleAlertIcon } from '@lucide/vue'
import { nextTick, ref, useTemplateRef, watch } from 'vue'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import ConfirmDialog from '~/components/common/ConfirmDialog.vue'
import CopyButton from '~/components/common/CopyButton.vue'
import { useSharedNow } from '~/components/common/relative-time'
import RelativeTime from '~/components/common/RelativeTime.vue'
import SettingsSection from '~/components/settings/SettingsSection.vue'
import { useApi } from '~/composables/useApi'
import { useUiStore } from '~/stores/ui'
import { hasErrorCode } from '~/utils/errors'
import { testIds } from '~/utils/testids'
import { expiryLabel, messageCountLabel, shareErrorView, shareUrl, sortNewestFirst } from './share-links'

const api = useApi()
const ui = useUiStore()
const now = useSharedNow()

const state = ref<'loading' | 'ready' | 'error'>('loading')
const shares = ref<ShareSummary[]>([])
/** The last load failed ("Try again"); the rows of an earlier load stay. */
const loadFailure = ref<ShareErrorView | null>(null)
/** The last revoke failed. */
const revokeFailure = ref<ShareErrorView | null>(null)
const revokeTarget = ref<ShareSummary | null>(null)
const revoking = ref(false)
const list = useTemplateRef<HTMLElement>('list')

let loadSeq = 0

const ERROR_ALERT_CLASS = 'border-destructive/35 bg-destructive/5 dark:bg-destructive/10 *:data-[slot=alert-description]:text-foreground/80'

/** `shares.list()` without a chat: every link. Keeps the current rows while it reloads. */
async function load() {
  const seq = ++loadSeq
  if (state.value === 'error')
    state.value = 'loading'
  try {
    const page = await api.shares.list()
    if (seq !== loadSeq)
      return
    shares.value = sortNewestFirst(page.items)
    state.value = 'ready'
    loadFailure.value = null
  }
  catch (error) {
    if (seq !== loadSeq)
      return
    loadFailure.value = shareErrorView(error)
    if (state.value !== 'ready')
      state.value = 'error'
  }
}

void load()

// The Share dialog closed (ui.shareChatId back to null): its changes are on the server now.
watch(() => ui.shareChatId, (chatId, previous) => {
  if (chatId === null && previous)
    void load()
})

function title(share: ShareSummary): string {
  return share.chatTitle?.trim() || 'Untitled chat'
}

function rowElement(id: string): HTMLElement | null {
  return list.value?.querySelector<HTMLElement>(`[data-testid="${testIds.sharesRow}"][data-share-id="${id}"]`) ?? null
}

function onRevokeOpenChange(value: boolean) {
  if (value || revoking.value)
    return
  const share = revokeTarget.value
  revokeTarget.value = null
  if (share)
    void nextTick(() => focusInRow(share.id, testIds.shareRevoke))
}

function focusInRow(id: string | undefined, testId: string) {
  if (id)
    rowElement(id)?.querySelector<HTMLElement>(`[data-testid="${testId}"]`)?.focus()
}

async function confirmRevoke() {
  const share = revokeTarget.value
  if (!share || revoking.value)
    return
  const index = shares.value.findIndex(item => item.id === share.id)
  revoking.value = true
  revokeFailure.value = null
  let removed = false
  try {
    await api.shares.remove({ params: { id: share.id } })
    removed = true
  }
  catch (error) {
    // Already revoked elsewhere (another tab): the row goes away all the same.
    removed = hasErrorCode(error, 'not_found')
    if (!removed)
      revokeFailure.value = shareErrorView(error)
  }
  revoking.value = false
  revokeTarget.value = null
  if (removed)
    shares.value = shares.value.filter(item => item.id !== share.id)
  await nextTick()
  if (removed)
    focusInRow(shares.value[Math.min(index, shares.value.length - 1)]?.id, testIds.shareCopy)
  else
    focusInRow(share.id, testIds.shareRevoke)
  await load()
}
</script>

<template>
  <SettingsSection
    title="Shared links"
    description="Read-only links to chat snapshots. Revoking a link stops it at once."
    :data-testid="testIds.sharesSection"
  >
    <Alert
      v-if="loadFailure"
      variant="destructive"
      :data-code="loadFailure.code"
      :class="ERROR_ALERT_CLASS"
    >
      <CircleAlertIcon />
      <AlertTitle>Couldn't load the shared links</AlertTitle>
      <AlertDescription>{{ loadFailure.message }}</AlertDescription>
      <div class="col-start-2 mt-2">
        <Button type="button" size="sm" variant="outline" class="text-foreground" @click="load">
          Try again
        </Button>
      </div>
    </Alert>
    <Alert
      v-else-if="revokeFailure"
      variant="destructive"
      :data-code="revokeFailure.code"
      :class="ERROR_ALERT_CLASS"
    >
      <CircleAlertIcon />
      <AlertTitle>{{ revokeFailure.title }}</AlertTitle>
      <AlertDescription>{{ revokeFailure.message }}</AlertDescription>
    </Alert>

    <div v-if="state === 'loading'" aria-busy="true" class="flex flex-col gap-2">
      <span class="sr-only">Loading shared links…</span>
      <Skeleton v-for="n in 2" :key="n" class="h-14 rounded-lg" />
    </div>

    <template v-else-if="state === 'ready'">
      <p v-if="shares.length === 0" :data-testid="testIds.sharesEmpty" class="text-sm text-muted-foreground">
        No shared links.
      </p>
      <ul v-else ref="list" class="flex flex-col divide-y rounded-lg border">
        <li
          v-for="share in shares"
          :key="share.id"
          :data-testid="testIds.sharesRow"
          :data-share-id="share.id"
          :data-chat-id="share.chatId"
          class="flex min-w-0 flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:gap-3"
        >
          <div class="flex min-w-0 flex-1 flex-col gap-0.5">
            <NuxtLink
              :to="`/chat/${share.chatId}`"
              class="min-w-0 truncate rounded-sm text-sm font-medium underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50" :class="[
                !share.chatTitle?.trim() && 'font-normal text-muted-foreground italic',
              ]"
            >
              {{ title(share) }}
            </NuxtLink>
            <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <span>{{ messageCountLabel(share.messageCount) }} · snapshot <RelativeTime :at="share.snapshotAt" /></span>
              <span v-if="share.expiresAt !== null && !share.expired">· {{ expiryLabel(share.expiresAt, now) }}</span>
              <Tooltip v-if="share.outdated">
                <TooltipTrigger as-child>
                  <Badge
                    variant="outline"
                    tabindex="0"
                    :data-testid="testIds.shareOutdated"
                    class="border-warning/60 text-foreground"
                  >
                    Outdated
                  </Badge>
                </TooltipTrigger>
                <TooltipContent class="max-w-64">
                  The chat changed after this snapshot. Update the snapshot to share the latest messages.
                </TooltipContent>
              </Tooltip>
              <Badge
                v-if="share.expired"
                variant="outline"
                :data-testid="testIds.shareExpired"
                class="border-destructive/60 text-destructive"
              >
                Expired
              </Badge>
            </div>
          </div>
          <div class="flex shrink-0 flex-wrap items-center gap-1">
            <CopyButton
              :text="() => shareUrl(share.path)"
              label="Copy link"
              size="sm"
              :data-testid="testIds.shareCopy"
              class="pointer-coarse:h-10"
            />
            <Button
              type="button"
              variant="ghost"
              size="xs"
              :data-testid="testIds.sharesRowManage"
              class="pointer-coarse:h-10"
              @click="ui.openShare(share.chatId)"
            >
              Manage…
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              :disabled="revoking && revokeTarget?.id === share.id"
              :data-testid="testIds.shareRevoke"
              class="text-destructive hover:bg-destructive/10 hover:text-destructive pointer-coarse:h-10"
              @click="revokeTarget = share"
            >
              Revoke…
            </Button>
          </div>
        </li>
      </ul>
    </template>

    <ConfirmDialog
      :open="revokeTarget !== null"
      title="Revoke this link?"
      description="People with the link can no longer open it. This can't be undone."
      confirm-label="Revoke"
      :pending="revoking"
      :data-testid="testIds.shareRevokeConfirm"
      @update:open="onRevokeOpenChange"
      @confirm="confirmRevoke"
    />
  </SettingsSection>
</template>
