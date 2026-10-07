<script setup lang="ts">
// One hook of the Customize Hooks tab (Phase 11, ADR-048; docs/UI.md 9.13, 10.8, 14): a list item with `Webhook`
// (`WebhookOff` for off and blocked), the event, the matcher ("All tools" for an empty or `*` tool matcher,
// `data-slot="hook-row-matcher"`), the command (mono, truncated in the middle, the full text in its `title`,
// `data-slot="hook-row-command"`; "Code hook" for a plugin code hook), the state badge (`hookStateBadge`; "Plugin not
// trusted" while the plugin waits for trust), the muted meta line (`hookRowMeta`), the problems of an invalid row under
// it and the `⋯` menu (`hook-row-menu`, "Actions for {event} hook", always visible, 40px on touch): personal Edit… ·
// Duplicate · Turn off / on · Copy as JSON · Delete…; project Review… · Copy to personal · Copy as JSON; plugin Open
// plugin · Copy as JSON (command hooks). A chosen item is emitted once the menu has closed (focus is back on the
// trigger, so a sheet or dialog it opens returns focus there).
// Props, emits and the root test id are frozen from Gate P11-0b (C39 stub); implementation W11.8.
// Phase 12 (ADR-056, ADR-057; C46, W12.12): the hook of a plugin that waits for trust (the server's `pending` state of a
// plugin row, or the plugin's `untrusted` state) reads "Plugin not trusted" and offers Review plugin…
// (`data-action="trust-plugin"`, the plugin's TrustDialog; harness-format plugins only: a Claude Code plugin is reviewed
// on its page); a project row whose settings file can be edited here (`HOOK_ROW_CONTEXT`, a known `position`) offers
// Edit… (`hook-edit`, the hook editor in project mode) and Delete… (`hook-delete`, removes the handler from the file);
// prompt rows carry `data-kind="prompt"`, show `MessageSquareText` and the prompt's first line
// (`data-slot="hook-row-prompt"`) instead of the command; an exec-form command shows its arguments; the meta line adds
// "In the background" and "Only when {rule}".
import type { HookEntry } from '@harness-forge/shared'
import type { HookAction } from './hooks'
import {
  BracesIcon,
  CircleAlertIcon,
  CopyIcon,
  CopyPlusIcon,
  ExternalLinkIcon,
  MessageSquareTextIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PowerIcon,
  PowerOffIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  ShieldQuestionMarkIcon,
  Trash2Icon,
  WebhookIcon,
  WebhookOffIcon,
} from '@lucide/vue'
import { computed, inject, nextTick, useId } from 'vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { usePluginsStore } from '~/stores/plugins'
import { testIds } from '~/utils/testids'
import { middleTruncate } from './customize'
import { HOOK_ROW_CONTEXT } from './customize-context'
import { execFormText, HOOK_COPY, hookMatcherText, hookRowMeta, hookStateBadge, promptFirstLine } from './hooks'

const props = defineProps<{ entry: HookEntry, busy?: boolean }>()
const emit = defineEmits<{ action: [action: HookAction] }>()

const plugins = usePluginsStore()
const ids = { diagnostics: useId() }

const pluginName = (id: string): string => plugins.byId(id)?.name ?? id
const context = inject(HOOK_ROW_CONTEXT, null)

const isPrompt = computed(() => props.entry.kind === 'command' && props.entry.type === 'prompt')
const command = computed(() => (props.entry.kind === 'command' && !isPrompt.value ? execFormText(props.entry.command, props.entry.args) : null))
const shortCommand = computed(() => (command.value === null ? null : middleTruncate(command.value.replace(/\s+/g, ' '), 72)))
/** + Phase 12: a prompt hook's prompt (its first line in the row, the whole prompt in the title). */
const prompt = computed(() => (props.entry.kind === 'command' && isPrompt.value ? props.entry.prompt ?? '' : null))
const promptLine = computed(() => (prompt.value === null ? null : middleTruncate(promptFirstLine(prompt.value), 96)))
const matcher = computed(() => hookMatcherText(props.entry))
const meta = computed(() => hookRowMeta(props.entry, pluginName))
/** A plugin whose trust is missing: its hooks do not run until it is trusted again. */
const pluginUntrusted = computed(() => {
  if (props.entry.source !== 'plugin' || !props.entry.pluginId)
    return false
  return plugins.byId(props.entry.pluginId)?.state === 'untrusted'
})
/**
 * + Phase 12: the plugin of a plugin row waits for trust (the server lists its hooks as `pending`); only a harness-format
 * plugin is trusted through TrustDialog (a Claude Code plugin is reviewed on its page).
 */
