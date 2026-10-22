<script setup lang="ts">
// An MCP server's question under its running tool row (Phase 14, ADR-060; docs/UI.md 2.20, 7.35, 10.10, 14): a `<form>`
// in a `role="region"` named "{server} needs more information": the countdown to `expiresAt`, × "Dismiss request"
// (cancel), the message as plain text (never Markdown or links: it is untrusted), one field per form field
// (`elicitation-field`, `data-name`, `data-type`), the caution "Share only what you would give {server}. Never enter
// passwords here.", Decline and Submit. `busy` = the answer is being posted (`submitting`); `issues` = a 400 answer's
// field issues; `gone` = "This request is no longer open.". Never takes focus by itself; `focusFirst()` (the jump pill)
// focuses the first field, else Submit. ToolPart renders it through TOOL_ELICITATIONS.
// Props, emits, the exposed `focusFirst` and the root test id are frozen from Gate P14-0b (C54 stub); W14.9 implements the
// card in P14-A (`parseElicitationForm`'s fields, `elicitationInitialValues`, `coerceElicitationValue`,
// `validateElicitationAnswer`, `isSensitiveField` of `@harness-forge/shared`).
// W14.9: fields per type — string → Input (`type` email / url / date / datetime-local from `format`, `minlength` /
// `maxlength`), number / integer → a numeric Input (`min`, `max`, `step` 1 or any), boolean → Checkbox, enum → RadioGroup
// for four options or fewer, else Select ("Choose…"), multi-select → a `role="group"` of checkboxes (a scroll box above
// eight options). Values start from `elicitationInitialValues` (a `date-time` default as local time) and are coerced and
// checked by `elicitationAnswer` (the server's rules): an invalid Submit shows the issues under their fields
// (`aria-invalid`, `aria-describedby`) and focuses the first invalid one; a 400's `issues` do the same (read by
// `elicitationIssuesOf`: the server sends `path: ['content', <field>]`, not `field`). At 0:00 the card
// is `expired` ("This request expired.", controls disabled); a `gone` answer reads "This request is no longer open." (the
// root's `data-state` is `expired` too: the request is closed). When the card closes while focus is inside it, focus stays
// on the card's container (`tabindex="-1"`). The root carries `data-elicitation-id` (ChatView's jump pill finds the card).
// At 390px the buttons are full width and stacked with Submit first; fields and buttons are 40px on coarse pointers.
import type { ElicitationField, ElicitationFieldIssue, ElicitationRawValue, McpElicitation, McpElicitationAnswerBody } from '@harness-forge/shared'
import { elicitationInitialValues, isSensitiveField } from '@harness-forge/shared'
import { MessageCircleQuestionIcon, TimerIcon, TriangleAlertIcon, XIcon } from '@lucide/vue'
import { computed, nextTick, onBeforeUnmount, ref, useId, useTemplateRef, watch } from 'vue'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { testIds } from '~/utils/testids'
import {
  countdownText,
  ELICITATION_CHOOSE_TEXT,
  ELICITATION_EXPIRED_TEXT,
  ELICITATION_GONE_TEXT,
  ELICITATION_MINUTE_MS,
  ELICITATION_SCROLL_OPTIONS_MAX,
  elicitationAnswer,
  elicitationCautionText,
  elicitationControl,
  elicitationFieldHint,
  elicitationFieldLabel,
  elicitationFocusTarget,
  elicitationHeading,
  elicitationInputType,
  elicitationIssuesOf,
  elicitationSensitiveText,
  firstFocusableControl,
  isLongElicitationMessage,
} from './elicitation'

const props = withDefaults(defineProps<{
  request: McpElicitation
  /** The answer is being posted (`data-state="submitting"`). */
  busy?: boolean
  /** A 400 answer's field issues. */
  issues?: readonly ElicitationFieldIssue[]
  /** A 'gone' answer: "This request is no longer open.". */
  gone?: boolean
}>(), {
  busy: false,
  issues: () => [],
  gone: false,
})

const emit = defineEmits<{
  respond: [answer: McpElicitationAnswerBody]
}>()

