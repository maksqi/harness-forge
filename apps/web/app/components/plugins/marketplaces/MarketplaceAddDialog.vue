<script setup lang="ts">
// "Add marketplace" (Phase 12, ADR-054; docs/UI.md 8.13, 10.9, 14.1): a form dialog (`marketplace-add-dialog`) titled "Add
// marketplace" with the source toggle (`marketplace-add-source`, `data-value` github | url | folder: "GitHub", "URL",
// "Folder on this server"; it sets the placeholder, and text that `parseMarketplaceInput` recognizes as another kind
// switches it), the input (`marketplace-add-input`, labelled "GitHub repository, marketplace.json URL or a folder on this
// server"; the dialog opens on it), Add (`marketplace-add-submit`, a spinner while it runs; Enter or Mod+Enter) →
// `useMarketplacesStore().add(source)` → the toast "Added {name}", `added(detail)` and the dialog closes. Adding needs no
// password: it reads a catalog and runs nothing. An unusable value shows "Enter owner/repo, an https URL or an absolute
// folder path." under the input; a server error shows its message as is (`marketplace-add-error`, `data-code`,
// `data-reason` for a 409: `exists` / `offline`), a 429 with "Try again in {n} min".
// Props, emits and the root test id are frozen from Gate P12-0b (C46 stub); implementation W12.8 (P12-A).
import type { MarketplaceDetail } from '@harness-forge/shared'
import type { AcceptableValue } from 'reka-ui'
import type { MarketplaceInputKind } from './marketplaces'
import { computed, nextTick, ref, useId, useTemplateRef, watch } from 'vue'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useMarketplacesStore } from '~/stores/marketplaces'
import { toHarnessError } from '~/utils/errors'
import { testIds } from '~/utils/testids'
import { addErrorText, conflictReasonOf, MARKETPLACE_INPUT_KINDS, parseMarketplaceInput, sourceOfInput } from './marketplaces'

const props = defineProps<{ open: boolean }>()

const emit = defineEmits<{ 'update:open': [open: boolean], 'added': [marketplace: MarketplaceDetail] }>()

const marketplaces = useMarketplacesStore()
const inputId = useId()
const errorId = useId()
const formId = useId()
const inputRef = useTemplateRef<{ $el?: HTMLElement } | HTMLElement>('input')

const text = ref('')
/** The kind the user picked on the toggle (the placeholder); text of another kind wins. */
const chosen = ref<MarketplaceInputKind>('github')
const pending = ref(false)
const error = ref<{ code: string, reason: string | null, message: string } | null>(null)

const parsed = computed(() => parseMarketplaceInput(text.value))
const kind = computed<MarketplaceInputKind>(() => ('error' in parsed.value ? chosen.value : parsed.value.kind))
const placeholder = computed(() => MARKETPLACE_INPUT_KINDS.find(option => option.value === kind.value)?.placeholder ?? '')
const canSubmit = computed(() => !pending.value && text.value.trim() !== '')

watch(() => props.open, (open) => {
  if (open) {
    text.value = ''
    chosen.value = 'github'
    error.value = null
    pending.value = false
  }
})

watch(text, () => {
  if (error.value)
    error.value = null
  // Typing text of another kind moves the toggle along, so clearing the field later keeps that kind's placeholder.
  if (!('error' in parsed.value))
    chosen.value = parsed.value.kind
})

function inputElement(): HTMLInputElement | null {
  const value = inputRef.value
  const element = value instanceof HTMLElement ? value : value?.$el
  return element instanceof HTMLInputElement ? element : (element?.querySelector?.('input') ?? null)
}

function focusInput(): void {
  void nextTick(() => inputElement()?.focus())
}

/** The dialog opens on its input (not on the toggle). */
function onOpenAutoFocus(event: Event): void {
  event.preventDefault()
  focusInput()
}

