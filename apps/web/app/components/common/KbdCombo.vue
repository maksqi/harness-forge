<script setup lang="ts">
// Platform-aware key combo hint: '⌘⇧O' on macOS, 'Ctrl Shift O' elsewhere (docs/UI.md section 12).
// Callers hide hints where the spec says so (below `lg`, on touch devices) with classes on this component.
// Rendered in the UI sans stack: at 11px a monospace "O" reads like a zero, and the system font draws the
// modifier glyphs at the right size.
import { computed } from 'vue'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { formatKeys, isApplePlatform } from './keys'

const props = defineProps<{ keys: string }>()

const mac = isApplePlatform()
const tokens = computed(() => formatKeys(props.keys, mac))
const spoken = computed(() => tokens.value.map(token => token.name).join('+'))
</script>

<template>
  <KbdGroup data-slot="kbd-combo" class="shrink-0">
    <span class="sr-only">{{ spoken }}</span>
    <Kbd v-if="mac" aria-hidden="true" class="font-sans text-[11px]">
      {{ tokens.map(token => token.label).join('') }}
    </Kbd>
    <template v-else>
      <Kbd v-for="(token, index) in tokens" :key="index" aria-hidden="true" class="font-sans text-[11px]">
        {{ token.label }}
      </Kbd>
    </template>
  </KbdGroup>
</template>
