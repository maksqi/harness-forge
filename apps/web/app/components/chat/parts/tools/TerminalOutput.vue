<script setup lang="ts">
// Terminal output of the `shell` workspace tool (docs/UI.md 2.14, 7.19; ADR-033): a bg-muted/60 block with the
// `$ command` line (terminal-command), stdout (terminal-stdout), stderr under a small "stderr" label
// (terminal-stderr; text-destructive only when the exit code is not 0), the last 40 lines of each stream with "Show all
// {n} lines" (up to the 60 KB body cap), and footer badges "Exit code {n}" (terminal-exit, data-value), "Timed out",
// the signal and the duration; while running a Spinner + "Running…"; byte counts larger than the kept text -> "Output
// truncated by server". ANSI codes are stripped (utils/ansi.ts). Store-free (the share page renders it too).
// Contract (docs/UI.md 10.4; + `cwd` in Phase 8): props below, no emits; root terminal-output (data-status = running | ok | error |
// timeout | killed; aria-label "Output of {command}").
import type { ShellOutput } from '@harness-forge/shared'
import { WORKSPACE_LIMITS } from '@harness-forge/shared'
import { computed, reactive, watch } from 'vue'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { terminalText } from '~/utils/ansi'
import { testIds } from '~/utils/testids'
import { formatDuration, TOOL_BODY_MAX_CHARS } from '../../chat-format'
import { commandFirstLine } from './workspace-tools'

const props = withDefaults(defineProps<{
  command: string
  /** The stored shell output; null while running. */
  output: ShellOutput | null
  running?: boolean
  /**
   * + Phase 8 (C20 declares it, W8.10 renders it): the folder the command starts in while running (the call's `cwd`
   * input, else the chat's current shell folder); default null. A finished output names its own `cwd`.
   */
  cwd?: string | null
}>(), {
  running: false,
  cwd: null,
})

/** Lines of each stream shown before "Show all {n} lines". */
const TAIL_LINES = 40

type StreamName = 'stdout' | 'stderr'

const expanded = reactive<Record<StreamName, boolean>>({ stdout: false, stderr: false })
watch(() => props.output, () => {
  expanded.stdout = false
  expanded.stderr = false
})

const status = computed(() => {
  const output = props.output
  if (props.running || !output)
    return 'running'
  if (output.timedOut)
    return 'timeout'
  if (output.signal !== null)
    return 'killed'
  return output.exitCode === 0 ? 'ok' : 'error'
})

const label = computed(() => `Output of ${commandFirstLine(props.command) ?? props.command}`)
const encoder = new TextEncoder()

/** The server keeps the head and the tail of a stream past this many bytes, with an omission marker between them. */
const STREAM_KEPT_BYTES = WORKSPACE_LIMITS.shellStreamHeadBytes + WORKSPACE_LIMITS.shellStreamTailBytes

interface StreamView {
  name: StreamName
  /** Every line (after ANSI stripping), without the trailing newline. */
  lineCount: number
  /** The text shown: the last 40 lines, or everything up to the body cap. */
  text: string
  hiddenLines: number
  /** Show all still leaves out the start of a stream longer than the body cap. */
  capped: boolean
}

function streamView(name: StreamName, raw: string): StreamView | null {
  const text = terminalText(raw).replace(/\n$/, '')
  if (text === '')
    return null
  const lines = text.split('\n')
  if (expanded[name] || lines.length <= TAIL_LINES) {
    const capped = text.length > TOOL_BODY_MAX_CHARS
    return { name, lineCount: lines.length, text: capped ? text.slice(-TOOL_BODY_MAX_CHARS) : text, hiddenLines: 0, capped }
  }
  return { name, lineCount: lines.length, text: lines.slice(-TAIL_LINES).join('\n'), hiddenLines: lines.length - TAIL_LINES, capped: false }
}

const stdout = computed(() => (props.output ? streamView('stdout', props.output.stdout) : null))
const stderr = computed(() => (props.output ? streamView('stderr', props.output.stderr) : null))

