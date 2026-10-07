<script setup lang="ts">
// The "Claude Code plugin" section of the Overview tab (Phase 12, ADR-053; docs/UI.md 8.13, `data-slot="plugin-claude-info"`):
// what the server read from the plugin's files (`PluginDetail.claude`): the name and the version as written, the
// namespace of its qualified names, its components, what it runs (`claude.executables`, the list trust approves; shown
// here also while the plugin is untrusted, when its hooks are not in `GET /hooks`), the parts that are never used and the
// diagnostics. Everything is plugin-provided text and is rendered as text.
import type { ClaudePluginInfo } from '@harness-forge/shared'
import { CircleXIcon, InfoIcon, TriangleAlertIcon } from '@lucide/vue'
import { computed } from 'vue'
import { CLAUDE_TREE_PIN_NOTE, claudeComponentsSummary, executableSource } from '../install/install'
import PluginDetailSection from './PluginDetailSection.vue'

const props = defineProps<{ claude: ClaudePluginInfo }>()

const components = computed(() => claudeComponentsSummary(props.claude.components))
const executables = computed(() => props.claude.executables.map(executable => ({
  source: executableSource(executable, props.claude.namespace),
  command: executable.command,
})))
const DIAGNOSTIC_ICONS = { error: CircleXIcon, warning: TriangleAlertIcon, info: InfoIcon } as const
const DIAGNOSTIC_COLORS = { error: 'text-destructive', warning: 'text-warning', info: 'text-muted-foreground' } as const
</script>

<template>
  <div data-slot="plugin-claude-info">
    <PluginDetailSection title="Claude Code plugin" description="Read in place in Claude Code's layout. Its files are not edited here.">
      <dl class="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)] gap-x-4 gap-y-2 rounded-xl border bg-card px-4 py-3 text-sm">
        <dt class="text-muted-foreground">
          Name
        </dt>
        <dd class="min-w-0 break-words">
          <span class="font-mono text-[13px]">{{ claude.name }}</span>
          <span v-if="claude.displayName && claude.displayName !== claude.name" class="text-muted-foreground"> · {{ claude.displayName }}</span>
        </dd>

        <dt class="text-muted-foreground">
          Version
        </dt>
        <dd class="min-w-0 font-mono text-[13px] break-all" data-slot="plugin-claude-version">
          <template v-if="claude.version">
            {{ claude.version }}
          </template>
          <span v-else class="font-sans text-muted-foreground">Not given</span>
        </dd>

        <dt class="text-muted-foreground">
          Names
        </dt>
        <dd class="min-w-0 break-words">
          Its commands, agents and skills start with <code class="font-mono text-[13px]">{{ claude.namespace }}:</code>
        </dd>

        <template v-if="components">
          <dt class="text-muted-foreground">
            Components
          </dt>
          <dd class="min-w-0">
            {{ components }}
          </dd>
        </template>
      </dl>

      <div v-if="executables.length" class="grid gap-1.5" data-slot="plugin-claude-executables">
        <span class="text-xs font-medium text-muted-foreground">Runs these commands</span>
        <ul role="list" class="divide-y divide-border overflow-hidden rounded-xl border bg-card">
          <li v-for="(item, index) in executables" :key="index" class="grid gap-0.5 px-4 py-2">
            <span class="text-xs text-muted-foreground">{{ item.source }}</span>
            <code class="font-mono text-xs break-all whitespace-pre-wrap text-foreground/85">{{ item.command }}</code>
          </li>
        </ul>
        <p class="text-xs text-muted-foreground">
          {{ CLAUDE_TREE_PIN_NOTE }}
        </p>
      </div>

      <div v-if="claude.unsupported.length" class="grid gap-1.5" data-slot="plugin-claude-ignored">
        <span class="text-xs font-medium text-muted-foreground">Ignored</span>
        <ul role="list" class="grid gap-1 text-sm">
          <li v-for="part in claude.unsupported" :key="part.component" class="flex min-w-0 flex-wrap items-baseline gap-x-2">
            <code class="font-mono text-[13px] break-all">{{ part.component }}</code>
            <span v-if="part.reason" class="min-w-0 text-muted-foreground">{{ part.reason }}</span>
          </li>
        </ul>
      </div>

      <div v-if="claude.diagnostics.length" class="grid gap-1.5" data-slot="plugin-claude-diagnostics">
        <span class="text-xs font-medium text-muted-foreground">Diagnostics</span>
        <ul role="list" class="grid gap-1.5 text-sm">
          <li
            v-for="(diagnostic, index) in claude.diagnostics"
            :key="index"
            :data-level="diagnostic.level"
            :data-code="diagnostic.code"
            class="flex min-w-0 items-start gap-2"
          >
            <component :is="DIAGNOSTIC_ICONS[diagnostic.level]" aria-hidden="true" class="mt-0.5 size-4 shrink-0" :class="DIAGNOSTIC_COLORS[diagnostic.level]" />
            <span class="sr-only">{{ diagnostic.level === 'error' ? 'Error:' : diagnostic.level === 'warning' ? 'Warning:' : 'Note:' }}</span>
            <span class="min-w-0 break-words">
              {{ diagnostic.message }}
              <span v-if="diagnostic.path" class="block font-mono text-xs break-all text-muted-foreground">{{ diagnostic.path }}</span>
            </span>
          </li>
        </ul>
      </div>
    </PluginDetailSection>
  </div>
</template>