const baseId = useId()
const headingId = `${baseId}-heading`
const root = useTemplateRef<HTMLElement>('root')

const server = computed(() => props.request.serverName || props.request.serverId)
const fields = computed<readonly ElicitationField[]>(() => props.request.form.fields)

/** The raw values of the controls (text, a checkbox's boolean, a multi-select's values). */
const values = ref<Record<string, ElicitationRawValue>>({})
/** The issues shown under the fields (the last invalid Submit, or a 400 answer). */
const shownIssues = ref<readonly ElicitationFieldIssue[]>([])
/** "Show more" of a long message. */
const messageOpen = ref(false)

watch(() => props.request.id, () => {
  values.value = elicitationInitialValues(props.request.form)
  shownIssues.value = []
  messageOpen.value = false
}, { immediate: true })

// ---------- countdown ----------

const now = ref(Date.now())
let ticker: ReturnType<typeof setInterval> | undefined
function stopTicker() {
  clearInterval(ticker)
  ticker = undefined
}
watch(() => props.request.expiresAt, (expiresAt) => {
  now.value = Date.now()
  stopTicker()
  if (expiresAt > now.value) {
    ticker = setInterval(() => {
      now.value = Date.now()
      if (now.value >= props.request.expiresAt)
        stopTicker()
    }, 1000)
  }
}, { immediate: true })
onBeforeUnmount(stopTicker)

const msLeft = computed(() => props.request.expiresAt - now.value)
const expired = computed(() => msLeft.value <= 0)
const lastMinute = computed(() => !expired.value && msLeft.value <= ELICITATION_MINUTE_MS)

// ---------- state ----------

/** Answered elsewhere or expired: the card no longer takes an answer. */
const closed = computed(() => expired.value || props.gone)
const disabled = computed(() => closed.value || props.busy)
const state = computed(() => (closed.value ? 'expired' : props.busy ? 'submitting' : 'pending'))
const closedText = computed(() => (props.gone ? ELICITATION_GONE_TEXT : expired.value ? ELICITATION_EXPIRED_TEXT : null))

// A card that closes while focus is inside it keeps the focus on its own container (its controls become disabled).
watch(closed, (isClosed) => {
  const active = typeof document === 'undefined' ? null : document.activeElement
  if (isClosed && root.value && active instanceof HTMLElement && active !== root.value && root.value.contains(active))
    root.value.focus()
})

const longMessage = computed(() => isLongElicitationMessage(props.request.message))
const sensitive = computed(() => new Set(fields.value.filter(field => isSensitiveField(field)).map(field => field.name)))

// ---------- fields ----------

function controlId(index: number): string {
  return `${baseId}-field-${index}`
}

function optionId(index: number, option: number): string {
  return `${baseId}-field-${index}-option-${option}`
}

function issueOf(name: string): ElicitationFieldIssue | null {
  return shownIssues.value.find(issue => issue.field === name) ?? null
}

/** Issues the form's fields cannot show (an unknown field, a malformed answer). */
const formIssues = computed(() => shownIssues.value.filter(issue => !fields.value.some(field => field.name === issue.field)))

/** The ids that describe a field's control: its description and hint, the secret warning, its error. */
function describedBy(field: ElicitationField, index: number): string | undefined {
  const ids: string[] = []
  if (field.description || elicitationFieldHint(field))
    ids.push(`${controlId(index)}-help`)
  if (sensitive.value.has(field.name))
    ids.push(`${controlId(index)}-sensitive`)
  if (issueOf(field.name))
    ids.push(`${controlId(index)}-error`)
  return ids.length > 0 ? ids.join(' ') : undefined
}

function textOf(name: string): string {
  const value = values.value[name]
  return typeof value === 'string' ? value : ''
}

function listOf(name: string): readonly string[] {
  const value = values.value[name]
  return Array.isArray(value) ? value : []
}

function setValue(name: string, value: ElicitationRawValue) {
  values.value = { ...values.value, [name]: value }
  if (shownIssues.value.some(issue => issue.field === name))
    shownIssues.value = shownIssues.value.filter(issue => issue.field !== name)
}

