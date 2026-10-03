<script setup lang="ts">
// "Always allow commands starting with" on the approval card of the builtin shell (docs/UI.md 2.15, 7.3, 7.23;
// ADR-038), mounted by ToolApprovalCard below the warning: the checkbox (tool-approval-allow-rule) reveals, once
// checked, the suggested prefixes (one: an editable Input checked with checkRulePrefix(prefix, command); several:
// read-only chips with the note "This command has several parts: one rule is added for each.";
// tool-approval-rule-prefix, data-value), the scope ToggleGroup This project | All projects (tool-approval-rule-scope,
// data-value) and the hint; inline errors (tool-approval-rule-error, data-code). A command without suggestions shows
// only the note of ruleSuggestion() (data-slot="allow-rule-note").
// Contract (docs/UI.md 10.5; frozen from Gate P8-0b): props, model and emits below; root tool-approval-allow-rule (the
// checkbox; data-state = checked | unchecked). Stub (C20, P8-0b): the checkbox sets the model to the suggested
// prefixes with the scope This project; no prefix editing or scope choice yet (W8.10).
import type { AllowRules } from './allow-rule'
import { computed, useId } from 'vue'
import { Checkbox } from '@/components/ui/checkbox'
import { testIds } from '~/utils/testids'
import { ruleSuggestion } from './allow-rule'

const props = withDefaults(defineProps<{
  /** The shell command of the card. */
  command: string
  disabled?: boolean
}>(), {
  disabled: false,
})

const emit = defineEmits<{
  /** False while the box is checked with an invalid prefix (the card disables Run). */
  valid: [value: boolean]
}>()

/** The rules to create with the approval; null = the box is unchecked. */
const model = defineModel<AllowRules | null>({ default: null })

const checkboxId = useId()
const suggestion = computed(() => ruleSuggestion(props.command))

function onChecked(value: boolean | 'indeterminate') {
  model.value = value === true ? { prefixes: [...suggestion.value.prefixes], scope: 'project' } : null
  emit('valid', true)
}
</script>

<template>
  <p v-if="suggestion.note" data-slot="allow-rule-note" class="text-xs text-muted-foreground">
    {{ suggestion.note }}
  </p>
  <div v-else class="flex min-h-6 items-center gap-2 pointer-coarse:min-h-10">
    <Checkbox
      :id="checkboxId"
      :model-value="model !== null"
      :disabled="disabled"
      :data-testid="testIds.toolApprovalAllowRule"
      class="pointer-coarse:after:-inset-[13px]"
      @update:model-value="onChecked"
    />
    <label :for="checkboxId" class="text-sm select-none">Always allow commands starting with</label>
  </div>
</template>
