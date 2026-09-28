<script setup lang="ts">
// MCP servers of a plugin (docs/UI.md 8.12): rendered in the Overview of `core-mcp` (user-configured servers, which
// can be added, switched, edited and deleted) and usable for any plugin (its declared servers are read-only here and
// can only be restarted). Rows: status dot + name, transport badge, status line, enabled switch, Restart and a menu
// with Edit / Delete. The list lives in the plugins store; it refetches on `plugin.changed`, so connection changes
// show up without polling.
import type { McpServer } from '@harness-forge/shared'
import type { HarnessErrorUiAction } from '~/components/common/harness-error'
import { EllipsisIcon, PencilIcon, PlusIcon, RotateCwIcon, ServerIcon, Trash2Icon } from '@lucide/vue'
import { computed, nextTick, onMounted, ref, useId } from 'vue'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import ConfirmDialog from '~/components/common/ConfirmDialog.vue'
import { errorActions, toHarnessErrorView } from '~/components/common/harness-error'
import HarnessErrorAlert from '~/components/common/HarnessErrorAlert.vue'
import StatusDot from '~/components/common/StatusDot.vue'
import { usePluginsStore } from '~/stores/plugins'
import { toHarnessError } from '~/utils/errors'
import { testIds } from '~/utils/testids'
import { CORE_MCP_PLUGIN_ID, MCP_STATUS_DOTS, MCP_STATUS_LABELS, mcpStatusText } from './mcp-form'
import McpServerDialog from './McpServerDialog.vue'
import McpTransportBadge from './McpTransportBadge.vue'

const props = withDefaults(defineProps<{ pluginId?: string }>(), { pluginId: CORE_MCP_PLUGIN_ID })

type RowAction = 'enabled' | 'restart'

const plugins = usePluginsStore()
const headingId = useId()

const loading = ref(false)
const loadError = ref<unknown>(null)
/** Actions in flight per server id. */
const pending = ref<Record<string, RowAction>>({})
/** Optimistic switch values while a toggle is saved. */
const switching = ref<Record<string, boolean>>({})

const servers = computed(() => plugins.mcp.filter(server => server.pluginId === props.pluginId))
const canAdd = computed(() => props.pluginId === CORE_MCP_PLUGIN_ID)
const showSkeleton = computed(() => !plugins.mcpLoaded && !loadError.value)
const loadErrorOffersRetry = computed(() => loadError.value !== null && errorActions(toHarnessErrorView(loadError.value)).includes('retry'))

async function load() {
  loading.value = true
  loadError.value = null
  try {
    await plugins.fetchMcp()
  }
  catch (error) {
    loadError.value = error
  }
  finally {
    loading.value = false
  }
}

function onLoadErrorAction(action: HarnessErrorUiAction) {
  if (action === 'retry')
    void load()
}

onMounted(() => {
  if (!plugins.mcpLoaded)
    void load()
})

/** A failed row action: what failed as the title, the server message as the description. */
function toastError(error: unknown, title: string) {
  toast.error(title, { description: toHarnessError(error).message })
}

function setPending(id: string, action: RowAction | null) {
  const { [id]: _previous, ...rest } = pending.value
  pending.value = action ? { ...rest, [id]: action } : rest
}

/** A disabled server (or one whose plugin is off) cannot be restarted; neither can one with an action in flight. */
function canRestart(server: McpServer): boolean {
  return server.enabled && server.status !== 'disabled' && pending.value[server.id] === undefined
}

function enabledOf(server: McpServer): boolean {
  return switching.value[server.id] ?? server.enabled
}

async function setEnabled(server: McpServer, enabled: boolean) {
  if (pending.value[server.id])
    return
  setPending(server.id, 'enabled')
  switching.value = { ...switching.value, [server.id]: enabled }
  try {
    await plugins.saveMcp({ id: server.id, patch: { enabled } })
  }
  catch (error) {
    toastError(error, enabled ? `Could not enable ${server.name}` : `Could not disable ${server.name}`)
  }
  finally {
    const { [server.id]: _done, ...rest } = switching.value
    switching.value = rest
    setPending(server.id, null)
  }
}

