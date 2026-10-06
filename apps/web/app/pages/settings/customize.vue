<script setup lang="ts">
// Settings -> Customize (docs/UI.md 2.17, 2.18, 9.12, 9.13; ADR-044, ADR-045, ADR-048, ADR-051): the agents, commands,
// skills, output styles and hooks of every source. A thin SettingsPage around CustomizeSettings; the header actions
// Import... (customize-import, FileUp, outline: the `.md` import on the definition tabs, the hook import on the Hooks tab)
// and New agent / New command / New skill / New output style / New hook (customize-new, Plus, primary, `data-kind` =
// the tab's kind or `hook`; the label follows `?tab=`) reach the body through its exposed `import()` / `create()`. Nav
// label "Customize" (5.5). Below `sm` Import… keeps only its icon (the label stays for screen readers), so the title is
// not cut.
// Phase 12 (ADR-055; C46, frozen from Gate P12-0b; W12.10 owns it in P12-A): the header action Import from Claude Code…
// (`customize-import-claude`, `FolderDown`, outline, after Import…) and the query `?import=claude` open the
// ClaudeImportDialog mounted here (so the frozen `create()` / `import()` of the body stay unchanged); closing the dialog
// removes the query with `router.replace`, and any other `import` value is dropped.
import { FileUpIcon, FolderDownIcon, PlusIcon } from '@lucide/vue'
import { computed, onMounted, ref, useTemplateRef, watch } from 'vue'
import { Button } from '@/components/ui/button'
import ClaudeImportDialog from '~/components/settings/claude-import/ClaudeImportDialog.vue'
import { KIND_LABEL, tabOf } from '~/components/settings/customize/customize'
import CustomizeSettings from '~/components/settings/customize/CustomizeSettings.vue'
import { useRoute, useRouter } from '~/components/settings/nuxt-imports'
import SettingsPage from '~/components/settings/SettingsPage.vue'
import { testIds } from '~/utils/testids'

/** The `?import=` value that opens the Import from Claude Code dialog (docs/UI.md 6, 9.14). */
const IMPORT_CLAUDE_QUERY = 'claude'

const route = useRoute()
const router = useRouter()
const body = useTemplateRef<InstanceType<typeof CustomizeSettings>>('body')

const tab = computed(() => tabOf(route.query.tab))
const newLabel = computed(() => (tab.value === 'hook' ? 'New hook' : `New ${KIND_LABEL[tab.value]}`))

const importOpen = ref(false)

/** Opens the dialog for `?import=claude` and drops any other `import` value. */
function readImportQuery(): void {
  const value = route.query.import
  if (value === undefined)
    return
  if (value === IMPORT_CLAUDE_QUERY) {
    importOpen.value = true
    return
  }
  const { import: _dropped, ...query } = route.query
  router.replace({ query }).catch(() => {})
}

onMounted(readImportQuery)
watch(() => route.query.import, readImportQuery)

function setImportOpen(value: boolean): void {
  importOpen.value = value
  if (!value && route.query.import !== undefined) {
    const { import: _dropped, ...query } = route.query
    router.replace({ query }).catch(() => {})
  }
}
</script>

<template>
  <SettingsPage title="Customize" description="Agents, commands, skills, output styles and hooks: yours, your projects' and your plugins'.">
    <template #actions>
      <Button
        type="button"
        size="sm"
        variant="outline"
        :data-testid="testIds.customizeImport"
        class="pointer-coarse:h-10"
        @click="body?.import()"
      >
        <FileUpIcon aria-hidden="true" data-icon="inline-start" />
        <span class="max-sm:sr-only">Import…</span>
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        :data-testid="testIds.customizeImportClaude"
        class="pointer-coarse:h-10"
        @click="setImportOpen(true)"
      >
        <FolderDownIcon aria-hidden="true" data-icon="inline-start" />
        <span class="max-sm:sr-only">Import from Claude Code…</span>
      </Button>
      <Button type="button" size="sm" :data-testid="testIds.customizeNew" :data-kind="tab" class="pointer-coarse:h-10" @click="body?.create()">
        <PlusIcon aria-hidden="true" data-icon="inline-start" />
        {{ newLabel }}
      </Button>
    </template>
    <CustomizeSettings ref="body" />
    <ClaudeImportDialog :open="importOpen" @update:open="setImportOpen" />
  </SettingsPage>
</template>
