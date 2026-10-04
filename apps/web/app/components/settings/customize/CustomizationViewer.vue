<script setup lang="ts">
// The read-only viewer of a project, plugin or built-in definition (docs/UI.md 9.12, 10.7): a right Sheet with the
// frontmatter as a definition list, the raw file (`customizations.sourceOf(entry, projectId)`) in a read-only
// MarkdownEditor with lint markers, Copy path, Copy to personal (`copy` with the draft) and Export .md. Mounted by
// CustomizeSettings. Props, emits and the root test id are frozen from Gate P10-0b (C33 stub); W10.8 implements it in
// P10-A. The stub shows the sheet with the name and the description.
import type { CustomizationEntry } from '@harness-forge/shared'
import type { CustomizationDraft } from './customize'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { testIds } from '~/utils/testids'

defineProps<{ open: boolean, entry: CustomizationEntry | null, projectId: string | null }>()

const emit = defineEmits<{ 'update:open': [open: boolean], 'copy': [draft: CustomizationDraft] }>()
</script>

<template>
  <Sheet :open="open && entry !== null" @update:open="value => emit('update:open', value)">
    <SheetContent
      v-if="entry"
      side="right"
      :data-testid="testIds.customizationViewer"
      :data-kind="entry.kind"
      :data-source="entry.source"
      class="data-[side=right]:w-full data-[side=right]:sm:max-w-2xl"
    >
      <SheetHeader>
        <SheetTitle class="font-mono">
          {{ entry.name }}
        </SheetTitle>
        <SheetDescription>{{ entry.description }}</SheetDescription>
      </SheetHeader>
    </SheetContent>
  </Sheet>
</template>