async function restart(server: McpServer) {
  if (pending.value[server.id])
    return
  setPending(server.id, 'restart')
  try {
    const result = await plugins.reconnectMcp(server.id)
    if (result.status === 'connected')
      toast.success(`${result.name} connected`)
    else if (result.status === 'error')
      toast.error(`Could not connect ${result.name}`, { description: result.error?.message ?? 'The server could not be reached.' })
    else
      toast(`${result.name} is still connecting`)
  }
  catch (error) {
    toastError(error, `Could not restart ${server.name}`)
  }
  finally {
    setPending(server.id, null)
  }
}

// ---------- row menu ----------

type MenuAction = 'edit' | 'delete'

/** Edit and Delete run once the menu has closed and given focus back, so the dialog keeps the focus it takes. */
let pendingMenuAction: { action: MenuAction, server: McpServer } | null = null

function chooseMenu(action: MenuAction, server: McpServer) {
  pendingMenuAction = { action, server }
}

function onMenuCloseAutoFocus(event: Event) {
  const next = pendingMenuAction
  pendingMenuAction = null
  if (!next)
    return
  event.preventDefault()
  void nextTick(() => {
    if (next.action === 'edit')
      openEdit(next.server)
    else
      askDelete(next.server)
  })
}

// ---------- add / edit ----------

const dialogOpen = ref(false)
const dialogServer = ref<McpServer | null>(null)

function openAdd() {
  dialogServer.value = null
  dialogOpen.value = true
}

function openEdit(server: McpServer) {
  dialogServer.value = server
  dialogOpen.value = true
}

// ---------- delete ----------

const deleteTarget = ref<McpServer | null>(null)
const deleteOpen = ref(false)
const deleting = ref(false)

function askDelete(server: McpServer) {
  deleteTarget.value = server
  deleteOpen.value = true
}

async function confirmDelete() {
  const server = deleteTarget.value
  if (!server || deleting.value)
    return
  deleting.value = true
  try {
    await plugins.removeMcp(server.id)
    toast.success(`Deleted ${server.name}`)
    deleteOpen.value = false
  }
  catch (error) {
    toastError(error, `Could not delete ${server.name}`)
  }
  finally {
    deleting.value = false
  }
}

function onDeleteOpenChange(value: boolean) {
  deleteOpen.value = value
}
</script>

