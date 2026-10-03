<script setup lang="ts">
// The chat page's workspace frame (docs/UI.md 2.15, 7.21, 12, 14; ADR-037): `pages/chat/[id].vue` wraps ChatView in it.
// Always a horizontal ResizablePanelGroup that holds the chat panel (so opening or closing the changes panel never
// remounts ChatView: scroll position and the stream survive), plus, at >= 1024px with the panel open and a project, the
// handle changes-resize (drag or arrow keys; a 24px hit area on coarse pointers) and an <aside> labelled by the panel's
// h2 with ChangesPanel variant="pane": 440px by default, 320-720px, the chat panel keeps at least 40%; reka keeps the
// pane's px size when the window resizes, and the width the user drags or keys in goes to `hf-changes-width`
// (useChangesPanel) from the pane's `resize` event (not reka's `autoSaveId`, which stores percentages). Below 1024px
// the same panel is a right Sheet (full width below `sm`, `sm:max-w-lg`, the panel's own 40px Close; it never opens by
// itself: a narrow viewport closes the panel). Without a project only the chat panel renders.
// Focus (14.1): a click on the toggle keeps focus there; Alt+C and the palette move it to the active view tab when they
// open the panel; Close (and Alt+C from inside the pane) returns it to the toggle; the sheet traps focus, closes with Esc
// and returns focus to the toggle.
// Alt+C (id toggle-changes, `alt+code:KeyC`, group Chat, also in inputs, obeys `altShortcuts`) is registered while the
// chat has a project; the same condition publishes the changes target for the command palette's "Show changes".
// Contract (docs/UI.md 10.5; frozen from Gate P8-0b): props and slot below, no emits; no root test id
// (data-slot="chat-workspace").
import { useMediaQuery } from '@vueuse/core'
import { computed, nextTick, onScopeDispose, ref, watch } from 'vue'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { CHANGES_SHORTCUT, CHANGES_SHORTCUT_KEYS, CHANGES_WIDTH, clampChangesWidth, useChangesPanel } from '~/composables/useChangesPanel'
import { useShortcuts } from '~/composables/useShortcuts'
import { testIds } from '~/utils/testids'
import { setChangesTarget } from './changes/changes-context'
import { CHANGES_HEADING_ID, CHANGES_PANEL_ID } from './changes/changes-rows'
import ChangesPanel from './changes/ChangesPanel.vue'

const props = defineProps<{
  chatId: string
  /** The chat's project; null: only the chat panel renders. */
  projectId: string | null
}>()

defineSlots<{
  /** The ChatView. */
  default: () => any
}>()

/** The chat panel keeps at least this share of the width (percent). */
const CHAT_MIN_PERCENT = 40
/** Arrow keys move the handle by this share of the width (percent). */
const KEYBOARD_STEP_PERCENT = 2

const panel = useChangesPanel()
const isDesktop = useMediaQuery('(min-width: 1024px)')
const hasProject = computed(() => props.projectId !== null)
const showPane = computed(() => isDesktop.value && panel.open.value && hasProject.value)
const sheetOpen = computed(() => !isDesktop.value && panel.open.value && hasProject.value)

// The sheet is modal: it never appears by itself (a stored "open" from a wide window, or a window narrowed while the
// pane shows); below 1024px only the toggle, Alt+C or the palette open it.
watch(isDesktop, (desktop) => {
  if (!desktop && panel.open.value)
    panel.setOpen(false)
}, { immediate: true })

// ---------- pane width ----------

/** The pane's initial size, read when it opens (a later persisted width must not re-layout the group). */
const paneDefault = ref(panel.width.value)
watch(showPane, (shown) => {
  if (shown)
    paneDefault.value = clampChangesWidth(panel.width.value)
})

const dragging = ref(false)
const handleFocused = ref(false)

/** Only a width the user chose is stored (drag or arrow keys), not one the window size forced. */
function onPaneResize(size: number) {
  if (dragging.value || handleFocused.value)
    panel.width.value = clampChangesWidth(size)
}

// ---------- focus ----------

