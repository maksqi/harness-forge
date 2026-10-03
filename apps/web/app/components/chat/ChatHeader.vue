<script setup lang="ts">
// Chat page header (docs/UI.md 5.6): h-12 bar whose bottom border shows only once the transcript scrolled (the 1px
// is always reserved); the sidebar trigger when the sidebar is collapsed or on mobile; the title renames inline on
// click; the project chip (docs/UI.md 7.20) between the title and `⋯` while the chat has a project; `⋯` menu: Rename ·
// Move to project ▸ (while any project exists) · Show thinking · Share… · Export as Markdown · Export as JSON · Delete.
// Rename, export and the undoable delete (toast with Undo, back to `/`) are the sidebar's chat actions (W2.4
// `useChatActions`); moving is `useMoveChat` (optimistic, toast with Undo); Share… opens the Share dialog
// (ui.openShare, docs/UI.md 7.14) once the menu has closed and its trigger has focus again, so the dialog returns focus
// there when it closes.
// Phase 8 (C20 mounts it, W8.8 implements it): ChangesToggle between the project chip and `⋯` (docs/UI.md 2.15, 7.21);
// it renders nothing without a project.
import {
  BrainIcon,
  FileJsonIcon,
  FileTextIcon,
  FolderInputIcon,
  MoreHorizontalIcon,
  PencilIcon,
  Share2Icon,
  Trash2Icon,
} from '@lucide/vue'
import { computed, ref, useTemplateRef } from 'vue'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { SidebarTrigger, useSidebar } from '@/components/ui/sidebar'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useChatActions } from '~/components/app-shell/chat-nav/chat-actions'
import InlineRename from '~/components/common/InlineRename.vue'
import KbdCombo from '~/components/common/KbdCombo.vue'
import ChatProjectChip from '~/components/projects/ChatProjectChip.vue'
import { useMoveChat } from '~/components/projects/move-chat'
import ProjectMenuItems from '~/components/projects/ProjectMenuItems.vue'
import ChangesToggle from '~/components/workspace/changes/ChangesToggle.vue'
import { useProjectsStore } from '~/stores/projects'
import { useUiStore } from '~/stores/ui'
import { testIds } from '~/utils/testids'

const props = withDefaults(defineProps<{
  chatId: string
  /** null until the chat has a title. */
  title: string | null
  /** The transcript scrolled away from the top. */
  scrolled?: boolean
  /** The chat is still loading: no "New chat" placeholder yet. */
  loading?: boolean
  /**
   * + Phase 7 (C15 declares it, W7.10 uses it): the chat's project, for ChatProjectChip and "Move to project"; null =
   * none.
   */
  projectId?: string | null
}>(), {
  scrolled: false,
  loading: false,
  projectId: null,
})

const actions = useChatActions()
const moveChat = useMoveChat()
const projects = useProjectsStore()
const ui = useUiStore()
const sidebar = useSidebar(null)
const root = useTemplateRef<HTMLElement>('root')

const showTrigger = computed(() => !!sidebar && (sidebar.isMobile.value || sidebar.state.value === 'collapsed'))
/** "Move to project" needs a project to move to (or one to leave). */
const canMove = computed(() => projects.items.length > 0 || props.projectId !== null)
const editing = ref(false)
/** The menu item that runs once the menu has closed. */
let afterMenu: 'rename' | 'share' | null = null

function startRename() {
  editing.value = true
}

function onMenuRename() {
  // The menu gives focus back to its trigger when it closes; the editor opens after that.
  afterMenu = 'rename'
}

function onMenuShare() {
  afterMenu = 'share'
}

function onMenuCloseAutoFocus(event: Event) {
  const action = afterMenu
  afterMenu = null
  if (!action)
    return
  event.preventDefault()
  if (action === 'rename') {
    startRename()
    return
  }
  // The trigger takes focus first: the Share dialog returns focus to whatever had it when it opened.
  root.value?.querySelector<HTMLElement>(`[data-testid="${testIds.chatMenuTrigger}"]`)?.focus()
  ui.openShare(props.chatId)
}

function rename(title: string) {
  void actions.rename(props.chatId, title)
}

