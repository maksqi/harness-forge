<script setup lang="ts">
// Fenced code inside `Markdown` (docs/UI.md 3.3, 4.4): language label + copy button, the code as plain text at once
// and Shiki tokens once the fence is complete. Lines keep the same metrics in both states, so highlighting never
// moves anything. markstream passes renderer props (index-key, is-dark, themes, ...) that this block does not use.
import type { CodeLine } from './highlight'
import { computed, ref, watch } from 'vue'
import CopyButton from '~/components/common/CopyButton.vue'
import { cachedCodeLines, highlightCode, normalizeCodeLanguage, plainCodeLines } from './highlight'

defineOptions({ inheritAttrs: false })

const props = defineProps<{
  node: { code?: string, raw?: string, language?: string, loading?: boolean }
  loading?: boolean
}>()

const code = computed(() => (props.node.code ?? props.node.raw ?? '').replace(/\n$/, ''))
const language = computed(() => normalizeCodeLanguage(props.node.language))
const complete = computed(() => !props.node.loading && !props.loading)

const highlighted = ref<CodeLine[] | null>(null)
const lines = computed(() => highlighted.value ?? plainCodeLines(code.value))

let requestSeq = 0
watch([code, language, complete], async ([value, lang, done]) => {
  const seq = ++requestSeq
  highlighted.value = cachedCodeLines(value, lang)
  if (!done || highlighted.value)
    return
  const result = await highlightCode(value, lang)
  if (seq === requestSeq)
    highlighted.value = result
}, { immediate: true })
</script>

<template>
  <div
    data-slot="markdown-code"
    :data-language="language || 'text'"
    :data-highlighted="highlighted ? 'true' : 'false'"
    class="hf-code-block not-prose my-4 overflow-hidden rounded-lg border bg-muted/50 first:mt-0 last:mb-0 dark:bg-card"
  >
    <div class="flex h-8 items-center justify-between gap-2 border-b pr-1 pl-3">
      <span class="truncate font-mono text-xs text-muted-foreground">{{ language || 'text' }}</span>
      <CopyButton :text="code" label="Copy code" />
    </div>
    <div class="overflow-x-auto" tabindex="0" :aria-label="`Code: ${language || 'text'}`">
      <code class="hf-code block w-max min-w-full px-3 py-2.5 font-mono">
        <span v-for="(line, lineIndex) in lines" :key="lineIndex" class="hf-code-line">
          <span v-for="(token, tokenIndex) in line" :key="tokenIndex" class="hf-code-token" :style="token.style">{{ token.content }}</span>
        </span>
      </code>
    </div>
  </div>
</template>

<style>
/* Unscoped on purpose: the dark rule needs the `.dark` ancestor (html). Class names are unique to this block. */
.hf-code {
  font-size: 13px;
  line-height: 1.55;
  tab-size: 2;
}
.hf-code-line {
  display: block;
  min-height: 1lh;
  white-space: pre;
}
.hf-code-token {
  color: var(--shiki-light, inherit);
  font-style: var(--shiki-light-font-style, inherit);
  font-weight: var(--shiki-light-font-weight, inherit);
  text-decoration: var(--shiki-light-text-decoration, inherit);
}
.dark .hf-code-token {
  color: var(--shiki-dark, inherit);
  font-style: var(--shiki-dark-font-style, inherit);
  font-weight: var(--shiki-dark-font-weight, inherit);
  text-decoration: var(--shiki-dark-text-decoration, inherit);
}
</style>