function toggleButton(): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="${testIds.changesToggle}"]`)
}

function panelElement(): HTMLElement | null {
  return document.getElementById(CHANGES_PANEL_ID)
}

function focusActiveTab() {
  panelElement()?.querySelector<HTMLElement>(`[data-testid="${testIds.changesViewOption}"][data-state="active"]`)?.focus()
}

watch(() => panel.focusRequest.value, async () => {
  await nextTick()
  if (panel.open.value)
    focusActiveTab()
})

/** Closes the panel; focus that was inside it (or `force`: the Close button) goes to the toggle. */
function closePanel(opts: { force?: boolean } = {}) {
  const inside = panelElement()?.contains(document.activeElement) ?? false
  panel.setOpen(false)
  if (!opts.force && !inside)
    return
  void nextTick(() => toggleButton()?.focus())
}

function onSheetOpenChange(open: boolean) {
  if (!open)
    panel.setOpen(false)
}

function onSheetCloseAutoFocus(event: Event) {
  const toggle = toggleButton()
  if (!toggle)
    return
  event.preventDefault()
  toggle.focus()
}

// ---------- Alt+C and the palette target ----------

/** Focus is in an overlay other than the changes sheet (a dialog, menu or listbox keeps its own keys). */
function inOtherOverlay(): boolean {
  const overlay = document.activeElement?.closest('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]')
  return !!overlay && !overlay.contains(panelElement())
}

function toggleFromKeyboard() {
  if (panel.open.value)
    closePanel()
  else
    panel.setOpen(true, { focus: true })
}

const shortcuts = useShortcuts()
const token = Symbol('chat-workspace')
let unregister: (() => void) | null = null

watch(() => [props.chatId, props.projectId] as const, ([chatId, projectId]) => {
  unregister?.()
  unregister = null
  setChangesTarget(token, projectId ? { chatId, projectId } : null)
  if (!projectId)
    return
  unregister = shortcuts.register({
    id: CHANGES_SHORTCUT,
    keys: CHANGES_SHORTCUT_KEYS,
    description: 'Show or hide changes',
    group: 'Chat',
    alt: true,
    allowInInputs: true,
    when: () => !inOtherOverlay(),
    handler: toggleFromKeyboard,
  })
}, { immediate: true })

onScopeDispose(() => {
  unregister?.()
  unregister = null
  setChangesTarget(token, null)
})
</script>

<template>
  <div data-slot="chat-workspace" class="flex h-dvh min-h-0 w-full min-w-0 flex-1">
    <ResizablePanelGroup direction="horizontal" :keyboard-resize-by="KEYBOARD_STEP_PERCENT" class="min-w-0">
      <ResizablePanel id="hf-chat-panel" :order="1" :min-size="CHAT_MIN_PERCENT" class="min-w-0">
        <slot />
      </ResizablePanel>
      <template v-if="showPane && projectId">
        <ResizableHandle
          id="hf-changes-resize"
          :data-testid="testIds.changesResize"
          aria-label="Resize changes"
          :hit-area-margins="{ coarse: 12, fine: 4 }"
          class="pointer-coarse:after:w-6"
          @dragging="dragging = $event"
          @focus="handleFocused = true"
          @blur="handleFocused = false"
        />
        <ResizablePanel
          id="hf-changes-pane"
          as="aside"
          :aria-labelledby="CHANGES_HEADING_ID"
          :order="2"
          size-unit="px"
          :default-size="paneDefault"
          :min-size="CHANGES_WIDTH.min"
          :max-size="CHANGES_WIDTH.max"
          class="flex min-w-0 flex-col"
          @resize="onPaneResize"
        >
          <ChangesPanel :key="chatId" :chat-id="chatId" :project-id="projectId" variant="pane" @close="closePanel({ force: true })" />
        </ResizablePanel>
      </template>
    </ResizablePanelGroup>

    <Sheet v-if="projectId && !isDesktop" :open="sheetOpen" @update:open="onSheetOpenChange">
      <SheetContent
        side="right"
        :show-close-button="false"
        :aria-labelledby="CHANGES_HEADING_ID"
        :aria-describedby="undefined"
        class="gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-lg"
        @close-auto-focus="onSheetCloseAutoFocus"
      >
        <!-- The visible h2 of the panel names the sheet; this title only satisfies reka's dialog check. -->
        <SheetTitle aria-hidden="true" class="sr-only">
          Changes
        </SheetTitle>
        <ChangesPanel :key="chatId" :chat-id="chatId" :project-id="projectId" variant="sheet" @close="closePanel({ force: true })" />
      </SheetContent>
    </Sheet>
  </div>
</template>
