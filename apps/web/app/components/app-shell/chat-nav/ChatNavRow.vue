<script setup lang="ts">
// One chat in the sidebar list (docs/UI.md 5.3, 5.10, 13.1): a link with the title ("New chat" in muted italic
// until a title arrives) and a trailing 20px slot. The slot shows the status dot; on hover, keyboard focus or
// while the menu is open it shows the actions button instead (touch devices show both). Rename turns the row
// into InlineRename. Rename and Delete wait until the menu has closed, so its focus return cannot steal focus from
// the rename input or land on a row that is gone. Share… opens the Share dialog (ui.openShare, docs/UI.md 7.14) once
// the menu has closed and its trigger has focus again, so the dialog returns focus there when it closes. Phase 7: "Move to
// project ▸" (chat-row-move, right after Rename; only with `canMove`) lists ProjectMenuItems with the chat's project
// checked; the move runs once the menu has closed and returned focus to its trigger.
import type { ChatExportFormat, ChatSummary } from '@harness-forge/shared'
import type { ChatListStatus } from '~/stores/chats'
import {
  FileBracesIcon,
  FileTextIcon,
  FolderInputIcon,
  MoreHorizontalIcon,
  PencilIcon,
  Share2Icon,
  Trash2Icon,
} from '@lucide/vue'
import { computed, nextTick, ref, useTemplateRef } from 'vue'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from '@/components/ui/sidebar'
import { cn } from '@/lib/utils'
import InlineRename from '~/components/common/InlineRename.vue'
import StatusDot from '~/components/common/StatusDot.vue'
import ProjectMenuItems from '~/components/projects/ProjectMenuItems.vue'
import { useUiStore } from '~/stores/ui'
import { testIds } from '~/utils/testids'
import { SIDEBAR_ROW_CLASS } from '../sidebar-classes'

const props = withDefaults(defineProps<{
  chat: ChatSummary
  active: boolean
  status: ChatListStatus | null
  /** Offer "Move to project" (a project exists). */
  canMove?: boolean
}>(), {
  canMove: false,
})

const emit = defineEmits<{
  rename: [title: string]
  move: [projectId: string | null]
  export: [format: ChatExportFormat]
  delete: []
}>()

const { isMobile } = useSidebar()
const ui = useUiStore()
const item = useTemplateRef<{ $el: HTMLElement }>('item')

const menuOpen = ref(false)
const editing = ref(false)
/** The menu item chosen that runs once the menu has closed. */
let pending: 'rename' | 'share' | 'delete' | null = null
/** The project picked in "Move to project" (null: nothing picked); the move runs once the menu has closed. */
let pendingMove: { projectId: string | null } | null = null

const title = computed(() => props.chat.title?.trim() ?? '')

// Fine pointers: the dot and the actions button share one 20px slot, and hover, keyboard focus or an open menu
// shows the button over the dot. The button is hidden with opacity, never display, so it stays focusable: closing
// the menu with Escape returns focus to it. Touch devices show both side by side, the button as a 40px target
// (docs/UI.md 14.5), and the title's right padding keeps clear of them: 40px button + 4px inset, plus 22px for the
// dot and its gap when there is one.
const rowClass = computed(() => cn(SIDEBAR_ROW_CLASS, 'pr-7', props.status ? 'pointer-coarse:pr-17' : 'pointer-coarse:pr-12'))

const dotClass = computed(() => cn(
  'transition-opacity duration-(--duration-fast)',
  'pointer-fine:group-hover/menu-item:opacity-0 pointer-fine:group-focus-within/menu-item:opacity-0',
  menuOpen.value && 'pointer-fine:opacity-0',
))

const triggerClass = computed(() => cn(
  'pointer-events-auto flex size-5 pointer-coarse:size-10 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/60 outline-none',
  'transition-[opacity,color,background-color] duration-(--duration-fast) hover:bg-sidebar-foreground/10 hover:text-sidebar-foreground',
  'focus-visible:ring-2 focus-visible:ring-sidebar-ring/50 data-[state=open]:bg-sidebar-foreground/10 data-[state=open]:text-sidebar-foreground',
  'pointer-fine:absolute pointer-fine:inset-0',
  !menuOpen.value && 'pointer-fine:opacity-0 pointer-fine:group-hover/menu-item:opacity-100 pointer-fine:group-focus-within/menu-item:opacity-100',
))

