<script setup lang="ts">
// The harness-forge ember diamond. Decorative: pair it with the wordmark or an aria-label on the parent.
withDefaults(defineProps<{ size?: number }>(), { size: 16 })
</script>

<template>
  <svg
    data-slot="brand-mark"
    :width="size"
    :height="size"
    viewBox="0 0 16 16"
    aria-hidden="true"
    focusable="false"
    class="shrink-0"
  >
    <path
      class="fill-primary"
      d="M7.293 1.707Q8 1 8.707 1.707L14.293 7.293Q15 8 14.293 8.707L8.707 14.293Q8 15 7.293 14.293L1.707 8.707Q1 8 1.707 7.293Z"
    />
    <path
      class="hf-brand-facet"
      d="M7.646 5.354Q8 5 8.354 5.354L10.646 7.646Q11 8 10.646 8.354L8.354 10.646Q8 11 7.646 10.646L5.354 8.354Q5 8 5.354 7.646Z"
    />
  </svg>
</template>
