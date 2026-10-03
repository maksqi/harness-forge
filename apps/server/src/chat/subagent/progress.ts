// The progress of one sub-agent as `TaskOutput` snapshots (Phase 9, ADR-043, ARCHITECTURE.md 6.22, API.md 6.9): the
// child runner (`./index.ts`) feeds the child's `streamText` parts in, and every snapshot is what the `task` tool yields
// (preliminary outputs while the child runs, the last one is the final output).
// - steps: one per tool call (`running` at the call, then `done` / `error` / `denied`), the latest
//   `LIMITS.taskStepsShownMax` kept and the older ones counted in `stepsOmitted`; a summary of the input (the first
//   string of `path`, `pattern`, `query`, `command`, `url`, … else the input as JSON) on one line, at most 200
//   characters; the result or error preview on one line, at most 300 characters;
// - the report: the text of the latest step that wrote text (the step under way first), at most
//   `LIMITS.taskReportMaxChars` characters;
// - every snapshot fits `TASK_OUTPUT_BYTES_MAX` of serialized JSON (below the 64 KB tool output cap, so a `task` output
//   is never replaced by the truncation marker): the oldest steps go first, then the end of the report.
// Nothing here is logged: the prompts, the previews and the report never reach the server log.
import type { MessageUsage, TaskInput, TaskOutput, TaskStatus, TaskStep, TaskStepState } from '@harness-forge/shared'
import { Buffer } from 'node:buffer'
import { LIMITS } from '@harness-forge/shared'
import { utf8Prefix } from '../tools.ts'

/** Characters of a step summary. */
export const TASK_SUMMARY_MAX_CHARS = 200
/** Characters of a step's result preview. */
export const TASK_PREVIEW_MAX_CHARS = 300
/** Characters of a step's tool call id and tool name (the schema bounds). */
const TOOL_CALL_ID_MAX_CHARS = 256
const TOOL_NAME_MAX_CHARS = 64
/** Characters of the `error` of an output (the schema bound). */
export const TASK_ERROR_MAX_CHARS = 2000
/** Serialized bytes of one snapshot (below `LIMITS.toolOutputBytes`, 64 KiB). */
export const TASK_OUTPUT_BYTES_MAX = 60_000

/** The input fields a step summary prefers, in order. */
const SUMMARY_KEYS = ['path', 'pattern', 'query', 'command', 'url', 'file', 'name', 'description', 'prompt'] as const

/** `text` cut to at most `max` UTF-16 code units, never inside a surrogate pair. */
export function cutChars(text: string, max: number): string {
  if (text.length <= max)
    return text
  const last = text.charCodeAt(max - 1)
  return text.slice(0, last >= 0xD800 && last <= 0xDBFF ? max - 1 : max)
}

/** `text` on one line (runs of whitespace become one space, trimmed), at most `max` characters. */
export function oneLine(text: string, max: number): string {
  return cutChars(text.replace(/\s+/g, ' ').trim(), max)
}

function json(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ''
  }
  catch {
    return ''
  }
}

/** One line about a call: the first string of the preferred input fields, else the input as JSON (`{}` = empty). */
export function callSummary(input: unknown): string {
  if (typeof input === 'string')
    return oneLine(input, TASK_SUMMARY_MAX_CHARS)
  if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
    const record = input as Record<string, unknown>
    for (const key of SUMMARY_KEYS) {
      const value = record[key]
      if (typeof value === 'string' && value.trim() !== '')
        return oneLine(value, TASK_SUMMARY_MAX_CHARS)
    }
  }
  const text = json(input)
  return text === '{}' ? '' : oneLine(text, TASK_SUMMARY_MAX_CHARS)
}

/** The start of a result (a string as it is, anything else as JSON) on one line; undefined when empty. */
export function resultPreview(output: unknown): string | undefined {
  if (output === undefined || output === null)
    return undefined
  const text = oneLine(typeof output === 'string' ? output : json(output), TASK_PREVIEW_MAX_CHARS)
  return text === '' ? undefined : text
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(json(value), 'utf8')
}

/**
 * `output` within `maxBytes` of serialized JSON: the oldest steps are dropped first (counted in `stepsOmitted`), then
 * the end of the report is cut.
 */
