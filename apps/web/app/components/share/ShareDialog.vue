<script setup lang="ts">
// Share dialog (docs/UI.md 2.8, 7.14, 14.1, ADR-025): the read-only links of one chat. On open it lists the chat's
// links (newest first, skeleton cards meanwhile, "Try again" on a failure); each card copies its absolute URL, changes
// its include options (options only, applied to the link at once), its expiry, updates its snapshot (the URL never
// changes) and revokes it after a confirmation; the form below creates a link (at most 20 per chat). Creating and
// changing a link are fresh-auth requests (useFreshAuth with `required`: the password prompt comes first when the
// session is not fresh, and once more after a 403 `login`); revoking is not. Without a password the dialog warns that
// links open only where the app is reachable without one. Focus: "Create link" when the chat has no link, else the
// first card's "Copy link"; a new link's URL is focused and selected; closing returns focus to the control that opened
// the dialog.
// Contract (docs/UI.md 10.4): no props, no emits; mounted once by layouts/default.vue; open while ui.shareChatId is
// set (ui.openShare(chatId) from "Share…" in the chat menus); closing calls ui.closeShare().
import type { ShareOptions, ShareSummary, ShareUpdate } from '@harness-forge/shared'
import type { ShareCardAction, ShareErrorView, ShareExpiryChoice, ShareOptionKey } from './share-links'
import { LIMITS } from '@harness-forge/shared'
import { CircleAlertIcon, TriangleAlertIcon } from '@lucide/vue'
import { computed, nextTick, reactive, ref, useId, useTemplateRef, watch } from 'vue'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import ConfirmDialog from '~/components/common/ConfirmDialog.vue'
import ConfirmPasswordDialog from '~/components/common/ConfirmPasswordDialog.vue'
import { useApi } from '~/composables/useApi'
import { isFreshAuthCancelled, useFreshAuth } from '~/composables/useFreshAuth'
import { useAuthStore } from '~/stores/auth'
import { useUiStore } from '~/stores/ui'
import { hasErrorCode } from '~/utils/errors'
import { testIds } from '~/utils/testids'
import {
  DEFAULT_SHARE_OPTIONS,
  expiresAtFor,
  expiryChoiceLabel,
  optionPatch,
  shareErrorView,
  sortNewestFirst,
} from './share-links'
import ShareExpirySelect from './ShareExpirySelect.vue'
import ShareLinkCard from './ShareLinkCard.vue'
import ShareOptionSwitches from './ShareOptionSwitches.vue'

const ui = useUiStore()
const auth = useAuthStore()
const api = useApi()
const { open: passwordOpen, pending: passwordPending, error: passwordError, run, submit: submitPassword, setOpen: setPasswordOpen, cancel: cancelPassword } = useFreshAuth()

/** Creating and changing a link always need fresh auth: the prompt comes first when the session is not fresh. */
function withFreshAuth<T>(task: () => Promise<T>): Promise<T> {
  return run(task, { required: true })
}

const open = computed({
  get: () => ui.shareChatId !== null,
  set: (value: boolean) => {
    if (!value)
      ui.closeShare()
  },
})

const LIMIT_HINT = `A chat can have up to ${LIMITS.sharesPerChatMax} links.`

const loadState = ref<'loading' | 'ready' | 'error'>('loading')
const links = ref<ShareSummary[]>([])
/** The last failure, shown in the dialog's alert; `retry`: the list failed to load ("Try again"). */
const failure = ref<(ShareErrorView & { retry: boolean }) | null>(null)
/** The request running per link id. */
const busy = reactive(new Map<string, ShareCardAction>())
/** Option changes being saved, shown on their card until the answer replaces it. */
const pendingOptions = reactive(new Map<string, Partial<ShareOptions>>())
const creating = ref(false)
const draftOptions = ref<ShareOptions>({ ...DEFAULT_SHARE_OPTIONS })
const draftExpiry = ref<ShareExpiryChoice>('never')
const revokeTarget = ref<ShareSummary | null>(null)
const revoking = ref(false)

