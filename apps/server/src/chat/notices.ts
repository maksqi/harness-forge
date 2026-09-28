// Notices of a run (API.md 4.7 `NoticeData`, 6.4): `data-notice` parts with a muted line of text. Most are added right
// after the `start` chunk (`withNotices` in `pipeline.ts`) and stored where the run's content starts; the
// `generated-file-dropped` notice (ADR-028) replaces a generated file in place (`generated-files.ts`, `images.ts`).
import type { NoticeData } from '@harness-forge/shared'
import { LIMITS } from '@harness-forge/shared'

export const NOTICES = {
  superseded: (count: number): NoticeData => ({
    level: 'info',
    code: 'approvals-superseded',
    message: count === 1
      ? 'A pending tool call was denied because a new message was sent.'
      : `${count} pending tool calls were denied because a new message was sent.`,
  }),
  toolsUnsupported: (): NoticeData => ({
    level: 'warning',
    code: 'tools-unsupported',
    message: 'This model does not support tools, so no tools were sent.',
  }),
  filesNotSent: (count: number): NoticeData => ({
    level: 'warning',
    code: 'attachments-unsupported',
    message: count === 1
      ? 'This model cannot read the attached file, so it was not sent.'
      : `This model cannot read ${count} of the attached files, so they were not sent.`,
  }),
  contextTrimmed: (): NoticeData => ({
    level: 'info',
    code: 'context-trimmed',
    message: 'Older messages were left out to fit the context window of this model.',
  }),
  /** Generated files that were not kept (not a raster image of `GENERATED_IMAGE_MIME_TYPES`, too large, unreadable). */
  generatedFileDropped: (count = 1): NoticeData => {
    const rule = `only PNG, JPEG, WebP and GIF images up to ${LIMITS.generatedImageBytes / 1024 / 1024} MB are stored.`
    return {
      level: 'warning',
      code: 'generated-file-dropped',
      message: count === 1
        ? `A file the model generated was not kept: ${rule}`
        : `${count} files the model generated were not kept: ${rule}`,
    }
  },
} as const
