// Image generation (ADR-028, ARCHITECTURE.md 6.11, API.md 4.18). Owner: W6.4. Implements `ImageService` (./types.ts)
// behind `createImageService(deps)`.
//
// Phase 6 skeleton (P6-0b): `generate` answers `not_implemented` (HTTP 501) until W6.4 implements the service. Tests of
// other services use `createFakeImageService` (`testing/fake-media.ts`).
import type { AppDeps } from '../../types.ts'
import type { ImageService } from './types.ts'
import { rejectsNotImplemented } from '../../not-implemented.ts'

export function createImageService(_deps: AppDeps): ImageService {
  return {
    generate: rejectsNotImplemented('ImageService.generate (W6.4)'),
  }
}
