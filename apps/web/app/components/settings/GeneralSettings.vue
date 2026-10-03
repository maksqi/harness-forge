<script setup lang="ts">
// Settings -> General body (docs/UI.md 9.4): display name, send key, default permission mode (Ask, Accept edits, Auto,
// Off) and effort, max steps (per response in chats without a project, and in project chats: 1-200 each), Alt
// shortcuts (Alt+M / R / P, Alt+V and, since Phase 8, Alt+C for the changes panel), custom instructions and the
// password block. Choices save at once (optimistic, toast on failure); text fields save on blur or Enter (Mod+Enter in
// the instructions), Esc restores the saved value. Bulk export, import and delete-all live in Settings -> Data
// (docs/UI.md 9.8, ADR-024); a single chat is still exported from its chat menus.
import type { ReasoningEffort, SendKey, Settings, ToolMode } from '@harness-forge/shared'
import { computed, ref, useId, watch } from 'vue'
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { isApplePlatform } from '~/components/common/keys'
import { useSettingsStore } from '~/stores/settings'
import { testIds } from '~/utils/testids'
import {
  DISPLAY_NAME_MAX,
  displayNameError,
  EFFORT_OPTIONS,
  INSTRUCTIONS_MAX,
  instructionsError,
  parseMaxSteps,
  sendKeyOptions,
  STEPS_MAX,
  TOOL_MODE_OPTIONS,
} from './general'
import { toastError } from './notify'
import PasswordSection from './PasswordSection.vue'
import { useSettingsLoad } from './settings-load'
import SettingsLoadError from './SettingsLoadError.vue'
import SettingsSection from './SettingsSection.vue'

const settings = useSettingsStore()
const resolved = computed(() => settings.resolved)

const ids = {
  displayName: useId(),
  sendKey: useId(),
  toolMode: useId(),
  effort: useId(),
  maxSteps: useId(),
  projectMaxSteps: useId(),
  altShortcuts: useId(),
  instructions: useId(),
}

const { loading: settingsLoading, loadError: settingsLoadError, load: loadSettings } = useSettingsLoad()

async function save(patch: Partial<Settings>) {
  try {
    await settings.update(patch)
    return true
  }
  catch (error) {
    toastError(error)
    return false
  }
}

// ---------- choices (save on change) ----------

const sendKeys = sendKeyOptions(isApplePlatform())
const toolModeLabel = computed(() => TOOL_MODE_OPTIONS.find(option => option.value === resolved.value.defaultToolMode)?.label)
const effortLabel = computed(() => EFFORT_OPTIONS.find(option => option.value === resolved.value.defaultReasoningEffort)?.label)

function onSendKey(value: unknown) {
  // A single ToggleGroup emits an empty value when the active item is clicked again: keep the setting.
  if ((value === 'enter' || value === 'mod-enter') && value !== resolved.value.sendKey)
    void save({ sendKey: value as SendKey })
}

function onToolMode(value: unknown) {
  if (typeof value === 'string' && value !== resolved.value.defaultToolMode)
    void save({ defaultToolMode: value as ToolMode })
}

function onEffort(value: unknown) {
  if (typeof value === 'string' && value !== resolved.value.defaultReasoningEffort)
    void save({ defaultReasoningEffort: value as ReasoningEffort })
}

// ---------- text fields (save on blur / Enter) ----------

function useTextField(read: () => string) {
  const draft = ref(read())
  const focused = ref(false)
  const error = ref<string | null>(null)
  // Server updates show up unless the user is editing.
  watch(read, (value) => {
    if (!focused.value)
      draft.value = value
  })
  return { draft, focused, error, restore: () => {
    draft.value = read()
    error.value = null
  } }
}

const displayName = useTextField(() => resolved.value.displayName)
const maxSteps = useTextField(() => String(resolved.value.maxSteps))
const projectMaxSteps = useTextField(() => String(resolved.value.projectMaxSteps))
const instructions = useTextField(() => resolved.value.instructions)

async function commitDisplayName() {
  displayName.focused.value = false
  const value = displayName.draft.value.trim()
  displayName.error.value = displayNameError(value)
  if (displayName.error.value)
    return
  displayName.draft.value = value
  if (value !== resolved.value.displayName && !(await save({ displayName: value })))
    displayName.restore()
}

/** Both step limits: an invalid value shows the error and keeps the saved value. */
async function commitSteps(field: ReturnType<typeof useTextField>, key: 'maxSteps' | 'projectMaxSteps') {
  field.focused.value = false
  const parsed = parseMaxSteps(String(field.draft.value ?? ''))
  if ('error' in parsed) {
    field.error.value = parsed.error
    return
  }
  field.error.value = null
  field.draft.value = String(parsed.value)
  if (parsed.value !== resolved.value[key] && !(await save({ [key]: parsed.value })))
    field.restore()
}

