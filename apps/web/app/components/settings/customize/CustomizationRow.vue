<script setup lang="ts">
// One definition of the Customize page (docs/UI.md 2.17, 9.12, 10.7, 14.2, 14.5): a list item with the kind icon, the
// name (commands as `/name`, mono) and the description (one line, two below `sm`); the muted meta line (source, path
// shortened in the middle, namespace, model, tools, argument hint); the state badges: Shadowed (EyeOff, its tooltip
// "Not used: {winner} wins." also the badge's description), Invalid (CircleAlert; the diagnostics list expanded under
// the row), "{n} warnings" (a button that shows or hides the same list) and Off; the diagnostics list
// (`customization-diagnostics`, a `ul` named "Problems in {name}", each message as the server wrote it: it already starts
// with "Line N: " when the line is known). The `⋯` menu ("Actions for {name}", always visible, 40px on touch):
// personal rows Edit… · Duplicate · Export .md · Turn off / Turn on · Delete…; the others View… · Copy to personal ·
// Export .md · Open plugin (plugin rows); built-in command rows have no menu. A chosen item is emitted once the menu
// has closed (focus is back on the trigger, so a sheet or dialog it opens returns focus there).
// Props, emits and the root test id are frozen from Gate P10-0b (C33).
// Phase 11 (W11.8; docs/UI.md 9.13): style rows show the `Feather` icon, the label (the slug in the meta line), the
// coding-instructions meta and the badges "Your default" / "Default in {project}" (`data-slot="style-default-badge"`),
// and their menu adds Use by default (`customization-set-default`; disabled while it already is); skill rows show
// "/{name}" and "Only when you run it"; a project command whose `!` lines wait for approval shows Needs approval
// (`ShieldQuestionMark`) and the menu item Review… (`customization-review`). The defaults and the pending trust come
// from CustomizeSettings through `CUSTOMIZE_ROW_CONTEXT` (the props are frozen).
// Phase 12 (ADR-056; C46, W12.11 owns it in P12-A): project rows add Edit… (`customization-edit`, `data-source="project"`,
// after Review…), which CustomizeSettings answers with the project file editor.
import type { CustomizationEntry } from '@harness-forge/shared'
import type { CustomizationAction } from './customize'
import {
  BookOpenIcon,
  BotIcon,
  BotMessageSquareIcon,
  CircleAlertIcon,
  CopyIcon,
  CopyPlusIcon,
  DownloadIcon,
  ExternalLinkIcon,
  EyeIcon,
  EyeOffIcon,
  FeatherIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PowerIcon,
  PowerOffIcon,
  ShieldQuestionMarkIcon,
  SquareSlashIcon,
  StarIcon,
  TelescopeIcon,
  Trash2Icon,
} from '@lucide/vue'
import { computed, inject, nextTick, ref, useId } from 'vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useModelsStore } from '~/stores/models'
import { usePluginsStore } from '~/stores/plugins'
import { testIds } from '~/utils/testids'
import { displayName as displayNameOf, hasRowMenu, isScopeDefault, rowDiagnostics, rowMetaItems, shadowedTooltip, stateBadge, styleDefaultBadges } from './customize'
import { CUSTOMIZE_ROW_CONTEXT } from './customize-context'

const props = defineProps<{ entry: CustomizationEntry, busy?: boolean }>()
const emit = defineEmits<{ action: [action: CustomizationAction] }>()

const plugins = usePluginsStore()
const models = useModelsStore()
const ids = { shadowed: useId(), diagnostics: useId() }

const pluginName = (id: string): string => plugins.byId(id)?.name ?? id
const modelName = (ref: string): string => models.byRef(ref)?.name ?? ref

const context = inject(CUSTOMIZE_ROW_CONTEXT, null)

const personal = computed(() => props.entry.source === 'user')
const displayName = computed(() => displayNameOf(props.entry))
const icon = computed(() => {
  const { kind, source, name } = props.entry
  if (kind === 'command')
    return SquareSlashIcon
  if (kind === 'style')
    return FeatherIcon
  if (kind === 'skill')
    return BookOpenIcon
  if (source === 'builtin')
    return name === 'explore' ? TelescopeIcon : BotIcon
  return BotMessageSquareIcon
})
const meta = computed(() => rowMetaItems(props.entry, pluginName, modelName))
const badge = computed(() => stateBadge(props.entry))
const diagnostics = computed(() => rowDiagnostics(props.entry))
/** "{n} warnings" of a shadowed or off row (its state badge takes the place of the warnings badge of active rows). */
const extraWarnings = computed(() => {
  if (props.entry.state !== 'shadowed' && props.entry.state !== 'off')
    return null
  return stateBadge({ ...props.entry, state: 'active' })
})
const warningsOpen = ref(false)
const showDiagnostics = computed(() => diagnostics.value.length > 0 && (props.entry.state === 'invalid' || warningsOpen.value))
const shadowedText = computed(() => (props.entry.state === 'shadowed' ? shadowedTooltip(props.entry, pluginName) : null))
/** + Phase 11: "Your default" / "Default in {project}" of a style row. */
const defaultBadges = computed(() => styleDefaultBadges(props.entry, context?.styleDefaults.value ?? null))
/** + Phase 11: Use by default (active style rows); disabled while the style already is the scope's default. */
const canSetDefault = computed(() => props.entry.kind === 'style' && props.entry.state === 'active' && !!context)
const isDefault = computed(() => isScopeDefault(props.entry, context?.styleDefaults.value ?? null))
/** + Phase 11: a project command whose `!` lines wait for approval. */
const needsApproval = computed(() => !!context?.pendingTrust(props.entry))

