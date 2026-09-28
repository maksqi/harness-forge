<script setup lang="ts">
// Read-only CodeMirror view of the manifest JSON in the wizard's Review step (docs/UI.md 8.5). Themed from the design
// tokens; syntax colors follow the active theme (`html.dark`).
import { json } from '@codemirror/lang-json'
import { Compartment, EditorState, Prec } from '@codemirror/state'
import { oneDark } from '@codemirror/theme-one-dark'
import { EditorView } from '@codemirror/view'
import { useMutationObserver } from '@vueuse/core'
import { minimalSetup } from 'codemirror'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = defineProps<{ json: string, label?: string }>()

const host = ref<HTMLElement | null>(null)
let view: EditorView | null = null
const highlight = new Compartment()

/** Surfaces, text and gutters from the design tokens (CSS variables), above any bundled theme. */
const tokenTheme = Prec.highest(EditorView.theme({
  '&': {
    backgroundColor: 'transparent',
    color: 'var(--foreground)',
    fontSize: '12.5px',
  },
  '.cm-content': {
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    caretColor: 'transparent',
    padding: '10px 0',
  },
  '.cm-scroller': { fontFamily: 'var(--font-mono, ui-monospace, monospace)', lineHeight: '1.55' },
  '&.cm-focused': { outline: 'none' },
  '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--muted-foreground)', border: 'none' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'transparent' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'color-mix(in oklch, var(--primary) 25%, transparent)' },
}))

function isDark(): boolean {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
}

function highlightFor(dark: boolean) {
  return dark ? oneDark : []
}

onMounted(() => {
  if (!host.value)
    return
  view = new EditorView({
    parent: host.value,
    state: EditorState.create({
      doc: props.json,
      extensions: [
        minimalSetup,
        json(),
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ 'aria-label': props.label ?? 'plugin.json', 'aria-readonly': 'true' }),
        highlight.of(highlightFor(isDark())),
        tokenTheme,
      ],
    }),
  })
})

watch(() => props.json, (next) => {
  if (view && view.state.doc.toString() !== next)
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } })
})

// The theme toggle flips `class="dark"` on <html>.
if (typeof document !== 'undefined') {
  useMutationObserver(document.documentElement, () => {
    view?.dispatch({ effects: highlight.reconfigure(highlightFor(isDark())) })
  }, { attributes: true, attributeFilter: ['class'] })
}

onBeforeUnmount(() => {
  view?.destroy()
  view = null
})
</script>

<template>
  <div ref="host" data-slot="wizard-manifest-view" class="min-h-24" />
</template>
