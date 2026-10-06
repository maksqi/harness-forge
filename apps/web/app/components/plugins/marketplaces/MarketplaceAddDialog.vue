<script setup lang="ts">
// "Add marketplace" (Phase 12, ADR-054; docs/UI.md 8.13, 10.9): a form dialog (`marketplace-add-dialog`) with the source
// toggle (`marketplace-add-source`, `data-value` github | url | folder), the input (`marketplace-add-input`; text that
// `parseMarketplaceInput` recognizes as another kind switches the toggle), Add (`marketplace-add-submit`) →
// `useMarketplacesStore().add(source)` → `added(detail)`, and the error (`marketplace-add-error`, `data-code`).
// Props, emits and the root test id are frozen from Gate P12-0b (C46 stub); W12.8 implements the dialog in P12-A. The
// stub adds what the input parses to.
import type { MarketplaceDetail } from '@harness-forge/shared'
import { computed, ref, useId, watch } from 'vue'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useMarketplacesStore } from '~/stores/marketplaces'
import { toHarnessError } from '~/utils/errors'
import { testIds } from '~/utils/testids'
import { parseMarketplaceInput, sourceOfInput } from './marketplaces'

const props = defineProps<{ open: boolean }>()

const emit = defineEmits<{ 'update:open': [open: boolean], 'added': [marketplace: MarketplaceDetail] }>()

const marketplaces = useMarketplacesStore()
const inputId = useId()
const text = ref('')
const pending = ref(false)
const error = ref<{ code: string, message: string } | null>(null)

const parsed = computed(() => parseMarketplaceInput(text.value))
const kind = computed(() => ('error' in parsed.value ? 'github' : parsed.value.kind))

watch(() => props.open, (open) => {
  if (open) {
    text.value = ''
    error.value = null
    pending.value = false
  }
})

async function submit(): Promise<void> {
  const source = sourceOfInput(parsed.value)
  if (!source || pending.value) {
    if ('error' in parsed.value)
      error.value = { code: 'validation_error', message: parsed.value.error }
    return
  }
  pending.value = true
  error.value = null
  try {
    const detail = await marketplaces.add(source)
    emit('added', detail)
    emit('update:open', false)
  }
  catch (failure) {
    const harnessError = toHarnessError(failure)
    error.value = { code: harnessError.code, message: harnessError.message }
  }
  finally {
    pending.value = false
  }
}
</script>

<template>
  <Dialog :open="open" @update:open="value => emit('update:open', value)">
    <DialogContent :data-testid="testIds.marketplaceAddDialog" class="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>Add marketplace</DialogTitle>
        <DialogDescription>GitHub repository, marketplace.json URL or a folder on this server</DialogDescription>
      </DialogHeader>
      <form class="grid gap-3" novalidate @submit.prevent="submit">
        <div :data-testid="testIds.marketplaceAddSource" :data-value="kind" class="sr-only">
          {{ kind }}
        </div>
        <div class="grid gap-1.5">
          <Label :for="inputId">GitHub repository, marketplace.json URL or a folder on this server</Label>
          <Input
            :id="inputId"
            v-model="text"
            autocomplete="off"
            spellcheck="false"
            class="font-mono"
            :disabled="pending"
            :data-testid="testIds.marketplaceAddInput"
          />
        </div>
        <p v-if="error" role="alert" :data-testid="testIds.marketplaceAddError" :data-code="error.code" class="text-sm text-destructive">
          {{ error.message }}
        </p>
        <DialogFooter>
          <Button type="button" variant="outline" :disabled="pending" @click="emit('update:open', false)">
            Cancel
          </Button>
          <Button type="submit" :disabled="pending" :data-testid="testIds.marketplaceAddSubmit">
            Add
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
