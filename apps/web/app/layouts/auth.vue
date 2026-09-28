<template>
  <main class="flex min-h-dvh items-center justify-center bg-background px-4 py-12">
    <!-- Layout without the sidebar for /login (docs/UI.md 5, 9.7): a centered column on the page background. -->
    <div class="w-full max-w-sm">
      <slot />
    </div>
  </main>
</template>
