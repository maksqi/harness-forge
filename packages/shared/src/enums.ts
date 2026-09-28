// Enumerations of the contract (DECISIONS.md "Enumerations", API.md section 4.1, PLUGINS.md section 9).
// Error codes and actions live in `errors.ts`.
import { z } from 'zod'

/** Chat permission mode (UI label: permission mode). Default `ask`. */
export const toolModeSchema = z.enum(['off', 'ask', 'auto'])
export type ToolMode = z.infer<typeof toolModeSchema>

/** Reasoning effort; `auto` sends nothing to the provider. */
export const reasoningEffortSchema = z.enum(['auto', 'off', 'low', 'medium', 'high', 'max'])
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>

/** Approval policy of a tool. */
export const toolPolicySchema = z.enum(['safe', 'ask', 'always'])
export type ToolPolicy = z.infer<typeof toolPolicySchema>

/** User override of a tool's approval (`tool_prefs.override`). */
export const toolOverrideSchema = z.enum(['allow', 'ask', 'deny'])
export type ToolOverride = z.infer<typeof toolOverrideSchema>

export const providerStatusSchema = z.enum(['connected', 'not_configured', 'env', 'error'])
export type ProviderStatus = z.infer<typeof providerStatusSchema>

export const pluginKindSchema = z.enum(['declarative', 'code'])
export type PluginKind = z.infer<typeof pluginKindSchema>

export const pluginSourceSchema = z.enum(['builtin', 'created', 'zip', 'npm', 'url', 'link', 'copy'])
export type PluginSource = z.infer<typeof pluginSourceSchema>

export const pluginStateSchema = z.enum(['disabled', 'untrusted', 'incompatible', 'loading', 'active', 'error'])
export type PluginState = z.infer<typeof pluginStateSchema>

/** Advisory plugin permissions (PLUGINS.md section 3). */
export const pluginPermissionSchema = z.enum(['network', 'secrets', 'storage', 'hooks', 'process'])
export type PluginPermission = z.infer<typeof pluginPermissionSchema>

/** Wire format of a declarative provider. */
export const apiFormatSchema = z.enum(['openai-chat', 'openai-responses', 'anthropic', 'google'])
export type ApiFormat = z.infer<typeof apiFormatSchema>

/** How a declarative provider maps the effort menu to request options (PLUGINS.md section 4). */
export const reasoningStyleSchema = z.enum(['openai-effort', 'anthropic-thinking', 'google-thinking', 'none'])
export type ReasoningStyle = z.infer<typeof reasoningStyleSchema>

/** Input type of a provider credential field. */
export const credentialFieldTypeSchema = z.enum(['secret', 'text', 'url', 'select'])
export type CredentialFieldType = z.infer<typeof credentialFieldTypeSchema>

export const modelKindSchema = z.enum(['chat', 'embedding', 'image', 'audio', 'other'])
export type ModelKind = z.infer<typeof modelKindSchema>

/** Where a catalog entry comes from. */
export const modelSourceSchema = z.enum(['custom', 'live', 'plugin', 'seed'])
export type ModelSource = z.infer<typeof modelSourceSchema>

export const titleSourceSchema = z.enum(['auto', 'fallback', 'user'])
export type TitleSource = z.infer<typeof titleSourceSchema>

/** Where a resolved secret comes from (`stored` wins over `env`). */
export const secretSourceSchema = z.enum(['stored', 'env'])
export type SecretSource = z.infer<typeof secretSourceSchema>

export const mcpStatusSchema = z.enum(['disabled', 'connecting', 'connected', 'error'])
export type McpStatus = z.infer<typeof mcpStatusSchema>

export const logLevelSchema = z.enum(['debug', 'info', 'warn', 'error'])
export type LogLevel = z.infer<typeof logLevelSchema>

/** Code plugin templates of `POST /plugins/scaffold`. */
export const pluginTemplateIdSchema = z.enum(['tool', 'provider', 'mcp-bridge', 'command-pack'])
export type PluginTemplateId = z.infer<typeof pluginTemplateIdSchema>

// ---------- global settings enums ----------

export const sendKeySchema = z.enum(['enter', 'mod-enter'])
export type SendKey = z.infer<typeof sendKeySchema>

export const densitySchema = z.enum(['comfortable', 'compact'])
export type Density = z.infer<typeof densitySchema>

export const readingFontSchema = z.enum(['sans', 'serif'])
export type ReadingFont = z.infer<typeof readingFontSchema>

export const textSizeSchema = z.enum(['sm', 'md', 'lg'])
export type TextSize = z.infer<typeof textSizeSchema>
