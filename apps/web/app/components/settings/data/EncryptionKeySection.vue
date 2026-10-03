<script setup lang="ts">
// Settings -> Data, "Encryption key" (docs/UI.md 9.8; docs/API.md 5.23; ADR-034): loads `keys.get()` (KeyStatus) and
// shows Source, Version, Rotated and Secrets; a destructive alert when the key fails the stored key check; "Rotate key…"
// (data-key-rotate) opens RotateKeyDialog and is disabled unless the server can rotate (a key from HF_MASTER_KEY is
// rotated offline: the note and the CLI commands follow). After a rotation the status, the summary line and Shared links
// reload (every share URL changed).
// Contract (docs/UI.md 10.4): no props, no emits; root data-key-section.
import type { KeyStatus } from '@harness-forge/shared'
import { CircleAlertIcon, RotateCwIcon } from '@lucide/vue'
import { computed, onMounted, ref } from 'vue'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import CopyButton from '~/components/common/CopyButton.vue'
import RelativeTime from '~/components/common/RelativeTime.vue'
import { useApi } from '~/composables/useApi'
import { withHarnessErrors } from '~/utils/errors'
import { testIds } from '~/utils/testids'
import SettingsLoadError from '../SettingsLoadError.vue'
import SettingsSection from '../SettingsSection.vue'
import {
  canRotateKey,
  KEY_MISMATCH_MESSAGE,
  KEY_SOURCE_LABELS,
  ROTATE_KEY_COMMANDS,
  secretsLabel,
} from './data'
import { useDataSettingsContext } from './data-context'
import RotateKeyDialog from './RotateKeyDialog.vue'

const api = useApi()
const page = useDataSettingsContext()

const status = ref<KeyStatus | null>(null)
const loading = ref(false)
const loadError = ref<unknown>(null)
const dialogOpen = ref(false)
// A newer load wins over one still in flight (the reload after a rotation).
let loadSeq = 0

const canRotate = computed(() => canRotateKey(status.value))
const envKey = computed(() => status.value?.source === 'env')
const mismatch = computed(() => status.value?.keyCheck === 'mismatch')

async function loadStatus(): Promise<void> {
  const seq = ++loadSeq
  loading.value = true
  loadError.value = null
  try {
    const next = await withHarnessErrors(api.keys.get())
    if (seq === loadSeq)
      status.value = next
  }
  catch (error) {
    if (seq === loadSeq)
      loadError.value = error
  }
  finally {
    if (seq === loadSeq)
      loading.value = false
  }
}

function openDialog(): void {
  if (canRotate.value)
    dialogOpen.value = true
}

function onRotated(): void {
  void loadStatus()
  page.reloadSummary()
  page.reloadShares()
}

onMounted(loadStatus)
</script>

<template>
  <SettingsSection
    :data-testid="testIds.dataKeySection"
    title="Encryption key"
    description="API keys and other secrets are encrypted on this server with a master key."
  >
    <SettingsLoadError
      v-if="!status && loadError"
      title="Could not load the encryption key status"
      :error="loadError"
      :pending="loading"
      @retry="loadStatus"
    />
    <div v-else-if="!status" aria-busy="true" class="grid grid-cols-[auto_1fr] gap-x-6 gap-y-3 rounded-xl border px-4 py-4">
      <span class="sr-only">Loading the encryption key status…</span>
      <template v-for="index in 4" :key="index">
        <Skeleton aria-hidden="true" class="h-3.5 w-16" />
        <Skeleton aria-hidden="true" class="h-3.5" :class="index % 2 ? 'w-48' : 'w-24'" />
      </template>
    </div>
    <template v-else>
      <Alert v-if="mismatch" variant="destructive" data-slot="key-mismatch-alert">
        <CircleAlertIcon aria-hidden="true" />
        <AlertDescription>{{ KEY_MISMATCH_MESSAGE }}</AlertDescription>
      </Alert>

      <dl
        class="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2.5 rounded-xl border bg-card px-4 py-3.5 text-sm text-card-foreground"
        data-slot="key-status"
        :data-source="status.source"
        :data-key-check="status.keyCheck"
      >
        <dt class="text-muted-foreground">
          Source
        </dt>
        <dd class="min-w-0" data-slot="key-source">
          {{ KEY_SOURCE_LABELS[status.source] }}
        </dd>
        <dt class="text-muted-foreground">
          Version
        </dt>
        <dd class="font-mono text-[13px] tabular-nums" data-slot="key-version">
          {{ status.keyVersion }}
        </dd>
        <dt class="text-muted-foreground">
          Rotated
        </dt>
        <dd data-slot="key-rotated">
          <RelativeTime v-if="status.rotatedAt !== null" :at="status.rotatedAt" />
          <template v-else>
            Never
          </template>
        </dd>
        <dt class="text-muted-foreground">
          Secrets
        </dt>
        <dd
          class="tabular-nums"
          :class="status.unreadableSecrets > 0 && 'text-destructive'"
          data-slot="key-secrets"
        >
          {{ secretsLabel(status) }}
        </dd>
      </dl>

      <div class="flex flex-col gap-3 sm:flex-row sm:items-start">
        <p v-if="envKey" class="min-w-0 flex-1 text-sm text-muted-foreground" data-slot="key-env-note">
          The key comes from HF_MASTER_KEY. Stop the server and run <code class="rounded bg-muted px-1 py-0.5 font-mono text-[0.8125rem] text-foreground">pnpm key:rotate</code> with
          HF_NEW_MASTER_KEY set to the new key.
        </p>
        <Button
          type="button"
          variant="outline"
          class="w-full sm:ml-auto sm:w-auto"
          :disabled="!canRotate"
          :data-testid="testIds.dataKeyRotate"
          @click="openDialog"
        >
          <RotateCwIcon aria-hidden="true" data-icon="inline-start" />
          Rotate key…
        </Button>
      </div>

      <div v-if="envKey" class="grid gap-2" data-slot="key-rotate-commands">
        <div
          v-for="item in ROTATE_KEY_COMMANDS"
          :key="item.label"
          class="overflow-hidden rounded-lg border bg-muted/40"
        >
          <div class="flex items-center justify-between gap-2 border-b py-1 pr-1 pl-3 text-xs text-muted-foreground">
            <span>{{ item.label }}</span>
            <CopyButton :text="item.command" :label="item.copyLabel" />
          </div>
          <pre class="overflow-x-auto px-3 py-2.5 font-mono text-xs leading-relaxed"><code>{{ item.command }}</code></pre>
        </div>
      </div>
    </template>

    <RotateKeyDialog v-model:open="dialogOpen" :status="status" @rotated="onRotated" />
  </SettingsSection>
</template>
