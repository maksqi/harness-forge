<script setup lang="ts">
// Remember (docs/UI.md 7.30, 10.7; ADR-047): `/remember [text]` opens this form dialog, mounted by ChatComposer, with
// the note (`remember-text`, at most 2,000 characters), the "Save to" targets (`remember-target`: the project file, the
// project's instructions, the custom instructions; the project ones disabled outside a saved project chat) and Save
// (`POST /api/memory` through useApi(); the returned project or settings go to their stores). Props, emits and the root
// test id are frozen from Gate P10-0b (C33 stub); W10.9 implements the form in P10-A. The stub shows the title and the
// text, and closes.
import type { RememberResult } from '@harness-forge/shared'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { testIds } from '~/utils/testids'

defineProps<{ open: boolean, text: string, projectId: string | null, chatId: string | null }>()

const emit = defineEmits<{ 'update:open': [open: boolean], 'saved': [result: RememberResult] }>()
</script>

<template>
  <Dialog :open="open" @update:open="value => emit('update:open', value)">
    <DialogContent :data-testid="testIds.rememberDialog" class="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>Remember</DialogTitle>
        <DialogDescription>Remember is not available yet.</DialogDescription>
      </DialogHeader>
      <p v-if="text" class="text-sm break-words whitespace-pre-wrap">
        {{ text }}
      </p>
      <DialogFooter>
        <Button type="button" variant="outline" @click="emit('update:open', false)">
          Cancel
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
