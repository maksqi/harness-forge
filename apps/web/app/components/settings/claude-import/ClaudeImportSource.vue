<script setup lang="ts">
// Step 1 of the import (Phase 12, ADR-055; docs/UI.md 9.14, 10.9): "Where is your .claude folder?" with three sources
// (`claude-import-source`, `data-value` folder | zip | server): Choose your .claude folder… (the visually hidden folder
// input `claude-import-folder-input` and the optional `.claude.json` input `claude-import-config-input`; the browser keeps
// only what `pickClaudeFiles` allows and never reads the files), Upload a zip… (`claude-import-zip-input`, sent as is) and
// Scan {path} on this server (the line `claude-import-scan`, `data-state` available | disabled | missing | unreadable).
// Emits the chosen source: `folder` (the kept files and the `.claude.json`), `zip` or `scan`. Store-free.
// Props, emits and the test ids are frozen from Gate P12-0b (C46 stub); W12.10 implements the source step in P12-A.
import type { ClaudeImportHome } from '@harness-forge/shared'
import { computed, ref } from 'vue'
import { testIds } from '~/utils/testids'
import { pickClaudeFiles } from './claude-import'

const props = defineProps<{ busy: boolean, serverHome: ClaudeImportHome | null }>()

const emit = defineEmits<{ folder: [files: readonly File[], claudeJson: File | null], zip: [file: File], scan: [] }>()

/** `webkitdirectory` is not in Vue's input attribute types. */
const FOLDER_INPUT_ATTRS: Readonly<Record<string, string>> = { webkitdirectory: '', directory: '' }

const choice = ref<'folder' | 'zip' | 'server'>('folder')
const picked = ref<File[]>([])
const claudeJson = ref<File | null>(null)
const pickedText = ref<string | null>(null)

const scanState = computed(() => {
  const home = props.serverHome
  if (!home)
    return 'disabled'
  return home.available ? 'available' : home.reason ?? 'disabled'
})
const scanText = computed(() => {
  const home = props.serverHome
  const path = home?.path ?? '~/.claude'
  switch (scanState.value) {
    case 'available':
      return path
    case 'missing':
      return `There is no .claude folder at ${path}.`
    case 'unreadable':
      return `harness-forge can't read ${path}.`
    default:
      return 'Scanning is turned off on this server (HF_CLAUDE_HOME=0).'
  }
})

function onFolder(event: Event): void {
  const files = (event.target as HTMLInputElement).files
  const result = pickClaudeFiles(files ?? [])
  picked.value = result.files
  pickedText.value = result.files.length === 0 ? 'Nothing to import in this folder.' : `${result.files.length} files picked`
  emit('folder', result.files, claudeJson.value)
}

function onConfig(event: Event): void {
  claudeJson.value = (event.target as HTMLInputElement).files?.[0] ?? null
  emit('folder', picked.value, claudeJson.value)
}

function onZip(event: Event): void {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (file)
    emit('zip', file)
}

function choose(value: 'folder' | 'zip' | 'server'): void {
  choice.value = value
  if (value === 'server' && scanState.value === 'available')
    emit('scan')
}
</script>

<template>
  <fieldset class="grid min-w-0 gap-3" :disabled="busy">
    <legend class="mb-1 text-sm font-medium">
      Where is your .claude folder?
    </legend>
    <div class="grid gap-1.5">
      <label class="flex items-center gap-2 text-sm">
        <input
          type="radio"
          name="claude-import-source"
          value="folder"
          :checked="choice === 'folder'"
          :data-testid="testIds.claudeImportSource"
          data-value="folder"
          @change="choose('folder')"
        >
        Choose your .claude folder…
      </label>
      <input
        type="file"
        multiple
        class="sr-only"
        tabindex="-1"
        aria-label=".claude folder"
        v-bind="FOLDER_INPUT_ATTRS"
        :data-testid="testIds.claudeImportFolderInput"
        @change="onFolder"
      >
      <input
        type="file"
        accept=".json,application/json"
        class="sr-only"
        tabindex="-1"
        aria-label=".claude.json (MCP servers)"
        :data-testid="testIds.claudeImportConfigInput"
        @change="onConfig"
      >
      <p v-if="pickedText" class="text-xs text-muted-foreground">
        {{ pickedText }}
      </p>
    </div>
    <div class="grid gap-1.5">
      <label class="flex items-center gap-2 text-sm">
        <input
          type="radio"
          name="claude-import-source"
          value="zip"
          :checked="choice === 'zip'"
          :data-testid="testIds.claudeImportSource"
          data-value="zip"
          @change="choose('zip')"
        >
        Upload a zip…
      </label>
      <input
        type="file"
        accept=".zip,application/zip,application/x-zip-compressed"
        class="sr-only"
        tabindex="-1"
        aria-label=".claude folder zip"
        :data-testid="testIds.claudeImportZipInput"
        @change="onZip"
      >
    </div>
    <div class="grid gap-1.5">
      <label class="flex items-center gap-2 text-sm">
        <input
          type="radio"
          name="claude-import-source"
          value="server"
          :checked="choice === 'server'"
          :disabled="scanState !== 'available'"
          :data-testid="testIds.claudeImportSource"
          data-value="server"
          @change="choose('server')"
        >
        Scan on this server
      </label>
      <p :data-testid="testIds.claudeImportScan" :data-state="scanState" class="font-mono text-xs text-muted-foreground">
        {{ scanText }}
      </p>
    </div>
    <p class="text-xs text-muted-foreground">
      Only agents, commands, skills, output styles, settings.json, CLAUDE.md and the mcpServers of .claude.json are read.
    </p>
  </fieldset>
</template>