function toggleOption(field: ElicitationField, option: string, checked: boolean) {
  const selected = listOf(field.name)
  const next = checked ? [...selected.filter(value => value !== option), option] : selected.filter(value => value !== option)
  // Keep the options' order.
  const order = field.options?.map(item => item.value) ?? []
  setValue(field.name, [...next].sort((a, b) => order.indexOf(a) - order.indexOf(b)))
}

/** Focuses the control of the first field with an issue (else the first form-level issue's Submit). */
function focusInvalid() {
  const card = root.value
  if (!card)
    return
  const index = fields.value.findIndex(field => issueOf(field.name) !== null)
  const element = index >= 0
    ? card.querySelectorAll<HTMLElement>(`[data-testid="${testIds.elicitationField}"]`)[index]
    : null
  const target = (element ? firstFocusableControl(element) : null) ?? elicitationFocusTarget(card)
  target?.focus()
}

// A 400 answer's issues (the server's `path: ['content', <field>]` shape included): shown under their fields, focus on
// the first one.
watch(() => props.issues, (issues) => {
  const read = elicitationIssuesOf(issues)
  if (read.length === 0)
    return
  shownIssues.value = read
  void nextTick(focusInvalid)
})

// ---------- answers ----------

function onSubmit() {
  if (disabled.value)
    return
  const result = elicitationAnswer(props.request.form, values.value)
  if (!result.ok) {
    shownIssues.value = result.issues
    void nextTick(focusInvalid)
    return
  }
  shownIssues.value = []
  emit('respond', { action: 'accept', content: result.content })
}

function onDecline() {
  if (!disabled.value)
    emit('respond', { action: 'decline' })
}

function onDismiss() {
  if (!disabled.value)
    emit('respond', { action: 'cancel' })
}

/** Focuses the first field, else Submit (the jump pill). */
function focusFirst(): void {
  if (root.value)
    elicitationFocusTarget(root.value)?.focus()
}

defineExpose({ focusFirst })

const FIELD_ROW = 'flex min-h-6 items-center gap-2 pointer-coarse:min-h-10'
const CONTROL_HIT = 'pointer-coarse:after:-inset-[13px]'
</script>

