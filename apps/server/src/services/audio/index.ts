// Dictation and read-aloud (ADR-029, ARCHITECTURE.md 6.12 / 10.8, API.md 5.21). Owner: W6.5. Implements
// `AudioService` (./types.ts) behind `createAudioService(deps)`; the magic-byte sniffer of recordings goes to
// `./sniff.ts`.
//
// Phase 6 skeleton (P6-0b): both members answer `not_implemented` (HTTP 501) until W6.5 implements the service. Route
// tests use `createFakeAudioService` (`testing/fake-media.ts`).
import type { AppDeps } from '../../types.ts'
import type { AudioService } from './types.ts'
import { rejectsNotImplemented } from '../../not-implemented.ts'

export function createAudioService(_deps: AppDeps): AudioService {
  return {
    transcribe: rejectsNotImplemented('AudioService.transcribe (W6.5)'),
    speak: rejectsNotImplemented('AudioService.speak (W6.5)'),
  }
}
