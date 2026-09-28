<script setup lang="ts">
// One share link of the Share dialog (docs/UI.md 2.8, 7.14): the absolute URL (read-only, selected on focus) with
// Copy link; "{n} messages · snapshot {time}" with the Outdated / Expired badges; the include switches (applied to the
// link at once); the expiry select; Update snapshot and Revoke…. Presentational: the dialog runs the requests and
// passes `busy` (the running action) while one of them runs, which disables every control of the card.
import type { ShareOptions, ShareSummary } from '@harness-forge/shared'
import type { ShareCardAction, ShareExpiryChoice, ShareOptionKey } from './share-links'
import { computed, useId, useTemplateRef } from 'vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import CopyButton from '~/components/common/CopyButton.vue'
import { useSharedNow } from '~/components/common/relative-time'
import RelativeTime from '~/components/common/RelativeTime.vue'
import { testIds } from '~/utils/testids'
import { expiryLabel, messageCountLabel, shareUrl } from './share-links'
import ShareExpirySelect from './ShareExpirySelect.vue'
import ShareOptionSwitches from './ShareOptionSwitches.vue'

const props = withDefaults(defineProps<{
  share: ShareSummary
  /** The options to show: the link's, with a change that is being saved applied on top. */
  options?: ShareOptions
  /** The request running for this card, if any: every control is disabled meanwhile. */
  busy?: ShareCardAction | null
}>(), {
  options: undefined,
  busy: null,
})

const emit = defineEmits<{
  option: [key: ShareOptionKey, value: boolean]
  expiry: [choice: ShareExpiryChoice]
  refresh: []
  revoke: []
}>()

const now = useSharedNow()
const urlId = useId()
const urlField = useTemplateRef<{ $el: HTMLInputElement }>('urlField')

const url = computed(() => shareUrl(props.share.path))
const shownOptions = computed(() => props.options ?? props.share.options)
const expiry = computed(() => expiryLabel(props.share.expiresAt, now.value, props.share.expired))
const disabled = computed(() => props.busy !== null)

/** The whole link is selected on focus and on click (a click would otherwise drop the selection). */
function selectUrl(event: Event) {
  (event.target as HTMLInputElement | null)?.select()
}

/** Focuses the URL with the text selected (a new link, docs/UI.md 14.1). */
function focusUrl() {
  const input = urlField.value?.$el
  input?.focus()
  input?.select()
}

defineExpose({ focusUrl })
</script>

<template>
  <article
    :data-testid="testIds.shareLink"
    :data-share-id="share.id"
    :data-outdated="share.outdated ? 'true' : 'false'"
    :data-expired="share.expired ? 'true' : 'false'"
    :aria-busy="busy ? true : undefined"
    class="flex min-w-0 flex-col gap-3 rounded-lg border bg-card p-3 text-card-foreground"
  >
    <div class="flex min-w-0 items-center gap-2">
      <label :for="urlId" class="sr-only">Share link</label>
      <Input
        :id="urlId"
        ref="urlField"
        :model-value="url"
        readonly
        spellcheck="false"
        :data-testid="testIds.shareUrl"
        class="h-8 min-w-0 flex-1 font-mono text-base pointer-coarse:h-10 md:text-xs"
        @focus="selectUrl"
        @click="selectUrl"
      />
      <CopyButton
        :text="() => url"
        label="Copy link"
        size="sm"
        :data-testid="testIds.shareCopy"
        class="shrink-0 pointer-coarse:h-10"
      />
    </div>

    <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      <span>{{ messageCountLabel(share.messageCount) }} · snapshot <RelativeTime :at="share.snapshotAt" /></span>
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

    <div class="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <ShareOptionSwitches
        :options="shownOptions"
        :disabled="disabled"
        @change="(key, value) => emit('option', key, value)"
      />
      <ShareExpirySelect :label="expiry" :disabled="disabled" @select="emit('expiry', $event)" />
    </div>
    <p class="-mt-1 text-xs text-muted-foreground">
      Changes apply to the link at once.
    </p>

    <div class="flex items-center justify-between gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        :disabled="disabled"
        :aria-busy="busy === 'refresh' || undefined"
        :data-testid="testIds.shareUpdate"
        class="pointer-coarse:h-10"
        @click="emit('refresh')"
      >
        <Spinner v-if="busy === 'refresh'" data-icon="inline-start" />
        Update snapshot
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        :disabled="disabled"
        :data-testid="testIds.shareRevoke"
        class="text-destructive hover:bg-destructive/10 hover:text-destructive pointer-coarse:h-10"
        @click="emit('revoke')"
      >
        Revoke…
      </Button>
    </div>
  </article>
</template>