const passwordless = computed(() => auth.status?.enabled === false)
const atLimit = computed(() => links.value.length >= LIMITS.sharesPerChatMax)

const container = useTemplateRef<HTMLElement>('container')
const errorAlert = useTemplateRef<{ $el: HTMLElement }>('errorAlert')
const cards = new Map<string, { focusUrl: () => void }>()
const limitHintId = useId()
const newLinkHeadingId = useId()

/** Bumped whenever the dialog opens, closes or switches chats: answers of an older session are ignored. */
let session = 0
let loadSeq = 0
/** The control that opened the dialog; focus returns to it on close (docs/UI.md 14.1). */
let returnFocusTo: HTMLElement | null = null

function reset() {
  loadState.value = 'loading'
  links.value = []
  failure.value = null
  busy.clear()
  pendingOptions.clear()
  creating.value = false
  draftOptions.value = { ...DEFAULT_SHARE_OPTIONS }
  draftExpiry.value = 'never'
  revokeTarget.value = null
  revoking.value = false
}

watch(() => ui.shareChatId, (chatId, previous) => {
  if (chatId === previous)
    return
  session += 1
  if (!chatId) {
    // Closing cancels a waiting password prompt; the content keeps its state while it animates out.
    cancelPassword()
    return
  }
  if (!previous)
    returnFocusTo = document.activeElement instanceof HTMLElement ? document.activeElement : null
  reset()
  void load(chatId)
}, { immediate: true })

async function load(chatId: string) {
  const current = session
  const seq = ++loadSeq
  loadState.value = 'loading'
  failure.value = null
  try {
    const page = await api.shares.list({ query: { chatId } })
    if (current !== session || seq !== loadSeq)
      return
    links.value = sortNewestFirst(page.items)
    loadState.value = 'ready'
    await nextTick()
    focusInitial()
  }
  catch (error) {
    if (current !== session || seq !== loadSeq)
      return
    loadState.value = 'error'
    showFailure(error, true)
  }
}

function retryLoad() {
  if (ui.shareChatId)
    void load(ui.shareChatId)
}

function showFailure(error: unknown, retry = false) {
  failure.value = { ...shareErrorView(error), retry }
  void nextTick(() => errorAlert.value?.$el?.scrollIntoView?.({ block: 'nearest' }))
}

// ---------- focus (docs/UI.md 14.1) ----------

function byTestId(testId: string, root: ParentNode | null | undefined = container.value): HTMLElement | null {
  return root?.querySelector<HTMLElement>(`[data-testid="${testId}"]`) ?? null
}

function cardElement(id: string): HTMLElement | null {
  return container.value?.querySelector<HTMLElement>(`[data-testid="${testIds.shareLink}"][data-share-id="${id}"]`) ?? null
}

/** "Create link" without links, else the first card's "Copy link" — unless the user already moved on in the dialog. */
function focusInitial() {
  const root = container.value
  if (!root)
    return
  const active = document.activeElement
  const content = root.closest('[role="dialog"]') ?? root
  if (active && active !== root && content.contains(active))
    return
  const target = links.value.length > 0 ? byTestId(testIds.shareCopy) : byTestId(testIds.shareCreate)
  ;(target ?? root).focus()
}

function onOpenAutoFocus(event: Event) {
  event.preventDefault()
  if (loadState.value === 'ready')
    focusInitial()
  else
    container.value?.focus()
}

function onCloseAutoFocus(event: Event) {
  const target = returnFocusTo
  returnFocusTo = null
  if (target?.isConnected) {
    event.preventDefault()
    target.focus()
  }
}

function setCardRef(id: string, instance: unknown) {
  if (instance && typeof (instance as { focusUrl?: unknown }).focusUrl === 'function')
    cards.set(id, instance as { focusUrl: () => void })
  else
    cards.delete(id)
}

// ---------- link actions ----------

function replace(summary: ShareSummary) {
  links.value = links.value.map(link => (link.id === summary.id ? summary : link))
}

function drop(id: string) {
  links.value = links.value.filter(link => link.id !== id)
}

