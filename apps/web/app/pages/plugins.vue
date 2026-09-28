<script setup lang="ts">
// Parent route of every /plugins/* page (docs/UI.md 6). STUB (C5): W3.1 mounts the single InstallDialog (W3.2) here,
// next to <NuxtPage />:
//   <InstallDialog v-model:open="ui.installDialogOpen" :initial-source="ui.installSource"
//     @installed="id => navigateTo(`/plugins/${id}`)" />
// `ui.openInstall(source?)` (sidebar "Install…", list page) opens it. Never renders its own <main>.
</script>

<template>
  <div class="contents">
    <NuxtPage />
    <!-- InstallDialog slot (W3.1) -->
  </div>
</template>
