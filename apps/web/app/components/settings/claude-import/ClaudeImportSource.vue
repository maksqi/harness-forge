<script setup lang="ts">
// Step 1 of the import (Phase 12, ADR-055; docs/UI.md 2.19, 9.14, 10.9): "Where is your .claude folder?", a radio group
// of three sources (`claude-import-source`, `data-value` folder | zip | server):
// - Choose your .claude folder… (default): Choose folder… opens the visually hidden folder input
//   (`claude-import-folder-input`, `webkitdirectory`) and + .claude.json (MCP servers) the optional `.claude.json` input
//   (`claude-import-config-input`; `~/.claude.json` sits next to the folder, not in it). The browser keeps only what
//   `pickClaudeFiles` allows (the shared allowlist and caps) and never reads the files: "{n} files picked" or "Nothing to
//   import in this folder.", plus the files over their cap.
// - Upload a zip… (`claude-import-zip-input`, sent as is: the browser never opens a zip).
// - Scan {path} on this server: the line under it is `claude-import-scan` (`data-state` available | disabled | missing |
//   unreadable) with the reason when the scan is not available (the radio is disabled then).
// Emits what the chosen source would send: `folder(files, claudeJson)`, `zip(file)` or `scan()`; a source with nothing to
// send yet (no zip picked, a scan that is not available) emits `folder([], null)`, which leaves Continue disabled.
// Store-free. Props, emits and the test ids are frozen from Gate P12-0b (C46 stub); body W12.10 (P12-A).
import type { ClaudeImportHome } from '@harness-forge/shared'
import { FileArchiveIcon, FolderOpenIcon, PlusIcon } from '@lucide/vue'
import { RadioGroupIndicator, RadioGroupItem, RadioGroupRoot } from 'reka-ui'
import { computed, ref, useId } from 'vue'
import { Button } from '@/components/ui/button'
import { formatBytes } from '~/components/common/format'
import { testIds } from '~/utils/testids'
import { pickClaudeFiles } from './claude-import'

type Source = 'folder' | 'zip' | 'server'

const props = defineProps<{ busy: boolean, serverHome: ClaudeImportHome | null }>()

const emit = defineEmits<{ folder: [files: readonly File[], claudeJson: File | null], zip: [file: File], scan: [] }>()

/** `webkitdirectory` is not in Vue's input attribute types. */
const FOLDER_INPUT_ATTRS: Readonly<Record<string, string>> = { webkitdirectory: '', directory: '' }

const OPTION_CLASS = 'grid min-w-0 gap-2 rounded-lg border bg-card px-3 py-2.5 transition-colors duration-(--duration-fast) data-[selected=true]:border-primary data-[selected=true]:bg-primary/5'
const RADIO_CLASS = [
  'group flex w-full min-w-0 items-start gap-3 rounded-md text-left text-sm outline-none',
  'focus-visible:ring-[3px] focus-visible:ring-ring/50 data-disabled:cursor-not-allowed data-disabled:opacity-60 pointer-coarse:min-h-10',
].join(' ')

const ids = { legend: useId(), folder: useId(), zip: useId(), scan: useId() }

const choice = ref<Source>('folder')
const folderInput = ref<HTMLInputElement | null>(null)
const configInput = ref<HTMLInputElement | null>(null)
const zipInput = ref<HTMLInputElement | null>(null)
const picked = ref<File[] | null>(null)
const tooLarge = ref<string[]>([])
const claudeJson = ref<File | null>(null)
const zipFile = ref<File | null>(null)

const scanState = computed<'available' | 'disabled' | 'missing' | 'unreadable'>(() => {
  const home = props.serverHome
  if (!home)
    return 'disabled'
  return home.available ? 'available' : home.reason ?? 'disabled'
})
const scanPath = computed(() => props.serverHome?.path ?? '~/.claude')
const scanText = computed(() => {
  if (!props.serverHome)
    return 'Scanning on this server isn\'t available right now.'
  switch (scanState.value) {
    case 'available':
      return 'Reads the folder on this server. It needs your password.'
    case 'missing':
      return `There is no .claude folder at ${scanPath.value}.`
    case 'unreadable':
      return `harness-forge can't read ${scanPath.value}.`
    default:
      return 'Scanning is turned off on this server (HF_CLAUDE_HOME=0).'
  }
})

const folderText = computed(() => {
  const parts: string[] = []
  if (picked.value !== null) {
    const count = picked.value.length
    parts.push(count === 0 ? 'Nothing to import in this folder.' : `${count} ${count === 1 ? 'file' : 'files'} picked`)
  }
  if (claudeJson.value)
    parts.push('.claude.json added')
  return parts.join(' · ')
})
const tooLargeText = computed(() => (tooLarge.value.length === 0 ? '' : `Too large, not sent: ${tooLarge.value.join(', ')}`))
const zipText = computed(() => (zipFile.value ? `${zipFile.value.name} · ${formatBytes(zipFile.value.size)}` : ''))

/** Tells the dialog what the chosen source would send now. */
function emitChoice(): void {
  if (choice.value === 'folder')
    emit('folder', picked.value ?? [], claudeJson.value)
  else if (choice.value === 'zip' && zipFile.value)
    emit('zip', zipFile.value)
  else if (choice.value === 'server' && scanState.value === 'available')
    emit('scan')
  else
    emit('folder', [], null)
}

function choose(value: unknown): void {
  if (value !== 'folder' && value !== 'zip' && value !== 'server')
    return
  if (value === 'server' && scanState.value !== 'available')
    return
  choice.value = value
  emitChoice()
}

/** The files of a file input; the input is cleared so the same choice fires `change` again. */
function takeFiles(event: Event): File[] {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  try {
    input.value = ''
  }
  catch {}
  return files
}

