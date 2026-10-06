<script setup lang="ts">
// The read-only viewer of a project, plugin or built-in definition (docs/UI.md 9.12, 10.7, 14): a right Sheet (full
// width on phones) named by the definition's name, with the frontmatter as a definition list (description, tools,
// model, argument hint, source), the raw file (`customizations.sourceOf(entry, projectId)`, i.e. `GET
// /customizations/source`; a shadowed project file shows its own content) in a read-only MarkdownEditor with the
// diagnostics as lint markers, and for project files the path in mono with Copy path. Footer: Copy to personal (`copy`
// with the draft parsed from the file) and Export .md (`downloadText`). A file that is gone (404) shows "This file no
// longer exists." with Close. Opens with focus on its Close button; reka returns focus to the row's `⋯` trigger.
// Props, emits and the root test id are frozen from Gate P10-0b (C33).
// Phase 11 (W11.8; docs/UI.md 9.13): a style is titled by its label and lists its name and what it does with the coding
// instructions; a skill lists the argument hint, whether it is in the slash menu and "Only when you run it".
// Phase 12 (ADR-056; C46 CCR, W12.11 owns it in P12-A): project files get Edit in the footer (`data-action="edit"`), the
// emit `edit` that CustomizeSettings answers with the project file editor.
import type { CustomizationEntry } from '@harness-forge/shared'
import type { CustomizationDraft } from './customize'
import { CopyPlusIcon, DownloadIcon, FileXIcon, PencilIcon } from '@lucide/vue'
import { computed, ref, watch } from 'vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import CopyButton from '~/components/common/CopyButton.vue'
import MarkdownEditor from '~/components/common/MarkdownEditor.vue'
import { useCustomizationsStore } from '~/stores/customizations'
import { useModelsStore } from '~/stores/models'
import { usePluginsStore } from '~/stores/plugins'
import { downloadText } from '~/utils/download'
import { hasErrorCode, toHarnessError } from '~/utils/errors'
import { testIds } from '~/utils/testids'
import { displayName as displayNameOf, draftFromEntry, sourceLabel } from './customize'

const props = defineProps<{ open: boolean, entry: CustomizationEntry | null, projectId: string | null }>()

const emit = defineEmits<{ 'update:open': [open: boolean], 'copy': [draft: CustomizationDraft], 'edit': [] }>()

const customizations = useCustomizationsStore()
const plugins = usePluginsStore()
const models = useModelsStore()

const content = ref<string | null>(null)
const loading = ref(false)
const gone = ref(false)
const loadError = ref<string | null>(null)
let request = 0

const pluginName = (id: string): string => plugins.byId(id)?.name ?? id

const displayName = computed(() => (props.entry ? displayNameOf(props.entry) : ''))
const details = computed(() => {
  const entry = props.entry
  if (!entry)
    return []
  const rows: { term: string, value: string, mono?: boolean }[] = [{ term: 'Description', value: entry.description || '—' }]
  if (entry.kind === 'agent')
    rows.push({ term: 'Tools', value: entry.tools ? (entry.tools.length > 0 ? entry.tools.join(', ') : 'None') : 'All tools', mono: !!entry.tools?.length })
  else if (entry.kind === 'command')
    rows.push({ term: 'Allowed tools', value: entry.tools ? (entry.tools.length > 0 ? entry.tools.join(', ') : 'None') : 'No restriction', mono: !!entry.tools?.length })
  if (entry.kind === 'agent' || entry.kind === 'command') {
    const model = entry.modelRef === 'inherit'
      ? 'Same as the chat'
      : entry.modelRef
        ? models.byRef(entry.modelRef)?.name ?? entry.modelRef
        : entry.kind === 'agent' ? 'Default sub-agent model' : 'The chat\'s model'
    rows.push({ term: 'Model', value: model })
  }
  if ((entry.kind === 'command' || entry.kind === 'skill') && entry.argumentHint)
    rows.push({ term: 'Argument hint', value: entry.argumentHint, mono: true })
  // + Phase 11: the skill and style keys.
  if (entry.kind === 'skill') {
    rows.push({ term: 'Slash menu', value: entry.userInvocable === false ? 'Not shown' : `/${entry.name}`, mono: entry.userInvocable !== false })
    if (entry.modelInvocable === false)
      rows.push({ term: 'Loading', value: 'Only when you run it' })
  }
  if (entry.kind === 'style') {
    if (displayName.value !== entry.name)
      rows.push({ term: 'Name', value: entry.name, mono: true })
    rows.push({ term: 'Coding', value: entry.keepCodingInstructions ? 'Keeps coding instructions' : 'Replaces coding instructions' })
  }
  if (entry.namespace)
    rows.push({ term: 'Namespace', value: entry.namespace, mono: true })
  rows.push({ term: 'Source', value: sourceLabel(entry, pluginName) })
  return rows
})

