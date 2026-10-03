<script setup lang="ts">
// The "allowed by rule" mark of a shell row (docs/UI.md 7.19, 7.23; ADR-038): a muted ShieldCheck before the row
// summary when the command ran without a card because shell rules matched it (`ShellOutput.allowedBy`), with the
// sr-only text ", allowed by rule {prefixes}" and the tooltip "Allowed by rule: {prefixes}". Renders nothing without
// prefixes. Store-free (ToolPart and ShareToolRow render it).
// Contract (docs/UI.md 10.5; frozen from Gate P8-0b): props below, no emits; root tool-row-rule (data-value = the
// prefixes joined with ", "). Stub (C20, P8-0b): W8.10 finishes it in P8-A.
import { ShieldCheckIcon } from '@lucide/vue'
import { computed } from 'vue'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { testIds } from '~/utils/testids'

const props = defineProps<{
  /** `ShellOutput.allowedBy`: the canonical prefixes of the rules that matched; empty renders nothing. */
  prefixes: readonly string[]
}>()

const joined = computed(() => props.prefixes.join(', '))
</script>

<template>
  <Tooltip v-if="prefixes.length > 0">
    <TooltipTrigger as-child>
      <span
        :data-testid="testIds.toolRowRule"
        :data-value="joined"
        class="inline-flex shrink-0 items-center text-muted-foreground"
      >
        <ShieldCheckIcon aria-hidden="true" class="size-3.5" />
        <span class="sr-only">, allowed by rule {{ joined }}</span>
      </span>
    </TooltipTrigger>
    <TooltipContent>Allowed by rule: {{ joined }}</TooltipContent>
  </Tooltip>
</template>
