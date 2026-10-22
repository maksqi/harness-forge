// Pure rules of MCP questions in the transcript (Phase 14, ADR-060; docs/UI.md 7.35, 11.10): the pending request of a
// running MCP tool part (its latest preliminary output `{ status: 'input-required', elicitation }`), the records the final
// output keeps (never the values), the result lines and the countdown. Untrusted text stays plain text.
// Signatures from C54 (P14-0b, frozen from Gate P14-0b). `pendingElicitationOf` is complete (useChatSession derives the
// session's pending requests from it); W14.9 owns the module (it may add helpers) and the card's texts.
// W14.9 (P14-A) adds the card's helpers: which control a field gets, its label, hint and input type, the answer built
// from the controls' raw values (`coerceElicitationValue` + `validateElicitationAnswer` of `@harness-forge/shared`, the
// rules the server applies), the copy of the card, the jump pill and the announcements, the focus target of a card, and
// the tab's record of announced requests.
import type {
  ElicitationAnswerResult,
  ElicitationField,
  ElicitationFieldIssue,
  ElicitationForm,
  ElicitationRawValue,
  ElicitationValue,
  McpElicitation,
  McpElicitationRecord,
} from '@harness-forge/shared'
import type { ToolPartLike } from '../chat-format'
import { coerceElicitationValue, mcpElicitationRecordSchema, mcpToolProgressSchema, validateElicitationAnswer } from '@harness-forge/shared'
import { testIds } from '~/utils/testids'
import { splitMcpToolName, toolNameOf } from '../chat-format'

/** The caution line of the card (`{server}` = the server's name). */
export const ELICITATION_CAUTION = 'Share only what you would give {server}. Never enter passwords here.'

/** "7:42 left" (whole seconds, never negative). */
export function countdownText(msLeft: number): string {
  const seconds = Math.max(0, Math.ceil((Number.isFinite(msLeft) ? msLeft : 0) / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} left`
}

/** The one-line result of an answered or ended request (docs/UI.md 7.35, 15). */
export function elicitationResultText(record: Pick<McpElicitationRecord, 'action' | 'reason'>, server: string): string {
  switch (record.reason) {
    case 'timeout':
      return `${server}'s request expired.`
    case 'stopped':
      return 'Stopped before you answered.'
    case 'not-interactive':
      return 'Declined automatically: sub-agents can\'t ask you.'
    case 'ambiguous':
      return `Declined automatically: more than one chat was using ${server}.`
    case 'unsupported':
      return 'Declined automatically: harness-forge can\'t show this form.'
  }
  if (record.action === 'accept')
    return `You answered ${server}'s request.`
  return record.action === 'decline' ? `You declined ${server}'s request.` : `You dismissed ${server}'s request.`
}

/** The `data-action` of a result line: the action, or `timeout` for an expired request. */
export function elicitationResultAction(record: McpElicitationRecord): 'accept' | 'decline' | 'cancel' | 'timeout' {
  return record.reason === 'timeout' ? 'timeout' : record.action
}

/** The records of a final MCP tool output (`output.elicitations`); invalid entries are dropped. */
export function elicitationRecordsOf(output: unknown): McpElicitationRecord[] {
  if (typeof output !== 'object' || output === null || !Array.isArray((output as { elicitations?: unknown }).elicitations))
    return []
  const records: McpElicitationRecord[] = []
  for (const entry of (output as { elicitations: unknown[] }).elicitations) {
    const parsed = mcpElicitationRecordSchema.safeParse(entry)
    if (parsed.success)
      records.push(parsed.data)
  }
  return records
}

/**
 * The pending request of an MCP tool part (`mcp__<server>__<tool>`): its latest preliminary output (`output-available`
 * with `preliminary: true`) is `{ status: 'input-required', elicitation }`; null otherwise (a final output, `running`, any
 * other tool, an output that does not parse).
 */
export function pendingElicitationOf(part: ToolPartLike): McpElicitation | null {
  if (part.state !== 'output-available' || part.preliminary !== true || splitMcpToolName(toolNameOf(part)) === null)
    return null
  const parsed = mcpToolProgressSchema.safeParse(part.output)
  return parsed.success && parsed.data.status === 'input-required' ? parsed.data.elicitation : null
}

// ---------- W14.9: the card ----------

/** An enum field with at most this many options is a radio group; more options use a select. */
export const ELICITATION_RADIO_OPTIONS_MAX = 4

