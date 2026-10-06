<script setup lang="ts">
// The refusal of a submit inside the composer card, above the text (Phase 11, ADR-048, ADR-049; docs/UI.md 7.31, 10.8):
// `role="alert"`, `hook-blocked`: `ShieldBan` "A hook blocked this message", the reason and "{event} · {source}"
// ("UserPromptSubmit · Project hook"; left out without the hook record); `untrusted`: `ShieldQuestionMark` "/{name} runs
// shell lines you haven't approved." with Review… (`review`, the host opens the project trust dialog); × "Dismiss"
// (`dismiss`). Renders nothing for null. It never takes focus (the textarea keeps it and points `aria-describedby` at
// the root: ChatComposer passes the root's `id` as an attribute). Props, emits and the root test id are frozen from
// Gate P11-0b (C39 stub); W11.10 implements it in P11-A.
import type { ComposerRefusalData } from './output-style'
import { ShieldBanIcon, ShieldQuestionMarkIcon, XIcon } from '@lucide/vue'
import { computed } from 'vue'
import { Button } from '@/components/ui/button'
import { testIds } from '~/utils/testids'
import { refusalSourceLine, refusalTitle } from './output-style'

const props = defineProps<{ refusal: ComposerRefusalData | null }>()

const emit = defineEmits<{ dismiss: [], review: [] }>()

const title = computed(() => (props.refusal ? refusalTitle(props.refusal) : ''))
const sourceLine = computed(() => (props.refusal ? refusalSourceLine(props.refusal) : null))
const blocked = computed(() => props.refusal?.code === 'hook-blocked')
</script>

<template>
  <div
    v-if="refusal"
    :data-testid="testIds.composerRefusal"
    :data-code="refusal.code"
    :data-event="refusal.event ?? ''"
    role="alert"
    class="flex w-full min-w-0 items-start gap-2 px-3 pt-2.5 text-sm"
  >
    <ShieldBanIcon v-if="blocked" aria-hidden="true" class="mt-0.5 size-4 shrink-0 text-destructive" />
    <ShieldQuestionMarkIcon v-else aria-hidden="true" class="mt-0.5 size-4 shrink-0 text-warning" />
    <div class="min-w-0 flex-1 break-words">
      <p class="font-medium">
        {{ title }}
      </p>
      <p
        v-if="blocked && refusal.reason"
        data-slot="composer-refusal-reason"
        class="max-h-32 overflow-y-auto whitespace-pre-wrap text-muted-foreground"
      >
        {{ refusal.reason }}
      </p>
      <p v-if="sourceLine" data-slot="composer-refusal-source" class="text-xs text-muted-foreground">
        {{ sourceLine }}
      </p>
    </div>
    <Button
      v-if="!blocked"
      type="button"
      size="sm"
      variant="outline"
      :data-testid="testIds.composerRefusalReview"
      class="shrink-0 pointer-coarse:h-10"
      @click="emit('review')"
    >
      Review…
    </Button>
    <Button
      type="button"
      size="icon-sm"
      variant="ghost"
      aria-label="Dismiss"
      :data-testid="testIds.composerRefusalDismiss"
      class="-mt-1 -mr-1 shrink-0 text-muted-foreground pointer-coarse:size-10"
      @click="emit('dismiss')"
    >
      <XIcon aria-hidden="true" />
    </Button>
  </div>
</template>