async function commitInstructions() {
  instructions.focused.value = false
  const value = instructions.draft.value
  instructions.error.value = instructionsError(value)
  if (instructions.error.value)
    return
  if (value !== resolved.value.instructions && !(await save({ instructions: value })))
    instructions.restore()
}

function blurTarget(event: Event) {
  (event.target as HTMLElement | null)?.blur()
}

function cancelEdit(field: ReturnType<typeof useTextField>, event: Event) {
  field.restore()
  field.focused.value = false
  blurTarget(event)
}

const instructionsCount = computed(() => `${instructions.draft.value.length.toLocaleString('en-US')} / ${INSTRUCTIONS_MAX.toLocaleString('en-US')}`)
</script>

<template>
  <SettingsLoadError
    v-if="settingsLoadError && !settings.loaded"
    title="Could not load your settings"
    :error="settingsLoadError"
    :pending="settingsLoading"
    class="mb-4"
    @retry="loadSettings"
  />
  <SettingsSection title="Profile">
    <FieldGroup>
      <Field orientation="responsive" :data-invalid="displayName.error.value ? true : undefined">
        <FieldContent>
          <FieldLabel :for="ids.displayName">
            Display name
          </FieldLabel>
          <FieldDescription>Used in the greeting.</FieldDescription>
        </FieldContent>
        <div class="grid gap-1.5 @md/field-group:w-72!">
          <Input
            :id="ids.displayName"
            v-model="displayName.draft.value"
            :maxlength="DISPLAY_NAME_MAX"
            placeholder="Your name"
            autocomplete="nickname"
            :aria-invalid="displayName.error.value ? true : undefined"
            :data-testid="testIds.settingsDisplayName"
            @focus="displayName.focused.value = true"
            @blur="commitDisplayName"
            @keydown.enter.prevent="blurTarget"
            @keydown.esc.prevent="cancelEdit(displayName, $event)"
          />
          <FieldError v-if="displayName.error.value" class="text-xs">
            {{ displayName.error.value }}
          </FieldError>
        </div>
      </Field>
    </FieldGroup>
  </SettingsSection>

  <SettingsSection title="Chat" description="Defaults for new chats. Each chat can change them in the composer.">
    <FieldGroup>
      <Field orientation="responsive">
        <FieldContent>
          <FieldLabel :id="ids.sendKey">
            Send messages with
          </FieldLabel>
          <FieldDescription>Shift+Enter always starts a new line.</FieldDescription>
        </FieldContent>
        <ToggleGroup
          type="single"
          variant="outline"
          :model-value="resolved.sendKey"
          :aria-labelledby="ids.sendKey"
          :data-testid="testIds.settingsSendKey"
          @update:model-value="onSendKey"
        >
          <ToggleGroupItem
            v-for="option in sendKeys"
            :key="option.value"
            :value="option.value"
            :data-value="option.value"
            class="px-3"
          >
            {{ option.label }}
          </ToggleGroupItem>
        </ToggleGroup>
      </Field>

      <Field orientation="responsive">
        <FieldContent>
          <FieldLabel :for="ids.toolMode">
            Default permission mode
          </FieldLabel>
          <FieldDescription>How tools may run in a new chat.</FieldDescription>
        </FieldContent>
        <Select :model-value="resolved.defaultToolMode" @update:model-value="onToolMode">
          <SelectTrigger :id="ids.toolMode" class="@md/field-group:w-48!" :data-testid="testIds.settingsDefaultMode">
            <span>{{ toolModeLabel }}</span>
          </SelectTrigger>
          <SelectContent position="popper" align="end" class="w-72">
            <SelectItem v-for="option in TOOL_MODE_OPTIONS" :key="option.value" :value="option.value" :data-value="option.value">
              <span class="flex flex-col gap-0.5">
                <span>{{ option.label }}</span>
                <span class="text-xs text-muted-foreground">{{ option.description }}</span>
              </span>
            </SelectItem>
          </SelectContent>
        </Select>
      </Field>

      <Field orientation="responsive">
        <FieldContent>
          <FieldLabel :for="ids.effort">
            Default reasoning effort
          </FieldLabel>
          <FieldDescription>Applies to models that can reason; the others ignore it.</FieldDescription>
        </FieldContent>
        <Select :model-value="resolved.defaultReasoningEffort" @update:model-value="onEffort">
          <SelectTrigger :id="ids.effort" class="@md/field-group:w-48!" :data-testid="testIds.settingsDefaultEffort">
            <span>{{ effortLabel }}</span>
          </SelectTrigger>
          <SelectContent position="popper" align="end" class="w-56">
            <SelectItem v-for="option in EFFORT_OPTIONS" :key="option.value" :value="option.value" :data-value="option.value">
              <span>{{ option.label }}</span>
              <span v-if="option.description" class="text-xs text-muted-foreground">{{ option.description }}</span>
            </SelectItem>
          </SelectContent>
        </Select>
      </Field>

      <Field orientation="responsive" :data-invalid="maxSteps.error.value ? true : undefined">
        <FieldContent>
          <FieldLabel :for="ids.maxSteps">
            Max steps per response
          </FieldLabel>
          <FieldDescription>How many tool calls and follow-ups one response may chain in chats without a project (1–{{ STEPS_MAX }}).</FieldDescription>
        </FieldContent>
        <div class="grid gap-1.5 @md/field-group:w-48!">
          <Input
            :id="ids.maxSteps"
            v-model="maxSteps.draft.value"
            inputmode="numeric"
            maxlength="3"
            autocomplete="off"
            class="tabular-nums"
            :aria-invalid="maxSteps.error.value ? true : undefined"
            :data-testid="testIds.settingsMaxSteps"
            @focus="maxSteps.focused.value = true"
            @blur="commitSteps(maxSteps, 'maxSteps')"
            @keydown.enter.prevent="blurTarget"
            @keydown.esc.prevent="cancelEdit(maxSteps, $event)"
          />
          <FieldError v-if="maxSteps.error.value" class="text-xs">
            {{ maxSteps.error.value }}
          </FieldError>
        </div>
      </Field>

      <Field orientation="responsive" :data-invalid="projectMaxSteps.error.value ? true : undefined">
        <FieldContent>
          <FieldLabel :for="ids.projectMaxSteps">
            Max steps in project chats
          </FieldLabel>
          <FieldDescription>Agent runs in project chats can take more steps (1–{{ STEPS_MAX }}).</FieldDescription>
        </FieldContent>
        <div class="grid gap-1.5 @md/field-group:w-48!">
          <Input
            :id="ids.projectMaxSteps"
            v-model="projectMaxSteps.draft.value"
            inputmode="numeric"
            maxlength="3"
            autocomplete="off"
            class="tabular-nums"
            :aria-invalid="projectMaxSteps.error.value ? true : undefined"
            :data-testid="testIds.settingsProjectMaxSteps"
            @focus="projectMaxSteps.focused.value = true"
            @blur="commitSteps(projectMaxSteps, 'projectMaxSteps')"
            @keydown.enter.prevent="blurTarget"
            @keydown.esc.prevent="cancelEdit(projectMaxSteps, $event)"
          />
          <FieldError v-if="projectMaxSteps.error.value" class="text-xs">
            {{ projectMaxSteps.error.value }}
          </FieldError>
        </div>
      </Field>

      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel :for="ids.altShortcuts">
            Alt shortcuts
          </FieldLabel>
          <FieldDescription>Use Alt+M, Alt+R and Alt+P for composer menus, Alt+V to dictate and Alt+C for changes.</FieldDescription>
        </FieldContent>
        <Switch
          :id="ids.altShortcuts"
          :model-value="resolved.altShortcuts"
          :data-testid="testIds.settingsAltShortcuts"
          @update:model-value="value => save({ altShortcuts: value })"
        />
      </Field>
    </FieldGroup>
  </SettingsSection>

  <SettingsSection title="Custom instructions" description="Sent with every chat, before the chat's own instructions.">
    <Field :data-invalid="instructions.error.value ? true : undefined">
      <FieldLabel :for="ids.instructions" class="sr-only">
        Custom instructions
      </FieldLabel>
      <Textarea
        :id="ids.instructions"
        v-model="instructions.draft.value"
        rows="6"
        placeholder="For example: Answer concisely. Prefer TypeScript in code examples."
        class="max-h-[50vh] min-h-32 resize-y"
        :aria-invalid="instructions.error.value ? true : undefined"
        :data-testid="testIds.settingsInstructions"
        @focus="instructions.focused.value = true"
        @blur="commitInstructions"
        @keydown.meta.enter.prevent="blurTarget"
        @keydown.ctrl.enter.prevent="blurTarget"
        @keydown.esc.prevent="cancelEdit(instructions, $event)"
      />
      <div class="flex items-start justify-between gap-4 text-xs text-muted-foreground">
        <FieldError v-if="instructions.error.value" class="text-xs">
          {{ instructions.error.value }}
        </FieldError>
        <span v-else>Saved when you leave the field.</span>
        <span class="shrink-0 tabular-nums">{{ instructionsCount }}</span>
      </div>
    </Field>
  </SettingsSection>

  <PasswordSection />
</template>