<template>
  <section
    ref="root"
    role="region"
    tabindex="-1"
    :aria-labelledby="headingId"
    :aria-busy="busy ? 'true' : undefined"
    :data-testid="testIds.elicitationCard"
    :data-state="state"
    :data-server-id="request.serverId"
    :data-elicitation-id="request.id"
    class="min-w-0 rounded-lg border bg-card p-3 text-sm outline-none"
  >
    <form novalidate class="flex min-w-0 flex-col gap-3" @submit.prevent="onSubmit">
      <div class="flex min-w-0 items-start gap-2">
        <MessageCircleQuestionIcon aria-hidden="true" class="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <h4 :id="headingId" class="min-w-0 flex-1 font-medium break-words">
          {{ elicitationHeading(server) }}
        </h4>
        <span
          :data-testid="testIds.elicitationCountdown"
          aria-hidden="true"
          :class="cn('mt-0.5 flex shrink-0 items-center gap-1 text-xs tabular-nums text-muted-foreground', lastMinute && 'text-warning')"
        >
          <TimerIcon class="size-3.5" />
          {{ countdownText(msLeft) }}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Dismiss request"
          :data-testid="testIds.elicitationDismiss"
          :disabled="disabled"
          class="-my-0.5 -mr-1 shrink-0 text-muted-foreground pointer-coarse:size-10"
          @click="onDismiss"
        >
          <XIcon aria-hidden="true" />
        </Button>
      </div>

      <div v-if="request.message" class="flex min-w-0 flex-col items-start gap-1">
        <p
          :data-testid="testIds.elicitationMessage"
          :class="cn('w-full break-words whitespace-pre-wrap text-muted-foreground', longMessage && !messageOpen && 'line-clamp-6')"
        >
          {{ request.message }}
        </p>
        <button
          v-if="longMessage"
          type="button"
          :aria-expanded="messageOpen"
          class="rounded-sm text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:min-h-10"
          @click="messageOpen = !messageOpen"
        >
          {{ messageOpen ? 'Show less' : 'Show more' }}
        </button>
      </div>

      <div
        v-for="(field, index) in fields"
        :key="field.name"
        :data-testid="testIds.elicitationField"
        :data-name="field.name"
        :data-type="field.type"
        class="flex min-w-0 flex-col gap-1.5"
      >
        <!-- boolean: the checkbox with its label on one line -->
        <div v-if="elicitationControl(field) === 'checkbox'" :class="FIELD_ROW">
          <Checkbox
            :id="controlId(index)"
            :model-value="values[field.name] === true"
            :disabled="disabled"
            :aria-invalid="issueOf(field.name) ? 'true' : undefined"
            :aria-describedby="describedBy(field, index)"
            :class="CONTROL_HIT"
            @update:model-value="value => setValue(field.name, value === true)"
          />
          <label :for="controlId(index)" class="min-w-0 break-words select-none">
            {{ elicitationFieldLabel(field) }}<template v-if="field.required"><span aria-hidden="true"> *</span><span class="sr-only"> required</span></template>
          </label>
        </div>

        <template v-else>
          <!-- a group (radios, checkboxes) is named by a text label; a single control by its label element -->
          <span
            v-if="elicitationControl(field) === 'radios' || elicitationControl(field) === 'checkboxes'"
            :id="`${controlId(index)}-label`"
            class="font-medium break-words"
          >
            {{ elicitationFieldLabel(field) }}<template v-if="field.required"><span aria-hidden="true"> *</span><span class="sr-only"> required</span></template>
          </span>
          <label v-else :id="`${controlId(index)}-label`" :for="controlId(index)" class="font-medium break-words">
            {{ elicitationFieldLabel(field) }}<template v-if="field.required"><span aria-hidden="true"> *</span><span class="sr-only"> required</span></template>
          </label>

          <Input
            v-if="elicitationControl(field) === 'input'"
            :id="controlId(index)"
            :model-value="textOf(field.name)"
            :type="elicitationInputType(field)"
            :minlength="field.minLength"
            :maxlength="field.maxLength"
            autocomplete="off"
            :disabled="disabled"
            :aria-required="field.required ? 'true' : undefined"
            :aria-invalid="issueOf(field.name) ? 'true' : undefined"
            :aria-describedby="describedBy(field, index)"
            class="pointer-coarse:h-10"
            @update:model-value="value => setValue(field.name, String(value))"
          />

          <Input
            v-else-if="elicitationControl(field) === 'number'"
            :id="controlId(index)"
            :model-value="textOf(field.name)"
            type="number"
            :min="field.minimum"
            :max="field.maximum"
            :step="field.type === 'integer' ? 1 : 'any'"
            :inputmode="field.type === 'integer' ? 'numeric' : 'decimal'"
            autocomplete="off"
            :disabled="disabled"
            :aria-required="field.required ? 'true' : undefined"
            :aria-invalid="issueOf(field.name) ? 'true' : undefined"
            :aria-describedby="describedBy(field, index)"
            class="tabular-nums pointer-coarse:h-10"
            @update:model-value="value => setValue(field.name, String(value))"
          />

          <RadioGroup
            v-else-if="elicitationControl(field) === 'radios'"
            :model-value="textOf(field.name) || undefined"
            :disabled="disabled"
            :aria-labelledby="`${controlId(index)}-label`"
            :aria-required="field.required ? 'true' : undefined"
            :aria-invalid="issueOf(field.name) ? 'true' : undefined"
            :aria-describedby="describedBy(field, index)"
            class="flex flex-col gap-1 sm:flex-row sm:flex-wrap sm:gap-x-4"
            @update:model-value="value => setValue(field.name, String(value ?? ''))"
          >
            <div v-for="(option, optionIndex) in field.options" :key="option.value" :class="FIELD_ROW">
              <RadioGroupItem :id="optionId(index, optionIndex)" :value="option.value" :class="CONTROL_HIT" />
              <label :for="optionId(index, optionIndex)" class="min-w-0 break-words select-none">{{ option.label }}</label>
            </div>
          </RadioGroup>

          <Select
            v-else-if="elicitationControl(field) === 'select'"
            :model-value="textOf(field.name) || undefined"
            :disabled="disabled"
            @update:model-value="value => setValue(field.name, typeof value === 'string' ? value : '')"
          >
            <SelectTrigger
              :id="controlId(index)"
              :aria-required="field.required ? 'true' : undefined"
              :aria-invalid="issueOf(field.name) ? 'true' : undefined"
              :aria-describedby="describedBy(field, index)"
              class="w-full pointer-coarse:h-10"
            >
              <SelectValue :placeholder="ELICITATION_CHOOSE_TEXT" />
            </SelectTrigger>
            <SelectContent position="popper" align="start">
              <SelectItem v-for="option in field.options" :key="option.value" :value="option.value" :data-value="option.value">
                {{ option.label }}
              </SelectItem>
            </SelectContent>
          </Select>

          <div
            v-else
            role="group"
            :aria-labelledby="`${controlId(index)}-label`"
            :aria-invalid="issueOf(field.name) ? 'true' : undefined"
            :aria-describedby="describedBy(field, index)"
            :class="cn(
              'flex min-w-0 flex-col gap-1 sm:flex-row sm:flex-wrap sm:gap-x-4',
              (field.options?.length ?? 0) > ELICITATION_SCROLL_OPTIONS_MAX && 'max-h-48 overflow-y-auto sm:flex-col sm:flex-nowrap',
            )"
          >
            <div v-for="(option, optionIndex) in field.options" :key="option.value" :class="FIELD_ROW">
              <Checkbox
                :id="optionId(index, optionIndex)"
                :model-value="listOf(field.name).includes(option.value)"
                :disabled="disabled"
                :class="CONTROL_HIT"
                @update:model-value="checked => toggleOption(field, option.value, checked === true)"
              />
              <label :for="optionId(index, optionIndex)" class="min-w-0 break-words select-none">{{ option.label }}</label>
            </div>
          </div>
        </template>

        <p
          v-if="field.description || elicitationFieldHint(field)"
          :id="`${controlId(index)}-help`"
          class="flex min-w-0 flex-col text-xs break-words text-muted-foreground"
        >
          <span v-if="field.description">{{ field.description }}</span>
          <span v-if="elicitationFieldHint(field)">{{ elicitationFieldHint(field) }}</span>
        </p>
        <p
          v-if="sensitive.has(field.name)"
          :id="`${controlId(index)}-sensitive`"
          data-slot="elicitation-sensitive"
          class="text-xs break-words text-warning"
        >
          {{ elicitationSensitiveText(server) }}
        </p>
        <p
          v-if="issueOf(field.name)"
          :id="`${controlId(index)}-error`"
          :data-testid="testIds.elicitationFieldError"
          class="text-xs break-words text-destructive"
        >
          {{ issueOf(field.name)!.message }}
        </p>
      </div>

      <p
        v-for="issue in formIssues"
        :key="`${issue.field}:${issue.code}`"
        :data-testid="testIds.elicitationFieldError"
        role="alert"
        class="text-xs break-words text-destructive"
      >
        {{ issue.message }}
      </p>

      <p class="flex min-w-0 items-start gap-2 text-xs text-muted-foreground">
        <TriangleAlertIcon aria-hidden="true" class="mt-px size-3.5 shrink-0" />
        <span class="min-w-0 break-words">{{ elicitationCautionText(server) }}</span>
      </p>

      <p v-if="closedText" role="status" class="text-sm text-muted-foreground">
        {{ closedText }}
      </p>

      <div class="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button
          type="button"
          variant="outline"
          size="sm"
          :disabled="disabled"
          :data-testid="testIds.elicitationDecline"
          class="w-full sm:w-auto pointer-coarse:h-10"
          @click="onDecline"
        >
          Decline
        </Button>
        <Button
          type="submit"
          size="sm"
          :disabled="disabled"
          :data-testid="testIds.elicitationSubmit"
          class="w-full sm:w-auto pointer-coarse:h-10"
        >
          Submit
        </Button>
      </div>
    </form>
  </section>
</template>