const canTrustPlugin = computed(() => props.entry.source === 'plugin' && !!props.entry.pluginId
  && (pluginUntrusted.value || props.entry.state === 'pending')
  && plugins.byId(props.entry.pluginId)?.format !== 'claude')
/** + Phase 12: a project row whose settings file can be edited here (its handler's position is known). */
const canEditProject = computed(() => props.entry.source === 'project' && props.entry.kind === 'command' && !!props.entry.path
  && !!props.entry.position && context?.editProjectHooks.value === true)
const badge = computed(() => {
  if (pluginUntrusted.value && props.entry.state !== 'invalid')
    return { label: HOOK_COPY.pluginNotTrusted!, tone: 'warning' as const }
  return hookStateBadge(props.entry)
})
const off = computed(() => props.entry.state === 'off' || props.entry.state === 'blocked')
const enabled = computed(() => props.entry.state !== 'off')
/** Errors and warnings (ignored fields stay quiet), errors first. */
const diagnostics = computed(() => props.entry.diagnostics
  .filter(diagnostic => diagnostic.level !== 'info')
  .sort((a, b) => (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1)))

/** The item chosen; emitted once the menu has closed and focus is back on the trigger. */
let pending: HookAction | null = null

function choose(action: HookAction): void {
  pending = action
}

function onMenuCloseAutoFocus(): void {
  const action = pending
  pending = null
  if (action)
    void nextTick(() => emit('action', action))
}
</script>