export function fitTaskOutput(output: TaskOutput, maxBytes: number = TASK_OUTPUT_BYTES_MAX): TaskOutput {
  let fitted = output
  let size = jsonBytes(fitted)
  while (size > maxBytes && fitted.steps.length > 0) {
    const drop = Math.max(1, Math.ceil(fitted.steps.length / 5))
    fitted = { ...fitted, steps: fitted.steps.slice(drop), stepsOmitted: fitted.stepsOmitted + drop }
    size = jsonBytes(fitted)
  }
  for (let attempt = 0; size > maxBytes && fitted.report !== '' && attempt < 8; attempt += 1) {
    const reportBytes = Buffer.byteLength(fitted.report, 'utf8')
    fitted = { ...fitted, report: utf8Prefix(fitted.report, Math.max(0, reportBytes - (size - maxBytes) - 64)) }
    size = jsonBytes(fitted)
  }
  return fitted
}

/** What a snapshot adds at the end of a child run. */
export interface SnapshotEnd {
  finishedAt?: number
  error?: string
}

/** The progress of one child (see the module comment). */
export class TaskProgress {
  readonly #input: TaskInput
  #modelRef: string
  #startedAt: number
  /** The kept steps, oldest first (at most `LIMITS.taskStepsShownMax`). */
  readonly #steps: TaskStep[] = []
  #omitted = 0
  #stepText = ''
  #lastText = ''
  #usage: MessageUsage | undefined
  #costUsd: number | undefined

  constructor(input: TaskInput, modelRef: string, startedAt: number) {
    this.#input = input
    this.#modelRef = modelRef
    this.#startedAt = startedAt
  }

  /** The child started running (after its slot): its model and start time. */
  start(modelRef: string, startedAt: number): void {
    this.#modelRef = modelRef
    this.#startedAt = startedAt
  }

  get modelRef(): string {
    return this.#modelRef
  }

  /** A model step started: its text is collected anew. */
  startStep(): void {
    this.#stepText = ''
  }

  text(delta: string): void {
    this.#stepText += delta
  }

  /** A model step finished: its text (when it wrote any) becomes the report candidate. */
  endStep(): void {
    if (this.#stepText.trim() !== '')
      this.#lastText = this.#stepText
    this.#stepText = ''
  }

  /** A tool call of the child started (`running`). */
  startCall(toolCallId: string, toolName: string, input: unknown): void {
    this.#steps.push({
      toolCallId: cutChars(toolCallId, TOOL_CALL_ID_MAX_CHARS) || 'call',
      toolName: cutChars(toolName, TOOL_NAME_MAX_CHARS) || 'tool',
      summary: callSummary(input),
      state: 'running',
    })
    while (this.#steps.length > LIMITS.taskStepsShownMax) {
      this.#steps.shift()
      this.#omitted += 1
    }
  }

  /** A tool call ended (`done`, `error` or `denied`) with an optional preview; unknown or omitted calls are ignored. */
  finishCall(toolCallId: string, state: Exclude<TaskStepState, 'running'>, preview: string | undefined): void {
    const id = cutChars(toolCallId, TOOL_CALL_ID_MAX_CHARS)
    const index = this.#steps.findLastIndex(step => step.toolCallId === id)
    if (index === -1)
      return
    const { resultPreview: _previous, ...step } = this.#steps[index]!
    this.#steps[index] = { ...step, state, ...(preview === undefined ? {} : { resultPreview: preview }) }
  }

  /** Steps still `running` when the child ended: they never finished (`error`). */
  endOpenCalls(preview: string): void {
    for (const [index, step] of this.#steps.entries()) {
      if (step.state === 'running')
        this.#steps[index] = { ...step, state: 'error', resultPreview: preview }
    }
  }

  setUsage(usage: MessageUsage | undefined, costUsd: number | undefined): void {
    this.#usage = usage
    this.#costUsd = costUsd
  }

  /** The report so far: the text of the step under way, else of the latest step that wrote text. */
  get report(): string {
    const text = this.#stepText.trim() !== '' ? this.#stepText : this.#lastText
    return cutChars(text.trim(), LIMITS.taskReportMaxChars)
  }

  /** A `TaskOutput` snapshot with `status` (fitted to `TASK_OUTPUT_BYTES_MAX`). */
  snapshot(status: TaskStatus, end: SnapshotEnd = {}): TaskOutput {
    const output: TaskOutput = {
      status,
      type: this.#input.type,
      description: cutChars(this.#input.description, 80),
      modelRef: this.#modelRef,
      steps: this.#steps.map(step => ({ ...step })),
      stepsOmitted: this.#omitted,
      report: this.report,
      ...(this.#usage === undefined ? {} : { usage: this.#usage }),
      ...(this.#costUsd === undefined ? {} : { costUsd: this.#costUsd }),
      startedAt: this.#startedAt,
      ...(end.finishedAt === undefined ? {} : { finishedAt: end.finishedAt }),
      ...(end.error === undefined ? {} : { error: cutChars(end.error, TASK_ERROR_MAX_CHARS) }),
    }
    return fitTaskOutput(output)
  }
}
