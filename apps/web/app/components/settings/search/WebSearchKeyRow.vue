<script setup lang="ts">
// One write-only search API key row of Settings → Web search (docs/UI.md 2.20, 9.15, 14.1, 14.2; ADR-063): the
// backend's name and "Get a key" (the vendor's page), then either "Key saved" with Replace and Remove, or a password
// input ("Paste a key…", always empty: the stored key is never read back, not even its hint) with Save. Writes the
// `core-search` secret setting through the web-search store (`setKey`; no password prompt: plugin settings are not a
// fresh-auth action) and toasts "Saved the {backend} key" / "Removed the {backend} key". Focus: Replace moves it into
// the input; after Save it lands on Replace, after Remove on the input (the row's next control). Esc while replacing
// goes back to "Key saved". Rendered by WebSearchSettings inside the list "Search API keys".
import type { SecretState, WebSearchBackend } from '@harness-forge/shared'
import { ArrowUpRightIcon, CheckIcon } from '@lucide/vue'
import { computed, nextTick, ref, useId, useTemplateRef } from 'vue'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { WEB_SEARCH_BACKEND_LABELS } from '~/components/chat/composer/web-search'
import { useWebSearchStore } from '~/stores/web-search'
import { testIds } from '~/utils/testids'
import { toastError } from '../notify'
import { WEB_SEARCH_KEY_URLS } from './web-search-settings'

const props = withDefaults(defineProps<{
  backend: WebSearchBackend
  state: SecretState
  disabled?: boolean
}>(), {
  disabled: false,
})

const webSearch = useWebSearchStore()
const row = useTemplateRef<HTMLElement>('row')

const ids = { name: useId(), state: useId(), input: useId() }
const label = computed(() => WEB_SEARCH_BACKEND_LABELS[props.backend])
const keyUrl = computed(() => WEB_SEARCH_KEY_URLS[props.backend])

const draft = ref('')
const replacing = ref(false)
const busy = ref<'save' | 'remove' | null>(null)

/** The input shows for a missing key and while replacing a saved one. */
const editing = computed(() => !props.state.set || replacing.value)
const canSave = computed(() => !props.disabled && busy.value === null && draft.value.trim() !== '')

/** The row's Replace button and key input (the focus targets after an action). */
const REPLACE_SELECTOR = '[data-action="replace"]'
const INPUT_SELECTOR = `[data-testid="${testIds.settingsSearchKeyInput}"]`

function focusIn(selector: string) {
  void nextTick(() => row.value?.querySelector<HTMLElement>(selector)?.focus())
}

function startReplace() {
  replacing.value = true
  focusIn(INPUT_SELECTOR)
}

function cancelReplace() {
  if (!props.state.set)
    return
  replacing.value = false
  draft.value = ''
  focusIn(REPLACE_SELECTOR)
}

/** Runs one `setKey`; true when it succeeded (a failure toasts). The buttons are enabled again before it returns. */
async function runSetKey(action: 'save' | 'remove', value: string | null): Promise<boolean> {
  busy.value = action
  try {
    await webSearch.setKey(props.backend, value)
    return true
  }
  catch (error) {
    toastError(error)
    return false
  }
  finally {
    busy.value = null
  }
}

async function saveKey() {
  const value = draft.value.trim()
  if (!canSave.value || value === '' || !(await runSetKey('save', value)))
    return
  draft.value = ''
  replacing.value = false
  toast.success(`Saved the ${label.value} key`)
  // "Key saved" replaces the input: Replace is the row's next control.
  focusIn(webSearch.config?.keys[props.backend]?.set === false ? INPUT_SELECTOR : REPLACE_SELECTOR)
}

async function removeKey() {
  if (props.disabled || busy.value !== null || !(await runSetKey('remove', null)))
    return
  draft.value = ''
  replacing.value = false
  toast.success(`Removed the ${label.value} key`)
  focusIn(INPUT_SELECTOR)
}
</script>

<template>
  <li
    ref="row"
    :data-testid="testIds.settingsSearchKey"
    :data-backend="backend"
    :data-state="state.set ? 'set' : 'missing'"
    :aria-labelledby="ids.name"
    class="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:gap-3"
  >
    <div class="flex min-w-0 items-center justify-between gap-3 sm:w-40 sm:shrink-0 sm:flex-col sm:items-start sm:justify-center sm:gap-0.5">
      <span :id="ids.name" class="text-sm font-medium">{{ label }}</span>
      <a
        :href="keyUrl"
        target="_blank"
        rel="noopener noreferrer"
        class="inline-flex items-center gap-0.5 rounded-sm text-xs text-muted-foreground underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 pointer-coarse:min-h-10"
      >
        Get a key
        <ArrowUpRightIcon aria-hidden="true" class="size-3" />
        <span class="sr-only">(opens {{ label }} in a new tab)</span>
      </a>
    </div>

    <div v-if="!editing" class="flex min-w-0 flex-1 flex-wrap items-center gap-2">
      <span :id="ids.state" class="mr-auto inline-flex items-center gap-1.5 text-sm">
        <CheckIcon aria-hidden="true" class="size-3.5 text-success" />
        Key saved
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        data-action="replace"
        :disabled="disabled || busy !== null"
        :aria-label="`Replace the ${label} key`"
        class="pointer-coarse:h-10"
        @click="startReplace"
      >
        Replace
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        :data-testid="testIds.settingsSearchKeyRemove"
        :data-backend="backend"
        :disabled="disabled || busy !== null"
        :aria-busy="busy === 'remove' || undefined"
        :aria-label="`Remove the ${label} key`"
        class="text-muted-foreground hover:text-destructive pointer-coarse:h-10"
        @click="removeKey"
      >
        <Spinner v-if="busy === 'remove'" data-icon="inline-start" />
        Remove
      </Button>
    </div>

    <form v-else class="flex min-w-0 flex-1 flex-wrap items-center gap-2" @submit.prevent="saveKey">
      <span :id="ids.state" class="sr-only">{{ state.set ? 'Key saved' : 'No key' }}</span>
      <Input
        :id="ids.input"
        v-model="draft"
        type="password"
        placeholder="Paste a key…"
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        data-1p-ignore="true"
        data-lpignore="true"
        :data-testid="testIds.settingsSearchKeyInput"
        :data-backend="backend"
        :disabled="disabled || busy !== null"
        :aria-label="`${label} key`"
        :aria-describedby="ids.state"
        class="min-w-0 flex-1 basis-full font-mono text-[13px] placeholder:font-sans placeholder:text-sm sm:basis-48 pointer-coarse:h-10"
        @keydown.esc.prevent="cancelReplace"
      />
      <div class="flex items-center gap-2">
        <Button
          type="submit"
          variant="outline"
          size="sm"
          :data-testid="testIds.settingsSearchKeySave"
          :data-backend="backend"
          :disabled="!canSave"
          :aria-busy="busy === 'save' || undefined"
          class="pointer-coarse:h-10"
        >
          <Spinner v-if="busy === 'save'" data-icon="inline-start" />
          Save
        </Button>
        <Button
          v-if="state.set"
          type="button"
          variant="ghost"
          size="sm"
          :disabled="busy !== null"
          class="pointer-coarse:h-10"
          @click="cancelReplace"
        >
          Cancel
        </Button>
      </div>
    </form>
  </li>
</template>
