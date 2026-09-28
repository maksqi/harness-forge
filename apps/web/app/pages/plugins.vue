<script setup lang="ts">
// Parent route of every /plugins/* page (docs/UI.md 6): the child page plus the single InstallDialog (W3.2), opened
// by `ui.openInstall(source?)` from the sidebar "Install…" and the list page. A successful install opens the new
// plugin. Never renders its own <main>.
import { navigateTo } from '#imports'
import { pluginDetailRoute } from '~/components/plugins/list/plugin-display'
import { useUiStore } from '~/stores/ui'

const ui = useUiStore()

function onInstalled(id: string) {
  ui.installDialogOpen = false
  void navigateTo(pluginDetailRoute(id))
}
</script>

<template>
  <div class="contents">
    <NuxtPage />
    <InstallDialog
      v-model:open="ui.installDialogOpen"
      :initial-source="ui.installSource"
      @installed="onInstalled"
    />
  </div>
</template>