function move(projectId: string | null) {
  // Never rejects: it shows its own toasts (Undo, a running reply, a deleted project).
  void moveChat(props.chatId, projectId)
}
</script>

<template>
  <header
    ref="root"
    :data-testid="testIds.chatHeader"
    :data-scrolled="scrolled ? 'true' : 'false'"
    :class="cn(
      'z-10 flex h-(--header-height) shrink-0 items-center gap-2 border-b bg-background px-4 transition-colors duration-(--duration-fast) md:px-6',
      scrolled ? 'border-border' : 'border-transparent',
    )"
  >
    <Tooltip v-if="showTrigger">
      <TooltipTrigger as-child>
        <SidebarTrigger
          :data-testid="testIds.sidebarTrigger"
          aria-label="Toggle sidebar"
          class="-ml-2 text-muted-foreground hover:text-foreground pointer-coarse:size-10"
        />
      </TooltipTrigger>
      <TooltipContent side="bottom">
        Toggle sidebar
        <KbdCombo keys="mod+b" />
      </TooltipContent>
    </Tooltip>

    <div class="flex min-w-0 flex-1 items-center">
      <InlineRename
        v-if="editing"
        :model-value="title ?? ''"
        :editing="editing"
        placeholder="New chat"
        aria-label="Chat title"
        :data-testid="testIds.chatTitleInput"
        class="max-w-xl text-base font-medium"
        @update:model-value="rename"
        @update:editing="editing = $event"
      />
      <h1 v-else class="-ml-1.5 flex min-w-0">
        <button
          type="button"
          :data-testid="testIds.chatTitle"
          :title="title ?? undefined"
          :class="cn(
            'min-w-0 truncate rounded-md px-1.5 py-0.5 text-left text-base font-medium outline-none',
            'hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50',
            !title && 'font-normal text-muted-foreground italic',
            !title && loading && 'invisible',
          )"
          @click="startRename"
        >
          {{ title ?? (loading ? '' : 'New chat') }}
        </button>
      </h1>
    </div>

    <ChatProjectChip v-if="projectId" :chat-id="chatId" :project-id="projectId" />
    <ChangesToggle :chat-id="chatId" :project-id="projectId" />

    <DropdownMenu>
      <DropdownMenuTrigger as-child>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Chat options"
          :data-testid="testIds.chatMenuTrigger"
          class="-mr-2 text-muted-foreground hover:text-foreground pointer-coarse:size-10"
        >
          <MoreHorizontalIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" class="w-52" @close-auto-focus="onMenuCloseAutoFocus">
        <DropdownMenuItem :data-testid="testIds.chatMenuRename" @select="onMenuRename">
          <PencilIcon />
          Rename
        </DropdownMenuItem>
        <DropdownMenuSub v-if="canMove">
          <DropdownMenuSubTrigger :data-testid="testIds.chatMenuMove">
            <FolderInputIcon />
            Move to project
          </DropdownMenuSubTrigger>
          <DropdownMenuPortal>
            <DropdownMenuSubContent class="max-h-80 w-64 overflow-y-auto">
              <ProjectMenuItems :model-value="projectId" @select="move" />
            </DropdownMenuSubContent>
          </DropdownMenuPortal>
        </DropdownMenuSub>
        <DropdownMenuCheckboxItem
          :model-value="ui.showThinking"
          :data-testid="testIds.chatMenuThinking"
          @update:model-value="ui.toggleShowThinking()"
        >
          <BrainIcon />
          Show thinking
        </DropdownMenuCheckboxItem>
        <DropdownMenuItem :data-testid="testIds.chatMenuShare" @select="onMenuShare">
          <Share2Icon />
          Share…
        </DropdownMenuItem>
        <DropdownMenuItem :data-testid="testIds.chatMenuExportMd" @select="actions.exportChat(chatId, 'md')">
          <FileTextIcon />
          Export as Markdown
        </DropdownMenuItem>
        <DropdownMenuItem :data-testid="testIds.chatMenuExportJson" @select="actions.exportChat(chatId, 'json')">
          <FileJsonIcon />
          Export as JSON
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" :data-testid="testIds.chatMenuDelete" @select="actions.remove(chatId)">
          <Trash2Icon />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </header>
</template>
