<script setup lang="ts">
// Settings -> Customize (docs/UI.md 2.17, 9.12; ADR-044, ADR-045): the agents, commands and skills of every source.
// A thin SettingsPage around CustomizeSettings; the header actions Import... (customize-import, FileUp, outline) and New
// agent / New command / New skill (customize-new, Plus, primary; the label follows `?tab=`) reach the body through its
// exposed `import()` / `create()`. Nav label "Customize" (5.5).
import { FileUpIcon, PlusIcon } from '@lucide/vue'
import { computed, useTemplateRef } from 'vue'
import { Button } from '@/components/ui/button'
import { kindOfTab } from '~/components/settings/customize/customize'
import CustomizeSettings from '~/components/settings/customize/CustomizeSettings.vue'
import { useRoute } from '~/components/settings/nuxt-imports'
import SettingsPage from '~/components/settings/SettingsPage.vue'
import { testIds } from '~/utils/testids'

const route = useRoute()
const body = useTemplateRef<InstanceType<typeof CustomizeSettings>>('body')

const kind = computed(() => kindOfTab(route.query.tab))
</script>

<template>
  <SettingsPage title="Customize" description="Sub-agents, slash commands and skills: yours, your projects' and your plugins'.">
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
        Import…
      </Button>
      <Button type="button" size="sm" :data-testid="testIds.customizeNew" :data-kind="kind" class="pointer-coarse:h-10" @click="body?.create()">
        <PlusIcon aria-hidden="true" data-icon="inline-start" />
        New {{ kind }}
      </Button>
    </template>
    <CustomizeSettings ref="body" />
  </SettingsPage>
</template>
