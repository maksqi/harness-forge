<script setup lang="ts">
// Install preview (docs/UI.md 8.3 step 2) of a `PluginInspection`: identity, kind, what the plugin adds, the hosts it
// talks to, advisory permissions, requested secrets, size, the sha256 that trust pins and the server's warnings.
// Everything is plugin-provided text and is rendered as text.
import type { PluginInspection } from '@harness-forge/shared'
import { CpuIcon, TriangleAlertIcon } from '@lucide/vue'
import { computed } from 'vue'
import { Badge } from '@/components/ui/badge'
import CopyButton from '~/components/common/CopyButton.vue'
import ProviderIcon from '~/components/providers/ProviderIcon.vue'
import { testIds } from '~/utils/testids'
import { contributionSummary, filesSummary, manifestIcon, permissionLabel } from './install'

const props = defineProps<{
  inspection: PluginInspection
  /** "{source}" label (file name, package, URL host, folder). */
  sourceLabel: string
}>()

const manifest = computed(() => props.inspection.manifest)
const icon = computed(() => manifestIcon(manifest.value.icon))
const adds = computed(() => contributionSummary(props.inspection.contributions))
const isCode = computed(() => props.inspection.kind === 'code')

const SOURCE_NAMES: Record<string, string> = { zip: 'Zip', npm: 'npm', url: 'URL', link: 'Linked folder', copy: 'Copied folder' }
</script>

<template>
  <section
    :data-testid="testIds.installPreview"
    :data-kind="inspection.kind"
    :data-plugin-id="manifest.id"
    class="grid gap-4"
  >
    <header class="flex items-start gap-3">
      <ProviderIcon :id="manifest.id" :icon="icon" :name="manifest.name" size="lg" variant="color" />
      <div class="grid min-w-0 flex-1 gap-1">
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span class="font-medium break-words">{{ manifest.name }}</span>
          <span class="font-mono text-xs text-muted-foreground">{{ manifest.version }}</span>
          <Badge variant="outline">
            {{ isCode ? 'Code' : 'Declarative' }}
          </Badge>
          <Badge v-if="inspection.requiresTrust" variant="outline" class="border-warning/50 text-warning">
            <CpuIcon data-icon="inline-start" />
            Runs code
          </Badge>
        </div>
        <span class="font-mono text-xs text-muted-foreground break-all">{{ manifest.id }}</span>
        <p v-if="manifest.description" class="text-sm text-muted-foreground break-words">
          {{ manifest.description }}
        </p>
      </div>
    </header>

    <dl class="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
      <dt class="text-muted-foreground">
        Source
      </dt>
      <dd class="min-w-0 break-all">
        {{ SOURCE_NAMES[inspection.source] ?? inspection.source }} · {{ sourceLabel }}
      </dd>

      <dt class="text-muted-foreground">
        Adds
      </dt>
      <dd class="min-w-0">
        <span v-if="adds">{{ adds }}</span>
        <span v-else class="text-muted-foreground">Nothing declared</span>
        <span v-if="isCode" class="block text-xs text-muted-foreground">Code plugins can register more when they run.</span>
      </dd>

      <dt class="text-muted-foreground">
        Network
      </dt>
      <dd class="min-w-0">
        <ul v-if="inspection.networkHosts.length" class="flex flex-wrap gap-1.5">
          <li v-for="host in inspection.networkHosts" :key="host" class="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs break-all">
            {{ host }}
          </li>
        </ul>
        <span v-else-if="isCode" class="text-muted-foreground">Any host (code can connect anywhere)</span>
        <span v-else class="text-muted-foreground">No hosts declared</span>
      </dd>

      <template v-if="inspection.permissions.length">
        <dt class="text-muted-foreground">
          Permissions
        </dt>
        <dd class="min-w-0">
          <ul class="flex flex-wrap gap-1.5" aria-label="Permissions">
            <li v-for="permission in inspection.permissions" :key="permission" class="rounded-md border px-1.5 py-0.5 text-xs">
              {{ permissionLabel(permission) }}
            </li>
          </ul>
        </dd>
      </template>

      <template v-if="inspection.secretsRequested.length">
        <dt class="text-muted-foreground">
          Secrets
        </dt>
        <dd class="min-w-0">
          <ul class="grid gap-0.5">
            <li v-for="secret in inspection.secretsRequested" :key="secret" class="break-words">
              {{ secret }}
            </li>
          </ul>
        </dd>
      </template>

      <dt class="text-muted-foreground">
        Files
      </dt>
      <dd class="min-w-0">
        {{ filesSummary(inspection.files) }}
      </dd>

      <dt class="text-muted-foreground">
        SHA-256
      </dt>
      <dd class="flex min-w-0 items-center gap-1">
        <code class="min-w-0 font-mono text-xs break-all">{{ inspection.sha256 }}</code>
        <CopyButton :text="inspection.sha256" label="Copy SHA-256" />
      </dd>
    </dl>

    <ul v-if="inspection.warnings.length" class="grid gap-1.5" aria-label="Warnings">
      <li
        v-for="warning in inspection.warnings"
        :key="warning"
        class="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/5 px-2.5 py-1.5 text-sm dark:bg-warning/10"
      >
        <TriangleAlertIcon class="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
        <span class="min-w-0 break-words">{{ warning }}</span>
      </li>
    </ul>
  </section>
</template>
