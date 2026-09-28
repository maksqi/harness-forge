<script setup lang="ts">
// Copies text with check feedback for 1.5s (docs/UI.md 7.5). size 'icon' = icon-only ghost button with a
// tooltip; size 'sm' = icon + label.
import { CheckIcon, CopyIcon } from '@lucide/vue'
import { computed, onBeforeUnmount, ref } from 'vue'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { copyText } from './clipboard'

// Attributes (data-testid, class) go to the button, not to the renderless tooltip root.
defineOptions({ inheritAttrs: false })

const props = withDefaults(defineProps<{
  text: string | (() => string)
  label?: string
  size?: 'sm' | 'icon'
}>(), {
  label: 'Copy',
  size: 'icon',
})

const emit = defineEmits<{ copied: [] }>()

const copied = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined

const currentLabel = computed(() => (copied.value ? 'Copied' : props.label))

async function onClick() {
  const value = typeof props.text === 'function' ? props.text() : props.text
  if (!(await copyText(value)))
    return
  copied.value = true
  emit('copied')
  clearTimeout(timer)
  timer = setTimeout(() => {
    copied.value = false
  }, 1500)
}

onBeforeUnmount(() => clearTimeout(timer))
</script>

<template>
  <Tooltip v-if="size === 'icon'">
    <TooltipTrigger as-child>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        :aria-label="currentLabel"
        :data-state="copied ? 'copied' : 'idle'"
        class="text-muted-foreground hover:text-foreground"
        v-bind="$attrs"
        @click="onClick"
      >
        <CheckIcon v-if="copied" class="size-3.5" />
        <CopyIcon v-else class="size-3.5" />
      </Button>
    </TooltipTrigger>
    <TooltipContent>{{ currentLabel }}</TooltipContent>
  </Tooltip>
  <Button
    v-else
    type="button"
    variant="ghost"
    size="xs"
    :data-state="copied ? 'copied' : 'idle'"
    class="text-muted-foreground hover:text-foreground"
    v-bind="$attrs"
    @click="onClick"
  >
    <CheckIcon v-if="copied" data-icon="inline-start" />
    <CopyIcon v-else data-icon="inline-start" />
    {{ currentLabel }}
  </Button>
</template>
