<script setup lang="ts">
// The refusal of a submit inside the composer card, above the text (Phase 11, ADR-048, ADR-049; docs/UI.md 7.31, 10.8):
// `role="alert"`, `hook-blocked`: `ShieldBan` "A hook blocked this message", the reason and "{event} · {source}";
// `untrusted`: `ShieldQuestionMark` "/{name} runs shell lines you haven't approved." with Review… (`review`, the host
// opens the project trust dialog); × "Dismiss" (`dismiss`). Renders nothing for null. Props, emits and the root test id
// are frozen from Gate P11-0b (C39 stub); W11.10 implements it in P11-A. The stub shows the reason and the buttons.
import type { ComposerRefusalData } from './output-style'
import { XIcon } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { testIds } from '~/utils/testids'

defineProps<{ refusal: ComposerRefusalData | null }>()

const emit = defineEmits<{ dismiss: [], review: [] }>()
</script>

<template>
  <div
    v-if="refusal"
    :data-testid="testIds.composerRefusal"
    :data-code="refusal.code"
    :data-event="refusal.event ?? ''"
    role="alert"
    class="flex min-w-0 items-start gap-2 px-3 pt-2.5 text-sm"
  >
    <p class="min-w-0 flex-1 break-words">
      {{ refusal.code === 'hook-blocked' ? 'A hook blocked this message' : `/${refusal.command ?? 'command'} runs shell lines you haven't approved.` }}
      <span v-if="refusal.code === 'hook-blocked'" class="text-muted-foreground">{{ refusal.reason }}</span>
    </p>
    <Button
      v-if="refusal.code === 'untrusted'"
      type="button"
      size="sm"
      variant="outline"
      :data-testid="testIds.composerRefusalReview"
      class="pointer-coarse:h-10"
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
      class="pointer-coarse:size-10"
      @click="emit('dismiss')"
    >
      <XIcon aria-hidden="true" />
    </Button>
  </div>
</template>