/** A PATCH for one card (fresh auth); the answer replaces the card. */
async function change(share: ShareSummary, action: ShareCardAction, body: ShareUpdate, options?: Partial<ShareOptions>) {
  if (busy.has(share.id))
    return
  const current = session
  busy.set(share.id, action)
  if (options)
    pendingOptions.set(share.id, options)
  failure.value = null
  try {
    const updated = await withFreshAuth(() => api.shares.update({ params: { id: share.id }, body }))
    if (current === session)
      replace(updated)
  }
  catch (error) {
    if (current !== session || isFreshAuthCancelled(error))
      return
    if (hasErrorCode(error, 'not_found'))
      drop(share.id)
    showFailure(error)
  }
  finally {
    if (current === session) {
      busy.delete(share.id)
      pendingOptions.delete(share.id)
    }
  }
}

function onOption(share: ShareSummary, key: ShareOptionKey, value: boolean) {
  const options = optionPatch(key, value)
  void change(share, 'options', { options }, options)
}

function onExpiry(share: ShareSummary, choice: ShareExpiryChoice) {
  void change(share, 'expiry', { expiresAt: expiresAtFor(choice) })
}

function onRefresh(share: ShareSummary) {
  void change(share, 'refresh', { refresh: true })
}

function shownOptions(share: ShareSummary): ShareOptions {
  const pending = pendingOptions.get(share.id)
  return pending ? { ...share.options, ...pending } : share.options
}

function onDraftOption(key: ShareOptionKey, value: boolean) {
  draftOptions.value = { ...draftOptions.value, [key]: value }
}

async function create() {
  const chatId = ui.shareChatId
  if (!chatId || creating.value || atLimit.value)
    return
  const current = session
  const options = { ...draftOptions.value }
  const choice = draftExpiry.value
  creating.value = true
  failure.value = null
  try {
    const created = await withFreshAuth(() => api.shares.create({ body: { chatId, options, expiresAt: expiresAtFor(choice) } }))
    if (current !== session)
      return
    links.value = [created, ...links.value.filter(link => link.id !== created.id)]
    creating.value = false
    await nextTick()
    cards.get(created.id)?.focusUrl()
  }
  catch (error) {
    if (current !== session)
      return
    creating.value = false
    if (!isFreshAuthCancelled(error))
      showFailure(error)
  }
}

// ---------- revoke ----------

function askRevoke(share: ShareSummary) {
  if (!busy.has(share.id))
    revokeTarget.value = share
}

function onRevokeOpenChange(value: boolean) {
  if (value || revoking.value)
    return
  const share = revokeTarget.value
  revokeTarget.value = null
  if (share)
    void nextTick(() => byTestId(testIds.shareRevoke, cardElement(share.id))?.focus())
}

