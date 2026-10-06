<script setup lang="ts">
// Output style menu of the composer (Phase 11, ADR-051; docs/UI.md 7.32, 10.8): a ghost h-8 trigger with `Feather`
// (the effective style's label from `sm` when it is not Default, a dot below `sm`), named "Output style: {name}" plus
// " (automatic)" without a choice of the chat's own; a radio menu "Output style" with Automatic ("Uses {name}, set for
// {project}" / "Uses {name}, your default in Settings"), the built-ins, then the personal, project and plugin styles,
// and the footer "Manage output styles". ChatComposer renders it after EffortMenu (hidden for image models).
// `modelValue` = the chat's own choice (null = Automatic); `automatic` = what Automatic resolves to. Props, emits and the
// root test id are frozen from Gate P11-0b (C39 stub); W11.10 implements the menu in P11-A. The stub renders the trigger
// with the effective style.
import type { OutputStyleOption } from './output-style'
import { FeatherIcon } from '@lucide/vue'
import { computed } from 'vue'
import { Button } from '@/components/ui/button'
import { testIds } from '~/utils/testids'

const props = withDefaults(defineProps<{
  open: boolean
  /** The chat's own choice; null = Automatic. */
  modelValue: string | null
  options: readonly OutputStyleOption[]
  /** What Automatic resolves to (the project's style, else the default). */
  automatic: OutputStyleOption | null
  /** Receives focus when the menu closes (the composer textarea); default: the trigger. */
  returnFocusTo?: HTMLElement | null
}>(), {
  returnFocusTo: null,
})

const emit = defineEmits<{
  'update:open': [open: boolean]
  'update:modelValue': [value: string | null]
}>()

const chosen = computed(() => (props.modelValue === null ? null : props.options.find(option => option.name === props.modelValue) ?? null))
const effective = computed(() => (props.modelValue === null ? props.automatic?.name ?? 'default' : props.modelValue))
const label = computed(() => (props.modelValue === null ? props.automatic?.label : chosen.value?.label) ?? effective.value)
</script>

<template>
  <Button
    type="button"
    variant="ghost"
    size="icon-sm"
    :data-testid="testIds.outputStyleTrigger"
    :data-value="effective"
    :data-source="modelValue === null ? 'automatic' : 'chat'"
    :aria-label="`Output style: ${label}${modelValue === null ? ' (automatic)' : ''}`"
    class="shrink-0 text-muted-foreground pointer-coarse:size-10"
    @click="emit('update:open', !open)"
  >
    <FeatherIcon aria-hidden="true" class="size-4" />
  </Button>
</template>