async function load(): Promise<void> {
  const entry = props.entry
  if (!entry)
    return
  const id = ++request
  loading.value = true
  gone.value = false
  loadError.value = null
  content.value = null
  try {
    const text = await customizations.sourceOf(entry, props.projectId)
    if (id === request)
      content.value = text
  }
  catch (error) {
    if (id !== request)
      return
    if (hasErrorCode(error, 'not_found'))
      gone.value = true
    else
      loadError.value = toHarnessError(error).message
  }
  finally {
    if (id === request)
      loading.value = false
  }
}

watch(() => [props.open, props.entry] as const, ([open, entry]) => {
  if (open && entry)
    void load()
}, { immediate: true })

function onOpenAutoFocus(event: Event): void {
  event.preventDefault()
  const target = event.target instanceof HTMLElement ? event.target : null
  target?.querySelector<HTMLElement>('[data-slot="sheet-close"]')?.focus()
}

function copyToPersonal(): void {
  if (!props.entry || content.value === null)
    return
  emit('copy', draftFromEntry(props.entry, content.value))
}

function exportFile(): void {
  if (!props.entry || content.value === null)
    return
  downloadText(content.value, `${props.entry.name}.md`, 'text/markdown')
}
</script>

<template>
  <Sheet :open="open && entry !== null" @update:open="value => emit('update:open', value)">
    <SheetContent
      v-if="entry"
      side="right"
      :data-testid="testIds.customizationViewer"
      :data-kind="entry.kind"
      :data-source="entry.source"
      class="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-2xl"
      @open-auto-focus="onOpenAutoFocus"
    >
      <SheetHeader class="border-b pr-14">
        <SheetTitle class="truncate" :class="entry.kind === 'style' && displayName !== entry.name ? undefined : 'font-mono'">
          {{ displayName }}
        </SheetTitle>
        <SheetDescription class="line-clamp-2">
          {{ entry.description }}
        </SheetDescription>
      </SheetHeader>

      <div class="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto overscroll-contain p-4">
        <dl class="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
          <template v-for="row in details" :key="row.term">
            <dt class="text-muted-foreground">
              {{ row.term }}
            </dt>
            <dd class="min-w-0 break-words" :class="row.mono ? 'font-mono text-[13px]' : undefined">
              {{ row.value }}
            </dd>
          </template>
        </dl>

        <div v-if="entry.source === 'project' && entry.path" class="flex min-w-0 items-center gap-2 rounded-md border bg-muted/40 py-1 pr-1 pl-3">
          <span class="min-w-0 flex-1 truncate font-mono text-xs" :title="entry.path">{{ entry.path }}</span>
          <CopyButton :text="entry.path" label="Copy path" size="sm" class="shrink-0 pointer-coarse:h-10" />
        </div>

        <Alert v-if="gone" role="alert" data-slot="customization-viewer-gone">
          <FileXIcon aria-hidden="true" />
          <AlertDescription class="text-foreground">
            This file no longer exists.
          </AlertDescription>
        </Alert>
        <Alert v-else-if="loadError" role="alert" class="border-destructive/35 bg-destructive/5 dark:bg-destructive/10">
          <FileXIcon aria-hidden="true" class="text-destructive" />
          <AlertDescription class="text-foreground">
            {{ loadError }}
          </AlertDescription>
        </Alert>
        <Skeleton v-else-if="loading || content === null" class="h-64 rounded-md" />
        <MarkdownEditor
          v-else
          :model-value="content"
          :label="`Contents of ${entry.path ?? `${entry.name}.md`}`"
          readonly
          :diagnostics="entry.diagnostics"
        />
      </div>

      <SheetFooter class="mt-0 flex-col-reverse gap-2 border-t p-4 sm:flex-row sm:justify-end">
        <Button
          v-if="gone || loadError"
          type="button"
          variant="outline"
          class="pointer-coarse:h-10"
          @click="emit('update:open', false)"
        >
          Close
        </Button>
        <template v-else>
          <Button type="button" variant="outline" :disabled="content === null" class="pointer-coarse:h-10" @click="exportFile">
            <DownloadIcon aria-hidden="true" data-icon="inline-start" />
            Export .md
          </Button>
          <Button
            v-if="entry?.source === 'project' && entry.path"
            type="button"
            variant="outline"
            data-action="edit"
            class="pointer-coarse:h-10"
            @click="emit('edit')"
          >
            <PencilIcon aria-hidden="true" data-icon="inline-start" />
            Edit
          </Button>
          <Button type="button" :disabled="content === null" class="pointer-coarse:h-10" @click="copyToPersonal">
            <CopyPlusIcon aria-hidden="true" data-icon="inline-start" />
            Copy to personal
          </Button>
        </template>
      </SheetFooter>
    </SheetContent>
  </Sheet>
</template>