function onFolder(event: Event): void {
  const result = pickClaudeFiles(takeFiles(event))
  picked.value = result.files
  tooLarge.value = result.tooLarge
  choice.value = 'folder'
  emitChoice()
}

function onConfig(event: Event): void {
  const file = takeFiles(event)[0]
  if (!file)
    return
  claudeJson.value = file
  choice.value = 'folder'
  emitChoice()
}

function onZip(event: Event): void {
  const file = takeFiles(event)[0]
  if (!file)
    return
  zipFile.value = file
  choice.value = 'zip'
  emitChoice()
}
</script>

<template>
  <div class="grid min-w-0 gap-3">
    <p :id="ids.legend" class="text-sm font-medium">
      Where is your .claude folder?
    </p>
    <RadioGroupRoot
      :model-value="choice"
      :disabled="busy"
      :aria-labelledby="ids.legend"
      class="grid min-w-0 gap-2"
      @update:model-value="choose"
    >
      <div :class="OPTION_CLASS" :data-selected="choice === 'folder'">
        <RadioGroupItem
          value="folder"
          :aria-describedby="ids.folder"
          :data-testid="testIds.claudeImportSource"
          data-value="folder"
          :class="RADIO_CLASS"
        >
          <span aria-hidden="true" class="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border border-input group-data-[state=checked]:border-primary group-data-[state=checked]:bg-primary">
            <RadioGroupIndicator class="flex items-center justify-center">
              <span class="size-1.5 rounded-full bg-primary-foreground" />
            </RadioGroupIndicator>
          </span>
          <span class="min-w-0 font-medium">Choose your .claude folder…</span>
        </RadioGroupItem>
        <div v-if="choice === 'folder'" class="flex flex-wrap gap-2 pl-7">
          <Button type="button" size="sm" variant="outline" class="pointer-coarse:h-10" :disabled="busy" @click="folderInput?.click()">
            <FolderOpenIcon aria-hidden="true" data-icon="inline-start" />
            Choose folder…
          </Button>
          <Button type="button" size="sm" variant="outline" class="pointer-coarse:h-10" :disabled="busy" @click="configInput?.click()">
            <PlusIcon aria-hidden="true" data-icon="inline-start" />
            .claude.json (MCP servers)
          </Button>
        </div>
        <div :id="ids.folder" class="grid gap-0.5 pl-7 text-xs text-muted-foreground" aria-live="polite">
          <p v-if="folderText" data-slot="claude-import-picked">
            {{ folderText }}
          </p>
          <p v-if="tooLargeText" class="break-words">
            {{ tooLargeText }}
          </p>
        </div>
        <input
          ref="folderInput"
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
          ref="configInput"
          type="file"
          accept=".json,application/json"
          class="sr-only"
          tabindex="-1"
          aria-label=".claude.json (MCP servers)"
          :data-testid="testIds.claudeImportConfigInput"
          @change="onConfig"
        >
      </div>

      <div :class="OPTION_CLASS" :data-selected="choice === 'zip'">
        <RadioGroupItem
          value="zip"
          :aria-describedby="ids.zip"
          :data-testid="testIds.claudeImportSource"
          data-value="zip"
          :class="RADIO_CLASS"
        >
          <span aria-hidden="true" class="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border border-input group-data-[state=checked]:border-primary group-data-[state=checked]:bg-primary">
            <RadioGroupIndicator class="flex items-center justify-center">
              <span class="size-1.5 rounded-full bg-primary-foreground" />
            </RadioGroupIndicator>
          </span>
          <span class="min-w-0 font-medium">Upload a zip…</span>
        </RadioGroupItem>
        <div v-if="choice === 'zip'" class="flex flex-wrap gap-2 pl-7">
          <Button type="button" size="sm" variant="outline" class="pointer-coarse:h-10" :disabled="busy" @click="zipInput?.click()">
            <FileArchiveIcon aria-hidden="true" data-icon="inline-start" />
            Choose zip…
          </Button>
        </div>
        <p :id="ids.zip" class="pl-7 text-xs break-all text-muted-foreground">
          {{ zipText || 'A zip of a .claude folder, up to 32 MiB.' }}
        </p>
        <input
          ref="zipInput"
          type="file"
          accept=".zip,application/zip,application/x-zip-compressed"
          class="sr-only"
          tabindex="-1"
          aria-label=".claude folder zip"
          :data-testid="testIds.claudeImportZipInput"
          @change="onZip"
        >
      </div>

      <div :class="OPTION_CLASS" :data-selected="choice === 'server'">
        <RadioGroupItem
          value="server"
          :disabled="scanState !== 'available'"
          :aria-describedby="ids.scan"
          :data-testid="testIds.claudeImportSource"
          data-value="server"
          :class="RADIO_CLASS"
        >
          <span aria-hidden="true" class="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border border-input group-data-[state=checked]:border-primary group-data-[state=checked]:bg-primary">
            <RadioGroupIndicator class="flex items-center justify-center">
              <span class="size-1.5 rounded-full bg-primary-foreground" />
            </RadioGroupIndicator>
          </span>
          <span class="min-w-0 font-medium break-all">Scan <span class="font-mono">{{ scanPath }}</span> on this server</span>
        </RadioGroupItem>
        <p
          :id="ids.scan"
          :data-testid="testIds.claudeImportScan"
          :data-state="scanState"
          class="pl-7 text-xs break-words text-muted-foreground"
        >
          {{ scanText }}
        </p>
      </div>
    </RadioGroupRoot>
    <p class="text-xs text-muted-foreground">
      Only agents, commands, skills, output styles, settings.json, CLAUDE.md and the mcpServers of .claude.json are read.
    </p>
  </div>
</template>