/** A multi-select field with more options than this scrolls inside its box. */
export const ELICITATION_SCROLL_OPTIONS_MAX = 8

/** The message is clamped to six lines; a longer one gets "Show more". */
export const ELICITATION_MESSAGE_CLAMP_LINES = 6

/** A message this long (characters) is clamped even without six line breaks (the column fits about 70 per line). */
const LONG_MESSAGE_CHARS = 420

/** One minute before the request expires: the countdown turns `text-warning` and ChatView announces it once. */
export const ELICITATION_MINUTE_MS = 60_000

export const ELICITATION_GONE_TEXT = 'This request is no longer open.'
export const ELICITATION_EXPIRED_TEXT = 'This request expired.'
/** The status cell of a tool row that waits on a request. */
export const ELICITATION_WAITING_TEXT = 'Waiting for your input'
/** The placeholder of a select field (an enum with more than four options). */
export const ELICITATION_CHOOSE_TEXT = 'Choose…'

/** How a field is answered (docs/UI.md 7.35). */
export type ElicitationControl = 'input' | 'number' | 'checkbox' | 'radios' | 'select' | 'checkboxes'

export function elicitationControl(field: Pick<ElicitationField, 'type' | 'options'>): ElicitationControl {
  switch (field.type) {
    case 'number':
    case 'integer':
      return 'number'
    case 'boolean':
      return 'checkbox'
    case 'enum':
      return (field.options?.length ?? 0) <= ELICITATION_RADIO_OPTIONS_MAX ? 'radios' : 'select'
    case 'multi-enum':
      return 'checkboxes'
    default:
      return 'input'
  }
}

/** The `type` of a text input: from the string's `format` (`datetime-local` for `date-time`), else `text`. */
export function elicitationInputType(field: Pick<ElicitationField, 'format'>): 'text' | 'email' | 'url' | 'date' | 'datetime-local' {
  switch (field.format) {
    case 'email':
      return 'email'
    case 'uri':
      return 'url'
    case 'date':
      return 'date'
    case 'date-time':
      return 'datetime-local'
    default:
      return 'text'
  }
}

/** A field's label: its title, else its name. */
export function elicitationFieldLabel(field: Pick<ElicitationField, 'name' | 'title'>): string {
  return field.title ?? field.name
}

/**
 * The help line of a bounded field (docs/UI.md 15): "Whole number, {min} to {max}" / "Number, {min} to {max}" for a
 * number with both bounds, "Choose {min} to {max}" for a multi-select with both counts; null otherwise.
 */
export function elicitationFieldHint(field: Pick<ElicitationField, 'type' | 'minimum' | 'maximum' | 'minItems' | 'maxItems'>): string | null {
  if ((field.type === 'integer' || field.type === 'number') && field.minimum !== undefined && field.maximum !== undefined)
    return `${field.type === 'integer' ? 'Whole number' : 'Number'}, ${field.minimum} to ${field.maximum}`
  if (field.type === 'multi-enum' && field.minItems !== undefined && field.maxItems !== undefined)
    return `Choose ${field.minItems} to ${field.maxItems}`
  return null
}

/** True when the message is long enough for "Show more" (more than six lines, or a long paragraph). */
export function isLongElicitationMessage(message: string): boolean {
  return message.split('\n').length > ELICITATION_MESSAGE_CLAMP_LINES || message.length > LONG_MESSAGE_CHARS
}

/**
 * The answer of a filled form: each control's raw value coerced (`coerceElicitationValue`: numbers from their text, a
 * local `datetime-local` value as RFC 3339 UTC, empty values left out) and checked with `validateElicitationAnswer`,
 * the rules the server applies (`content` = the cleaned values; else the field issues).
 */
export function elicitationAnswer(form: ElicitationForm, values: Readonly<Record<string, ElicitationRawValue>>): ElicitationAnswerResult {
  const content: Record<string, ElicitationValue> = {}
  for (const field of form.fields) {
    const value = coerceElicitationValue(field, Object.hasOwn(values, field.name) ? values[field.name] : undefined)
    if (value !== undefined)
      content[field.name] = value
  }
  return validateElicitationAnswer(form, content)
}

/**
 * The field issues of a `400` answer, whatever their shape: `{ field, code, message }` (`ElicitationFieldIssue`) or the
 * server's `{ path: ['content', <field>], code, message }` (W14.3's `details.issues`); a path without a field is a
 * form-level issue (`field: ''`). Entries without a message are dropped.
 */
