<script setup lang="ts">
// One item of the import preview (Phase 12, ADR-055; docs/UI.md 2.19, 9.14, 10.9, 14.2): a list item
// (`claude-import-item`, `data-kind`, `data-status`, `data-name`) with its checkbox (`claude-import-select`, named
// "{kind} {name}"; none for unchanged, unsupported and invalid items), the name (a prompt hook gets `MessageSquareText`),
// the source file (mono, "linked" when the scan followed a link), the status word (`STATUS_TEXT`, never color alone), the
// summary, the warnings and diagnostics as text, then:
// - `update` / `conflict` items: the resolution select (`claude-import-resolution`, `data-value`): Keep mine (skip),
//   Replace (overwrite) and Import as {renameTo} (rename), as the item's `actions` allow;
// - the `CLAUDE.md` item: "Add to your instructions" (`claude-import-instructions-mode`, `data-value`): Append / Replace /
//   Skip (the item's actions; Skip = not picked; the preview keeps the selection's mode in step);
// - items that run commands: "Imported turned off: it runs shell lines." ("… it starts a program." for stdio servers;
//   "From the project {path}: imported turned off." for per-project servers) and the switch Turn on after import
//   (`data-action="enable"`, described by the note; off by default);
// - MCP servers that need values: "Needs {names}" and a password input per name (`data-action="variable"`, `data-name`;
//   sent only with the apply).
// `update:choice(null)` = not selected. Store-free.
// Props, emits and the root test id are frozen from Gate P12-0b (C46 stub); body W12.10 (P12-A).
import type { ClaudeImportAction, ClaudeImportPlan } from '@harness-forge/shared'
import type { ClaudeImportChoice } from './claude-import'
import { MessageSquareTextIcon, ShieldAlertIcon } from '@lucide/vue'
import { computed, useId } from 'vue'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { testIds } from '~/utils/testids'
import { canEnable, defaultChoice, isPromptHook, isSelectable, KIND_TEXT, STATUS_TEXT, turnedOffNote, WARNING_TEXT } from './claude-import'

const props = defineProps<{ item: ClaudeImportPlan['items'][number], choice: ClaudeImportChoice | null }>()

const emit = defineEmits<{ 'update:choice': [choice: ClaudeImportChoice | null] }>()

const SELECT_CLASS = 'h-8 max-w-full min-w-0 rounded-md border border-input bg-transparent px-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30 pointer-coarse:h-10'

const ids = { check: useId(), note: useId(), select: useId() }

const selectable = computed(() => isSelectable(props.item))
const instructions = computed(() => props.item.kind === 'instructions' && selectable.value)
const resolvable = computed(() => selectable.value && !instructions.value && (props.item.status === 'update' || props.item.status === 'conflict'))
const prompt = computed(() => isPromptHook(props.item))
const note = computed(() => turnedOffNote(props.item))
const enableable = computed(() => canEnable(props.item))
const linked = computed(() => props.item.warnings.includes('linked'))
const warningLines = computed(() => props.item.warnings.flatMap(warning => WARNING_TEXT[warning] ?? []))
const diagnosticLines = computed(() => props.item.diagnostics
  .filter(diagnostic => diagnostic.level !== 'info' && diagnostic.message !== props.item.summary)
  .map(diagnostic => diagnostic.message))
const variables = computed(() => (props.item.kind === 'mcp-server' ? props.item.variables ?? [] : []))
const checkboxName = computed(() => `${KIND_TEXT[props.item.kind]} ${props.item.name}`)
const modeOptions = computed(() => (['append', 'replace', 'skip'] as const).filter(action => action === 'skip' || props.item.actions.includes(action)))
const mode = computed(() => (props.choice?.action === 'append' || props.choice?.action === 'replace' ? props.choice.action : 'skip'))

/** The choice for a check: the default one, else the first action that is not skip (a rename with its suggestion). */
function firstChoice(): ClaudeImportChoice {
  const fallback = defaultChoice(props.item)
  if (fallback)
    return fallback
  const first: ClaudeImportAction = props.item.actions.find(action => action !== 'skip') ?? props.item.defaultAction
  return first === 'rename' && props.item.renameTo ? { action: 'rename', renameTo: props.item.renameTo } : { action: first }
}

/** A new choice that keeps the item's `enable` and variables. */
function withAction(action: ClaudeImportAction): ClaudeImportChoice {
  const { renameTo: _renameTo, ...rest } = props.choice ?? {}
  return action === 'rename' && props.item.renameTo ? { ...rest, action, renameTo: props.item.renameTo } : { ...rest, action }
}

function onChecked(value: boolean | 'indeterminate'): void {
  emit('update:choice', value === true ? { ...firstChoice(), ...(props.choice?.enable ? { enable: true } : {}) } : null)
}

function onResolution(event: Event): void {
  const action = (event.target as HTMLSelectElement).value
  if (action === 'skip')
    emit('update:choice', null)
  else if ((action === 'overwrite' || action === 'rename') && props.item.actions.includes(action))
    emit('update:choice', withAction(action))
}

