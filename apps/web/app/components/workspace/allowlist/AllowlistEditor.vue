<script setup lang="ts">
// The shell rules of one scope (docs/UI.md 2.15, 7.23, 9.10; ADR-038), in AllowlistDialog (a project) and
// GlobalAllowlistSection (every project): the explanation and the risk note, the rules sorted by prefix
// (allowlist-rule: data-rule-id, data-value; mono) with Remove (allowlist-rule-remove, Trash2, "Remove {prefix}";
// immediate), the add form (allowlist-input, allowlist-add; Enter submits; checkRulePrefix and the one-word warning),
// inline errors (allowlist-error, data-code), "No allowed commands yet." (allowlist-empty) and the failed-load Retry.
// There is no edit: a rule is removed and added again. Reads and writes useShellRulesStore.
// Contract (docs/UI.md 10.5; frozen from Gate P8-0b): props below, no emits; no root test id
// (data-slot="allowlist-editor"). Stub (C20, P8-0b): the loaded rules (the store does not load them yet) or the empty
// state; no add form or Remove yet (W8.11).
import { computed } from 'vue'
import { useShellRulesStore } from '~/stores/shell-rules'
import { testIds } from '~/utils/testids'

const props = defineProps<{
  /** The project whose rules are shown; null = the global rules ("Allowed in every project"). */
  projectId: string | null
}>()

const store = useShellRulesStore()
const rules = computed(() => (props.projectId === null ? store.global : store.forProject(props.projectId)))
</script>

<template>
  <div data-slot="allowlist-editor" class="flex min-w-0 flex-col gap-2">
    <ul v-if="rules.length > 0" class="flex min-w-0 flex-col">
      <li
        v-for="rule in rules"
        :key="rule.id"
        :data-testid="testIds.allowlistRule"
        :data-rule-id="rule.id"
        :data-value="rule.prefix"
        class="min-w-0 truncate py-1 font-mono text-sm"
      >
        {{ rule.prefix }}
      </li>
    </ul>
    <p v-else :data-testid="testIds.allowlistEmpty" class="text-sm text-muted-foreground">
      No allowed commands yet.
    </p>
  </div>
</template>
