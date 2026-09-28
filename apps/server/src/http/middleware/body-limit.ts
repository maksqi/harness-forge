// Request body limits (ARCHITECTURE.md 10.4, `LIMITS` of `@harness-forge/shared`) - Phase 0 pass-through stub.
// Owner: W1.1.
//
// Contract: last `/api` middleware before the routes. Rejects bodies over the limit of the matched route with
// `payload_too_large` (`details.limitBytes`), checking `Content-Length` first and counting streamed bytes otherwise:
// `chat.send` `LIMITS.chatBodyBytes` (2 MB); `files.upload` `LIMITS.uploadBytes` + multipart overhead;
// `pluginInstall.inspect` / `pluginInstall.install` `LIMITS.pluginZipBytes` + overhead; `pluginFiles.write`
// `LIMITS.pluginFileBytes` + JSON envelope; every other route `LIMITS.jsonBodyBytes` (1 MB).
import type { AppDeps } from '../../types.ts'
import type { AppMiddleware } from '../types.ts'

export function bodyLimitMiddleware(_deps: AppDeps): AppMiddleware {
  return async (_c, next) => {
    await next()
  }
}
