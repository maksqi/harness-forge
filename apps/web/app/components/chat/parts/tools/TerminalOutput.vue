<script setup lang="ts">
// Terminal output of the `shell` workspace tool (docs/UI.md 2.14, 7.19; ADR-033): a bg-muted/60 block with the
// `$ command` line (terminal-command), stdout (terminal-stdout), stderr under a small "stderr" label
// (terminal-stderr), the last 40 lines with "Show all {n} lines", and footer badges "Exit code {n}" (terminal-exit,
// data-value), "Timed out", the signal and the duration; while running a Spinner + "Running…". ANSI codes are
// stripped (utils/ansi.ts). Store-free (the share page renders it too).
// Contract (docs/UI.md 10.4): props below, no emits; root terminal-output (data-status = running | ok | error |
// timeout | killed; aria-label "Output of {command}").
// Stub (C15, P7-0b): implemented by W7.11 in P7-A; props are frozen. The stub renders its root with the status.
import type { ShellOutput } from '@harness-forge/shared'
import { computed } from 'vue'
import { testIds } from '~/utils/testids'

const props = withDefaults(defineProps<{
  command: string
  /** The stored shell output; null while running. */
  output: ShellOutput | null
  running?: boolean
}>(), {
  running: false,
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
</script>

<template>
  <div
    :data-testid="testIds.terminalOutput"
    :data-status="status"
    role="group"
    :aria-label="`Output of ${command}`"
    class="rounded-md bg-muted/60 font-mono text-xs"
  />
</template>
