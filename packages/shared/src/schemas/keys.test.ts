import { describe, expect, it } from 'vitest'
import { conflictDetailsSchema, conflictReasonSchema } from '../errors.ts'
import { dataCleanupPreviewSchema, dataCleanupResultSchema, fileSweepStatusSchema, pluginDataScanSchema } from './data.ts'
import { keyCheckSchema, keyRotateBodySchema, keyRotationResultSchema, keySourceSchema, keyStatusSchema } from './keys.ts'

describe('master key (ADR-034)', () => {
  const status = {
    source: 'file',
    keyVersion: 1,
    rotatedAt: null,
    keyCheck: 'ok',
    secrets: 4,
    unreadableSecrets: 0,
    shares: 2,
    pendingApprovals: 1,
    canRotate: true,
  }

  it('parses the key status', () => {
    expect(keyStatusSchema.parse(status)).toEqual(status)
    expect(keyStatusSchema.parse({ ...status, source: 'env', keyVersion: 3, rotatedAt: 9, keyCheck: 'mismatch', canRotate: false })).toMatchObject({ keyVersion: 3 })
    expect(keySourceSchema.options).toEqual(['env', 'file'])
    expect(keyCheckSchema.options).toEqual(['ok', 'mismatch', 'unknown'])
    for (const change of [{ keyVersion: 0 }, { source: 'kms' }, { keyCheck: 'bad' }, { secrets: -1 }, { canRotate: undefined }])
      expect(keyStatusSchema.safeParse({ ...status, ...change }).success, JSON.stringify(change)).toBe(false)
  })

  it('needs the typed confirmation, strictly', () => {
    expect(keyRotateBodySchema.parse({ confirm: 'ROTATE' })).toEqual({ confirm: 'ROTATE' })
    for (const body of [{}, { confirm: 'rotate' }, { confirm: 'DELETE' }, { confirm: 'ROTATE', key: 'x' }])
      expect(keyRotateBodySchema.safeParse(body).success, JSON.stringify(body)).toBe(false)
  })

  it('parses the rotation result', () => {
    const result = { keyVersion: 2, rotatedAt: 10, secrets: 4, skippedSecrets: 0, shares: 2, approvalsExpired: 1, chats: 1, runsStopped: 0 }
    expect(keyRotationResultSchema.parse(result)).toEqual(result)
    expect(keyRotationResultSchema.safeParse({ ...result, keyVersion: 0 }).success).toBe(false)
    expect(keyRotationResultSchema.safeParse({ ...result, approvalsExpired: undefined }).success).toBe(false)
  })

  it('adds the env-key and key-mismatch conflict reasons', () => {
    expect(conflictReasonSchema.options).toEqual(expect.arrayContaining(['busy', 'env-key', 'key-mismatch']))
    expect(conflictDetailsSchema.parse({ reason: 'env-key' })).toEqual({ reason: 'env-key' })
    expect(conflictDetailsSchema.parse({ reason: 'key-mismatch' })).toEqual({ reason: 'key-mismatch' })
  })
})

describe('orphaned file cleanup (ADR-035)', () => {
  it('parses the preview and the result', () => {
    const fileSweep = { mode: 'off', lastAttempt: null, nextRunAt: null }
    const preview = { files: 12, fileBytes: 48_000_000, blobs: 10, diskBytes: 40_000_000, tempFiles: 1, recentFiles: 3, graceMs: 86_400_000, lastRunAt: null, fileSweep, pluginData: 'complete' }
    expect(dataCleanupPreviewSchema.parse(preview)).toEqual(preview)
    expect(dataCleanupPreviewSchema.parse({ ...preview, lastRunAt: 5 }).lastRunAt).toBe(5)
    for (const change of [{ files: -1 }, { graceMs: undefined }, { lastRunAt: undefined }])
      expect(dataCleanupPreviewSchema.safeParse({ ...preview, ...change }).success, JSON.stringify(change)).toBe(false)
    const result = { files: 12, fileBytes: 48_000_000, blobs: 10, diskBytes: 40_000_000, tempFiles: 1, ranAt: 7, pluginData: 'partial' }
    expect(dataCleanupResultSchema.parse(result)).toEqual(result)
    expect(dataCleanupResultSchema.safeParse({ ...result, ranAt: null }).success).toBe(false)
  })
})

describe('automatic file sweep (ADR-039)', () => {
  const status = { mode: 'daily', lastAttempt: { at: 5, status: 'done', reason: null, files: 2, diskBytes: 1024 }, nextRunAt: 86_400_005 }

  it('parses the sweep status', () => {
    expect(fileSweepStatusSchema.parse(status)).toEqual(status)
    const skipped = { ...status, lastAttempt: { at: 5, status: 'skipped', reason: 'plugin-data-limit', files: 0, diskBytes: 0 } }
    expect(fileSweepStatusSchema.parse(skipped)).toEqual(skipped)
    const off = { mode: 'off', lastAttempt: null, nextRunAt: null }
    expect(fileSweepStatusSchema.parse(off)).toEqual(off)
    expect(pluginDataScanSchema.options).toEqual(['complete', 'partial'])
    for (const change of [
      { mode: 'monthly' },
      { nextRunAt: undefined },
      { lastAttempt: { ...status.lastAttempt, status: 'running' } },
      { lastAttempt: { ...status.lastAttempt, reason: 'busy' } },
      { lastAttempt: { ...status.lastAttempt, files: -1 } },
    ])
      expect(fileSweepStatusSchema.safeParse({ ...status, ...change }).success, JSON.stringify(change)).toBe(false)
  })

  it('requires the sweep status and the plugin data coverage on the cleanup DTOs', () => {
    const preview = { files: 0, fileBytes: 0, blobs: 0, diskBytes: 0, tempFiles: 0, recentFiles: 0, graceMs: 86_400_000, lastRunAt: null, fileSweep: status, pluginData: 'partial' }
    expect(dataCleanupPreviewSchema.parse(preview)).toEqual(preview)
    for (const change of [{ fileSweep: undefined }, { pluginData: undefined }, { pluginData: 'none' }])
      expect(dataCleanupPreviewSchema.safeParse({ ...preview, ...change }).success, JSON.stringify(change)).toBe(false)
    const result = { files: 0, fileBytes: 0, blobs: 0, diskBytes: 0, tempFiles: 0, ranAt: 1 }
    expect(dataCleanupResultSchema.safeParse(result).success).toBe(false)
    expect(dataCleanupResultSchema.parse({ ...result, pluginData: 'complete' }).pluginData).toBe('complete')
  })
})
