<script setup lang="ts">
// The composer `+` menu (docs/UI.md 7.7): "Attach files" opens the file picker, "Commands" inserts `/` and opens the
// slash menu. The composer does both (it owns the hidden file input and the text).
// Phase 9 (ADR-042; C25 declares, W9.8 adds the item; frozen from Gate P9-0b): in a project chat (`projectChat`),
// "Mention a file" (`composer-mention`, `AtSign`) emits `mention`; the composer inserts `@` and opens the mention menu.
import { PaperclipIcon, PlusIcon, SquareTerminalIcon } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { testIds } from '~/utils/testids'

const props = withDefaults(defineProps<{
  /** Receives focus when the menu closes (the composer textarea); default: the trigger. */
  returnFocusTo?: HTMLElement | null
  /** + Phase 9: the chat has a project ("Mention a file" is offered); default false. */
  projectChat?: boolean
}>(), {
  returnFocusTo: null,
  projectChat: false,
})

const emit = defineEmits<{
  attach: []
  commands: []
  /** + Phase 9: "Mention a file" was picked. */
  mention: []
}>()

function onCloseAutoFocus(event: Event) {
  if (!props.returnFocusTo)
    return
  event.preventDefault()
  props.returnFocusTo.focus()
}
</script>

<template>
  <!-- The menu root sits inside the tooltip trigger (see EffortMenu). -->
  <Tooltip>
    <TooltipTrigger as-child>
      <span class="inline-flex">
        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              :data-testid="testIds.composerAdd"
              aria-label="Add"
              class="rounded-full text-muted-foreground hover:text-foreground aria-expanded:text-foreground pointer-coarse:size-10"
            >
              <PlusIcon aria-hidden="true" class="size-[18px]" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" :collision-padding="8" class="w-48 rounded-xl" @close-auto-focus="onCloseAutoFocus">
            <DropdownMenuItem :data-testid="testIds.composerAttach" class="rounded-md" @select="emit('attach')">
              <PaperclipIcon aria-hidden="true" />
              Attach files
            </DropdownMenuItem>
            <DropdownMenuItem class="rounded-md" @select="emit('commands')">
              <SquareTerminalIcon aria-hidden="true" />
              Commands
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </span>
    </TooltipTrigger>
    <TooltipContent side="top">
      Add
    </TooltipContent>
  </Tooltip>
</template>
