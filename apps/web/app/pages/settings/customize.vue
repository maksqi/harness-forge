<script setup lang="ts">
// Settings -> Customize (docs/UI.md 2.17, 2.18, 9.12, 9.13; ADR-044, ADR-045, ADR-048, ADR-051): the agents, commands,
// skills, output styles and hooks of every source. A thin SettingsPage around CustomizeSettings; the header actions
// Import... (customize-import, FileUp, outline: the `.md` import on the definition tabs, the hook import on the Hooks tab)
// and New agent / New command / New skill / New output style / New hook (customize-new, Plus, primary, `data-kind` =
// the tab's kind or `hook`; the label follows `?tab=`) reach the body through its exposed `import()` / `create()`. Nav
// label "Customize" (5.5). Below `sm` Import… keeps only its icon (the label stays for screen readers), so the title is
// not cut.
import { FileUpIcon, PlusIcon } from '@lucide/vue'
import { computed, useTemplateRef } from 'vue'
import { Button } from '@/components/ui/button'
import { KIND_LABEL, tabOf } from '~/components/settings/customize/customize'
import CustomizeSettings from '~/components/settings/customize/CustomizeSettings.vue'
import { useRoute } from '~/components/settings/nuxt-imports'
import SettingsPage from '~/components/settings/SettingsPage.vue'
import { testIds } from '~/utils/testids'

const route = useRoute()
const body = useTemplateRef<InstanceType<typeof CustomizeSettings>>('body')

const tab = computed(() => tabOf(route.query.tab))
const newLabel = computed(() => (tab.value === 'hook' ? 'New hook' : `New ${KIND_LABEL[tab.value]}`))
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
      <Button type="button" size="sm" :data-testid="testIds.customizeNew" :data-kind="tab" class="pointer-coarse:h-10" @click="body?.create()">
        <PlusIcon aria-hidden="true" data-icon="inline-start" />
        {{ newLabel }}
      </Button>
    </template>
    <CustomizeSettings ref="body" />
  </SettingsPage>
</template>
