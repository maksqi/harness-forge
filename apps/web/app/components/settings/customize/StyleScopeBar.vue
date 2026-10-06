<script setup lang="ts">
// The scope bar of the Customize Output styles tab (Phase 11, ADR-051; docs/UI.md 2.18, 9.13, 10.8): without a project
// "Your default" with a Select of the active styles (writes the setting `outputStyle` through the settings store, the
// same value as Settings -> General); with a project "Style in {project}" with "Same as your default" and the styles
// (writes `projects.update(id, { outputStyle })`, null for Same as your default) and the line "Your default: {name}"
// under it. A chosen style that is no longer an option stays listed as "Not available". Both writes are optimistic in
// their stores; a failure shows an error toast.
// Props and the root test id (`customize-style-default` on the select trigger, `data-value` = the chosen name, '' for
// Same as your default) are frozen from Gate P11-0b (C39 stub); implementation W11.8.
import type { AcceptableValue } from 'reka-ui'
import type { OutputStyleOption } from '~/components/chat/composer/output-style'
import { FeatherIcon } from '@lucide/vue'
import { computed, useId } from 'vue'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger } from '@/components/ui/select'
import { useProjectsStore } from '~/stores/projects'
import { useSettingsStore } from '~/stores/settings'
import { testIds } from '~/utils/testids'
import { toastError } from '../notify'

const props = defineProps<{ projectId: string | null, projectName: string | null, options: readonly OutputStyleOption[] }>()

/** The Select item of "Same as your default" (a Select item cannot have an empty value). */
const SAME = '__same__'

const settings = useSettingsStore()
const projects = useProjectsStore()
const ids = { select: useId(), note: useId() }

const globalStyle = computed(() => settings.resolved.outputStyle)
/** The chosen name: the project's style ('' = Same as your default), else the global setting. */
const value = computed(() => (props.projectId
  ? projects.byId(props.projectId)?.outputStyle ?? ''
  : globalStyle.value))
const label = computed(() => (props.projectId ? `Style in ${props.projectName ?? 'this project'}` : 'Your default'))

function labelOf(name: string): string {
  return props.options.find(option => option.name === name)?.label ?? name
}

const shown = computed(() => (value.value === '' ? 'Same as your default' : labelOf(value.value)))
/** A chosen style that is not an option any more (deleted, turned off, a plugin removed). */
const missing = computed(() => (value.value !== '' && !props.options.some(option => option.name === value.value) ? value.value : null))

async function onChange(next: AcceptableValue): Promise<void> {
  if (typeof next !== 'string')
    return
  const name = next === SAME ? '' : next
  if (name === value.value)
    return
  try {
    if (props.projectId)
      await projects.update(props.projectId, { outputStyle: name === '' ? null : name })
    else if (name !== '')
      await settings.update({ outputStyle: name })
  }
  catch (error) {
    toastError(error)
  }
}
</script>

<template>
  <div class="flex min-w-0 flex-col gap-1 py-1">
    <div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
      <Label :for="ids.select" class="shrink-0 text-sm text-muted-foreground">
        <FeatherIcon aria-hidden="true" class="size-4" />
        {{ label }}
      </Label>
      <Select :model-value="value === '' ? SAME : value" @update:model-value="onChange">
        <SelectTrigger
          :id="ids.select"
          :data-testid="testIds.customizeStyleDefault"
          :data-value="value"
          :aria-describedby="projectId ? ids.note : undefined"
          class="w-full min-w-0 sm:w-64 pointer-coarse:h-10"
        >
          <span class="min-w-0 truncate">{{ shown }}</span>
        </SelectTrigger>
        <SelectContent position="popper" align="start" class="w-72">
          <template v-if="projectId">
            <SelectItem :value="SAME" data-value="" class="pointer-coarse:min-h-10">
              Same as your default
            </SelectItem>
            <SelectSeparator />
          </template>
          <SelectItem
            v-for="option in options"
            :key="option.name"
            :value="option.name"
            :data-value="option.name"
            class="pointer-coarse:min-h-10"
          >
            <span class="flex min-w-0 flex-col gap-0.5">
              <span class="truncate">{{ option.label }}</span>
              <span v-if="option.description" class="text-xs whitespace-normal text-muted-foreground">{{ option.description }}</span>
            </span>
          </SelectItem>
          <SelectItem v-if="missing" :value="missing" :data-value="missing" class="pointer-coarse:min-h-10">
            <span class="flex min-w-0 flex-col gap-0.5">
              <span class="truncate">{{ missing }}</span>
              <span class="text-xs text-muted-foreground">Not available</span>
            </span>
          </SelectItem>
        </SelectContent>
      </Select>
    </div>
    <p v-if="projectId" :id="ids.note" class="text-xs text-muted-foreground">
      Your default: {{ labelOf(globalStyle) }}
    </p>
  </div>
</template>
