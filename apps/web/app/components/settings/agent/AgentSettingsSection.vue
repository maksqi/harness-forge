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
// - Save approved plans (Phase 10, ADR-047; `settings-plan-files`, `planFiles`): a switch; on, approving a plan in a
//   project chat also writes it to the project.
// - Plan folder (Phase 10; `settings-plan-directory`, `planDirectory`): a mono input, disabled while Save approved
//   plans is off; blur or Enter saves the trimmed value, Esc restores the saved one; checked with the shared settings
//   schema ("Use a folder inside the project, like .harness/plans." / "Use at most 200 characters."); a 400 from the
//   server shows the same texts and keeps the saved value; any other failure restores it with a toast.
// The Shift+Tab switch (`settings-shift-tab-modes`) belongs to GeneralSettings. The section loads the model catalog
// when nothing loaded it yet (the selects and the warning read it). Switches and inputs are 40px targets on coarse
// pointers.
import type { Settings } from '@harness-forge/shared'
import { TriangleAlertIcon } from '@lucide/vue'
import { computed, nextTick, onMounted, useId, watch } from 'vue'
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { loadModelCatalog } from '~/composables/useComposerModel'
import { useModelsStore } from '~/stores/models'
import { useSettingsStore } from '~/stores/settings'
import { hasErrorCode } from '~/utils/errors'
import { testIds } from '~/utils/testids'
import { blurTarget, cancelDraftEdit, commitStepsField, STEPS_MAX, useDraftField } from '../general'
import { toastError } from '../notify'
import SettingsModelSelect from '../SettingsModelSelect.vue'
import SettingsSection from '../SettingsSection.vue'
import {
  PLAN_DIRECTORY_FOLDER_ERROR,
  PLAN_DIRECTORY_PLACEHOLDER,
  planDirectoryError,
  SAME_MODEL_LABEL,
  subagentModelWarning,
} from './agent-settings'

const settings = useSettingsStore()
const models = useModelsStore()
const resolved = computed(() => settings.resolved)

const ids = {
  autoCompact: useId(),
  compactModel: useId(),
  subagentModel: useId(),
  subagentWarning: useId(),
  subagentMaxSteps: useId(),
  planFiles: useId(),
  planDirectory: useId(),
  planDirectoryHelp: useId(),
  planDirectoryError: useId(),
}

/** Switches: a 40px tall hit area on coarse pointers (the switch itself stays 18px). */
const SWITCH_CLASS = 'pointer-coarse:after:-inset-y-[11px]'

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

// ---------- plan files (Phase 10) ----------

const planDirectory = useDraftField(() => resolved.value.planDirectory)

const planDirectoryDescribedBy = computed(() => planDirectory.error.value
  ? `${ids.planDirectoryHelp} ${ids.planDirectoryError}`
  : ids.planDirectoryHelp)

// Turning plan files off disables the folder: drop an unsaved draft and its error.
watch(() => resolved.value.planFiles, (on) => {
  if (!on)
    planDirectory.restore()
})

/**
 * Commits the plan folder: an invalid value shows the error and keeps the saved value; an unchanged value saves
 * nothing; a 400 shows the inline error (the setting keeps its saved value); any other failure restores the saved value
 * with a toast.
 */
async function commitPlanDirectory(): Promise<void> {
  planDirectory.focused.value = false
  const value = String(planDirectory.draft.value ?? '').trim()
  planDirectory.error.value = planDirectoryError(value)
  if (planDirectory.error.value)
    return
  planDirectory.draft.value = value
  if (value === resolved.value.planDirectory)
    return
  try {
    await settings.update({ planDirectory: value })
  }
  catch (error) {
    if (!hasErrorCode(error, 'validation_error')) {
      toastError(error)
      planDirectory.restore()
      return
    }
    // The rollback has put the saved value back into the draft; show what was typed with the error, like a local check.
    await nextTick()
    planDirectory.draft.value = value
    planDirectory.error.value = planDirectoryError(value) ?? PLAN_DIRECTORY_FOLDER_ERROR
  }
}
</script>

<template>
  <SettingsSection title="Agent" description="Long chats, sub-agents and plans.">
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
          :class="SWITCH_CLASS"
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
            class="tabular-nums pointer-coarse:h-10"
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

      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel :for="ids.planFiles">
            Save approved plans
          </FieldLabel>
          <FieldDescription>
            When you approve a plan in a project chat, it's saved as a Markdown file in the project.
          </FieldDescription>
        </FieldContent>
        <Switch
          :id="ids.planFiles"
          :model-value="resolved.planFiles"
          :data-testid="testIds.settingsPlanFiles"
          :class="SWITCH_CLASS"
          @update:model-value="value => save({ planFiles: value })"
        />
      </Field>

      <Field
        orientation="responsive"
        :data-disabled="resolved.planFiles ? undefined : true"
        :data-invalid="planDirectory.error.value ? true : undefined"
      >
        <FieldContent>
          <FieldLabel :for="ids.planDirectory">
            Plan folder
          </FieldLabel>
          <FieldDescription :id="ids.planDirectoryHelp">
            A folder inside the project. Files are named by date and plan title.
          </FieldDescription>
        </FieldContent>
        <div class="grid gap-1.5 @md/field-group:w-96!">
          <Input
            :id="ids.planDirectory"
            v-model="planDirectory.draft.value"
            :disabled="!resolved.planFiles"
            :placeholder="PLAN_DIRECTORY_PLACEHOLDER"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            class="font-mono pointer-coarse:h-10"
            :aria-invalid="planDirectory.error.value ? true : undefined"
            :aria-describedby="planDirectoryDescribedBy"
            :data-testid="testIds.settingsPlanDirectory"
            @focus="planDirectory.focused.value = true"
            @blur="commitPlanDirectory"
            @keydown.enter.prevent="blurTarget"
            @keydown.esc.prevent="cancelDraftEdit(planDirectory, $event)"
          />
          <FieldError v-if="planDirectory.error.value" :id="ids.planDirectoryError" class="text-xs">
            {{ planDirectory.error.value }}
          </FieldError>
        </div>
      </Field>
    </FieldGroup>
  </SettingsSection>
</template>