<template>
  <li
    :data-testid="testIds.hookRow"
    :data-source="entry.source"
    :data-event="entry.event"
    :data-kind="entry.kind === 'command' && entry.type === 'prompt' ? 'prompt' : entry.kind"
    :data-state="entry.state"
    :data-hook-id="entry.source === 'personal' ? entry.id : undefined"
    :data-path="entry.kind === 'command' && entry.source === 'project' ? entry.path : undefined"
    :data-plugin-id="entry.source === 'plugin' ? entry.pluginId : undefined"
    :aria-busy="busy ? 'true' : undefined"
    class="flex min-w-0 flex-col gap-1.5 px-3 py-2"
  >
    <div class="flex min-h-(--row-height) min-w-0 items-start gap-3">
      <component :is="isPrompt ? MessageSquareTextIcon : off ? WebhookOffIcon : WebhookIcon" aria-hidden="true" class="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div class="flex min-w-0 flex-1 flex-col gap-1">
        <div class="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
          <span class="shrink-0 text-sm font-medium" :class="off ? 'text-muted-foreground' : undefined">{{ entry.event }}</span>
          <span v-if="matcher" data-slot="hook-row-matcher" class="min-w-0 font-mono text-xs break-all text-muted-foreground">{{ matcher }}</span>
          <code
            v-if="command !== null"
            data-slot="hook-row-command"
            :title="command"
            class="min-w-0 flex-1 basis-48 truncate font-mono text-xs text-foreground/85"
          >{{ shortCommand }}</code>
          <span
            v-else-if="prompt !== null"
            data-slot="hook-row-prompt"
            :title="prompt"
            class="min-w-0 flex-1 basis-48 truncate text-xs text-foreground/85"
          >{{ promptLine }}</span>
        </div>
        <div class="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
          <template v-for="(item, index) in meta" :key="index">
            <span v-if="index > 0" aria-hidden="true">·</span>
            <span :class="entry.kind === 'command' && item === entry.path ? 'min-w-0 font-mono break-all' : undefined">{{ item }}</span>
          </template>
          <template v-if="badge">
            <Badge
              v-if="badge.tone === 'success'"
              variant="outline"
              data-slot="hook-row-state"
              class="ml-1 gap-1 border-success/40 text-foreground"
            >
              <ShieldCheckIcon aria-hidden="true" class="text-success" />
              {{ badge.label }}
            </Badge>
            <Badge
              v-else-if="badge.tone === 'warning'"
              variant="outline"
              data-slot="hook-row-state"
              class="ml-1 gap-1 border-warning/50 text-foreground"
            >
              <ShieldQuestionMarkIcon aria-hidden="true" class="text-warning" />
              {{ badge.label }}
            </Badge>
            <Badge
              v-else-if="badge.tone === 'destructive'"
              variant="outline"
              data-slot="hook-row-state"
              class="ml-1 gap-1 border-destructive/50 text-destructive"
            >
              <CircleAlertIcon aria-hidden="true" />
              {{ badge.label }}
            </Badge>
            <Badge v-else variant="outline" data-slot="hook-row-state" class="ml-1 text-muted-foreground">
              {{ badge.label }}
            </Badge>
          </template>
        </div>
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            :data-testid="testIds.hookRowMenu"
            :aria-label="`Actions for ${entry.event} hook`"
            class="-my-0.5 shrink-0 text-muted-foreground pointer-coarse:size-10"
          >
            <MoreHorizontalIcon aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" class="w-52" @close-auto-focus="onMenuCloseAutoFocus">
          <template v-if="entry.source === 'personal'">
            <DropdownMenuItem :data-testid="testIds.hookEdit" class="pointer-coarse:min-h-10" @select="choose('edit')">
              <PencilIcon aria-hidden="true" />
              Edit…
            </DropdownMenuItem>
            <DropdownMenuItem :data-testid="testIds.hookDuplicate" class="pointer-coarse:min-h-10" @select="choose('duplicate')">
              <CopyIcon aria-hidden="true" />
              Duplicate
            </DropdownMenuItem>
            <DropdownMenuItem
              :data-testid="testIds.hookToggle"
              :data-state="enabled ? 'on' : 'off'"
              :disabled="busy"
              class="pointer-coarse:min-h-10"
              @select="choose('toggle')"
            >
              <PowerOffIcon v-if="enabled" aria-hidden="true" />
              <PowerIcon v-else aria-hidden="true" />
              {{ enabled ? 'Turn off' : 'Turn on' }}
            </DropdownMenuItem>
            <DropdownMenuItem :data-testid="testIds.hookCopyJson" class="pointer-coarse:min-h-10" @select="choose('copy-json')">
              <BracesIcon aria-hidden="true" />
              Copy as JSON
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              :data-testid="testIds.hookDelete"
              :disabled="busy"
              class="pointer-coarse:min-h-10"
              @select="choose('delete')"
            >
              <Trash2Icon aria-hidden="true" />
              Delete…
            </DropdownMenuItem>
          </template>
          <template v-else-if="entry.source === 'project'">
            <DropdownMenuItem v-if="canEditProject" :data-testid="testIds.hookEdit" class="pointer-coarse:min-h-10" @select="choose('edit')">
              <PencilIcon aria-hidden="true" />
              Edit…
            </DropdownMenuItem>
            <DropdownMenuItem :data-testid="testIds.hookReview" class="pointer-coarse:min-h-10" @select="choose('review')">
              <ShieldQuestionMarkIcon aria-hidden="true" />
              Review…
            </DropdownMenuItem>
            <DropdownMenuItem :data-testid="testIds.hookDuplicate" class="pointer-coarse:min-h-10" @select="choose('duplicate')">
              <CopyPlusIcon aria-hidden="true" />
              Copy to personal
            </DropdownMenuItem>
            <DropdownMenuItem :data-testid="testIds.hookCopyJson" class="pointer-coarse:min-h-10" @select="choose('copy-json')">
              <BracesIcon aria-hidden="true" />
              Copy as JSON
            </DropdownMenuItem>
            <template v-if="canEditProject">
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                :data-testid="testIds.hookDelete"
                :disabled="busy"
                class="pointer-coarse:min-h-10"
                @select="choose('delete')"
              >
                <Trash2Icon aria-hidden="true" />
                Delete…
              </DropdownMenuItem>
            </template>
          </template>
          <template v-else>
            <DropdownMenuItem v-if="canTrustPlugin" data-action="trust-plugin" class="pointer-coarse:min-h-10" @select="choose('trust-plugin')">
              <ShieldAlertIcon aria-hidden="true" />
              {{ HOOK_COPY.reviewPlugin }}
            </DropdownMenuItem>
            <DropdownMenuItem v-if="entry.pluginId" data-action="open-plugin" class="pointer-coarse:min-h-10" @select="choose('open-plugin')">
              <ExternalLinkIcon aria-hidden="true" />
              Open plugin
            </DropdownMenuItem>
            <DropdownMenuItem v-if="entry.kind === 'command'" :data-testid="testIds.hookCopyJson" class="pointer-coarse:min-h-10" @select="choose('copy-json')">
              <BracesIcon aria-hidden="true" />
              Copy as JSON
            </DropdownMenuItem>
          </template>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>

    <ul
      v-if="diagnostics.length > 0"
      :id="ids.diagnostics"
      data-slot="hook-row-diagnostics"
      :aria-label="`Problems in this ${entry.event} hook`"
      class="ml-7 flex flex-col gap-0.5 border-l-2 pl-3 text-xs"
      :class="entry.state === 'invalid' ? 'border-destructive/50' : 'border-warning/50'"
    >
      <li
        v-for="(diagnostic, index) in diagnostics"
        :key="index"
        :data-level="diagnostic.level"
        :class="diagnostic.level === 'error' ? 'text-destructive' : 'text-muted-foreground'"
      >
        {{ diagnostic.message }}
      </li>
    </ul>
  </li>
</template>
