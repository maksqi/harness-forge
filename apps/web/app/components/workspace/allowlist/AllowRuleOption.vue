<script setup lang="ts">
// "Always allow commands starting with" on the approval card of the builtin shell (docs/UI.md 2.15, 7.3, 7.23;
// ADR-038), mounted by ToolApprovalCard below the warning: the checkbox (tool-approval-allow-rule) reveals, once
// checked, the suggested prefixes (one: an editable Input checked with checkRulePrefix(prefix, command); several:
// read-only chips with the note "This command has several parts: one rule is added for each.";
// tool-approval-rule-prefix, data-value), the scope ToggleGroup This project | All projects (tool-approval-rule-scope,
// data-value) and the hint; inline errors (tool-approval-rule-error, data-code), linked to the input with
// aria-describedby. A command without suggestions shows only the note of ruleSuggestion() (data-slot="allow-rule-note").
// Contract (docs/UI.md 10.5; frozen from Gate P8-0b): props, model and emits below; root tool-approval-allow-rule (the
// checkbox; data-state = checked | unchecked). The model holds the canonical prefixes (null = unchecked); `valid` is
// emitted on every change of the box or the prefix (false while checked with an invalid prefix: the card disables Run).
import type { AllowRules, RulePrefixCheck, ShellRuleScope } from './allow-rule'
import { computed, ref, useId, watch } from 'vue'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { testIds } from '~/utils/testids'
import { checkRulePrefix, COMBINED_COMMANDS_HINT, ruleSuggestion, SEVERAL_RULES_NOTE } from './allow-rule'

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
const labelId = useId()
const errorId = useId()

const SCOPES: ReadonlyArray<{ value: ShellRuleScope, label: string }> = [
  { value: 'project', label: 'This project' },
  { value: 'global', label: 'All projects' },
]

const suggestion = computed(() => ruleSuggestion(props.command))
/** One suggested prefix: an editable input; several: read-only chips. */
const single = computed(() => suggestion.value.prefixes.length === 1)

/** The editable prefix (one suggestion only). */
const draft = ref(suggestion.value.prefixes[0] ?? '')
const scope = ref<ShellRuleScope>(model.value?.scope ?? 'project')
const checked = computed(() => model.value !== null)

/** The check of the edited prefix: the parser's verdict, and it must still cover the command. */
const check = computed<RulePrefixCheck | null>(() => (single.value ? checkRulePrefix(draft.value, props.command) : null))
const valid = computed(() => check.value === null || check.value.ok)
const error = computed(() => (checked.value && check.value && !check.value.ok ? check.value : null))

/** The rules the model holds while checked: the canonical prefix of the input, or every suggested prefix. */
function rules(): AllowRules {
  const result = check.value
  const prefixes = result === null
    ? [...suggestion.value.prefixes]
    : [result.ok ? result.canonical : draft.value.trim()]
  return { prefixes, scope: scope.value }
}

function onChecked(value: boolean | 'indeterminate') {
  model.value = value === true ? rules() : null
  emit('valid', value === true ? valid.value : true)
}

function onPrefix(value: string | number) {
  draft.value = String(value)
  if (!checked.value)
    return
  model.value = rules()
  emit('valid', valid.value)
}

function onScope(value: unknown) {
  // A single ToggleGroup emits an empty value when the active item is clicked again: keep the choice.
  if (value !== 'project' && value !== 'global')
    return
  scope.value = value
  if (checked.value)
    model.value = rules()
}

// Another command (the card is reused for another call): start again from its suggestion.
watch(() => props.command, () => {
  draft.value = suggestion.value.prefixes[0] ?? ''
  if (!checked.value)
    return
  model.value = suggestion.value.prefixes.length > 0 ? rules() : null
  emit('valid', model.value === null || valid.value)
})
</script>

<template>
  <p v-if="suggestion.note" data-slot="allow-rule-note" class="text-xs text-muted-foreground">
    {{ suggestion.note }}
  </p>
  <div v-else data-slot="allow-rule" class="flex min-w-0 flex-col gap-2">
    <div class="flex min-h-6 items-center gap-2 pointer-coarse:min-h-10">
      <Checkbox
        :id="checkboxId"
        :model-value="checked"
        :disabled="disabled"
        :data-testid="testIds.toolApprovalAllowRule"
        class="pointer-coarse:after:-inset-[13px]"
        @update:model-value="onChecked"
      />
      <label :id="labelId" :for="checkboxId" class="text-sm select-none">Always allow commands starting with</label>
    </div>
    <div v-if="checked" data-slot="allow-rule-details" class="flex min-w-0 flex-col gap-2 pl-6">
      <div class="flex min-w-0 flex-wrap items-center gap-2">
        <Input
          v-if="single"
          :model-value="draft"
          :disabled="disabled"
          :aria-labelledby="labelId"
          :aria-invalid="error ? true : undefined"
          :aria-describedby="error ? errorId : undefined"
          :data-testid="testIds.toolApprovalRulePrefix"
          :data-value="draft"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          class="h-8 min-w-0 flex-1 basis-40 font-mono text-sm md:text-sm pointer-coarse:h-10"
          @update:model-value="onPrefix"
        />
        <ul v-else :aria-labelledby="labelId" class="flex min-w-0 flex-wrap items-center gap-1.5">
          <li
            v-for="prefix in suggestion.prefixes"
            :key="prefix"
            :data-testid="testIds.toolApprovalRulePrefix"
            :data-value="prefix"
            class="inline-flex h-7 max-w-full items-center rounded-md border bg-muted/60 px-2 font-mono text-xs break-all"
          >
            {{ prefix }}
          </li>
        </ul>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          :model-value="scope"
          :disabled="disabled"
          aria-label="Where the rule applies"
          :data-testid="testIds.toolApprovalRuleScope"
          :data-value="scope"
          @update:model-value="onScope"
        >
          <ToggleGroupItem
            v-for="option in SCOPES"
            :key="option.value"
            :value="option.value"
            :data-value="option.value"
            class="px-2.5 text-xs pointer-coarse:h-10"
          >
            {{ option.label }}
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
      <p
        v-if="error"
        :id="errorId"
        :data-testid="testIds.toolApprovalRuleError"
        :data-code="error.code"
        class="text-xs text-destructive"
      >
        {{ error.message }}
      </p>
      <p v-if="!single" class="text-xs text-muted-foreground">
        {{ SEVERAL_RULES_NOTE }}
      </p>
      <p class="text-xs text-muted-foreground">
        {{ COMBINED_COMMANDS_HINT }}
      </p>
    </div>
  </div>
</template>