/** The item chosen; emitted once the menu has closed and focus is back on the trigger. */
let pending: CustomizationAction | null = null

function choose(action: CustomizationAction): void {
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
    :data-testid="testIds.customizationRow"
    :data-kind="entry.kind"
    :data-name="entry.name"
    :data-source="entry.source"
    :data-state="entry.state"
    :data-customization-id="entry.source === 'user' ? entry.id : undefined"
    :data-path="entry.source === 'project' ? entry.path : undefined"
    :data-plugin-id="entry.source === 'plugin' ? entry.pluginId : undefined"
    :aria-busy="busy ? 'true' : undefined"
    class="flex min-w-0 flex-col gap-1.5 px-3 py-2"
  >
    <div class="flex min-h-(--row-height) min-w-0 items-start gap-3">
      <component :is="icon" aria-hidden="true" class="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div class="flex min-w-0 flex-1 flex-col gap-1">
        <div class="flex min-w-0 flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-2.5">
          <span
            class="shrink-0 truncate text-[13px] font-medium"
            :class="[entry.kind === 'style' && displayName !== entry.name ? undefined : 'font-mono', entry.state === 'off' || entry.state === 'shadowed' ? 'text-muted-foreground' : undefined]"
          >
            {{ displayName }}
          </span>
          <span class="line-clamp-2 min-w-0 text-sm text-muted-foreground sm:line-clamp-1 sm:truncate" :title="entry.description || undefined">
            {{ entry.description }}
          </span>
        </div>
        <div class="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
          <template v-for="(item, index) in meta" :key="index">
            <span v-if="index > 0" aria-hidden="true">·</span>
            <span :class="item.mono ? 'min-w-0 font-mono break-all' : undefined" :title="item.title">{{ item.text }}</span>
          </template>

          <template v-if="badge">
            <Tooltip v-if="entry.state === 'shadowed'">
              <TooltipTrigger as-child>
                <Badge variant="outline" tabindex="0" :aria-describedby="ids.shadowed" class="ml-1 gap-1 text-muted-foreground">
                  <EyeOffIcon aria-hidden="true" />
                  Shadowed
                </Badge>
              </TooltipTrigger>
              <TooltipContent>{{ shadowedText }}</TooltipContent>
            </Tooltip>
            <Badge v-else-if="badge.tone === 'destructive'" variant="outline" class="ml-1 gap-1 border-destructive/50 text-destructive">
              <CircleAlertIcon aria-hidden="true" />
              {{ badge.label }}
            </Badge>
            <button
              v-else-if="badge.tone === 'warning'"
              type="button"
              :aria-expanded="warningsOpen"
              :aria-controls="showDiagnostics ? ids.diagnostics : undefined"
              class="ml-1 inline-flex h-5 items-center gap-1.5 rounded-4xl border border-warning/40 px-2 text-xs font-medium text-foreground outline-none hover:bg-warning/10 focus-visible:ring-3 focus-visible:ring-ring/50 pointer-coarse:h-10"
              @click="warningsOpen = !warningsOpen"
            >
              <span aria-hidden="true" class="size-1.5 rounded-full bg-warning" />
              {{ badge.label }}
            </button>
            <Badge v-else variant="outline" class="ml-1 text-muted-foreground">
              {{ badge.label }}
            </Badge>
          </template>
          <button
            v-if="extraWarnings"
            type="button"
            :aria-expanded="warningsOpen"
            :aria-controls="showDiagnostics ? ids.diagnostics : undefined"
            class="inline-flex h-5 items-center gap-1.5 rounded-4xl border border-warning/40 px-2 text-xs font-medium text-foreground outline-none hover:bg-warning/10 focus-visible:ring-3 focus-visible:ring-ring/50 pointer-coarse:h-10"
            @click="warningsOpen = !warningsOpen"
          >
            <span aria-hidden="true" class="size-1.5 rounded-full bg-warning" />
            {{ extraWarnings.label }}
          </button>
          <span v-if="shadowedText" :id="ids.shadowed" class="sr-only">{{ shadowedText }}</span>
          <Badge
            v-for="label in defaultBadges"
            :key="label"
            variant="outline"
            data-slot="style-default-badge"
            class="ml-1 gap-1 border-primary/40 text-foreground"
          >
            <StarIcon aria-hidden="true" class="text-primary" />
            {{ label }}
          </Badge>
          <Badge
            v-if="needsApproval"
            variant="outline"
            data-slot="customization-needs-approval"
            class="ml-1 gap-1 border-warning/50 text-foreground"
          >
            <ShieldQuestionMarkIcon aria-hidden="true" class="text-warning" />
            Needs approval
          </Badge>
        </div>
      </div>

      <DropdownMenu v-if="hasRowMenu(entry)">
        <DropdownMenuTrigger as-child>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            :data-testid="testIds.customizationRowMenu"
            :aria-label="`Actions for ${entry.name}`"
            class="-my-0.5 shrink-0 text-muted-foreground pointer-coarse:size-10"
          >
            <MoreHorizontalIcon aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" class="w-52" @close-auto-focus="onMenuCloseAutoFocus">
          <template v-if="personal">
            <DropdownMenuItem :data-testid="testIds.customizationEdit" @select="choose('edit')">
              <PencilIcon aria-hidden="true" />
              Edit…
            </DropdownMenuItem>
            <DropdownMenuItem :data-testid="testIds.customizationDuplicate" @select="choose('duplicate')">
              <CopyIcon aria-hidden="true" />
              Duplicate
            </DropdownMenuItem>
            <DropdownMenuItem :data-testid="testIds.customizationExport" @select="choose('export')">
              <DownloadIcon aria-hidden="true" />
              Export .md
            </DropdownMenuItem>
            <DropdownMenuItem
              :data-testid="testIds.customizationToggle"
              :data-state="entry.enabled ? 'on' : 'off'"
              :disabled="busy"
              @select="choose('toggle')"
            >
              <PowerOffIcon v-if="entry.enabled" aria-hidden="true" />
              <PowerIcon v-else aria-hidden="true" />
              {{ entry.enabled ? 'Turn off' : 'Turn on' }}
            </DropdownMenuItem>
            <DropdownMenuItem
              v-if="canSetDefault"
              :data-testid="testIds.customizationSetDefault"
              :disabled="isDefault"
              @select="choose('set-default')"
            >
              <StarIcon aria-hidden="true" />
              Use by default
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" :data-testid="testIds.customizationDelete" :disabled="busy" @select="choose('delete')">
              <Trash2Icon aria-hidden="true" />
              Delete…
            </DropdownMenuItem>
          </template>
          <template v-else>
            <DropdownMenuItem v-if="needsApproval" :data-testid="testIds.customizationReview" @select="choose('review')">
              <ShieldQuestionMarkIcon aria-hidden="true" />
              Review…
            </DropdownMenuItem>
            <DropdownMenuItem
              v-if="entry.source === 'project' && entry.path"
              :data-testid="testIds.customizationEdit"
              data-source="project"
              @select="choose('edit')"
            >
              <PencilIcon aria-hidden="true" />
              Edit…
            </DropdownMenuItem>
            <DropdownMenuItem :data-testid="testIds.customizationView" @select="choose('view')">
              <EyeIcon aria-hidden="true" />
              View…
            </DropdownMenuItem>
            <DropdownMenuItem :data-testid="testIds.customizationDuplicate" @select="choose('duplicate')">
              <CopyPlusIcon aria-hidden="true" />
              Copy to personal
            </DropdownMenuItem>
            <DropdownMenuItem :data-testid="testIds.customizationExport" @select="choose('export')">
              <DownloadIcon aria-hidden="true" />
              Export .md
            </DropdownMenuItem>
            <DropdownMenuItem
              v-if="canSetDefault"
              :data-testid="testIds.customizationSetDefault"
              :disabled="isDefault"
              @select="choose('set-default')"
            >
              <StarIcon aria-hidden="true" />
              Use by default
            </DropdownMenuItem>
            <DropdownMenuItem v-if="entry.source === 'plugin' && entry.pluginId" data-action="open-plugin" @select="choose('open-plugin')">
              <ExternalLinkIcon aria-hidden="true" />
              Open plugin
            </DropdownMenuItem>
          </template>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>

    <ul
      v-if="showDiagnostics"
      :id="ids.diagnostics"
      :data-testid="testIds.customizationDiagnostics"
      :data-count="diagnostics.length"
      :aria-label="`Problems in ${entry.name}`"
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
