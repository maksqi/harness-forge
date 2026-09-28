// Phase 0 stub of the SSRF-guarded fetch (ARCHITECTURE.md 10.4). Needed by W3.2 (URL installs) and W3.5 (`web_fetch`);
// its owner is assigned by the coordinator (see the C4 report). Keep the export name and the `SafeFetch` signature
// (./types.ts). Suggested implementation: `node:http` / `node:https` requests with a custom `lookup` that rejects
// non-public addresses at connect time (no re-resolve), manual redirects (each hop re-checked), a byte cap and a timeout.
import type { SafeFetch } from './types.ts'
import { rejectsNotImplemented } from '../not-implemented.ts'

export const safeFetch: SafeFetch = rejectsNotImplemented('safeFetch')
