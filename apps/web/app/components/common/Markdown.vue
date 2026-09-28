<script setup lang="ts">
// Safe markdown renderer (docs/UI.md 7.1, 10.4) for every assistant text and reasoning part: markstream-vue with raw
// HTML escaped (`html-policy="escape"`, no HTML strings are ever rendered), links limited to http(s) and mailto
// (external links open in a new tab with rel="noopener noreferrer"), our own code block (lazy Shiki, dual theme,
// copy button) and image (lazy, no referrer). KaTeX and Mermaid load on demand. Contract: props `content` + `final`;
// no slots.
import MarkdownRender from 'markstream-vue'
import { computed, watch } from 'vue'
import { useColorMode } from '~/components/chat/nuxt-imports'
import { registerMarkdownComponents } from '~/components/chat/parts/markdown/components'
import { ensureMathStyles, MARKDOWN_CUSTOM_ID, MARKDOWN_PARSE_OPTIONS } from '~/components/chat/parts/markdown/markdown-options'
import 'markstream-vue/index.css'

const props = withDefaults(defineProps<{
  content: string
  /** false while the part streams (unfinished constructs may stay pending); true once it is done. */
  final?: boolean
}>(), {
  final: true,
})

registerMarkdownComponents()

const colorMode = useColorMode()
const isDark = computed(() => colorMode.value !== 'light')

watch(() => props.content, ensureMathStyles, { immediate: true })
</script>

<template>
  <div data-slot="markdown" class="hf-markdown min-w-0 break-words">
    <MarkdownRender
      :content="content"
      :final="final"
      mode="chat"
      html-policy="escape"
      :custom-id="MARKDOWN_CUSTOM_ID"
      :parse-options="MARKDOWN_PARSE_OPTIONS"
      :is-dark="isDark"
      :fade="false"
      :show-tooltips="false"
    />
  </div>
</template>

<style>
/* markstream-vue reads its look from --ms-* / component variables; map them to our tokens (docs/UI.md 3.1, 3.3). */
.hf-markdown .markstream-vue {
  --ms-font-sans: var(--reading-font);
  --ms-font-mono: var(--font-mono);
  --ms-text-body: 1em;
  --ms-leading-body: inherit;
  --ms-text-h1: 1.35em;
  --ms-text-h2: 1.2em;
  --ms-text-h3: 1.05em;
  --ms-text-h4: 1em;
  --ms-text-h5: 1em;
  --ms-text-h6: 1em;
  --ms-leading-h1: 1.3;
  --ms-leading-h2: 1.35;
  --ms-leading-h3: 1.45;
  --ms-weight-h1: 600;
  --ms-weight-h2: 600;
  --ms-weight-h3: 600;
  --ms-weight-h4: 600;
  --ms-flow-paragraph-y: 0.75em;
  --ms-flow-list-y: 0.75em;
  --ms-flow-list-item-y: 0.25em;
  --ms-flow-heading-1-mt: 1.4em;
  --ms-flow-heading-2-mt: 1.4em;
  --ms-flow-heading-3-mt: 1.4em;
  --ms-flow-heading-4-mt: 1.2em;
  --ms-flow-heading-1-mb: 0.5em;
  --ms-flow-heading-2-mb: 0.5em;
  --ms-flow-heading-3-mb: 0.4em;
  --ms-flow-heading-4-mb: 0.4em;
  --ms-flow-blockquote-y: 0.75em;
  --ms-flow-table-y: 1em;
  --ms-flow-hr-y: 1.5em;
  --ms-flow-codeblock-y: 1em;
  --ms-flow-diagram-y: 1em;
  --link-color: var(--foreground);
  --inline-code-bg: var(--muted);
  --inline-code-fg: var(--foreground);
  --inline-code-border: var(--border);
  --blockquote-border: var(--border);
  --blockquote-fg: var(--muted-foreground);
  --table-border: var(--border);
  --table-header-bg: color-mix(in oklch, var(--muted) 60%, transparent);
  --list-marker: var(--muted-foreground);
  --list-counter-marker: var(--muted-foreground);
  --hr-border: var(--border);
  --footnote-border: var(--border);
  --diagram-bg: var(--card);
  --diagram-border: var(--border);
  --diagram-header-bg: var(--muted);
  --image-placeholder-bg: var(--muted);
  --loading-spinner: var(--muted-foreground);
  --loading-shimmer: var(--muted);
  --focus-ring: var(--ring);
  font-family: var(--reading-font);
  font-size: inherit;
  line-height: inherit;
  color: inherit;
}

.hf-markdown .markstream-vue > .node-slot:first-child > .node-content > :first-child,
.hf-markdown .markstream-vue > .node-slot:first-child .paragraph-node:first-child,
.hf-markdown .markstream-vue > .node-slot:first-child .heading-node:first-child {
  margin-top: 0;
}
.hf-markdown .markstream-vue > .node-slot:last-of-type .paragraph-node:last-child {
  margin-bottom: 0;
}

.hf-markdown .markstream-vue .heading-node {
  font-weight: 600;
  color: var(--foreground);
}

/* Links: foreground text, ember underline (docs/UI.md 14.3). */
.hf-markdown .markstream-vue a.link-node {
  color: var(--foreground);
  text-decoration-line: underline;
  text-decoration-color: color-mix(in oklch, var(--primary) 60%, transparent);
  text-underline-offset: 2px;
  transition: text-decoration-color var(--duration-fast) var(--ease-out);
}
.hf-markdown .markstream-vue a.link-node:hover {
  text-decoration-color: var(--primary);
}
.hf-markdown .markstream-vue a.link-node:focus-visible {
  outline: 2px solid color-mix(in oklch, var(--ring) 50%, transparent);
  outline-offset: 2px;
  border-radius: 2px;
}

/* Inline code: 0.9em mono on bg-muted, rounded-sm px-1. */
.hf-markdown .markstream-vue code.inline-code {
  font-family: var(--font-mono);
  font-size: 0.9em;
  padding: 0.1em 0.3em;
  border-radius: calc(var(--radius) - 4px);
  background-color: var(--muted);
  color: var(--foreground);
}

.hf-markdown .markstream-vue .html-inline-node,
.hf-markdown .markstream-vue .html-block-node {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.hf-markdown .markstream-vue table {
  font-size: 0.875rem;
}

.hf-markdown .markstream-vue ::selection {
  background-color: color-mix(in oklch, var(--primary) 32%, transparent);
}
</style>
