// Frozen security interfaces (ARCHITECTURE.md section 10). Implementations:
// - `Keyring`         -> `createKeyring(deps)` in `security/keyring.ts` (W1.2)
// - `PasswordService` -> `createPasswordService(deps)` in `security/password.ts` (W1.1)
// - `SessionService`  -> `createSessionService(deps)` in `security/session.ts` (W1.1)
// - `Redactor`        -> `createRedactor()` in `security/redact.ts` (implemented; hardened in W4.1)

/** HKDF subkeys derived from the master key (ARCHITECTURE.md 10.3). */
export type SubkeyName = 'encryption' | 'session' | 'approval'

export const SUBKEY_NAMES = ['encryption', 'session', 'approval'] as const satisfies readonly SubkeyName[]

/**
 * Master key + HKDF-SHA256 subkeys (salt `harness-forge/v1`, info = subkey name, 32 bytes).
 *
 * The master key comes from `HF_MASTER_KEY` (base64, exactly 32 bytes) or `<dataDir>/secret.key` (generated once
 * with `crypto.randomBytes(32)`, mode 0600; a group/world readable file is refused). The factory loads the key
 * synchronously and throws on an invalid key, which fails the boot (exit 1). `createTestApp()` injects a fake keyring.
 */
export interface Keyring {
  /** Version of the master key, stored in `secrets.key_version` (1 in v1; rotation is future work). */
  readonly keyVersion: number
  /**
   * 32-byte subkey: `encryption` (AES-256-GCM secrets), `session` (HMAC of `hf_session`), `approval`
   * (`experimental_toolApprovalSecret` of the chat pipeline). Always returns the same bytes for a name.
   */
  readonly subkey: (name: SubkeyName) => Uint8Array
}

/** Where the active password comes from (`AuthStatus.source`). */
export type PasswordSource = 'env' | 'settings'

/**
 * Password hashing and the active password (ARCHITECTURE.md 10.1). `HF_PASSWORD` (hashed in memory at boot) wins over
 * the stored hash (secrets scope `auth`, name `password`).
 */
export interface PasswordService {
  /** scrypt (N = 2^15, r = 8, p = 1, 32-byte key, 16-byte random salt): `scrypt$15$8$1$<salt b64>$<hash b64>`. */
  readonly hash: (password: string) => Promise<string>
  /** Constant-time comparison (`timingSafeEqual`); false for a malformed or tampered hash string. */
  readonly verify: (password: string, hash: string) => Promise<boolean>
  /** `env` when `HF_PASSWORD` is set, `settings` when a hash is stored, else null (no login required). */
  readonly source: () => Promise<PasswordSource | null>
  /** Checks a candidate against the active password; false when no password is configured. */
  readonly check: (password: string) => Promise<boolean>
  /**
   * Stores the hash of `newPassword`, or removes the stored password (`null`). Increments the session epoch
   * (`SessionService.revokeAll`). Throws `conflict` (`reason: 'env-password'`) while `HF_PASSWORD` is set. Route-level
   * checks (current password, `insecure-bind`) stay in `PUT /auth/password`.
   */
  readonly set: (newPassword: string | null) => Promise<void>
}

/** Payload of the `hf_session` cookie (all timestamps in ms). */
export interface SessionPayload {
  /** Issued at. */
  iat: number
  /** Expires at (`iat` + 30 days). */
  exp: number
  /** Time of the password login that created the session chain (drives fresh auth, ADR-017). */
  authAt: number
  /** Must equal the internal setting `_auth.sessionEpoch`. */
  epoch: number
}

/**
 * Stateless HMAC-SHA256 session tokens: `v1.<payload b64url>.<signature b64url>`, keyed with the keyring `session`
 * subkey. Cookie attributes and rolling re-issue are HTTP concerns (session middleware and `auth.ts`).
 */
export interface SessionService {
  /** Signs a new token for a session whose password login happened at `authAt` (a rolling re-issue keeps it). */
  readonly issue: (input: { authAt: number, now?: number }) => Promise<string>
  /** The payload of a valid token (signature, expiry and current epoch checked), else null. */
  readonly verify: (token: string, now?: number) => Promise<SessionPayload | null>
  /** Invalidates every session by incrementing `_auth.sessionEpoch`; returns the new epoch. */
  readonly revokeAll: () => Promise<number>
}

export interface SafeFetchOptions {
  /** Body cap in bytes (`web_fetch` 2 MB, installs 20 MB); a larger body fails with `payload_too_large`. */
  maxBytes: number
  /** Default 10 000 ms for the whole exchange (redirects included). */
  timeoutMs?: number
  /** Default 5; every hop is re-checked. */
  maxRedirects?: number
  /** Default `['http:', 'https:']` (URL installs pass `['https:']`). */
  protocols?: readonly ('http:' | 'https:')[]
  method?: 'GET' | 'HEAD'
  headers?: Record<string, string>
  signal?: AbortSignal
}

export interface SafeFetchResult {
  /** Final URL after redirects. */
  url: string
  status: number
  headers: Headers
  body: Uint8Array
}

/**
 * Outbound HTTP with the SSRF guard (ARCHITECTURE.md 10.4), used by the `web_fetch` tool (W3.5) and URL installs
 * (W3.2); implemented in `security/ssrf.ts` as `safeFetch`. The host is DNS-resolved and loopback, private
 * (RFC 1918), link-local (incl. `169.254.169.254`), CGNAT, multicast, unspecified, IPv6 ULA / link-local and
 * IPv4-mapped forms of these are refused (`validation_error`); the connection goes to the checked address (no
 * re-resolve). Network failures and timeouts are `provider_unreachable`. Provider base URLs are not guarded.
 */
export type SafeFetch = (url: string, options: SafeFetchOptions) => Promise<SafeFetchResult>

/**
 * Masks secrets in logs and error messages (ARCHITECTURE.md 10.3 / 12). Shared by the logger, the error handler and
 * every service that decrypts secrets.
 */
export interface Redactor {
  /**
   * Registers a secret value (a decrypted API key, a password, a header value) so it is masked wherever it appears.
   * Values shorter than 4 characters are ignored.
   */
  readonly addSecret: (value: string) => void
  /** Masks registered secrets, `Bearer` / `Basic` credentials, `sk-...`-like tokens and `?key=` style URL secrets. */
  readonly redactText: (text: string) => string
  /**
   * A redacted deep copy: values under sensitive keys (`authorization`, `cookie`, `x-api-key`, `api-key` and keys
   * matching `key|secret|password|token`) are masked (numbers and booleans are kept), every string goes through
   * `redactText`, errors become `{ name, message, code?, stack? }`.
   */
  readonly redact: (value: unknown) => unknown
}