function onKind(value: AcceptableValue | AcceptableValue[]): void {
  // A single toggle cannot be emptied: clicking the active item again keeps it.
  if (value === 'github' || value === 'url' || value === 'folder') {
    chosen.value = value
    focusInput()
  }
}

function setOpen(value: boolean): void {
  // Closing while the add runs would hide its result.
  if (!value && pending.value)
    return
  emit('update:open', value)
}

async function submit(): Promise<void> {
  if (pending.value || text.value.trim() === '')
    return
  const input = parsed.value
  const source = sourceOfInput(input)
  if (!source) {
    error.value = { code: 'validation_error', reason: null, message: 'error' in input ? input.error : '' }
    focusInput()
    return
  }
  pending.value = true
  error.value = null
  try {
    const detail = await marketplaces.add(source)
    toast.success(`Added ${detail.name}`)
    pending.value = false
    emit('added', detail)
    emit('update:open', false)
  }
  catch (failure) {
    const harnessError = toHarnessError(failure)
    error.value = { code: harnessError.code, reason: conflictReasonOf(harnessError), message: addErrorText(harnessError) }
    focusInput()
  }
  finally {
    pending.value = false
  }
}

/** Mod+Enter adds from anywhere in the dialog (Enter in the input submits the form too). */
function onKeydown(event: KeyboardEvent): void {
  if (event.defaultPrevented || event.isComposing || event.key !== 'Enter' || !(event.metaKey || event.ctrlKey))
    return
  event.preventDefault()
  void submit()
}
</script>

<template>
  <Dialog :open="open" @update:open="setOpen">
    <DialogContent
      :data-testid="testIds.marketplaceAddDialog"
      class="max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-lg"
      @open-auto-focus="onOpenAutoFocus"
      @keydown="onKeydown"
    >
      <DialogHeader>
        <DialogTitle>Add marketplace</DialogTitle>
        <DialogDescription>Adding a marketplace reads its list of plugins. Nothing is installed or run.</DialogDescription>
      </DialogHeader>
      <form :id="formId" class="-mx-1 grid min-h-0 content-start gap-4 overflow-y-auto px-1" novalidate @submit.prevent="submit">
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          :model-value="kind"
          :disabled="pending"
          :data-testid="testIds.marketplaceAddSource"
          :data-value="kind"
          aria-label="Source"
          class="w-full max-sm:flex-wrap"
          @update:model-value="onKind"
        >
          <ToggleGroupItem
            v-for="option in MARKETPLACE_INPUT_KINDS"
            :key="option.value"
            :value="option.value"
            :data-value="option.value"
            class="flex-1 px-3 text-xs pointer-coarse:h-10"
          >
            {{ option.label }}
          </ToggleGroupItem>
        </ToggleGroup>
        <div class="grid gap-1.5">
          <Label :for="inputId">GitHub repository, marketplace.json URL or a folder on this server</Label>
          <Input
            :id="inputId"
            ref="input"
            v-model="text"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            class="font-mono pointer-coarse:h-10"
            :placeholder="placeholder"
            :disabled="pending"
            :aria-invalid="error ? 'true' : undefined"
            :aria-describedby="error ? errorId : undefined"
            :data-testid="testIds.marketplaceAddInput"
          />
          <p
            v-if="error"
            :id="errorId"
            role="alert"
            :data-testid="testIds.marketplaceAddError"
            :data-code="error.code"
            :data-reason="error.reason ?? undefined"
            class="text-sm text-destructive"
          >
            {{ error.message }}
          </p>
        </div>
      </form>
      <DialogFooter>
        <Button type="button" variant="outline" :disabled="pending" class="pointer-coarse:h-10" @click="setOpen(false)">
          Cancel
        </Button>
        <Button
          type="submit"
          :form="formId"
          :disabled="!canSubmit"
          :aria-busy="pending || undefined"
          :data-testid="testIds.marketplaceAddSubmit"
          class="pointer-coarse:h-10"
        >
          <Spinner v-if="pending" data-icon="inline-start" />
          Add
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
