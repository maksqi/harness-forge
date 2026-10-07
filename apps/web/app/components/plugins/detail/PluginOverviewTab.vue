<script setup lang="ts">
// Overview tab (docs/UI.md 2.4, 8.8): the description, then what the plugin adds (PluginContributions); beside it
// the details: id, version, source, author, homepage, install and update times, plugin API range, the advisory
// permissions and the trust pin of plugins that run code.
// Phase 12 (ADR-053 / ADR-054, docs/UI.md 8.13; W12.9): a Claude Code plugin adds the "Claude Code plugin" section
// (PluginClaudeInfo, after the contributions); the Source detail names a marketplace plugin's marketplace (the header
// shows the origin).
import type { PluginDetail } from '@harness-forge/shared'
import { ArrowUpRightIcon, ShieldAlertIcon, ShieldCheckIcon } from '@lucide/vue'
import { computed } from 'vue'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import CopyButton from '~/components/common/CopyButton.vue'
import { safeAssetUrl } from '~/components/common/format'
import RelativeTime from '~/components/common/RelativeTime.vue'
import { pluginSourceDescription, pluginSourceLabel } from '../list/plugin-display'
import { permissionLabel } from './plugin-detail'
import PluginClaudeInfo from './PluginClaudeInfo.vue'
import PluginContributions from './PluginContributions.vue'

const props = defineProps<{ plugin: PluginDetail }>()

const homepage = computed(() => {
  const url = safeAssetUrl(props.plugin.manifest.homepage)
  return url && /^https?:\/\//i.test(url) ? url : null
})
const homepageLabel = computed(() => {
  if (!homepage.value)
    return ''
  try {
    const url = new URL(homepage.value)
    return `${url.host}${url.pathname === '/' ? '' : url.pathname}`
  }
  catch {
    return homepage.value
  }
})
const permissions = computed(() => props.plugin.manifest.permissions ?? [])
const trustPin = computed(() => props.plugin.trust.trustedHash?.replace(/^path:/, '') ?? null)
const apiRange = computed(() => props.plugin.manifest.engines?.harness ?? null)
</script>

<template>
  <div class="grid gap-x-10 gap-y-8 lg:grid-cols-[minmax(0,1fr)_16rem]">
    <div class="flex min-w-0 flex-col gap-8">
      <p v-if="plugin.description" class="text-[15px] leading-6 whitespace-pre-line text-foreground/90">
        {{ plugin.description }}
      </p>
      <PluginContributions :plugin="plugin" />
      <PluginClaudeInfo v-if="plugin.claude" :claude="plugin.claude" />
    </div>

    <aside aria-label="Plugin details" class="min-w-0 lg:border-l lg:pl-6">
      <dl class="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-3 text-sm lg:grid-cols-1 lg:gap-y-1">
        <dt class="text-xs text-muted-foreground lg:mt-2">
          Id
        </dt>
        <dd class="flex min-w-0 items-center gap-1">
          <code class="truncate font-mono text-[13px]">{{ plugin.id }}</code>
          <CopyButton :text="plugin.id" label="Copy id" />
        </dd>

        <dt class="text-xs text-muted-foreground lg:mt-2">
          Version
        </dt>
        <dd class="font-mono text-[13px]">
          {{ plugin.version }}
        </dd>

        <dt class="text-xs text-muted-foreground lg:mt-2">
          Source
        </dt>
        <dd class="min-w-0">
          <span class="font-medium">{{ pluginSourceLabel(plugin) }}</span>
          <span class="block text-xs break-words text-muted-foreground">{{ pluginSourceDescription(plugin) }}</span>
        </dd>

        <template v-if="plugin.manifest.author">
          <dt class="text-xs text-muted-foreground lg:mt-2">
            Author
          </dt>
          <dd class="min-w-0 break-words">
            {{ plugin.manifest.author }}
          </dd>
        </template>

        <template v-if="homepage">
          <dt class="text-xs text-muted-foreground lg:mt-2">
            Homepage
          </dt>
          <dd class="min-w-0">
            <a
              :href="homepage"
              target="_blank"
              rel="noopener noreferrer"
              class="inline-flex max-w-full items-center gap-0.5 rounded-sm text-foreground underline decoration-primary/60 underline-offset-2 outline-none hover:decoration-primary focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <span class="truncate">{{ homepageLabel }}</span>
              <ArrowUpRightIcon aria-hidden="true" class="size-3.5 shrink-0" />
              <span class="sr-only">(opens in a new tab)</span>
            </a>
          </dd>
        </template>

        <template v-if="!plugin.builtin">
          <dt class="text-xs text-muted-foreground lg:mt-2">
            Installed
          </dt>
          <dd><RelativeTime :at="plugin.installedAt" /></dd>
          <template v-if="plugin.updatedAt > plugin.installedAt">
            <dt class="text-xs text-muted-foreground lg:mt-2">
              Updated
            </dt>
            <dd><RelativeTime :at="plugin.updatedAt" /></dd>
          </template>
        </template>

        <template v-if="apiRange">
          <dt class="text-xs text-muted-foreground lg:mt-2">
            Plugin API
          </dt>
          <dd class="font-mono text-[13px]">
            {{ apiRange }}
          </dd>
        </template>

        <template v-if="permissions.length">
          <dt class="text-xs text-muted-foreground lg:mt-2">
            Permissions
          </dt>
          <dd class="flex flex-wrap gap-1.5">
            <Tooltip v-for="permission in permissions" :key="permission">
              <TooltipTrigger as-child>
                <Badge variant="secondary" tabindex="0" :data-value="permission" class="h-auto rounded-md px-1.5 py-0.5 font-normal whitespace-normal">
                  {{ permissionLabel(permission) }}
                </Badge>
              </TooltipTrigger>
              <TooltipContent>
                Declared permission "{{ permission }}". Plugins run in-process, so permissions are not enforced.
              </TooltipContent>
            </Tooltip>
          </dd>
        </template>

        <template v-if="plugin.trust.required">
          <dt class="text-xs text-muted-foreground lg:mt-2">
            Trust
          </dt>
          <dd class="min-w-0">
            <span v-if="plugin.trust.trusted" class="inline-flex items-center gap-1.5">
              <ShieldCheckIcon aria-hidden="true" class="size-3.5 text-success" />
              {{ plugin.trust.trustedHash?.startsWith('path:') ? 'Trusted folder' : 'Trusted' }}
            </span>
            <span v-else class="inline-flex items-center gap-1.5">
              <ShieldAlertIcon aria-hidden="true" class="size-3.5 text-warning" />
              Not trusted
            </span>
            <span v-if="trustPin" class="mt-0.5 flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
              <span class="truncate font-mono" :title="trustPin">sha256 {{ trustPin.slice(0, 12) }}…</span>
              <CopyButton :text="trustPin" label="Copy pin" />
            </span>
          </dd>
        </template>
      </dl>
    </aside>
  </div>
</template>
