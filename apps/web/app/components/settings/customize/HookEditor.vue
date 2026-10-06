<script setup lang="ts">
// The hook editor of the Customize Hooks tab (Phase 11, ADR-048; docs/UI.md 9.13, 10.8): a right Sheet (`w-full
// sm:max-w-2xl`, sticky footer) "New hook" / "Edit hook" / "Copy hook" with the warning (`hook-warning`), Event
// (`hook-event`, the descriptions of `HOOK_EVENT_INFO`), Tools (`hook-matcher`, tool events only, with the preview
// `hook-matcher-preview`), Command (`hook-command`), Timeout (`hook-timeout`), On (`hook-editor-enabled`) and Save hook
// (`hook-save`): `useFreshAuth().run(() => hooks.create(body) | hooks.update(id, patch), { required: true })` ("Saving a
// hook needs your password."); "Discard changes?" on a dirty close; Mod+Enter saves. Mounted by HooksPanel; `hook` =
// the personal hook (edit), `draft` = the prefilled fields (Duplicate, Copy to personal). Props, emits and the root test
// id are frozen from Gate P11-0b (C39 stub); W11.8 implements the form in P11-A. The stub shows the sheet with its title.
import type { PersonalHook } from '@harness-forge/shared'
import type { HookDraft } from './hooks'
import { computed } from 'vue'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { testIds } from '~/utils/testids'
import { HOOK_COPY } from './hooks'

const props = defineProps<{
  open: boolean
  mode: 'new' | 'edit' | 'copy'
  /** Edit mode: the personal hook. */
  hook: PersonalHook | null
  /** New (Duplicate, Copy to personal) and copy mode: the prefilled fields. */
  draft?: HookDraft | null
}>()

const emit = defineEmits<{ 'update:open': [open: boolean], 'saved': [hook: PersonalHook] }>()

const title = computed(() => ({ new: 'New hook', edit: 'Edit hook', copy: 'Copy hook' })[props.mode])
</script>

<template>
  <Sheet :open="open" @update:open="value => emit('update:open', value)">
    <SheetContent
      side="right"
      :data-testid="testIds.hookEditor"
      :data-mode="mode"
      class="data-[side=right]:w-full data-[side=right]:sm:max-w-2xl"
    >
      <SheetHeader>
        <SheetTitle>{{ title }}</SheetTitle>
        <SheetDescription class="sr-only">
          {{ HOOK_COPY.warning }}
        </SheetDescription>
      </SheetHeader>
    </SheetContent>
  </Sheet>
</template>
