<script setup lang="ts">
// One chat in the sidebar list (docs/UI.md 5.3, 5.10, 13.1): a link with the title ("New chat" in muted italic
// until a title arrives) and a trailing 20px slot. The slot shows the status dot; on hover, keyboard focus or
// while the menu is open it shows the actions button instead (touch devices show both). Rename turns the row
// into InlineRename. Rename and Delete wait until the menu has closed, so its focus return cannot steal focus from
// the rename input or land on a row that is gone.
import type { ChatExportFormat, ChatSummary } from '@harness-forge/shared'
import type { ChatListStatus } from '~/stores/chats'
import { FileBracesIcon, FileTextIcon, MoreHorizontalIcon, PencilIcon, Trash2Icon } from '@lucide/vue'
import { computed, nextTick, ref, useTemplateRef } from 'vue'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from '@/components/ui/sidebar'
import { cn } from '@/lib/utils'
import InlineRename from '~/components/common/InlineRename.vue'
import StatusDot from '~/components/common/StatusDot.vue'
import { testIds } from '~/utils/testids'
import { SIDEBAR_ROW_CLASS } from '../sidebar-classes'

const props = defineProps<{
  chat: ChatSummary
  active: boolean
  status: ChatListStatus | null
}>()

const emit = defineEmits<{
  rename: [title: string]
  export: [format: ChatExportFormat]
  delete: []
}>()

const { isMobile } = useSidebar()
const item = useTemplateRef<{ $el: HTMLElement }>('item')

const menuOpen = ref(false)
const editing = ref(false)
/** The menu item chosen that runs once the menu has closed. */
let pending: 'rename' | 'delete' | null = null

const title = computed(() => props.chat.title?.trim() ?? '')

// Fine pointers: the dot and the actions button share one 20px slot, and hover, keyboard focus or an open menu
// shows the button over the dot. The button is hidden with opacity, never display, so it stays focusable: closing
// the menu with Escape returns focus to it. Touch devices show both side by side.
const dotClass = computed(() => cn(
  'transition-opacity duration-(--duration-fast)',
  'pointer-fine:group-hover/menu-item:opacity-0 pointer-fine:group-focus-within/menu-item:opacity-0',
  menuOpen.value && 'pointer-fine:opacity-0',
))

const triggerClass = computed(() => cn(
  'pointer-events-auto flex size-5 pointer-coarse:size-8 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/60 outline-none',
  'transition-[opacity,color,background-color] duration-(--duration-fast) hover:bg-sidebar-foreground/10 hover:text-sidebar-foreground',
  'focus-visible:ring-2 focus-visible:ring-sidebar-ring/50 data-[state=open]:bg-sidebar-foreground/10 data-[state=open]:text-sidebar-foreground',
  'pointer-fine:absolute pointer-fine:inset-0',
  !menuOpen.value && 'pointer-fine:opacity-0 pointer-fine:group-hover/menu-item:opacity-100 pointer-fine:group-focus-within/menu-item:opacity-100',
))

/** Focuses the row link (after a rename, or when a neighbour row was deleted). */
function focus() {
  item.value?.$el.querySelector<HTMLElement>(`[data-testid="${testIds.chatRow}"]`)?.focus()
}

/** Rename and Delete run from onCloseAutoFocus, once the menu is closed. */
function choose(action: 'rename' | 'delete') {
  pending = action
}

function onCloseAutoFocus(event: Event) {
  const action = pending
  pending = null
  if (!action)
    return
  event.preventDefault()
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
        :class="cn(SIDEBAR_ROW_CLASS, 'pr-7 pointer-coarse:pr-12')"
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
