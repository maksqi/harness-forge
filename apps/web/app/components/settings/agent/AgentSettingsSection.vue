<script setup lang="ts">
// Settings -> General -> Agent (docs/UI.md 2.16, 9.11, 10.6): mounted by GeneralSettings between the Chat fields and
// Custom instructions. No props, no emits; it reads and writes the settings store (optimistic, rolled back with an error
// toast like every General field):
// - Automatic compaction (`settings-auto-compact`, `autoCompact`): a switch; off, the server leaves the oldest messages
//   out instead (the `context-trimmed` notice), and `/compact` still works.
// - Compaction model (`settings-compaction-model`, `compactModelRef`) and Sub-agent model (`settings-subagent-model`,
//   `subagentModelRef`): SettingsModelSelect (chat models), "Same model as the chat" = null. A sub-agent model that
//   can't call tools (`capabilities.tools` false) gets a warning; a model gone from the catalog shows the select's
//   usual unknown state (the server then falls back to the chat's model).
// - Sub-agent max steps (`settings-subagent-max-steps`, `subagentMaxSteps`): 1-200 with the rules of Max steps (blur or
//   Enter saves, Esc restores, an invalid value shows the error and keeps the saved value).
// The Shift+Tab switch (`settings-shift-tab-modes`) belongs to GeneralSettings. The section loads the model catalog
// when nothing loaded it yet (the selects and the warning read it).
import type { Settings } from '@harness-forge/shared'
import { TriangleAlertIcon } from '@lucide/vue'
import { computed, onMounted, useId } from 'vue'
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { loadModelCatalog } from '~/composables/useComposerModel'
import { useModelsStore } from '~/stores/models'
import { useSettingsStore } from '~/stores/settings'
import { testIds } from '~/utils/testids'
import { blurTarget, cancelDraftEdit, commitStepsField, STEPS_MAX, useDraftField } from '../general'
import { toastError } from '../notify'
import SettingsModelSelect from '../SettingsModelSelect.vue'
import SettingsSection from '../SettingsSection.vue'
import { SAME_MODEL_LABEL, subagentModelWarning } from './agent-settings'

const settings = useSettingsStore()
const models = useModelsStore()
const resolved = computed(() => settings.resolved)

const ids = {
  autoCompact: useId(),
  compactModel: useId(),
  subagentModel: useId(),
  subagentWarning: useId(),
  subagentMaxSteps: useId(),
}

onMounted(loadModelCatalog)

async function save(patch: Partial<Settings>): Promise<boolean> {
  try {
    await settings.update(patch)
    return true
  }
  catch (error) {
    toastError(error)
    return false
  }
}

const subagentWarning = computed(() => {
  const modelRef = resolved.value.subagentModelRef
  return modelRef ? subagentModelWarning(models.byRef(modelRef)) : null
})

const subagentMaxSteps = useDraftField(() => String(resolved.value.subagentMaxSteps))

function commitSubagentMaxSteps() {
  return commitStepsField(subagentMaxSteps, resolved.value.subagentMaxSteps, value => save({ subagentMaxSteps: value }))
}
</script>

<template>
  <SettingsSection title="Agent" description="Long chats and sub-agents.">
    <FieldGroup>
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel :for="ids.autoCompact">
            Automatic compaction
          </FieldLabel>
          <FieldDescription>
            Summarize older messages when a chat nears the model's context window. When off, older messages are left
            out instead.
          </FieldDescription>
        </FieldContent>
        <Switch
          :id="ids.autoCompact"
          :model-value="resolved.autoCompact"
          :data-testid="testIds.settingsAutoCompact"
          @update:model-value="value => save({ autoCompact: value })"
        />
      </Field>

      <Field orientation="responsive">
        <FieldContent>
          <FieldLabel :for="ids.compactModel">
            Compaction model
          </FieldLabel>
          <FieldDescription>Writes the summary when a chat is compacted.</FieldDescription>
        </FieldContent>
        <SettingsModelSelect
          :id="ids.compactModel"
          :model-value="resolved.compactModelRef"
          kind="chat"
          allow-none
          :none-label="SAME_MODEL_LABEL"
          label="Compaction model"
          :data-testid="testIds.settingsCompactionModel"
          class="@md/field-group:w-96!"
          @update:model-value="value => save({ compactModelRef: value })"
        />
      </Field>

      <Field orientation="responsive">
        <FieldContent>
          <FieldLabel :for="ids.subagentModel">
            Sub-agent model
          </FieldLabel>
          <FieldDescription>Runs the tasks the agent hands to sub-agents.</FieldDescription>
          <p
            v-if="subagentWarning"
            :id="ids.subagentWarning"
            data-slot="subagent-model-warning"
            class="flex items-start gap-1.5 text-sm text-warning"
          >
            <TriangleAlertIcon aria-hidden="true" class="mt-0.5 size-3.5 shrink-0" />
            <span>{{ subagentWarning }}</span>
          </p>
        </FieldContent>
        <SettingsModelSelect
          :id="ids.subagentModel"
          :model-value="resolved.subagentModelRef"
          kind="chat"
          allow-none
          :none-label="SAME_MODEL_LABEL"
          label="Sub-agent model"
          :aria-describedby="subagentWarning ? ids.subagentWarning : undefined"
          :data-testid="testIds.settingsSubagentModel"
          class="@md/field-group:w-96!"
          @update:model-value="value => save({ subagentModelRef: value })"
        />
      </Field>

      <Field orientation="responsive" :data-invalid="subagentMaxSteps.error.value ? true : undefined">
        <FieldContent>
          <FieldLabel :for="ids.subagentMaxSteps">
            Sub-agent max steps
          </FieldLabel>
          <FieldDescription>How many tool calls one sub-agent may chain (1–{{ STEPS_MAX }}).</FieldDescription>
        </FieldContent>
        <div class="grid gap-1.5 @md/field-group:w-48!">
          <Input
            :id="ids.subagentMaxSteps"
            v-model="subagentMaxSteps.draft.value"
            inputmode="numeric"
            maxlength="3"
            autocomplete="off"
            class="tabular-nums"
            :aria-invalid="subagentMaxSteps.error.value ? true : undefined"
            :data-testid="testIds.settingsSubagentMaxSteps"
            @focus="subagentMaxSteps.focused.value = true"
            @blur="commitSubagentMaxSteps"
            @keydown.enter.prevent="blurTarget"
            @keydown.esc.prevent="cancelDraftEdit(subagentMaxSteps, $event)"
          />
          <FieldError v-if="subagentMaxSteps.error.value" class="text-xs">
            {{ subagentMaxSteps.error.value }}
          </FieldError>
        </div>
      </Field>
    </FieldGroup>
  </SettingsSection>
</template>
