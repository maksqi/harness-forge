// Model catalog DTOs (API.md section 4.5).
import { z } from 'zod'
import { modelKindSchema, modelSourceSchema, reasoningEffortSchema } from '../enums.ts'
import { modelIdSchema, modelRefSchema, providerIdSchema, timestampSchema } from '../ids.ts'
import { isUnique } from '../util/text.ts'
import { queryBooleanSchema } from './common.ts'

/** Model capabilities; unknown -> false. */
export const modelCapabilitiesSchema = z.strictObject({
  tools: z.boolean(),
  vision: z.boolean(),
  pdf: z.boolean(),
  reasoning: z.boolean(),
  structuredOutput: z.boolean(),
  /**
   * A chat model that can return images in its reply (`file` parts, e.g. Gemini `*-image`); its provider options come
   * from `ProviderDefinition.imageParams` (ADR-028). Dedicated image models are `kind: 'image'` instead.
   */
  imageOutput: z.boolean(),
})
export type ModelCapabilities = z.infer<typeof modelCapabilitiesSchema>

const usdPerMillionSchema = z.number().min(0)

/** Prices in USD per 1M tokens. */
export const modelCostSchema = z.strictObject({
  input: usdPerMillionSchema.optional(),
  output: usdPerMillionSchema.optional(),
  cacheRead: usdPerMillionSchema.optional(),
  cacheWrite: usdPerMillionSchema.optional(),
})
export type ModelCost = z.infer<typeof modelCostSchema>

/** A list of reasoning efforts without duplicates. */
export const reasoningEffortListSchema = z
  .array(reasoningEffortSchema)
  .refine(isUnique, 'Reasoning efforts must be unique.')

export const catalogModelSchema = z.object({
  /** `${providerId}:${id}`. */
  ref: modelRefSchema,
  providerId: providerIdSchema,
  id: modelIdSchema,
  /** alias ?? catalog name ?? id. */
  name: z.string(),
  /** User display-name override. */
  alias: z.string().nullable(),
  kind: modelKindSchema,
  contextWindow: z.int().positive().nullable(),
  maxOutputTokens: z.int().positive().nullable(),
  capabilities: modelCapabilitiesSchema,
  /** `[]` = no effort control; otherwise the options shown, `auto` first. */
  reasoningEfforts: z.array(reasoningEffortSchema),
  cost: modelCostSchema.nullable(),
  favorite: z.boolean(),
  /** Effective: `model_prefs.hidden ?? classify()`. */
  hidden: z.boolean(),
  /** User-added custom id. */
  custom: z.boolean(),
  source: modelSourceSchema,
  lastUsedAt: timestampSchema.nullable(),
  /** `speech` models: voice names suggested by the provider (`ModelInfo.voices`, ADR-029); absent = unknown. */
  voices: z.array(z.string().min(1).max(64)).max(100).optional(),
})
export type CatalogModel = z.infer<typeof catalogModelSchema>

/** Query of `GET /models`. `includeHidden` defaults to false. */
export const modelsQuerySchema = z.object({
  providerId: providerIdSchema.optional(),
  includeHidden: queryBooleanSchema.optional(),
})
export type ModelsQuery = z.infer<typeof modelsQuerySchema>

/** Body of `PUT /model-prefs`; at least one of `favorite`, `hidden`, `alias`. */
export const modelPrefsUpdateSchema = z
  .strictObject({
    providerId: providerIdSchema,
    modelId: modelIdSchema,
    favorite: z.boolean().optional(),
    /** null = back to the `classify()` default. */
    hidden: z.boolean().nullable().optional(),
    /** null removes the alias. */
    alias: z.string().trim().min(1).max(100).nullable().optional(),
  })
  .refine(
    value => value.favorite !== undefined || value.hidden !== undefined || value.alias !== undefined,
    'Set at least one of favorite, hidden or alias.',
  )
export type ModelPrefsUpdate = z.infer<typeof modelPrefsUpdateSchema>

/** Body of `POST /custom-models` (creates or replaces). `kind` defaults to `chat`. */
export const customModelInputSchema = z.strictObject({
  providerId: providerIdSchema,
  modelId: modelIdSchema,
  name: z.string().trim().min(1).max(100).optional(),
  kind: modelKindSchema.optional(),
  contextWindow: z.int().positive().optional(),
  maxOutputTokens: z.int().positive().optional(),
  capabilities: modelCapabilitiesSchema.partial().optional(),
  reasoningEfforts: reasoningEffortListSchema.optional(),
  cost: modelCostSchema.optional(),
})
export type CustomModelInput = z.infer<typeof customModelInputSchema>

/** Query of `DELETE /custom-models`. */
export const customModelKeySchema = z.object({
  providerId: providerIdSchema,
  modelId: modelIdSchema,
})
export type CustomModelKey = z.infer<typeof customModelKeySchema>
