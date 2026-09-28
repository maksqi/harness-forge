<script setup lang="ts">
// Scroll-to-bottom pill of the transcript (docs/UI.md 5.9, 14.4): visible while the reader is away from the bottom
// (fading in and out; `visibility: hidden` otherwise, so it is neither focusable nor announced), and it scrolls
// smoothly, or instantly with reduced motion (the AI Elements button always animates). Must render inside
// AiConversation: it reads the stick-to-bottom context.
import { ArrowDownIcon } from '@lucide/vue'
import { usePreferredReducedMotion } from '@vueuse/core'
import { useStickToBottomContext } from 'vue-stick-to-bottom'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

// Attributes (data-testid, class) go to the button.
defineOptions({ inheritAttrs: false })

const { isAtBottom, scrollToBottom } = useStickToBottomContext()
const reducedMotion = usePreferredReducedMotion()

function onClick() {
  void scrollToBottom(reducedMotion.value === 'reduce' ? 'instant' : {})
}
</script>

<template>
  <Tooltip>
    <TooltipTrigger as-child>
      <Button
        type="button"
        variant="outline"
        size="icon"
        aria-label="Scroll to bottom"
        :aria-hidden="isAtBottom || undefined"
        v-bind="$attrs"
        :class="cn(
          'absolute left-1/2 -translate-x-1/2 rounded-full transition-[opacity,visibility,background-color] duration-(--duration-fast) dark:bg-background dark:hover:bg-muted',
          isAtBottom && 'pointer-events-none invisible opacity-0',
        )"
        @click="onClick"
      >
        <ArrowDownIcon aria-hidden="true" class="size-4" />
      </Button>
    </TooltipTrigger>
    <TooltipContent side="top">
      Scroll to bottom
    </TooltipContent>
  </Tooltip>
</template>
