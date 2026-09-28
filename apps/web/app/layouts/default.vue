<script setup lang="ts">
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { TooltipProvider } from '@/components/ui/tooltip'
// App shell (docs/UI.md 5): sidebar (16.5rem, icon mode, Mod+B, a sheet below md) + the page inset, plus the
// command palette and shortcuts dialog, mounted once. SidebarProvider brings its own TooltipProvider without a
// delay; the inner provider restores the app-wide 400ms delay (docs/UI.md 3.6).
import AppSidebar from '~/components/app-shell/AppSidebar.vue'
import CommandPalette from '~/components/app-shell/CommandPalette.vue'
import ShortcutsDialog from '~/components/app-shell/ShortcutsDialog.vue'
</script>

<template>
  <SidebarProvider :style="{ '--sidebar-width': '16.5rem' }">
    <TooltipProvider :delay-duration="400">
      <AppSidebar />
      <SidebarInset class="min-h-dvh min-w-0 bg-background">
        <slot />
      </SidebarInset>
      <CommandPalette />
      <ShortcutsDialog />
    </TooltipProvider>
  </SidebarProvider>
</template>