const serverTruncated = computed(() => {
  const output = props.output
  if (!output)
    return false
  const cut = (bytes: number, kept: string) => bytes > STREAM_KEPT_BYTES && bytes > encoder.encode(kept).length
  return cut(output.stdoutBytes, output.stdout) || cut(output.stderrBytes, output.stderr)
})

const stderrError = computed(() => props.output !== null && props.output.exitCode !== 0)
const duration = computed(() => (props.output ? formatDuration(props.output.durationMs) : ''))

const BADGE_CLASS = 'inline-flex h-5 items-center rounded-sm border px-1.5 font-sans text-[11px] font-medium'
const SHOW_ALL_CLASS = 'self-start rounded-sm font-sans text-[11px] font-medium text-foreground underline decoration-primary/60 underline-offset-2 outline-none hover:decoration-primary focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:min-h-10'
</script>

<template>
  <div
    :data-testid="testIds.terminalOutput"
    :data-status="status"
    role="group"
    :aria-label="label"
    class="flex min-w-0 flex-col gap-2 rounded-md bg-muted/60 p-3 font-mono text-xs leading-relaxed"
  >
    <pre
      :data-testid="testIds.terminalCommand"
      class="font-mono whitespace-pre-wrap break-words text-foreground"
    ><span aria-hidden="true" class="text-muted-foreground select-none">$ </span>{{ command }}</pre>

    <template v-for="(stream, index) in [stdout, stderr]" :key="index">
      <div v-if="stream" class="flex min-w-0 flex-col gap-1">
        <span
          v-if="stream.name === 'stderr'"
          class="font-sans text-[11px] font-medium tracking-wide text-muted-foreground uppercase"
        >stderr</span>
        <button
          v-if="stream.hiddenLines > 0"
          type="button"
          data-action="show-all"
          :data-stream="stream.name"
          :class="SHOW_ALL_CLASS"
          @click="expanded[stream.name] = true"
        >
          Show all {{ stream.lineCount }} lines
        </button>
        <pre
          :data-testid="stream.name === 'stdout' ? testIds.terminalStdout : testIds.terminalStderr"
          :class="cn(
            'max-h-96 overflow-y-auto font-mono whitespace-pre-wrap break-words',
            stream.name === 'stderr' && stderrError ? 'text-destructive' : 'text-foreground',
          )"
        >{{ stream.text }}</pre>
        <span v-if="stream.capped" class="font-sans text-[11px] text-muted-foreground">
          Showing the last {{ Math.round(TOOL_BODY_MAX_CHARS / 1024) }} KB
        </span>
      </div>
    </template>

    <div v-if="status === 'running'" class="flex items-center gap-2 font-sans text-muted-foreground">
      <Spinner class="size-3" />
      <span>Running…</span>
    </div>
    <div v-else-if="output" class="flex flex-wrap items-center gap-1.5 text-muted-foreground">
      <span
        v-if="output.exitCode !== null"
        :data-testid="testIds.terminalExit"
        :data-value="output.exitCode"
        :class="cn(BADGE_CLASS, output.exitCode === 0 ? 'text-muted-foreground' : 'border-destructive/40 text-destructive')"
      >Exit code {{ output.exitCode }}</span>
      <span v-if="output.timedOut" data-slot="terminal-timeout" :class="cn(BADGE_CLASS, 'border-warning/50 text-warning')">Timed out</span>
      <span v-if="output.signal" data-slot="terminal-signal" :class="cn(BADGE_CLASS, 'border-warning/50 text-warning')">{{ output.signal }}</span>
      <span v-if="duration" data-slot="terminal-duration" :class="BADGE_CLASS">{{ duration }}</span>
      <span v-if="!stdout && !stderr" class="font-sans text-[11px]">No output</span>
      <span v-if="serverTruncated" data-slot="server-truncated" class="font-sans text-[11px]">Output truncated by server</span>
    </div>
  </div>
</template>