export function elicitationIssuesOf(issues: readonly unknown[]): ElicitationFieldIssue[] {
  const read: ElicitationFieldIssue[] = []
  for (const entry of issues.slice(0, 100)) {
    if (typeof entry !== 'object' || entry === null)
      continue
    const { field, path, code, message } = entry as { field?: unknown, path?: unknown, code?: unknown, message?: unknown }
    if (typeof message !== 'string' || message === '')
      continue
    let name = ''
    if (typeof field === 'string')
      name = field
    else if (Array.isArray(path) && path[0] === 'content' && typeof path[1] === 'string')
      name = path[1]
    read.push({ field: name, code: (typeof code === 'string' ? code : 'type') as ElicitationFieldIssue['code'], message })
  }
  return read
}

/** "{server} needs more information" (the card's heading and its region's name). */
export function elicitationHeading(server: string): string {
  return `${server} needs more information`
}

/** The caution line with the server's name. */
export function elicitationCautionText(server: string): string {
  return ELICITATION_CAUTION.split('{server}').join(server)
}

/** The extra warning of a field that looks like a secret (`isSensitiveField`). */
export function elicitationSensitiveText(server: string): string {
  return `${server} asks for something that looks like a secret. Answer only if you trust ${server}.`
}

/** ChatView's announcement of a new request (once per request and tab). */
export function elicitationAnnouncement(server: string): string {
  return `${server} needs your input`
}

/** ChatView's announcement one minute before a request expires (once per request and tab). */
export function elicitationMinuteAnnouncement(server: string): string {
  return `${server}'s request expires in 1 minute`
}

/** The jump pill's visible text. */
export function elicitationJumpText(server: string): string {
  return `${server} needs your input · Show`
}

/** The jump pill's accessible name. */
export function elicitationJumpLabel(server: string): string {
  return `${server} needs your input, show the request`
}

/** The asked field names of a record in a tool body (never the values). */
export function elicitationFieldsText(fields: readonly string[]): string | null {
  return fields.length > 0 ? `Asked for: ${fields.join(', ')}` : null
}

/**
 * Controls a card can focus: inputs, the checkbox / radio / select buttons and the submit button, and a radio group's
 * root (`tabindex="0"`: reka moves its focus to the checked radio, else the first one).
 */
const FOCUSABLE = 'input, button, select, textarea, [role="combobox"], [tabindex="0"]'

function focusable(element: HTMLElement): boolean {
  return element.tabIndex >= 0
    && element.getAttribute('aria-hidden') !== 'true'
    && !(element as HTMLInputElement).disabled
    && !(element instanceof HTMLInputElement && element.type === 'hidden')
}

/**
 * The first focusable control inside `container` (an input, a radio group's tabbable radio, a checkbox, a select
 * trigger); hidden, disabled and untabbable elements are skipped.
 */
export function firstFocusableControl(container: ParentNode): HTMLElement | null {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].find(focusable) ?? null
}

/**
 * The control a card's first field focuses (its first focusable control), else the card's Submit button; null when
 * neither is focusable. Used by the card's `focusFirst` and by ChatView's jump pill.
 */
export function elicitationFocusTarget(card: ParentNode): HTMLElement | null {
  const field = card.querySelector(`[data-testid="${testIds.elicitationField}"]`)
  const control = field ? firstFocusableControl(field) : null
  if (control)
    return control
  const submit = card.querySelector<HTMLElement>(`[data-testid="${testIds.elicitationSubmit}"]`)
  return submit && focusable(submit) ? submit : null
}

/** Requests remembered by `announcedElicitations` (the oldest are forgotten). */
const ANNOUNCED_MAX = 200

/** A tab's record of announced requests: `add` is false when the key was already announced. */
export interface AnnouncedElicitations {
  add: (key: string) => boolean
  clear: () => void
}

export function createAnnouncedElicitations(max = ANNOUNCED_MAX): AnnouncedElicitations {
  const keys = new Set<string>()
  return {
    add: (key) => {
      if (keys.has(key))
        return false
      keys.add(key)
      if (keys.size > max)
        keys.delete(keys.values().next().value!)
      return true
    },
    clear: () => keys.clear(),
  }
}

/**
 * The announcements this tab made ("{server} needs your input" as `<id>`, the minute warning as `<id>:minute`), so a
 * view that mounts again (the chat was left and opened again) never repeats them.
 */
export const announcedElicitations: AnnouncedElicitations = createAnnouncedElicitations()
