<script setup lang="ts">
// File tree of the Source tab (docs/UI.md 8.10): folders (collapsible) then files, the open file highlighted, a dirty
// dot, and per-file actions Rename / Delete (disabled for plugin.json, the entry named by `main` and files that cannot
// be edited). "New file" sits in the header. Read-only plugins show the tree without actions.
import type { PluginFileEntry } from '@harness-forge/shared'
import type { FileTreeNode } from './source-files'
import {
  ChevronRightIcon,
  FileCodeIcon,
  FileIcon,
  FileJsonIcon,
  FilePlusIcon,
  FileTextIcon,
  FolderIcon,
  FolderOpenIcon,
  MoreHorizontalIcon,
  PencilIcon,
  Trash2Icon,
} from '@lucide/vue'
import { computed, nextTick, ref } from 'vue'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { testIds } from '~/utils/testids'
import { buildFileTree, languageOf } from './source-files'

const props = withDefaults(defineProps<{
  entries: readonly PluginFileEntry[]
  activePath: string | null
  dirtyPaths?: readonly string[]
  readonly?: boolean
  /** Files that cannot be renamed or deleted (plugin.json, the entry). */
  protectedPaths?: readonly string[]
  loading?: boolean
}>(), {
  dirtyPaths: () => [],
  readonly: false,
  protectedPaths: () => [],
  loading: false,
})

const emit = defineEmits<{
  open: [path: string]
  newFile: [folder: string]
  rename: [path: string]
  delete: [path: string]
}>()

interface TreeRow {
  node: FileTreeNode
  depth: number
}

const collapsed = ref(new Set<string>())
const tree = computed(() => buildFileTree(props.entries))
const dirty = computed(() => new Set(props.dirtyPaths))
const protectedSet = computed(() => new Set(props.protectedPaths))

const rows = computed<TreeRow[]>(() => {
  const out: TreeRow[] = []
  const walk = (nodes: readonly FileTreeNode[], depth: number) => {
    for (const node of nodes) {
      out.push({ node, depth })
      if (node.type === 'dir' && !collapsed.value.has(node.path))
        walk(node.children, depth + 1)
    }
  }
  walk(tree.value, 0)
  return out
})

function toggle(path: string) {
  const next = new Set(collapsed.value)
  if (next.has(path))
    next.delete(path)
  else
    next.add(path)
  collapsed.value = next
}

function fileIcon(path: string) {
  switch (languageOf(path)) {
    case 'javascript':
    case 'typescript':
      return FileCodeIcon
    case 'json':
      return FileJsonIcon
    case 'markdown':
      return FileTextIcon
    default:
      return FileIcon
  }
}

function canChange(node: FileTreeNode): boolean {
  return !props.readonly && node.entry?.editable === true && !protectedSet.value.has(node.path)
}

/** Menu choices run once the menu has closed, so its focus return cannot steal focus from the dialog they open. */
let pending: { action: 'rename' | 'delete', path: string } | null = null

function choose(action: 'rename' | 'delete', path: string) {
  pending = { action, path }
}

function onCloseAutoFocus(event: Event) {
  const choice = pending
  pending = null
  if (!choice)
    return
  event.preventDefault()
  void nextTick(() => {
    if (choice.action === 'rename')
      emit('rename', choice.path)
    else
      emit('delete', choice.path)
  })
}
</script>

<template>
  <div :data-testid="testIds.codeFileTree" class="flex h-full min-h-0 flex-col">
    <div class="flex h-9 shrink-0 items-center justify-between border-b pr-1 pl-3">
      <span class="text-xs font-medium tracking-wide text-muted-foreground uppercase">Files</span>
      <Button
        v-if="!readonly"
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label="New file"
        title="New file"
        :data-testid="testIds.codeNewFile"
        @click="emit('newFile', '')"
      >
        <FilePlusIcon aria-hidden="true" />
      </Button>
    </div>
    <nav aria-label="Plugin files" class="min-h-0 flex-1 overflow-y-auto py-1">
      <p v-if="loading && entries.length === 0" class="px-3 py-2 text-sm text-muted-foreground">
        Loading files…
      </p>
      <ul class="grid">
        <li v-for="{ node, depth } in rows" :key="`${node.type}:${node.path}`" class="group/row relative">
          <button
            v-if="node.type === 'dir'"
            type="button"
            :aria-expanded="!collapsed.has(node.path)"
            :style="{ paddingLeft: `${0.5 + depth * 0.875}rem` }"
            class="flex h-7 w-full items-center gap-1.5 pr-2 text-left text-sm text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
            @click="toggle(node.path)"
          >
            <ChevronRightIcon aria-hidden="true" :class="cn('size-3.5 shrink-0 transition-transform', !collapsed.has(node.path) && 'rotate-90')" />
            <component :is="collapsed.has(node.path) ? FolderIcon : FolderOpenIcon" aria-hidden="true" class="size-4 shrink-0" />
            <span class="truncate">{{ node.name }}</span>
          </button>
          <template v-else>
            <button
              type="button"
              :data-testid="testIds.codeFile"
              :data-path="node.path"
              :aria-current="node.path === activePath ? 'true' : undefined"
              :title="node.path"
              :style="{ paddingLeft: `${1.5 + depth * 0.875}rem` }"
              :class="cn(
                'flex h-7 w-full items-center gap-1.5 pr-8 text-left text-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset',
                node.path === activePath ? 'bg-muted font-medium text-foreground' : 'text-foreground/85',
                node.entry?.editable === false && 'text-muted-foreground',
              )"
              @click="emit('open', node.path)"
            >
              <component :is="fileIcon(node.path)" aria-hidden="true" class="size-4 shrink-0 text-muted-foreground" />
              <span class="truncate">{{ node.name }}</span>
              <span v-if="dirty.has(node.path)" class="ml-auto size-1.5 shrink-0 rounded-full bg-foreground/70" aria-label="Unsaved changes" role="img" />
            </button>
            <div v-if="!readonly" class="absolute inset-y-0 right-1 flex items-center">
              <DropdownMenu>
                <DropdownMenuTrigger
                  :aria-label="`Actions for ${node.name}`"
                  class="flex size-6 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-foreground/10 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 data-[state=open]:bg-foreground/10 pointer-fine:opacity-0 pointer-fine:group-hover/row:opacity-100 pointer-fine:group-focus-within/row:opacity-100 pointer-fine:data-[state=open]:opacity-100"
                >
                  <MoreHorizontalIcon aria-hidden="true" class="size-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" class="w-44" @close-auto-focus="onCloseAutoFocus">
                  <DropdownMenuItem :disabled="!canChange(node)" :data-testid="testIds.codeFileRename" @select="choose('rename', node.path)">
                    <PencilIcon aria-hidden="true" />
                    Rename…
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" :disabled="!canChange(node)" :data-testid="testIds.codeFileDelete" @select="choose('delete', node.path)">
                    <Trash2Icon aria-hidden="true" />
                    Delete…
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </template>
        </li>
      </ul>
    </nav>
  </div>
</template>
