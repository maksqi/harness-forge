// Test helper (not app code): DTO factories with valid defaults, overridable per test.
import type {
  AuthStatus,
  CatalogModel,
  ChatDetail,
  ChatSummary,
  PluginDetail,
  PluginLogEntry,
  PluginSummary,
  ProviderSummary,
  ToolSummary,
} from '@harness-forge/shared'

/** A fixed uuidv7 chat id with a varying last group: chatId(1) -> '...000000000001'. */
export function chatId(n: number): string {
  return `0199a8f0-0000-7000-8000-${String(n).padStart(12, '0')}`
}

export function authStatus(overrides: Partial<AuthStatus> = {}): AuthStatus {
  return { enabled: false, authenticated: true, source: null, freshUntil: null, ...overrides }
}

export function chatSummary(overrides: Partial<ChatSummary> = {}): ChatSummary {
  return {
    id: chatId(1),
    title: 'Chat',
    titleSource: 'auto',
    modelRef: 'mock:echo',
    pinned: false,
    archived: false,
    running: false,
    pendingApproval: false,
    createdAt: 1_759_000_000_000,
    updatedAt: 1_759_000_000_000,
    ...overrides,
  }
}

export function chatDetail(overrides: Partial<ChatDetail> = {}): ChatDetail {
  return {
    ...chatSummary(),
    settings: {},
    messages: [],
    totals: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null },
    ...overrides,
  }
}

export function providerSummary(overrides: Partial<ProviderSummary> = {}): ProviderSummary {
  return {
    id: 'anthropic',
    name: 'Anthropic (Claude)',
    pluginId: 'core-providers',
    icon: { color: '/api/icons/lobe/claude-color', mono: '/api/icons/lobe/claude' },
    enabled: true,
    status: 'connected',
    credentialFields: [],
    credentials: {},
    keyUrl: null,
    local: false,
    modelCount: 3,
    modelsFetchedAt: null,
    lastError: null,
    validatedAt: null,
    ...overrides,
  }
}

export function catalogModel(overrides: Partial<CatalogModel> = {}): CatalogModel {
  const providerId = overrides.providerId ?? 'anthropic'
  const id = overrides.id ?? 'claude-sonnet-5'
  return {
    ref: `${providerId}:${id}`,
    providerId,
    id,
    name: id,
    alias: null,
    kind: 'chat',
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    capabilities: { tools: true, vision: true, pdf: false, reasoning: true, structuredOutput: true },
    reasoningEfforts: [],
    cost: null,
    favorite: false,
    hidden: false,
    custom: false,
    source: 'seed',
    lastUsedAt: null,
    ...overrides,
  }
}

export function pluginSummary(overrides: Partial<PluginSummary> = {}): PluginSummary {
  return {
    id: 'dice-roller',
    name: 'Dice roller',
    version: '1.0.0',
    description: 'Rolls dice',
    icon: null,
    kind: 'code',
    source: 'created',
    sourceRef: null,
    builtin: false,
    removable: true,
    enabled: true,
    state: 'active',
    runsCode: true,
    contributions: { providers: [], models: 0, tools: ['roll_dice'], mcpServers: [], commands: [], hooks: [] },
    lastError: null,
    installedAt: 1_759_000_000_000,
    updatedAt: 1_759_000_000_000,
    ...overrides,
  }
}

export function pluginDetail(overrides: Partial<PluginDetail> = {}): PluginDetail {
  const summary = pluginSummary(overrides)
  return {
    ...summary,
    manifest: { id: summary.id, name: summary.name, version: summary.version, main: 'index.mjs' } as PluginDetail['manifest'],
    trust: { required: true, trusted: true, hash: 'a'.repeat(64), trustedHash: 'a'.repeat(64) },
    editable: true,
    hasSettings: false,
    ...overrides,
  }
}

export function toolSummary(overrides: Partial<ToolSummary> = {}): ToolSummary {
  return {
    name: 'roll_dice',
    title: null,
    description: 'Roll dice',
    pluginId: 'dice-roller',
    mcpServerId: null,
    policy: 'safe',
    enabled: true,
    override: null,
    available: true,
    inputSchema: {},
    ...overrides,
  }
}

export function logEntry(seq: number, overrides: Partial<PluginLogEntry> = {}): PluginLogEntry {
  return { seq, at: 1_759_000_000_000 + seq, level: 'info', message: `entry ${seq}`, ...overrides }
}