<template>
  <section
    :data-testid="testIds.mcpPanel"
    :data-plugin-id="pluginId"
    :aria-labelledby="headingId"
    class="flex flex-col gap-3"
  >
    <header class="flex items-center gap-3">
      <div class="min-w-0 flex-1">
        <h3 :id="headingId" class="text-sm font-medium">
          MCP servers
        </h3>
        <p v-if="canAdd" class="text-xs text-muted-foreground">
          Their tools become tools of the chat.
        </p>
      </div>
      <Button
        v-if="canAdd"
        type="button"
        size="sm"
        variant="outline"
        :data-testid="testIds.mcpAdd"
        @click="openAdd"
      >
        <PlusIcon aria-hidden="true" data-icon="inline-start" />
        Add server
      </Button>
    </header>

    <div v-if="loadError && !plugins.mcpLoaded" data-slot="mcp-load-error" class="grid gap-2">
      <HarnessErrorAlert :error="loadError" @action="onLoadErrorAction" />
      <Button
        v-if="!loadErrorOffersRetry"
        type="button"
        size="sm"
        variant="outline"
        class="w-fit"
        :disabled="loading"
        @click="load"
      >
        <Spinner v-if="loading" data-icon="inline-start" />
        Retry
      </Button>
    </div>

    <div
      v-if="showSkeleton"
      aria-busy="true"
      aria-label="Loading MCP servers"
      class="divide-y divide-border overflow-hidden rounded-xl border bg-card"
    >
      <div v-for="index in 2" :key="index" class="flex items-center gap-3 px-4 py-3">
        <Skeleton class="size-2 rounded-full" />
        <div class="flex flex-1 flex-col gap-1.5">
          <Skeleton class="h-3.5 w-40" />
          <Skeleton class="h-3 w-28" />
        </div>
        <Skeleton class="h-[18px] w-8 rounded-full" />
        <Skeleton class="size-8" />
      </div>
    </div>

    <ul
      v-else-if="servers.length"
      aria-label="MCP servers"
      class="divide-y divide-border overflow-hidden rounded-xl border bg-card"
    >
      <li
        v-for="server in servers"
        :key="server.id"
        :data-testid="testIds.mcpServerRow"
        :data-server-id="server.id"
        :data-status="server.status"
        class="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 px-4 py-3"
      >
        <StatusDot :status="MCP_STATUS_DOTS[server.status]" :label="MCP_STATUS_LABELS[server.status]" class="-ml-1.5" />
        <div class="min-w-0">
          <div class="flex min-w-0 items-center gap-2">
            <span :class="cn('truncate text-sm font-medium', !server.enabled && 'text-muted-foreground')">
              {{ server.name }}
            </span>
            <McpTransportBadge :type="server.transport.type" />
          </div>
          <p
            :data-testid="testIds.mcpStatus"
            :data-status="server.status"
            :title="server.status === 'error' ? mcpStatusText(server) : undefined"
            :class="cn('truncate text-xs', server.status === 'error' ? 'text-destructive' : 'text-muted-foreground')"
          >
            {{ mcpStatusText(server) }}
          </p>
        </div>
        <div class="flex items-center gap-1">
          <Switch
            v-if="server.editable"
            size="sm"
            :model-value="enabledOf(server)"
            :disabled="pending[server.id] !== undefined"
            :aria-label="`Enable ${server.name}`"
            :data-testid="testIds.mcpEnabled"
            :data-server-id="server.id"
            class="mr-2"
            @update:model-value="value => setEnabled(server, value)"
          />
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            :disabled="!canRestart(server)"
            :aria-label="`Restart ${server.name}`"
            :title="`Restart ${server.name}`"
            :aria-busy="pending[server.id] === 'restart' || undefined"
            :data-testid="testIds.mcpRestart"
            :data-server-id="server.id"
            @click="restart(server)"
          >
            <Spinner v-if="pending[server.id] === 'restart'" />
            <RotateCwIcon v-else aria-hidden="true" />
          </Button>
          <DropdownMenu v-if="server.editable">
            <DropdownMenuTrigger as-child>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                :aria-label="`Actions for ${server.name}`"
                data-action="mcp-menu"
                :data-server-id="server.id"
              >
                <EllipsisIcon aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" class="w-40" @close-auto-focus="onMenuCloseAutoFocus">
              <DropdownMenuItem :data-testid="testIds.mcpEdit" :data-server-id="server.id" @select="chooseMenu('edit', server)">
                <PencilIcon aria-hidden="true" />
                Edit
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                :data-testid="testIds.mcpDelete"
                :data-server-id="server.id"
                @select="chooseMenu('delete', server)"
              >
                <Trash2Icon aria-hidden="true" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </li>
    </ul>

    <Empty v-else-if="plugins.mcpLoaded" class="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <ServerIcon aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle>No MCP servers yet.</EmptyTitle>
        <EmptyDescription v-if="canAdd">
          Add a local command (stdio) or a remote server (HTTP, SSE). Its tools become tools of the chat.
        </EmptyDescription>
        <EmptyDescription v-else>
          This plugin declares no MCP servers.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent v-if="canAdd">
        <Button type="button" size="sm" @click="openAdd">
          <PlusIcon aria-hidden="true" data-icon="inline-start" />
          Add server
        </Button>
      </EmptyContent>
    </Empty>

    <McpServerDialog v-if="canAdd" v-model:open="dialogOpen" :server="dialogServer" />

    <ConfirmDialog
      :open="deleteOpen"
      :title="`Delete ${deleteTarget?.name ?? 'server'}?`"
      description="Its tools are removed from the chat and its stored headers and environment values are deleted."
      confirm-label="Delete"
      :pending="deleting"
      data-action="mcp-delete-confirm"
      @update:open="onDeleteOpenChange"
      @confirm="confirmDelete"
    />
  </section>
</template>
