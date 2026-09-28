// Error mapping of the chat pipeline (API.md 2.3 / 6.5). Provider errors go through `ProviderService.mapError`
// (`provider.mapError` first, then the default table: 401/403 `auth_invalid`, 429 `rate_limited`, 404
// `model_not_found`, context length `context_overflow`, network `provider_unreachable`, else `provider_error`). Local
// AI SDK errors (invalid approvals, a history that cannot be converted) are mapped here first. In-stream errors are
// sent as the envelope JSON (`errorText`); tool errors stay plain text (they become `output-error` parts).
import type { HarnessErrorInit } from '@harness-forge/shared'
import type { ProviderService } from '../providers/types.ts'
import { HarnessError, isHarnessError } from '@harness-forge/shared'
import {
  InvalidDataContentError,
  InvalidMessageRoleError,
  InvalidPromptError,
  InvalidToolApprovalError,
  InvalidToolApprovalSignatureError,
  InvalidToolInputError,
  MessageConversionError,
  MissingToolResultsError,
  NoOutputGeneratedError,
  NoSuchToolError,
  ToolCallNotFoundForApprovalError,
  ToolCallRepairError,
} from 'ai'

/** Maximum length of a plain tool error text. */
const TOOL_ERROR_MAX_CHARS = 2000

/** Codes that come from an upstream provider (recorded as the provider's call outcome). */
export const PROVIDER_ERROR_CODES: ReadonlySet<string> = new Set([
  'auth_invalid',
  'rate_limited',
  'model_not_found',
  'context_overflow',
  'provider_unreachable',
  'provider_error',
])

/**
 * A tool call that failed inside the host wrapper (owner inactive, blocked by `tool.before`, `execute` threw or timed
 * out, output not serializable). The message is safe to show and is sent to the model as the error result.
 */
export class ToolFailure extends Error {
  override readonly name = 'ToolFailure'
}

/** The reason passed to `AbortController.abort` for a user stop or shutdown (an `AbortError`, as the SDK expects). */
export function abortReason(message: string): DOMException {
  return new DOMException(message, 'AbortError')
}

/** True for an abort of the run (not a failure). */
export function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && ((error as { name?: unknown }).name === 'AbortError')
}

function messageOf(error: unknown): string {
  if (error instanceof Error)
    return error.message
  if (typeof error === 'string')
    return error
  return ''
}

/** Errors of one tool call (the stream goes on): the wrapper's failures and the SDK's tool call validation errors. */
export function isToolCallError(error: unknown): boolean {
  return error instanceof ToolFailure
    || typeof error === 'string'
    || InvalidToolInputError.isInstance(error)
    || NoSuchToolError.isInstance(error)
    || ToolCallRepairError.isInstance(error)
}

/** The plain text shown in an `output-error` / `tool-input-error` part (redacted, capped, never empty). */
export function toolErrorText(error: unknown, redactText: (text: string) => string): string {
  let text = redactText(messageOf(error).trim())
  if (text === '')
    text = 'The tool call failed.'
  return text.length > TOOL_ERROR_MAX_CHARS ? `${text.slice(0, TOOL_ERROR_MAX_CHARS)}...` : text
}

/** Errors raised by the AI SDK itself (not by the provider), mapped before the provider table. */
function localSdkError(error: unknown, providerId: string): HarnessError | null {
  if (InvalidToolApprovalError.isInstance(error) || InvalidToolApprovalSignatureError.isInstance(error) || ToolCallNotFoundForApprovalError.isInstance(error)) {
    return new HarnessError(
      { code: 'validation_error', message: 'The tool approval is invalid or no longer matches the tool call. Send a new message instead.' },
      { cause: error },
    )
  }
  if (InvalidPromptError.isInstance(error) || MessageConversionError.isInstance(error) || InvalidMessageRoleError.isInstance(error)
    || InvalidDataContentError.isInstance(error) || MissingToolResultsError.isInstance(error)) {
    return new HarnessError(
      { code: 'validation_error', message: 'The conversation cannot be sent to the model. Edit or regenerate an earlier message.' },
      { cause: error },
    )
  }
  if (NoOutputGeneratedError.isInstance(error))
    return new HarnessError({ code: 'provider_error', message: 'The model returned no output.', providerId, action: 'retry' }, { cause: error })
  return null
}

/** Maps any error of a run to a `HarnessError` (never throws). */
export function mapRunError(providers: ProviderService, providerId: string, error: unknown): HarnessError {
  if (isHarnessError(error))
    return error instanceof HarnessError ? error : HarnessError.from(error)
  const local = localSdkError(error, providerId)
  if (local !== null)
    return local
  try {
    return providers.mapError(providerId, error)
  }
  catch {
    return new HarnessError({ code: 'provider_error', message: 'The provider returned an error.', providerId, action: 'retry' }, { cause: error })
  }
}

/** The envelope JSON sent as `errorText` of an in-stream `error` chunk. */
export function errorEnvelopeText(error: HarnessError): string {
  return JSON.stringify(error.toJSON())
}

/** The `HarnessErrorInit` persisted in `metadata.error` and `run.finished`. */
export function errorInit(error: HarnessError): HarnessErrorInit {
  return error.toJSON().error
}

/**
 * Errors thrown before the stream starts: a `HarnessError` as is (HTTP status from `errorStatusByCode`), anything else
 * an `internal_error`.
 */
export function preStreamError(error: unknown, requestId: string): HarnessError {
  if (isHarnessError(error))
    return error instanceof HarnessError ? error : HarnessError.from(error)
  return new HarnessError({ code: 'internal_error', message: 'An unexpected error occurred.', action: 'retry', details: { requestId } }, { cause: error })
}
