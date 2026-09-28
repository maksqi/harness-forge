<script setup lang="ts">
// One plugin in the list (docs/UI.md 2.3, 8.1, 10.4): icon, name, version and the enable switch on top, the
// description (two lines), then the source badge, "Runs code", state badges and the contributions summary. The
// whole card links to the detail page (a stretched link on the name, so the switch and buttons stay separate
// controls). States: error -> red border, message and "View logs"; untrusted -> "Untrusted" + "Review";
// incompatible -> badge with the reason; loading -> spinner; disabled -> dimmed. Presentational: the parent runs
// the actions.
import type { PluginSummary } from '@harness-forge/shared'
import { CircleAlertIcon, ShieldAlertIcon } from '@lucide/vue'
import { computed } from 'vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { testIds } from '~/utils/testids'
import { contributionsSummary, pluginDetailRoute } from './plugin-display'
import PluginIcon from './PluginIcon.vue'
import PluginRunsCodeBadge from './PluginRunsCodeBadge.vue'
import PluginSourceBadge from './PluginSourceBadge.vue'

const props = defineProps<{ plugin: PluginSummary }>()

const emit = defineEmits<{
  'update:enabled': [value: boolean]
  'view-logs': []
  'review': []
}>()

const summary = computed(() => contributionsSummary(props.plugin.contributions))
const failed = computed(() => props.plugin.state === 'error')
const errorMessage = computed(() => props.plugin.lastError?.message || 'The plugin failed to load.')
const incompatibleMessage = computed(() => props.plugin.lastError?.message || 'Built for a different version of the harness-forge plugin API.')

function onViewLogs() {
  // eslint-disable-next-line vue/custom-event-name-casing -- contract name from docs/UI.md 10.4
  emit('view-logs')
}

/** Controls that sit above the stretched link. */
const ABOVE_LINK = 'relative z-10'
</script>

<template>
  <article
    :data-testid="testIds.pluginCard"
    :data-plugin-id="plugin.id"
    :data-state="plugin.state"
    :data-enabled="plugin.enabled"
    :class="cn(
      'group/card relative flex min-w-0 flex-col gap-3 rounded-lg border bg-card p-4 text-card-foreground',
      'transition-[border-color,background-color,opacity] duration-(--duration-fast) ease-(--ease-out)',
      'hover:border-foreground/15 hover:bg-accent/40 dark:hover:bg-accent/30',
      failed && 'border-destructive/60 hover:border-destructive/80',
      !plugin.enabled && 'opacity-70 hover:opacity-100',
    )"
  >
    <div class="flex items-start gap-3">
      <PluginIcon :plugin="plugin" size="lg" />
      <div class="min-w-0 flex-1 pt-px">
        <div class="flex min-w-0 items-center gap-1.5">
          <h3 class="min-w-0 truncate text-sm leading-5 font-medium">
            <NuxtLink
              :to="pluginDetailRoute(plugin.id)"
              class="rounded-sm outline-none after:absolute after:inset-0 after:rounded-lg after:content-[''] focus-visible:after:ring-[3px] focus-visible:after:ring-ring/50"
            >
              {{ plugin.name }}
            </NuxtLink>
          </h3>
          <Spinner v-if="plugin.state === 'loading'" class="size-3.5 shrink-0 text-muted-foreground" />
        </div>
        <p class="truncate font-mono text-xs leading-4 text-muted-foreground">
          v{{ plugin.version }}
        </p>
      </div>
      <Switch
        size="sm"
        :model-value="plugin.enabled"
        :aria-label="`Enable ${plugin.name}`"
        :data-testid="testIds.pluginCardSwitch"
        :class="cn(ABOVE_LINK, 'mt-1.5')"
        @update:model-value="value => emit('update:enabled', value)"
      />
    </div>

    <p :class="cn('line-clamp-2 text-sm leading-5', plugin.description ? 'text-muted-foreground' : 'text-muted-foreground/70 italic')">
      {{ plugin.description || 'No description' }}
    </p>

    <div v-if="failed" class="-mt-1 flex min-w-0 items-center gap-1.5 text-xs" role="status">
      <CircleAlertIcon aria-hidden="true" class="size-3.5 shrink-0 text-destructive" />
      <span class="min-w-0 truncate text-foreground/85" :title="errorMessage">{{ errorMessage }}</span>
      <Button
        type="button"
        variant="link"
        size="xs"
        :data-testid="testIds.pluginCardLogs"
        :class="cn(ABOVE_LINK, 'h-auto shrink-0 px-0 text-foreground underline decoration-destructive/60 underline-offset-2 hover:decoration-destructive')"
        @click="onViewLogs"
      >
        View logs
      </Button>
    </div>

    <div class="mt-auto flex min-w-0 flex-wrap items-center gap-1.5">
      <PluginSourceBadge :plugin="plugin" />
      <PluginRunsCodeBadge v-if="plugin.runsCode" />
      <Badge
        v-if="plugin.state === 'untrusted'"
        variant="outline"
        class="rounded-md border-transparent bg-warning/15 px-1.5 text-foreground dark:text-warning"
      >
        <ShieldAlertIcon aria-hidden="true" data-icon="inline-start" class="text-warning" />
        Untrusted
      </Badge>
      <Tooltip v-if="plugin.state === 'incompatible'">
        <TooltipTrigger as-child>
          <Badge
            variant="outline"
            tabindex="0"
            :class="cn(ABOVE_LINK, 'rounded-md border-transparent bg-warning/15 px-1.5 text-foreground dark:text-warning')"
          >
            Incompatible
          </Badge>
        </TooltipTrigger>
        <TooltipContent class="max-w-xs">
          {{ incompatibleMessage }}
        </TooltipContent>
      </Tooltip>
      <span :class="cn('min-w-0 truncate pl-0.5 text-xs text-muted-foreground', !summary && 'text-muted-foreground/70')">
        {{ summary || 'No contributions' }}
      </span>
      <Button
        v-if="plugin.state === 'untrusted'"
        type="button"
        variant="outline"
        size="xs"
        :data-testid="testIds.pluginCardReview"
        :class="cn(ABOVE_LINK, 'ml-auto')"
        @click="emit('review')"
      >
        Review
      </Button>
    </div>
  </article>
</template>
