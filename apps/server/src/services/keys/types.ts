// Frozen interface of the master-key service (Phase 7, ADR-034, API.md 5.23, ARCHITECTURE.md 6.14). Implementation:
// `createKeyService(deps)` in `services/keys/index.ts` (C16 stub; W7.7). Consumer: the keys routes
// (`http/routes/keys.ts`, W7.7). Boot hooks of the same module (not services): `recoverKeyState` (./recover.ts),
// `acquireServerLock` (./server-lock.ts) and the offline `rotate-key` CLI (./cli.ts), all called from `main.ts`.
import type { KeyRotateBody, KeyRotationResult, KeyStatus } from '@harness-forge/shared'
import type { SensitiveOperationOptions } from '../../types.ts'

/** Internal setting holding the key state (DECISIONS.md contract seed). */
export const KEY_STATE_SETTING = '_keys'

/** The stored key state: the internal setting `_keys`. */
export interface KeyState {
  /** Key version of every secret row written since the last rotation (1 until the first rotation). */
  version: number
  /** base64url of `HMAC-SHA256(encryption subkey, KEY_CHECK_INFO)`: tells a wrong key from a damaged row. */
  check: string
  /** Last rotation (ms); null = never rotated. */
  rotatedAt: number | null
}

/** The HMAC message of the key check (`KeyState.check`). */
export const KEY_CHECK_INFO = 'harness-forge/key-check/v1'

/** Message of the open approvals a rotation denies (`denyOpenApprovals`, `services/chats/approvals.ts`). */
export const KEY_ROTATION_DENIAL_REASON = 'Expired after a key rotation.'

/**
 * Master-key state and the online rotation. Never returns, logs or emits key material.
 */
export interface KeyService {
  /**
   * `GET /keys`: where the key comes from (`env` = `HF_MASTER_KEY`, `file` = `secret.key`), its version, the last
   * rotation, the key check (`ok`, `mismatch`, `unknown` when no check is stored), the secret rows (and the unreadable
   * ones), share links and pending approvals, and `canRotate` (`file` source and `keyCheck: 'ok'`).
   */
  readonly status: () => Promise<KeyStatus>
  /**
   * `POST /keys/rotate` (file mode only; ARCHITECTURE.md 6.14 steps 1-10, 12): calls `options.requireFreshAuth()`
   * again, checks `confirm: 'ROTATE'` (else `validation_error`), refuses with `409 conflict` (`env-key`: the key comes
   * from `HF_MASTER_KEY`; `key-mismatch`: the key fails the stored check; `busy`: another maintenance operation runs),
   * then under `maintenance.exclusive('key-rotation', ..., { blockRuns: true })`: stops every run, writes the new key to
   * `secret.key.next`, re-encrypts every readable secret to version V+1 in one transaction (also denying open approvals
   * with `KEY_ROTATION_DENIAL_REASON`, clearing `chats.pending_approval` and writing `_keys`), renames the file over
   * `secret.key`, swaps the live keyring, emits `key.rotated` and closes every event stream. The route issues the
   * caller's new session cookie (step 11).
   */
  readonly rotate: (body: KeyRotateBody, options: SensitiveOperationOptions) => Promise<KeyRotationResult>
}
