<script setup lang="ts">
// Command palette (docs/UI.md 5.3, 10.4, 12): Mod+K or the sidebar Search row. Chats first (recent chats, or a
// debounced `GET /api/chats?q=` search with local title matches until the results arrive), then actions, pages,
// the default model (while searching) and the theme. Bound to ui.paletteOpen. Its setup registers the global
// shortcuts (useGlobalShortcuts): layouts/default.vue mounts it once. Contract: no props, no emits.
import type { ChatSummary } from '@harness-forge/shared'
import type { PaletteCommand, PaletteItem, PaletteModel } from './chat-nav/palette'
import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue'
import { toast } from 'vue-sonner'
import {
  Command,
  CommandGroup,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from '@/components/ui/command'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Kbd } from '@/components/ui/kbd'
import { useSidebar } from '@/components/ui/sidebar'
import { cn } from '@/lib/utils'
import KbdCombo from '~/components/common/KbdCombo.vue'
import RelativeTime from '~/components/common/RelativeTime.vue'
import ProviderIcon from '~/components/providers/ProviderIcon.vue'
import { useGlobalShortcuts } from '~/composables/useGlobalShortcuts'
import { useChatsStore } from '~/stores/chats'
import { useModelsStore } from '~/stores/models'
import { useProvidersStore } from '~/stores/providers'
import { useSettingsStore } from '~/stores/settings'
import { useUiStore } from '~/stores/ui'
import { toHarnessError } from '~/utils/errors'
import { testIds } from '~/utils/testids'
import { useNewChat } from './chat-nav/new-chat'
import { buildPaletteSections, CHAT_RESULTS_LIMIT } from './chat-nav/palette'
import PaletteSearchInput from './chat-nav/PaletteSearchInput.vue'
import { navigateTo, useColorMode } from './nuxt-imports'
import { normalizeThemePreference } from './theme'

const SEARCH_DEBOUNCE_MS = 200

useGlobalShortcuts()

const ui = useUiStore()
const chats = useChatsStore()
const models = useModelsStore()
const providers = useProvidersStore()
const settings = useSettingsStore()
const colorMode = useColorMode()
const sidebar = useSidebar(null)
const newChat = useNewChat()

const open = computed({
  get: () => ui.paletteOpen,
  set: (value: boolean) => {
    if (value)
      ui.openPalette()
    else
      ui.closePalette()
  },
})

const query = ref('')
const trimmedQuery = computed(() => query.value.trim())
/** Server results for the current query; null until they arrive (or when the search failed). */
const searchResults = shallowRef<ChatSummary[] | null>(null)
const searching = ref(false)

let searchTimer: ReturnType<typeof setTimeout> | undefined
let searchAbort: AbortController | null = null
let modelsRequested = false
/** Closing returns focus to where it was, unless the chosen item moves focus itself (navigation, new chat). */
let restoreFocus = true

function stopSearch() {
  clearTimeout(searchTimer)
  searchTimer = undefined
  searchAbort?.abort()
  searchAbort = null
  searching.value = false
}

async function searchChats(q: string) {
  const controller = new AbortController()
  searchAbort = controller
  try {
    const results = await chats.search(q, { limit: CHAT_RESULTS_LIMIT, signal: controller.signal })
    if (!controller.signal.aborted && q === trimmedQuery.value)
      searchResults.value = results
  }
  catch {
    // Aborted by a newer query, or the search failed: the local title matches stay.
  }
  finally {
    if (searchAbort === controller) {
      searchAbort = null
      searching.value = false
    }
  }
}

/** The default-model section needs the catalog and the provider list; load them once per opening, quietly. */
function requestModels() {
  if (modelsRequested)
    return
  modelsRequested = true
  if (!providers.loaded)
    providers.fetchAll().catch(() => {})
  if (!models.loaded)
    models.fetchAll().catch(() => {})
}

watch(trimmedQuery, (q) => {
  stopSearch()
  searchResults.value = null
  if (!q)
    return
  searching.value = true
  requestModels()
  searchTimer = setTimeout(() => void searchChats(q), SEARCH_DEBOUNCE_MS)
})

watch(() => ui.paletteOpen, (isOpen) => {
  if (!isOpen) {
    stopSearch()
    return
  }
  query.value = ''
  searchResults.value = null
  restoreFocus = true
  modelsRequested = false
  if (!chats.loaded && !chats.loading)
    chats.fetchPage().catch(() => {})
}, { immediate: true })

onScopeDispose(stopSearch)

const paletteModels = computed<PaletteModel[]>(() => models.visible
  .filter(model => model.kind === 'chat')
  .map((model) => {
    const provider = providers.byId(model.providerId)
    return {
      ref: model.ref,
      name: model.name,
      providerId: model.providerId,
      providerName: provider?.name ?? model.providerId,
      icon: provider?.icon ?? null,
    }
  }))