/** Focuses the row link (after a rename, or when a neighbour row was deleted). */
function focus() {
  item.value?.$el.querySelector<HTMLElement>(`[data-testid="${testIds.chatRow}"]`)?.focus()
}

/** Rename, Share and Delete run from onCloseAutoFocus, once the menu is closed. */
function choose(action: 'rename' | 'share' | 'delete') {
  pending = action
}

function chooseMove(projectId: string | null) {
  pendingMove = { projectId }
}

function onCloseAutoFocus(event: Event) {
  const move = pendingMove
  pendingMove = null
  if (move) {
    // Focus returns to the trigger first; ChatNav moves it on when the row leaves the filtered list.
    void nextTick(() => emit('move', move.projectId))
    return
  }
  const action = pending
  pending = null
  if (!action)
    return
  event.preventDefault()
  if (action === 'share') {
    // The trigger takes focus first: the Share dialog returns focus to whatever had it when it opened.
    item.value?.$el.querySelector<HTMLElement>(`[data-testid="${testIds.chatRowMenu}"]`)?.focus()
    ui.openShare(props.chat.id)
    return
  }
  void nextTick(() => {
    if (action === 'rename')
      editing.value = true
    else
      emit('delete')
  })
}

async function onEditingChange(value: boolean) {
  editing.value = value
  if (value)
    return
  await nextTick()
  focus()
}

defineExpose({ focus })
</script>

<template>
  <SidebarMenuItem ref="item">
    <div v-if="editing" class="flex h-(--row-height) items-center px-0.5">
      <InlineRename
        :model-value="title"
        :editing="editing"
        placeholder="New chat"
        aria-label="Chat title"
        :data-testid="testIds.chatRowRenameInput"
        class="text-sm"
        @update:model-value="emit('rename', $event)"
        @update:editing="onEditingChange"
      />
    </div>

    <template v-else>
      <SidebarMenuButton
        as-child
        :is-active="active"
        :data-testid="testIds.chatRow"
        :data-chat-id="chat.id"
        :class="rowClass"
      >
        <NuxtLink :to="`/chat/${chat.id}`">
          <span :class="cn('min-w-0 flex-1 truncate', !title && 'text-muted-foreground italic')">
            {{ title || 'New chat' }}
          </span>
        </NuxtLink>
      </SidebarMenuButton>

      <div class="pointer-events-none absolute inset-y-0 right-1 flex items-center">
        <span class="relative flex items-center gap-0.5 pointer-fine:size-5 pointer-fine:justify-center">
          <StatusDot
            v-if="status"
            :status="status"
            :data-testid="testIds.chatStatusDot"
            :class="dotClass"
          />
          <DropdownMenu v-model:open="menuOpen">
            <DropdownMenuTrigger
              aria-label="Chat actions"
              :data-testid="testIds.chatRowMenu"
              :class="triggerClass"
            >
              <MoreHorizontalIcon aria-hidden="true" class="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              :side="isMobile ? 'bottom' : 'right'"
              :align="isMobile ? 'end' : 'start'"
              class="w-48"
              @close-auto-focus="onCloseAutoFocus"
            >
              <DropdownMenuItem :data-testid="testIds.chatRowRename" @select="choose('rename')">
                <PencilIcon aria-hidden="true" />
                Rename
              </DropdownMenuItem>
              <DropdownMenuSub v-if="canMove">
                <DropdownMenuSubTrigger :data-testid="testIds.chatRowMove" class="pointer-coarse:min-h-10">
                  <FolderInputIcon aria-hidden="true" class="text-muted-foreground" />
                  Move to project
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent class="max-h-80 w-64 max-w-[calc(100vw-2rem)] overflow-y-auto">
                  <ProjectMenuItems :model-value="chat.projectId" @select="chooseMove" />
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuItem :data-testid="testIds.chatRowShare" @select="choose('share')">
                <Share2Icon aria-hidden="true" />
                Share…
              </DropdownMenuItem>
              <DropdownMenuItem :data-testid="testIds.chatRowExportMd" @select="emit('export', 'md')">
                <FileTextIcon aria-hidden="true" />
                Export as Markdown
              </DropdownMenuItem>
              <DropdownMenuItem :data-testid="testIds.chatRowExportJson" @select="emit('export', 'json')">
                <FileBracesIcon aria-hidden="true" />
                Export as JSON
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" :data-testid="testIds.chatRowDelete" @select="choose('delete')">
                <Trash2Icon aria-hidden="true" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </div>
    </template>
  </SidebarMenuItem>
</template>
