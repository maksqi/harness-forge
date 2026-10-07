<script setup lang="ts">
// Result panel of an import (docs/UI.md 2.7, 9.8): "Imported {n} chats · copied {n} · skipped {n} · failed {n}", the
// attachments ("{n} files ({reused} reused, {missing} missing)"), "Settings restored", the personal definitions restored
// ("{n} personal definitions restored · {k} kept · {f} failed"), the commands turned off (Phase 12), then one row per chat (its title, a link to /chat/<id>
// for imported and copied chats, a status badge and the error of a failed one) and the warnings.
import type { DataImportResult, DataImportStatus } from '@harness-forge/shared'
import { CircleAlertIcon, CircleCheckIcon } from '@lucide/vue'
import { computed } from 'vue'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { testIds } from '~/utils/testids'
import { IMPORT_STATUS_LABELS, importFilesLine, importHeadline, importItemLink, importItemTitle, turnedOffLine } from './data'

const props = defineProps<{ result: DataImportResult }>()

// Tinted badges keep text-foreground in light mode for contrast (docs/UI.md 14.3).
const STATUS_STYLES: Record<DataImportStatus, string> = {
  imported: 'border-transparent bg-success/15 text-foreground dark:text-success',
  copied: 'border-transparent bg-info/15 text-foreground dark:text-info',
  skipped: 'border-border bg-transparent text-muted-foreground',
  failed: 'border-transparent bg-destructive/12 text-foreground dark:text-destructive',
}

const headline = computed(() => importHeadline(props.result))
const filesLine = computed(() => importFilesLine(props.result))
const failed = computed(() => props.result.counts.failed > 0)
// Phase 10 (ADR-044): the personal definitions restored from `customizations.json`. Phase 11 (docs/UI.md 9.8): output
// styles are personal definitions too, so the line reads "{n} personal definitions restored". Phase 12 (docs/UI.md 9.14):
// the commands with shell lines that came back turned off are counted ("{t} commands turned off (they run shell lines)",
// `data-slot="data-import-turned-off"`, from `customizations.turnedOff`; nothing when 0).
const turnedOff = computed(() => turnedOffLine(props.result.customizations?.turnedOff))
const customizationsLine = computed(() => {
  const c = props.result.customizations
  if (!c)
    return null
  const parts = [`${c.imported} ${c.imported === 1 ? 'personal definition' : 'personal definitions'} restored`]
  if (c.skipped > 0)
    parts.push(`${c.skipped} kept`)
  if (c.failed > 0)
    parts.push(`${c.failed} failed`)
  return parts.join(' · ')
})
const rows = computed(() => props.result.items.map((item, index) => ({
  key: `${index}:${item.sourceId}`,
  item,
  title: importItemTitle(item),
  link: importItemLink(item),
})))
</script>

<template>
  <div
    :data-testid="testIds.dataImportResult"
    :data-kind="result.kind"
    class="overflow-hidden rounded-xl border bg-card text-card-foreground"
  >
    <div class="flex items-start gap-3 p-4">
      <CircleAlertIcon v-if="failed" aria-hidden="true" class="mt-0.5 size-4 shrink-0 text-destructive" />
      <CircleCheckIcon v-else aria-hidden="true" class="mt-0.5 size-4 shrink-0 text-success" />
      <div class="flex min-w-0 flex-col gap-0.5 text-sm">
        <p class="font-medium tabular-nums" data-slot="data-import-headline">
          {{ headline }}
        </p>
        <p v-if="filesLine" class="text-muted-foreground tabular-nums" data-slot="data-import-files">
          {{ filesLine }}
        </p>
        <p v-if="result.settingsRestored" class="text-muted-foreground" data-slot="data-import-settings">
          Settings restored
        </p>
        <p v-if="customizationsLine" class="text-muted-foreground tabular-nums" data-slot="data-import-customizations">
          {{ customizationsLine }}
        </p>
        <p v-if="turnedOff" class="text-muted-foreground tabular-nums" data-slot="data-import-turned-off">
          {{ turnedOff }}
        </p>
      </div>
    </div>

    <!-- Focusable so the keyboard can scroll it even when no row has a link (e.g. every chat skipped). -->
    <ul
      v-if="rows.length > 0"
      aria-label="Chats in the upload"
      tabindex="0"
      class="max-h-80 divide-y overflow-y-auto border-t outline-none focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset"
    >
      <li
        v-for="row in rows"
        :key="row.key"
        :data-testid="testIds.dataImportItem"
        :data-status="row.item.status"
        :data-chat-id="row.item.chatId ?? undefined"
        class="flex items-start gap-3 px-4 py-2.5"
      >
        <div class="flex min-w-0 flex-1 flex-col gap-0.5">
          <NuxtLink
            v-if="row.link"
            :to="row.link"
            class="truncate rounded-sm text-sm font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {{ row.title }}
          </NuxtLink>
          <span v-else class="truncate text-sm font-medium">{{ row.title }}</span>
          <span v-if="row.item.status === 'failed' && row.item.error" class="text-sm break-words text-destructive">
            {{ row.item.error }}
          </span>
        </div>
        <Badge variant="outline" :class="cn('shrink-0 rounded-full', STATUS_STYLES[row.item.status])">
          {{ IMPORT_STATUS_LABELS[row.item.status] }}
        </Badge>
      </li>
    </ul>

    <ul
      v-if="result.warnings.length > 0"
      aria-label="Warnings"
      class="flex flex-col gap-1 border-t px-4 py-3 text-xs text-muted-foreground"
    >
      <li v-for="(warning, index) in result.warnings" :key="index" :data-testid="testIds.dataImportWarning" class="break-words">
        {{ warning }}
      </li>
    </ul>
  </div>
</template>