const sections = computed(() => buildPaletteSections({
  query: query.value,
  chats: chats.items,
  searchResults: searchResults.value,
  models: trimmedQuery.value ? paletteModels.value : [],
  defaultModelRef: settings.resolved.defaultModelRef,
  theme: normalizeThemePreference(colorMode.preference),
  canToggleSidebar: sidebar !== null,
}))

/** Changes when results arrive for the same query, so the first item is highlighted again. */
const highlightKey = computed(() => `${searchResults.value ? 'server' : 'local'}:${trimmedQuery.value}`)

async function setDefaultModel(modelRef: string) {
  const name = models.byRef(modelRef)?.name ?? modelRef
  try {
    await settings.update({ defaultModelRef: modelRef })
    toast.success(`Default model set to ${name}`)
  }
  catch (error) {
    toast.error('Couldn\'t change the default model', { description: toHarnessError(error).message })
  }
}

function run(command: PaletteCommand) {
  switch (command.type) {
    case 'open-chat':
      restoreFocus = false
      ui.closePalette()
      void navigateTo(`/chat/${command.chatId}`)
      return
    case 'new-chat':
      restoreFocus = false
      void newChat()
      return
    case 'show-shortcuts':
      restoreFocus = false
      ui.openShortcuts()
      return
    case 'toggle-sidebar':
      ui.closePalette()
      sidebar?.toggleSidebar()
      return
    case 'navigate':
      restoreFocus = false
      ui.closePalette()
      void navigateTo(command.to)
      return
    case 'default-model':
      ui.closePalette()
      void setDefaultModel(command.modelRef)
      return
    case 'theme':
      ui.closePalette()
      colorMode.preference = command.value
  }
}

function onSelect(event: Event, item: PaletteItem) {
  // Commands run once: the listbox keeps no selected value.
  event.preventDefault()
  run(item.command)
}

function onCloseAutoFocus(event: Event) {
  if (!restoreFocus)
    event.preventDefault()
  restoreFocus = true
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent
      :data-testid="testIds.commandPalette"
      :show-close-button="false"
      class="top-[14%] translate-y-0 gap-0 overflow-hidden rounded-xl p-0 shadow-2xl sm:max-w-xl"
      @close-auto-focus="onCloseAutoFocus"
    >
      <DialogHeader class="sr-only">
        <DialogTitle>Command palette</DialogTitle>
        <DialogDescription>Search chats and run commands.</DialogDescription>
      </DialogHeader>
      <Command class="rounded-none! bg-transparent p-0">
        <PaletteSearchInput
          v-model="query"
          :highlight-key="highlightKey"
          :loading="searching"
          :data-testid="testIds.commandPaletteInput"
          aria-label="Search chats and commands"
          placeholder="Search chats and commands…"
        />
        <CommandList v-if="sections.length > 0" class="max-h-[min(26rem,60dvh)] p-1.5">
          <template v-for="(section, index) in sections" :key="section.id">
            <CommandSeparator v-if="index > 0" class="my-1" />
            <CommandGroup :heading="section.heading" :data-section="section.id" class="p-0">
              <CommandItem
                v-for="item in section.items"
                :key="item.value"
                :value="item.value"
                :data-testid="testIds.commandPaletteItem"
                :data-value="item.value"
                :data-checked="item.checked ? 'true' : undefined"
                class="h-9 gap-2.5 px-2.5"
                @select="onSelect($event, item)"
              >
                <ProviderIcon
                  v-if="item.model"
                  :id="item.model.providerId"
                  :icon="item.model.icon"
                  :name="item.model.providerName"
                  size="sm"
                />
                <component :is="item.icon" v-else-if="item.icon" aria-hidden="true" class="text-muted-foreground" />
                <span :class="cn('truncate', item.detail && 'max-w-[65%] shrink-0', item.placeholder && 'text-muted-foreground italic')">
                  {{ item.label }}
                </span>
                <span v-if="item.detail" class="min-w-0 flex-1 truncate text-muted-foreground">{{ item.detail }}</span>
                <CommandShortcut v-if="item.keys" class="tracking-normal">
                  <KbdCombo :keys="item.keys" />
                </CommandShortcut>
                <CommandShortcut v-else-if="item.updatedAt !== undefined" class="tracking-normal">
                  <RelativeTime :at="item.updatedAt" />
                </CommandShortcut>
              </CommandItem>
            </CommandGroup>
          </template>
        </CommandList>
        <p v-else role="status" class="py-10 text-center text-sm text-muted-foreground">
          No results
        </p>
        <div
          aria-hidden="true"
          class="flex items-center gap-4 border-t border-border px-3.5 py-2 text-[11px] text-muted-foreground max-sm:hidden pointer-coarse:hidden"
        >
          <span class="inline-flex items-center gap-1.5"><Kbd>↑</Kbd><Kbd>↓</Kbd> Navigate</span>
          <span class="inline-flex items-center gap-1.5"><Kbd>↵</Kbd> Open</span>
          <span class="inline-flex items-center gap-1.5"><Kbd>Esc</Kbd> Close</span>
        </div>
      </Command>
    </DialogContent>
  </Dialog>
</template>