async function confirmRevoke() {
  const share = revokeTarget.value
  if (!share || revoking.value)
    return
  const current = session
  const index = links.value.findIndex(link => link.id === share.id)
  revoking.value = true
  busy.set(share.id, 'revoke')
  failure.value = null
  let removed = false
  try {
    await api.shares.remove({ params: { id: share.id } })
    removed = true
  }
  catch (error) {
    if (current !== session)
      return
    // Already revoked (another tab): the card goes away all the same.
    removed = hasErrorCode(error, 'not_found')
    if (!removed)
      showFailure(error)
  }
  if (current !== session)
    return
  busy.delete(share.id)
  revoking.value = false
  revokeTarget.value = null
  if (removed)
    drop(share.id)
  await nextTick()
  if (!removed) {
    byTestId(testIds.shareRevoke, cardElement(share.id))?.focus()
    return
  }
  // Focus the card that took its place, else the one above, else "Create link".
  const next = links.value[Math.min(index, links.value.length - 1)]
  ;(next ? byTestId(testIds.shareCopy, cardElement(next.id)) : byTestId(testIds.shareCreate))?.focus()
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent
      :data-testid="testIds.shareDialog"
      :data-chat-id="ui.shareChatId ?? undefined"
      class="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg"
      @open-auto-focus="onOpenAutoFocus"
      @close-auto-focus="onCloseAutoFocus"
    >
      <DialogHeader>
        <DialogTitle>Share chat</DialogTitle>
        <DialogDescription>
          Anyone with a link can read a snapshot of this chat. Messages you add later are not shared until you update
          the snapshot.
        </DialogDescription>
      </DialogHeader>

      <div ref="container" tabindex="-1" class="flex min-w-0 flex-col gap-4 outline-none">
        <Alert
          v-if="passwordless"
          :data-testid="testIds.sharePasswordlessWarning"
          role="note"
          class="border-warning/40 bg-warning/5 dark:bg-warning/10 *:[svg]:text-warning *:data-[slot=alert-description]:text-foreground/80"
        >
          <TriangleAlertIcon />
          <AlertTitle>No password set</AlertTitle>
          <AlertDescription>
            Links open only where the app is reachable without a password (normally just this computer). Set
            HF_PASSWORD before exposing the server.
          </AlertDescription>
        </Alert>

        <Alert
          v-if="failure"
          ref="errorAlert"
          variant="destructive"
          :data-testid="testIds.shareDialogError"
          :data-code="failure.code"
          class="border-destructive/35 bg-destructive/5 dark:bg-destructive/10 *:data-[slot=alert-description]:text-foreground/80"
        >
          <CircleAlertIcon />
          <AlertTitle>{{ failure.title }}</AlertTitle>
          <AlertDescription>
            {{ failure.message }}
          </AlertDescription>
          <div v-if="failure.retry" class="col-start-2 mt-2">
            <Button type="button" size="sm" variant="outline" class="text-foreground" @click="retryLoad">
              Try again
            </Button>
          </div>
        </Alert>

        <div
          v-if="loadState === 'loading'"
          aria-busy="true"
          class="flex flex-col gap-3"
        >
          <span class="sr-only">Loading links…</span>
          <Skeleton v-for="n in 2" :key="n" class="h-40 rounded-lg" />
        </div>

        <template v-else-if="loadState === 'ready'">
          <div v-if="links.length" class="flex flex-col gap-3">
            <ShareLinkCard
              v-for="share in links"
              :key="share.id"
              :ref="(instance: unknown) => setCardRef(share.id, instance)"
              :share="share"
              :options="shownOptions(share)"
              :busy="busy.get(share.id) ?? null"
              @option="(key, value) => onOption(share, key, value)"
              @expiry="onExpiry(share, $event)"
              @refresh="onRefresh(share)"
              @revoke="askRevoke(share)"
            />
          </div>
          <p v-else class="text-sm text-muted-foreground">
            This chat has no links yet.
          </p>

          <form
            :data-testid="testIds.shareCreateForm"
            :aria-labelledby="newLinkHeadingId"
            class="flex flex-col gap-3 border-t pt-4"
            @submit.prevent="create"
          >
            <h3 :id="newLinkHeadingId" class="text-sm font-medium">
              New link
            </h3>
            <div class="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2">
              <ShareOptionSwitches :options="draftOptions" :disabled="creating" @change="onDraftOption" />
              <ShareExpirySelect
                :label="expiryChoiceLabel(draftExpiry)"
                :model-value="draftExpiry"
                :disabled="creating"
                @select="draftExpiry = $event"
              />
            </div>
            <div class="flex flex-wrap items-center justify-end gap-3">
              <p v-if="atLimit" :id="limitHintId" class="mr-auto text-xs text-muted-foreground">
                {{ LIMIT_HINT }}
              </p>
              <Button
                type="submit"
                :disabled="creating || atLimit"
                :aria-busy="creating || undefined"
                :aria-describedby="atLimit ? limitHintId : undefined"
                :data-testid="testIds.shareCreate"
                class="pointer-coarse:h-10"
              >
                <Spinner v-if="creating" data-icon="inline-start" />
                Create link
              </Button>
            </div>
          </form>
        </template>
      </div>
    </DialogContent>
  </Dialog>

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

  <ConfirmPasswordDialog
    :open="passwordOpen"
    description="Confirm your password to create or change a share link."
    :pending="passwordPending"
    :error="passwordError"
    @update:open="setPasswordOpen"
    @submit="submitPassword"
  />
</template>
