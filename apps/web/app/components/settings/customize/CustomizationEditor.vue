<script setup lang="ts">
// The definition editor of the Customize page (docs/UI.md 9.12, 10.7): a right Sheet (`w-full sm:max-w-2xl`, sticky
// footer) with the name, description, tools, model, argument hint and body fields of a kind, serialized with
// `formatDefinition` and saved through the customizations store (create / update); "Discard changes?" on a dirty
// close. Mounted by CustomizeSettings. Props, emits and the root test id are frozen from Gate P10-0b (C33 stub); W10.8
// implements the form in P10-A. The stub shows the sheet with its title.
import type { Customization, CustomizationKind } from '@harness-forge/shared'
import type { CustomizationDraft } from './customize'
import { computed } from 'vue'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { testIds } from '~/utils/testids'
import { EDITOR_COPY } from './customize'

const props = defineProps<{
  open: boolean
  kind: CustomizationKind
  mode: 'new' | 'edit' | 'import'
  /** Edit mode: the personal definition. */
  customization?: Customization | null
  /** New (Duplicate) and import mode: the prefilled fields. */
  draft?: CustomizationDraft | null
  /** Import notes (customization-import-notes). */
  notes?: readonly string[]
}>()

const emit = defineEmits<{ 'update:open': [open: boolean], 'saved': [customization: Customization] }>()

const title = computed(() => {
  const kind = EDITOR_COPY[props.kind].title
  if (props.mode === 'edit')
    return `Edit ${props.customization?.name ?? kind}`
  return props.mode === 'import' ? `Import ${kind}` : `New ${kind}`
})
</script>

<template>
  <Sheet :open="open" @update:open="value => emit('update:open', value)">
    <SheetContent
      side="right"
      :data-testid="testIds.customizationEditor"
      :data-kind="kind"
      :data-mode="mode"
      class="data-[side=right]:w-full data-[side=right]:sm:max-w-2xl"
    >
      <SheetHeader>
        <SheetTitle>{{ title }}</SheetTitle>
        <SheetDescription class="sr-only">
          {{ EDITOR_COPY[kind].bodyHelp }}
        </SheetDescription>
      </SheetHeader>
    </SheetContent>
  </Sheet>
</template>