function onMode(event: Event): void {
  const action = (event.target as HTMLSelectElement).value
  if (action === 'skip')
    emit('update:choice', null)
  else if ((action === 'append' || action === 'replace') && props.item.actions.includes(action))
    emit('update:choice', withAction(action))
}

function onEnable(value: boolean): void {
  const base = props.choice ?? firstChoice()
  const { enable: _enable, ...rest } = base
  emit('update:choice', value ? { ...rest, enable: true } : rest)
}

function onVariable(name: string, value: string | number): void {
  const base = props.choice ?? firstChoice()
  emit('update:choice', { ...base, variables: { ...base.variables, [name]: String(value) } })
}
</script>

<template>
  <li
    :data-testid="testIds.claudeImportItem"
    :data-kind="item.kind"
    :data-status="item.status"
    :data-name="item.name"
    class="flex min-w-0 items-start gap-3 py-2.5"
  >
    <Checkbox
      v-if="selectable"
      :id="ids.check"
      :model-value="choice !== null"
      :aria-label="checkboxName"
      :data-testid="testIds.claudeImportSelect"
      class="mt-0.5 pointer-coarse:after:-inset-[13px]"
      @update:model-value="onChecked"
    />
    <span v-else aria-hidden="true" class="size-4 shrink-0" />
    <div class="grid min-w-0 flex-1 gap-1">
      <div class="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <MessageSquareTextIcon v-if="prompt" aria-hidden="true" class="size-3.5 shrink-0 self-center text-muted-foreground" />
        <component
          :is="selectable ? 'label' : 'span'"
          :for="selectable ? ids.check : undefined"
          class="min-w-0 text-sm font-medium break-all"
        >
          {{ item.name }}
        </component>
        <span class="min-w-0 font-mono text-xs break-all text-muted-foreground">
          {{ item.source.file }}<template v-if="linked"> · linked</template>
        </span>
        <span class="ml-auto shrink-0 text-xs font-medium" data-slot="claude-import-status">{{ STATUS_TEXT[item.status] }}</span>
      </div>
      <p v-if="item.summary" class="text-xs break-words text-muted-foreground">
        {{ item.summary }}
      </p>
      <p v-for="(line, index) in [...warningLines, ...diagnosticLines]" :key="index" class="text-xs break-words text-muted-foreground">
        {{ line }}
      </p>

      <select
        v-if="resolvable"
        :id="ids.select"
        :value="choice?.action ?? 'skip'"
        :aria-label="`Resolution for ${item.name}`"
        :data-testid="testIds.claudeImportResolution"
        :data-value="choice?.action ?? 'skip'"
        :class="SELECT_CLASS"
        class="justify-self-start"
        @change="onResolution"
      >
        <option value="skip">
          Keep mine
        </option>
        <option v-if="item.actions.includes('overwrite')" value="overwrite">
          Replace
        </option>
        <option v-if="item.actions.includes('rename') && item.renameTo" value="rename">
          Import as {{ item.renameTo }}
        </option>
      </select>

      <label v-if="instructions" class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        Add to your instructions
        <select
          :value="mode"
          :data-testid="testIds.claudeImportInstructionsMode"
          :data-value="mode"
          :class="SELECT_CLASS"
          class="text-foreground"
          @change="onMode"
        >
          <option v-for="option in modeOptions" :key="option" :value="option">
            {{ option === 'append' ? 'Append' : option === 'replace' ? 'Replace' : 'Skip' }}
          </option>
        </select>
      </label>

      <div v-if="note" class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <p :id="ids.note" class="flex items-center gap-1.5 text-xs" data-slot="claude-import-turned-off">
          <ShieldAlertIcon aria-hidden="true" class="size-3.5 shrink-0 text-warning" />
          {{ note }}
        </p>
        <label v-if="enableable" class="flex items-center gap-2 text-xs">
          <Switch
            :model-value="choice?.enable === true"
            :disabled="choice === null"
            :aria-describedby="ids.note"
            data-action="enable"
            class="pointer-coarse:after:-inset-y-[11px]"
            @update:model-value="onEnable"
          />
          Turn on after import
        </label>
      </div>

      <div v-if="variables.length > 0" class="grid gap-1.5">
        <p class="text-xs text-muted-foreground">
          Needs {{ variables.join(', ') }}
        </p>
        <label v-for="name in variables" :key="name" class="grid gap-1 text-xs sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)] sm:items-center">
          <span class="truncate font-mono">{{ name }}</span>
          <Input
            type="password"
            autocomplete="off"
            :model-value="choice?.variables?.[name] ?? ''"
            :disabled="choice === null"
            data-action="variable"
            :data-name="name"
            class="h-8 pointer-coarse:h-10"
            @update:model-value="value => onVariable(name, value)"
          />
        </label>
      </div>
    </div>
  </li>
</template>
